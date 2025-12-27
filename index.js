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

const groq = new Groq({ apiKey: "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" });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const OWNER_PASSWORD = "613031896";
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activeSessions = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getGroqResponse(userMessage) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Tu es Stone 2, une IA créée par Moussa Kamara." },
                { role: "user", content: userMessage }
            ],
            model: "llama-3.1-8b-instant",
        });
        return completion.choices[0]?.message?.content || "Désolé, je bug.";
    } catch (error) { return "Cerveau indisponible."; }
}

async function createBotInstance(phoneNumber) {
    // Nettoyer le numéro pour le nom du dossier
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    console.log(`[SYSTÈME] Démarrage de la session pour : ${cleanNumber}`);
    
    const sessionPath = path.join(SESSIONS_DIR, cleanNumber);
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

    activeSessions.set(cleanNumber, { sock, isBotActive: true, activeSpams: new Set() });

    // Demande de Pairing Code si non connecté
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                console.log(`\n[CODE POUR ${cleanNumber}] : ${code}\n`);
            } catch (e) { console.log(`[ERREUR CODE] ${cleanNumber}: ${e.message}`); }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log(`[${cleanNumber}] Reconnexion dans 5s...`);
                await sleep(5000);
                createBotInstance(cleanNumber);
            } else {
                console.log(`[${cleanNumber}] Déconnecté définitivement.`);
                activeSessions.delete(cleanNumber);
            }
        } else if (connection === 'open') { 
            console.log(`[${cleanNumber}] ✅ CONNECTÉ`); 
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();

        // --- COMMANDE CONNECT ---
        if (lowerText === 'connect') {
            const target = remoteJid.split('@')[0];
            await sock.sendMessage(remoteJid, { text: `🔄 Génération du code pour le numéro ${target}...` });
            createBotInstance(target);
            return;
        }

        // --- COMMANDE DISCONNECT ---
        if (lowerText.startsWith('disconnect ')) {
            const parts = text.split(' ');
            if (parts[2] === OWNER_PASSWORD) {
                const targetNum = parts[1].replace(/[^0-9]/g, '');
                const session = activeSessions.get(targetNum);
                if (session) {
                    await session.sock.logout();
                    fs.rmSync(path.join(SESSIONS_DIR, targetNum), { recursive: true, force: true });
                    await sock.sendMessage(remoteJid, { text: `✅ Session ${targetNum} supprimée.` });
                }
            }
            return;
        }

        // Logique IA / Save / VV / Love
        const current = activeSessions.get(cleanNumber);
        if (!current || !current.isBotActive) return;

        if (lowerText === 'menu') {
            await sock.sendMessage(remoteJid, { text: "*STONE 2*\n- connect\n- save\n- vv\n- love\n- on/off" });
        } else if (!isFromMe && !['save', 'vv', 'menu', 'connect'].includes(lowerText)) {
            const res = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: res });
        }
    });
}

async function start() {
    console.log("--- DÉMARRAGE STONE 2 (PAR NUMÉRO) ---");
    const mainNum = await question('Veuillez entrer votre numéro principal (ex: 224620000000) : ');
    createBotInstance(mainNum.replace(/[^0-9]/g, ''));
}

start();
