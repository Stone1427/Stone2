const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage,
    getDevice,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const readline = require('readline');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: "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" });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// État global du bot
let isBotActive = true;

// Cache pour stocker temporairement les messages (pour l'anti-suppression)
// On garde les 500 derniers messages en mémoire
const messageDatabase = new Map();

async function getGroqResponse(userMessage) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `Tu es Stone 2, une intelligence artificielle avancée créée par Moussa Kamara.`
                },
                { role: "user", content: userMessage }
            ],
            model: "llama-3.1-8b-instant",
        });
        return completion.choices[0]?.message?.content || "Désolé, je n'ai pas pu générer de réponse.";
    } catch (error) { return "Désolé, mon cerveau d'IA est temporairement indisponible."; }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
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

    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('Veuillez entrer votre numéro de téléphone : ');
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\nVotre code d'appairage est : ${code}\n`);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') { console.log('Bot Stone 2 connecté avec succès !'); }
    });

    // --- LOGIQUE ANTI-SUPPRESSION (DÉTECTION) ---
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) { // Type 0 = Message supprimé
                const deletedMsgId = update.update.protocolMessage.key.id;
                const remoteJid = update.key.remoteJid;
                
                // On cherche le message original dans notre cache
                const originalMsg = messageDatabase.get(deletedMsgId);
                
                if (originalMsg && isBotActive) {
                    const participant = originalMsg.key.participant || originalMsg.key.remoteJid;
                    const senderName = originalMsg.pushName || "Inconnu";
                    
                    await sock.sendMessage(remoteJid, { 
                        text: `🛡️ *ANTI-SUPPRESSION DÉTECTÉ*\n\n👤 *Auteur :* ${senderName}\n📱 *Numéro :* @${participant.split('@')[0]}\n\n📜 *Message supprimé :*`,
                        mentions: [participant]
                    });

                    // On renvoie le contenu original
                    await sock.copyNForward(remoteJid, originalMsg, false);
                    
                    // Optionnel : supprimer du cache après récupération
                    messageDatabase.delete(deletedMsgId);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();

        // --- STOCKAGE DANS LE CACHE (Pour l'anti-suppression) ---
        if (msg.key.id) {
            messageDatabase.set(msg.key.id, msg);
            // Limiter la taille du cache pour éviter de saturer la RAM
            if (messageDatabase.size > 500) {
                const firstKey = messageDatabase.keys().next().value;
                messageDatabase.delete(firstKey);
            }
        }

        // --- COMMANDES DE CONTRÔLE (PROPRIÉTAIRE) ---
        if (isFromMe) {
            if (text === 'off') {
                isBotActive = false;
                await sock.sendMessage(remoteJid, { text: "Stone 2 est désactivé (IA + Anti-Suppression). 🛑" });
                return;
            }
            if (text === 'on') {
                isBotActive = true;
                await sock.sendMessage(remoteJid, { text: "Stone 2 est activé. ✅" });
                return;
            }
        }

        // --- COMMANDE "VV" ---
        if (text === 'vv') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) return sock.sendMessage(remoteJid, { text: "Répondez à un message à vue unique avec 'vv'." });

            let type = Object.keys(quoted)[0];
            if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
                type = Object.keys(quoted[type].message)[0];
            }

            if (type === 'imageMessage' || type === 'videoMessage') {
                try {
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    if (type === 'imageMessage') {
                        await sock.sendMessage(remoteJid, { image: buffer, caption: "Récupéré ✅" }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { video: buffer, caption: "Récupéré ✅" }, { quoted: msg });
                    }
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: "Erreur de récupération." });
                }
            }
            return;
        }

        // --- RÉPONSE IA ---
        if (!isFromMe && isBotActive && text && text !== 'vv') {
            const aiResponse = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: aiResponse });
        }
    });
}

startBot();
