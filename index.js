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

async function createBotInstance(sessionId, phoneNumber = null, isAutoReconnect = true) {
    console.log(`[SYSTÈME] Démarrage de : ${sessionId}`);
    
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

    activeSessions.set(sessionId, { sock, isBotActive: true, activeSpams: new Set() });

    // Pairing Code pour la session principale ou nouvelle session
    if (!sock.authState.creds.registered && (sessionId === 'main_session' || phoneNumber)) {
        const num = phoneNumber || await question('[CONNEXION] Entrez votre numéro (ex: 224620000000) : ');
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(num.replace(/[^0-9]/g, ''));
                console.log(`\n[CODE ${sessionId}] : ${code}\n`);
            } catch (e) { console.log(`[ERREUR CODE] ${sessionId}: ${e.message}`); }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && isAutoReconnect;
            
            console.log(`[${sessionId}] Déconnecté. Reconnexion : ${shouldReconnect} (Code: ${statusCode})`);
            
            if (shouldReconnect) {
                await sleep(5000); // Attendre 5s avant de retenter
                createBotInstance(sessionId, phoneNumber, true);
            } else {
                activeSessions.delete(sessionId);
            }
        } else if (connection === 'open') { 
            console.log(`[${sessionId}] ✅ CONNECTÉ`); 
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
            const target = remoteJid.split('@')[0];
            await sock.sendMessage(remoteJid, { text: "🔄 Création de votre bot..." });
            createBotInstance(`session_${target}`, target, true);
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
                    await sock.sendMessage(remoteJid, { text: "✅ Supprimé." });
                }
            }
            return;
        }

        // Logique IA / Save / VV / Love (simplifiée pour la stabilité)
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

console.log("--- DÉMARRAGE STONE 2 STABLE ---");
createBotInstance('main_session');
