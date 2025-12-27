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

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const pushName = msg.pushName || "Utilisateur";
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();

        // --- COMMANDE MENU ---
        if (text === 'menu') {
            const menuText = `
╔════════════════════╗
      *STONE 2 - MENU* 🤖
╚════════════════════╝

Bonjour *${pushName}* ! Voici la liste de mes fonctionnalités :

✨ *INTELLIGENCE ARTIFICIELLE*
└ Posez-moi n'importe quelle question et je vous répondrai intelligemment.

📥 *STATUS SAVER*
└ Répondez à un statut (photo/vidéo) avec le mot *save* pour l'enregistrer.

👁️ *ANTI-VIEW ONCE*
└ Répondez à un message à vue unique avec *vv* pour le récupérer.

⚙️ *CONTRÔLE (Propriétaire)*
├ *on* : Activer le bot.
└ *off* : Désactiver le bot.

📌 *INFOS*
├ *Développeur :* Moussa Kamara
└ *Statut :* ${isBotActive ? 'En ligne ✅' : 'Hors ligne 🛑'}

---
_Tapez une commande pour commencer !_
            `.trim();
            
            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
            return;
        }

        // --- COMMANDES DE CONTRÔLE (PROPRIÉTAIRE) ---
        if (isFromMe) {
            if (text === 'off') {
                isBotActive = false;
                await sock.sendMessage(remoteJid, { text: "Stone 2 est désactivé. 🛑" });
                return;
            }
            if (text === 'on') {
                isBotActive = true;
                await sock.sendMessage(remoteJid, { text: "Stone 2 est activé. ✅" });
                return;
            }
        }

        // --- FONCTIONNALITÉ STATUS SAVER (SAVE) ---
        if (text === 'save' && isBotActive) {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) return sock.sendMessage(remoteJid, { text: "Répondez à un statut avec 'save'." });

            let type = Object.keys(quoted)[0];
            if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
                type = Object.keys(quoted[type].message)[0];
            }

            if (type === 'imageMessage' || type === 'videoMessage') {
                try {
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    await sock.sendMessage(remoteJid, { 
                        image: type === 'imageMessage' ? buffer : undefined,
                        video: type === 'videoMessage' ? buffer : undefined,
                        caption: "Stone 2 : Sauvegardé ! ✅" 
                    }, { quoted: msg });
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: "Erreur de sauvegarde." });
                }
            }
            return;
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
                    await sock.sendMessage(remoteJid, { 
                        image: type === 'imageMessage' ? buffer : undefined,
                        video: type === 'videoMessage' ? buffer : undefined,
                        caption: "Récupéré ✅" 
                    }, { quoted: msg });
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: "Erreur de récupération." });
                }
            }
            return;
        }

        // --- RÉPONSE IA ---
        if (!isFromMe && isBotActive && text && text !== 'vv' && text !== 'save' && text !== 'menu') {
            const aiResponse = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: aiResponse });
        }
    });
}

startBot();
