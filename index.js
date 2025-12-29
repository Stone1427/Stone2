require('dotenv').config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const readline = require('readline');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const GROQ_API_KEY = process.env.GROQ_API_KEY || "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";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "613031896";

const groq = new Groq({ apiKey: GROQ_API_KEY });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activeSessions = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- FONCTIONS UTILITAIRES OPTIMISÉES ---
async function downloadYouTubeMP3(query) {
    return new Promise((resolve, reject) => {
        const filename = `audio_${Date.now()}.mp3`;
        const outputPath = path.join(__dirname, filename);
        const command = `yt-dlp --max-filesize 15M -f "bestaudio" --extract-audio --audio-format mp3 -o "${outputPath}" "ytsearch1:${query}"`;
        exec(command, (error) => {
            if (error) return reject("Erreur.");
            if (fs.existsSync(outputPath)) resolve(outputPath);
            else reject("Échec.");
        });
    });
}

async function getGroqResponse(userMessage) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [{ role: "system", content: "Tu es Stone 2, créé par Moussa Kamara. Sois bref." }, { role: "user", content: userMessage }],
            model: "llama-3.1-8b-instant",
        });
        return completion.choices[0]?.message?.content || "Désolé.";
    } catch (e) { return "IA occupée."; }
}

async function createBotInstance(phoneNumber, sockToNotify = null, jidToNotify = null) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSIONS_DIR, cleanNumber);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
    });

    activeSessions.set(cleanNumber, { sock, isBotActive: false, activeSpams: new Set() });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                if (sockToNotify && jidToNotify) await sockToNotify.sendMessage(jidToNotify, { text: `✅ *CODE : ${code}*` });
            } catch (e) {}
        }, 2000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if ((lastDisconnect?.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut) {
                await sleep(3000);
                createBotInstance(cleanNumber);
            }
        } else if (connection === 'open') { console.log(`[${cleanNumber}] ✅ PRÊT`); }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();

        const current = activeSessions.get(cleanNumber);
        if (!current) return;

        // --- 1. COMMANDES PRIORITAIRES (INSTANTANÉES) ---
        if (isFromMe) {
            if (lowerText === 'on') { current.isBotActive = true; return sock.sendMessage(remoteJid, { text: "✅ Stone 2 ON." }); }
            if (lowerText === 'off') { current.isBotActive = false; return sock.sendMessage(remoteJid, { text: "🛑 Stone 2 OFF." }); }
        }

        if (lowerText === 'menu') {
            const menu = `*STONE 2*\n\n- *on/off*\n- *video [nom]*\n- *connect [num] [mdp]*\n- *save/vv*\n- *love [mot]*\n- *disconnect [num] [mdp]*\n\n*Statut :* ${current.isBotActive ? 'ON' : 'OFF'}`;
            return sock.sendMessage(remoteJid, { text: menu }, { quoted: msg });
        }

        // --- 2. LOGIQUE DE SÉCURITÉ ---
        if (lowerText.startsWith('connect ')) {
            const parts = text.split(' ');
            if (parts[2] !== OWNER_PASSWORD) return sock.sendMessage(remoteJid, { text: "❌ MDP." });
            createBotInstance(parts[1].replace(/[^0-9]/g, ''), sock, remoteJid);
            return;
        }

        if (lowerText.startsWith('disconnect ')) {
            const parts = text.split(' ');
            if (parts[2] === OWNER_PASSWORD) {
                const targetNum = parts[1].replace(/[^0-9]/g, '');
                const session = activeSessions.get(targetNum);
                if (session) {
                    await session.sock.logout();
                    fs.rmSync(path.join(SESSIONS_DIR, targetNum), { recursive: true, force: true });
                    activeSessions.delete(targetNum);
                    return sock.sendMessage(remoteJid, { text: "✅ Supprimé." });
                }
            }
            return;
        }

        // --- 3. SI OFF, ON ARRÊTE TOUT ---
        if (!current.isBotActive) return;

        // --- 4. TRAITEMENT DES OUTILS (ASYNCHRONE) ---
        if (lowerText.startsWith('video ')) {
            const query = text.slice(6).trim();
            if (query) {
                sock.sendMessage(remoteJid, { text: "⏳..." });
                downloadYouTubeMP3(query).then(path => {
                    sock.sendMessage(remoteJid, { audio: fs.readFileSync(path), mimetype: 'audio/mp4' }, { quoted: msg });
                    fs.unlinkSync(path);
                }).catch(e => sock.sendMessage(remoteJid, { text: "❌" }));
            }
            return;
        }

        if (lowerText === 'save' || lowerText === 'vv') {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) }).then(buffer => {
                    let type = Object.keys(quoted)[0];
                    if (type.includes('viewOnceMessage')) type = Object.keys(quoted[type].message)[0];
                    sock.sendMessage(remoteJid, { [type === 'imageMessage' ? 'image' : 'video']: buffer, caption: "✅" }, { quoted: msg });
                }).catch(e => {});
            }
            return;
        }

        if (isFromMe && lowerText.startsWith('love ')) {
            const word = text.slice(5).trim();
            if (word) {
                current.activeSpams.add(remoteJid);
                (async () => {
                    for (let i = 1; i <= 4000; i++) {
                        if (!current.activeSpams.has(remoteJid) || !current.isBotActive) break;
                        await sock.sendMessage(remoteJid, { text: word });
                        await sleep(10000);
                    }
                })();
            }
            return;
        }

        // --- 5. RÉPONSE IA (ASYNCHRONE ET NON-BLOQUANTE) ---
        if (!isFromMe && text && !['menu', 'save', 'vv'].includes(lowerText) && !lowerText.startsWith('connect ') && !lowerText.startsWith('video ')) {
            getGroqResponse(text).then(res => {
                sock.sendMessage(remoteJid, { text: res });
            }).catch(e => {});
        }
    });
}

async function start() {
    console.log("--- STONE 2 OPTIMISÉ ---");
    const mainNum = await question('Numéro : ');
    createBotInstance(mainNum.replace(/[^0-9]/g, ''));
}

start();
