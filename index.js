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
let activeSpams = new Set(); // Pour suivre les processus de "love" actifs

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

// Fonction utilitaire pour le délai
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();

        // --- COMMANDE MENU ---
        if (lowerText === 'menu') {
            const menuText = `
╔════════════════════╗
      *STONE 2 - MENU* 🤖
╚════════════════════╝

Bonjour *${pushName}* ! Voici mes commandes :

✨ *IA & FUN*
├ Posez une question pour l'IA.
└ *love [mot]* : Envoie un mot 4000 fois (Délai 10s).

📥 *OUTILS*
├ *save* : (En réponse) Sauvegarder un statut.
└ *vv* : (En réponse) Récupérer un message unique.

⚙️ *CONTRÔLE (Propriétaire)*
├ *on* / *off* : Activer/Désactiver le bot.
└ *stoplove* : Arrêter l'envoi massif en cours.

📌 *INFOS*
├ *Développeur :* Moussa Kamara
└ *Statut :* ${isBotActive ? 'Actif ✅' : 'Inactif 🛑'}
            `.trim();
            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
            return;
        }

        // --- COMMANDE LOVE (PROPRIÉTAIRE UNIQUEMENT) ---
        if (isFromMe && lowerText.startsWith('love ')) {
            const wordToRepeat = text.slice(5).trim();
            if (!wordToRepeat) return sock.sendMessage(remoteJid, { text: "Veuillez préciser le mot après 'love'." });

            activeSpams.add(remoteJid);
            await sock.sendMessage(remoteJid, { text: `🚀 Lancement de l'envoi de "${wordToRepeat}" 4000 fois avec un délai de 10s.\nTapez *stoplove* pour arrêter.` });

            for (let i = 1; i <= 4000; i++) {
                if (!activeSpams.has(remoteJid) || !isBotActive) break;
                
                await sock.sendMessage(remoteJid, { text: wordToRepeat });
                await sleep(10000); // Délai de 10 secondes
            }
            
            activeSpams.delete(remoteJid);
            return;
        }

        // --- COMMANDE STOPLOVE ---
        if (isFromMe && lowerText === 'stoplove') {
            if (activeSpams.has(remoteJid)) {
                activeSpams.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: "🛑 Envoi massif arrêté avec succès." });
            } else {
                await sock.sendMessage(remoteJid, { text: "Aucun envoi massif n'est en cours ici." });
            }
            return;
        }

        // --- COMMANDES DE CONTRÔLE ---
        if (isFromMe) {
            if (lowerText === 'off') {
                isBotActive = false;
                activeSpams.clear(); // Arrête tout envoi en cours
                await sock.sendMessage(remoteJid, { text: "Stone 2 est désactivé. 🛑" });
                return;
            }
            if (lowerText === 'on') {
                isBotActive = true;
                await sock.sendMessage(remoteJid, { text: "Stone 2 est activé. ✅" });
                return;
            }
        }

        // --- FONCTIONNALITÉ STATUS SAVER (SAVE) ---
        if (lowerText === 'save' && isBotActive) {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) return;

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
                } catch (e) {}
            }
            return;
        }

        // --- COMMANDE "VV" ---
        if (lowerText === 'vv') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) return;

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
                } catch (e) {}
            }
            return;
        }

        // --- RÉPONSE IA ---
        if (!isFromMe && isBotActive && text && lowerText !== 'vv' && lowerText !== 'save' && lowerText !== 'menu') {
            const aiResponse = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: aiResponse });
        }
    });
}

startBot();
