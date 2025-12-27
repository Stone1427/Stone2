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

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

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

async function createBotInstance(sessionId, phoneNumber = null) {
    console.log(`[SYSTÈME] Initialisation de la session : ${sessionId}...`);
    
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
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

    activeSessions.set(sessionId, {
        sock,
        isBotActive: true,
        activeSpams: new Set()
    });

    // Demande de numéro si non enregistré
    if (!sock.authState.creds.registered && sessionId === 'main_session') {
        if (!phoneNumber) {
            phoneNumber = await question('[CONNEXION] Veuillez entrer votre numéro (ex: 224620000000) : ');
        }
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                console.log(`\n[CODE D'APPAIRAGE] Votre code est : ${code}\n`);
            } catch (e) {
                console.error("[ERREUR] Impossible de générer le code :", e.message);
            }
        }, 2000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log(`[SESSION ${sessionId}] Connexion fermée. Reconnexion : ${shouldReconnect}`);
            if (shouldReconnect) createBotInstance(sessionId);
        } else if (connection === 'open') { 
            console.log(`[SESSION ${sessionId}] ✅ Connectée et opérationnelle !`); 
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();

        // --- COMMANDES ---
        if (lowerText === 'connect') {
            const targetNumber = remoteJid.split('@')[0];
            await sock.sendMessage(remoteJid, { text: "🔄 Préparation de votre session..." });
            createBotInstance(`session_${targetNumber}`, targetNumber);
            return;
        }

        if (lowerText.startsWith('disconnect ')) {
            const parts = text.split(' ');
            if (parts[2] === OWNER_PASSWORD) {
                const targetId = parts[1] === 'me' ? sessionId : `session_${parts[1].replace(/[^0-9]/g, '')}`;
                const session = activeSessions.get(targetId);
                if (session) {
                    await session.sock.logout();
                    fs.rmSync(path.join(SESSIONS_DIR, targetId), { recursive: true, force: true });
                    await sock.sendMessage(remoteJid, { text: "✅ Déconnecté." });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ MDP incorrect." });
            }
            return;
        }

        // ... (Reste de la logique IA, Save, VV, Love identique)
        const current = activeSessions.get(sessionId);
        if (!current || !current.isBotActive) return;

        if (lowerText === 'menu') {
            await sock.sendMessage(remoteJid, { text: "*STONE 2*\n- connect\n- save\n- vv\n- love\n- on/off" });
        } else if (!isFromMe && !['save', 'vv', 'menu', 'connect'].includes(lowerText)) {
            const res = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: res });
        }
    });
}

console.log("====================================");
console.log("   DÉMARRAGE DU SYSTÈME STONE 2     ");
console.log("====================================");

createBotInstance('main_session').catch(err => {
    console.error("[ERREUR CRITIQUE]", err);
});
