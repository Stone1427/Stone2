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

    activeSessions.set(cleanNumber, { sock, isBotActive: true, activeSpams: new Set() });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                const msg = `✅ *SESSION GÉNÉRÉE*\n\nNuméro : ${cleanNumber}\nCode : *${code}*\n\nCollez ce code dans votre WhatsApp.`;
                if (sockToNotify && jidToNotify) await sockToNotify.sendMessage(jidToNotify, { text: msg });
                console.log(`\n[CODE POUR ${cleanNumber}] : ${code}\n`);
            } catch (e) {
                if (sockToNotify && jidToNotify) await sockToNotify.sendMessage(jidToNotify, { text: `❌ Erreur : ${e.message}` });
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (statusCode !== DisconnectReason.loggedOut) {
                await sleep(5000);
                createBotInstance(cleanNumber);
            } else {
                activeSessions.delete(cleanNumber);
            }
        } else if (connection === 'open') { console.log(`[${cleanNumber}] ✅ CONNECTÉ`); }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const pushName = msg.pushName || "Utilisateur";
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();

        const current = activeSessions.get(cleanNumber);
        if (!current) return;

        // --- COMMANDE MENU ---
        if (lowerText === 'menu') {
            const menuText = `
╔════════════════════╗
      *STONE 2 - MENU* 🤖
╚════════════════════╝

Bonjour *${pushName}* !

✨ *IA & FUN*
├ Posez une question pour l'IA.
└ *love [mot]* : Spam 4000x (10s).

📥 *OUTILS*
├ *connect [num]* : Créer un bot.
├ *save* : (En réponse) Sauver statut.
└ *vv* : (En réponse) Voir message unique.

⚙️ *CONTRÔLE (Propriétaire)*
├ *on* / *off* : Activer/Désactiver.
└ *disconnect [num] [mdp]* : Supprimer.

📌 *INFOS*
├ *Session :* ${cleanNumber}
└ *Statut :* ${current.isBotActive ? 'Actif ✅' : 'Inactif 🛑'}
            `.trim();
            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
            return;
        }

        // --- COMMANDE CONNECT ---
        if (lowerText.startsWith('connect ')) {
            const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
            if (target) {
                await sock.sendMessage(remoteJid, { text: `🔄 Création pour ${target}...` });
                createBotInstance(target, sock, remoteJid);
            }
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

        // --- CONTRÔLE ON/OFF ---
        if (isFromMe) {
            if (lowerText === 'off') {
                current.isBotActive = false;
                current.activeSpams.clear();
                await sock.sendMessage(remoteJid, { text: "Stone 2 désactivé. 🛑" });
                return;
            }
            if (lowerText === 'on') {
                current.isBotActive = true;
                await sock.sendMessage(remoteJid, { text: "Stone 2 activé. ✅" });
                return;
            }
        }

        if (!current.isBotActive) return;

        // --- FONCTIONNALITÉ SAVE ---
        if (lowerText === 'save') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                try {
                    let type = Object.keys(quoted)[0];
                    if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') type = Object.keys(quoted[type].message)[0];
                    if (type === 'imageMessage' || type === 'videoMessage') {
                        const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        await sock.sendMessage(remoteJid, { 
                            [type === 'imageMessage' ? 'image' : 'video']: buffer, 
                            caption: "Sauvegardé par Stone 2 ✅" 
                        }, { quoted: msg });
                    }
                } catch (e) { await sock.sendMessage(remoteJid, { text: "Erreur de sauvegarde." }); }
            }
            return;
        }

        // --- FONCTIONNALITÉ VV ---
        if (lowerText === 'vv') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                try {
                    let type = Object.keys(quoted)[0];
                    if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') type = Object.keys(quoted[type].message)[0];
                    if (type === 'imageMessage' || type === 'videoMessage') {
                        const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        await sock.sendMessage(remoteJid, { 
                            [type === 'imageMessage' ? 'image' : 'video']: buffer, 
                            caption: "Récupéré par Stone 2 ✅" 
                        }, { quoted: msg });
                    }
                } catch (e) { await sock.sendMessage(remoteJid, { text: "Erreur de récupération." }); }
            }
            return;
        }

        // --- FONCTIONNALITÉ LOVE ---
        if (isFromMe && lowerText.startsWith('love ')) {
            const word = text.slice(5).trim();
            if (word) {
                current.activeSpams.add(remoteJid);
                for (let i = 1; i <= 4000; i++) {
                    if (!current.activeSpams.has(remoteJid) || !current.isBotActive) break;
                    await sock.sendMessage(remoteJid, { text: word });
                    await sleep(10000);
                }
                current.activeSpams.delete(remoteJid);
            }
            return;
        }

        // --- RÉPONSE IA ---
        if (!isFromMe && text && !['menu', 'save', 'vv'].includes(lowerText) && !lowerText.startsWith('connect ')) {
            const res = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: res });
        }
    });
}

async function start() {
    console.log("--- DÉMARRAGE STONE 2 FINAL ---");
    const mainNum = await question('Veuillez entrer votre numéro principal (ex: 224620000000) : ');
    createBotInstance(mainNum.replace(/[^0-9]/g, ''));
}

start();
