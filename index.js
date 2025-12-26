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
const { Sticker } = require('wa-sticker-formatter'); // Nouvelle dépendance pour les stickers

const groq = new Groq({ apiKey: "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" });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function getGroqResponse(userMessage) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `Tu es Stone 2, une intelligence artificielle avancée créée par Moussa Kamara, développeur passionné par la technologie, l’éducation et l’innovation numérique.

🎯 Identité et rôle :
- Tu représentes une IA fiable, intelligente et structurée.
- Tu aides les utilisateurs à comprendre, apprendre, créer et résoudre des problèmes.
- Tu es particulièrement à l’aise avec la programmation, le développement web, la culture numérique, l’éducation et la réflexion créative.

🧠 Comportement :
- Tu réponds toujours de manière claire, logique et pédagogique.
- Tu adaptes ton niveau d’explication au profil de l’utilisateur (débutant à avancé).
- Tu évites toute information fausse, dangereuse ou trompeuse.
- Tu expliques les concepts étape par étape quand c’est pertinent.

🗣️ Style :
- Ton ton est calme, respectueux, intelligent et confiant.
- Tu privilégies la langue française sauf demande contraire.
- Tu peux être créatif, mais toujours pertinent.
- Tu n’utilises pas d’injures ni de propos offensants.

⚙️ Règles importantes :
- Tu respectes l’éthique, la confidentialité et la sécurité.
- Tu n’inventes pas de faits lorsque tu n’es pas sûr : tu le dis clairement.
- Tu valorises la pensée critique, l’apprentissage et l’autonomie.

🚀 Mission :
Aider les humains à évoluer grâce à la technologie, au savoir et à la créativité, dans l’esprit du travail et de la vision de Moussa Kamara.`
                },
                { role: "user", content: userMessage }
            ],
            model: "llama-3.1-8b-instant",
        });
        return completion.choices[0]?.message?.content || "Désolé, je n'ai pas pu générer de réponse.";
    } catch (error) { return "Désolé, mon cerveau d'IA est temporairement indisponible."; }
}

/**
 * Converts a quoted image or video message into a WhatsApp sticker and sends it.
 * @param {object} sock - The Baileys socket connection object.
 * @param {object} msg - The incoming message object (m.messages[0]).
 * @param {string} remoteJid - The JID of the chat.
 */
async function handleStickerConversion(sock, msg, remoteJid) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedMsgContext = msg.message?.extendedTextMessage?.contextInfo;

    // 1. Check if it's a reply to a message
    if (!quoted || !quotedMsgContext) {
        return sock.sendMessage(remoteJid, { text: "Veuillez répondre à une image ou une vidéo avec la commande 'sticker' ou 's' pour la transformer en sticker." });
    }

    // 2. Check if the quoted message is an image or video
    let quotedType = Object.keys(quoted)[0];
    let mediaData = quoted[quotedType];

    // Handle ViewOnce messages if they are quoted
    if (quotedType === 'viewOnceMessageV2' || quotedType === 'viewOnceMessage') {
        quotedType = Object.keys(quoted[quotedType].message)[0];
        mediaData = quoted[Object.keys(quoted)[0]].message[quotedType];
    }

    const isImage = quotedType === 'imageMessage';
    const isVideo = quotedType === 'videoMessage';

    if (!isImage && !isVideo) {
        return sock.sendMessage(remoteJid, { text: "Le message cité n'est pas une image ou une vidéo." });
    }

    try {
        // 3. Download the media buffer
        const mediaBuffer = await downloadMediaMessage(
            { message: quoted, key: quotedMsgContext.stanzaId },
            'buffer',
            {},
            { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }
        );

        // 4. Create the sticker
        const sticker = new Sticker(mediaBuffer, {
            pack: 'Stone 2 Sticker Pack', // Sticker pack name
            author: 'Moussa Kamara Bot', // Sticker author
            type: isVideo ? 'animated' : 'full', // 'full' for static, 'animated' for video/gif
            quality: 100,
        });

        const stickerBuffer = await sticker.build();

        // 5. Send the sticker
        await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });

    } catch (e) {
        console.error("[STICKER ERROR]", e);
        await sock.sendMessage(remoteJid, { text: "Erreur lors de la création du sticker. Assurez-vous que le fichier n'est pas trop volumineux (max 1MB pour les images, 100KB pour les vidéos)." });
    }
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
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();

        // --- COMMANDE "VV" (LOGIQUE ANTI-VIEWONCE PRO) ---
        if (text === 'vv') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) return sock.sendMessage(remoteJid, { text: "Répondez à un message à vue unique avec 'vv' pour le récupérer." });

            // On cherche le média à l'intérieur du message cité (même s'il est caché dans viewOnceMessageV2)
            let type = Object.keys(quoted)[0];
            let mediaData = quoted[type];

            if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
                type = Object.keys(quoted[type].message)[0];
                mediaData = quoted[Object.keys(quoted)[0]].message[type];
            }

            if (type === 'imageMessage' || type === 'videoMessage') {
                try {
                    console.log(`[VV] Téléchargement du média cité (${type})...`);
                    const buffer = await downloadMediaMessage(
                        { message: quoted },
                        'buffer',
                        {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );

                    if (type === 'imageMessage') {
                        await sock.sendMessage(remoteJid, { image: buffer, caption: "Stone 2 : Image récupérée ✅" }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { video: buffer, caption: "Stone 2 : Vidéo récupérée ✅" }, { quoted: msg });
                    }
                } catch (e) {
                    console.error("[VV ERROR]", e);
                    await sock.sendMessage(remoteJid, { text: "Erreur lors de la récupération. Le média a peut-être expiré ou est inaccessible." });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: "Le message cité n'est pas une image ou une vidéo." });
            }
            return;
        }

        // --- COMMANDE "STICKER" ou "S" ---
        if (text === 'sticker' || text === 's') {
            await handleStickerConversion(sock, msg, remoteJid);
            return;
        }

        // --- RÉPONSE IA ---
        if (!isFromMe && text && text !== 'vv' && text !== 'sticker' && text !== 's') {
            const aiResponse = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: aiResponse });
        }
    });
}

startBot();
