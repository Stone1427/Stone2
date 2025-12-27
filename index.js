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

// --- CONFIGURATION ---
const OWNER_PASSWORD = "613031896";
const SESSIONS_DIR = './sessions';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// Stockage des instances de bot actives
const activeSessions = new Map(); // sessionId -> { sock, isBotActive, activeSpams }

// Fonction utilitaire pour le délai
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

    // Initialisation de l'état de la session
    const sessionData = {
        sock,
        isBotActive: true,
        activeSpams: new Set()
    };
    activeSessions.set(sessionId, sessionData);

    // Si c'est une nouvelle connexion par numéro
    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                console.log(`[SESSION ${sessionId}] Code généré : ${code}`);
                // On ne peut pas envoyer le code directement ici car le bot n'est pas encore connecté
            } catch (e) { console.error("Erreur pairing code:", e); }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) createBotInstance(sessionId);
            else {
                activeSessions.delete(sessionId);
                console.log(`[SESSION ${sessionId}] Déconnectée.`);
            }
        } else if (connection === 'open') { 
            console.log(`[SESSION ${sessionId}] Connectée avec succès !`); 
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const pushName = msg.pushName || "Utilisateur";
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();

        // --- COMMANDE CONNECT (Seulement pour le bot principal ou propriétaire) ---
        if (lowerText === 'connect') {
            const targetNumber = remoteJid.split('@')[0];
            await sock.sendMessage(remoteJid, { text: `🔄 Initialisation d'une session pour ${targetNumber}...` });
            
            // Créer une nouvelle instance pour ce numéro
            const newSessionId = `session_${targetNumber}`;
            if (activeSessions.has(newSessionId)) {
                return sock.sendMessage(remoteJid, { text: "Une session est déjà active pour ce numéro." });
            }

            const newSock = makeWASocket({
                version,
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                auth: (await useMultiFileAuthState(path.join(SESSIONS_DIR, newSessionId))).state,
            });

            setTimeout(async () => {
                try {
                    const code = await newSock.requestPairingCode(targetNumber);
                    await sock.sendMessage(remoteJid, { 
                        text: `✅ *SESSION PRÊTE*\n\nVotre code d'appairage est : *${code}*\n\nEntrez ce code sur votre WhatsApp (Appareils connectés > Connecter un appareil > Se connecter avec le numéro de téléphone).` 
                    });
                    // Lancer l'instance complète
                    createBotInstance(newSessionId, targetNumber);
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: "Erreur lors de la génération du code." });
                }
            }, 2000);
            return;
        }

        // --- COMMANDE DISCONNECT (Propriétaire + Mot de passe) ---
        if (lowerText.startsWith('disconnect ')) {
            const parts = text.split(' ');
            const target = parts[1]; // numéro ou "me"
            const pass = parts[2];

            if (pass !== OWNER_PASSWORD) {
                return sock.sendMessage(remoteJid, { text: "❌ Mot de passe incorrect." });
            }

            const targetId = target === 'me' ? sessionId : `session_${target.replace(/[^0-9]/g, '')}`;
            const targetSession = activeSessions.get(targetId);

            if (targetSession) {
                await targetSession.sock.logout();
                activeSessions.delete(targetId);
                // Supprimer le dossier de session
                fs.rmSync(path.join(SESSIONS_DIR, targetId), { recursive: true, force: true });
                await sock.sendMessage(remoteJid, { text: `✅ Session ${targetId} déconnectée et supprimée.` });
            } else {
                await sock.sendMessage(remoteJid, { text: "Session introuvable." });
            }
            return;
        }

        // --- LOGIQUE CLASSIQUE DU BOT ---
        const currentSession = activeSessions.get(sessionId);
        if (!currentSession) return;

        if (lowerText === 'menu') {
            const menuText = `*STONE 2 - MULTI-SESSION*\n\n- *connect* : Créer votre propre bot\n- *save* : Sauver statut\n- *vv* : Voir message unique\n- *love [mot]* : Spam\n- *on/off* : Contrôle\n\n_Session : ${sessionId}_`;
            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
            return;
        }

        if (isFromMe && lowerText.startsWith('love ')) {
            const word = text.slice(5).trim();
            currentSession.activeSpams.add(remoteJid);
            for (let i = 1; i <= 4000; i++) {
                if (!currentSession.activeSpams.has(remoteJid) || !currentSession.isBotActive) break;
                await sock.sendMessage(remoteJid, { text: word });
                await sleep(10000);
            }
            currentSession.activeSpams.delete(remoteJid);
            return;
        }

        if (isFromMe && lowerText === 'off') {
            currentSession.isBotActive = false;
            await sock.sendMessage(remoteJid, { text: "Bot désactivé." });
            return;
        }

        if (isFromMe && lowerText === 'on') {
            currentSession.isBotActive = true;
            await sock.sendMessage(remoteJid, { text: "Bot activé." });
            return;
        }

        if (lowerText === 'save' && currentSession.isBotActive) {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) return;
            try {
                const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                let type = Object.keys(quoted)[0];
                if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') type = Object.keys(quoted[type].message)[0];
                await sock.sendMessage(remoteJid, { 
                    [type === 'imageMessage' ? 'image' : 'video']: buffer, 
                    caption: "Sauvegardé ✅" 
                }, { quoted: msg });
            } catch (e) {}
            return;
        }

        if (lowerText === 'vv' && currentSession.isBotActive) {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) return;
            try {
                const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                let type = Object.keys(quoted)[0];
                if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') type = Object.keys(quoted[type].message)[0];
                await sock.sendMessage(remoteJid, { 
                    [type === 'imageMessage' ? 'image' : 'video']: buffer, 
                    caption: "Récupéré ✅" 
                }, { quoted: msg });
            } catch (e) {}
            return;
        }

        if (!isFromMe && currentSession.isBotActive && text && !['menu', 'save', 'vv', 'connect'].includes(lowerText)) {
            const aiResponse = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: aiResponse });
        }
    });
}

// Lancer la session principale (la vôtre)
// Le premier dossier sera 'main_session'
createBotInstance('main_session');
