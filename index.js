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
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const groq = new Groq({ apiKey: "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" });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// État global du bot
let isBotActive = true;

// Fonction pour télécharger une vidéo via yt-dlp
async function downloadVideo(url) {
    return new Promise((resolve, reject) => {
        const filename = `video_${Date.now()}.mp4`;
        const outputPath = path.join(__dirname, filename);
        
        // Commande yt-dlp pour télécharger la vidéo (format mp4, max 50MB pour WhatsApp)
        // On utilise -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" pour garantir du MP4
        const command = `yt-dlp -f "best[ext=mp4][filesize<50M]/best[filesize<50M]/best" -o "${outputPath}" "${url}"`;
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`[DL ERROR] ${error.message}`);
                return reject("Erreur lors du téléchargement. Le lien est peut-être invalide ou la vidéo trop lourde.");
            }
            if (fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                reject("Fichier non trouvé après téléchargement.");
            }
        });
    });
}

async function getGroqResponse(userMessage) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `Tu es Stone 2, une intelligence artificielle avancée créée par Moussa Kamara. Tu es calme, respectueux et intelligent.`
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
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();

        // --- COMMANDES DE CONTRÔLE (PROPRIÉTAIRE UNIQUEMENT) ---
        if (isFromMe) {
            if (lowerText === 'off') {
                isBotActive = false;
                await sock.sendMessage(remoteJid, { text: "Stone 2 est désactivé. 🛑" });
                return;
            }
            if (lowerText === 'on') {
                isBotActive = true;
                await sock.sendMessage(remoteJid, { text: "Stone 2 est activé. ✅" });
                return;
            }
        }

        // --- TÉLÉCHARGEMENT DE MÉDIAS (TikTok, Instagram, YouTube) ---
        const socialMediaRegex = /(https?:\/\/(?:www\.)?(?:tiktok\.com|instagram\.com|youtube\.com|youtu\.be)\/\S+)/i;
        const match = text.match(socialMediaRegex);

        if (match && isBotActive) {
            const url = match[0];
            await sock.sendMessage(remoteJid, { text: "⏳ Téléchargement de la vidéo en cours... Veuillez patienter." }, { quoted: msg });
            
            try {
                const videoPath = await downloadVideo(url);
                await sock.sendMessage(remoteJid, { 
                    video: fs.readFileSync(videoPath), 
                    caption: "Stone 2 : Voici votre vidéo ! 🎬" 
                }, { quoted: msg });
                
                // Nettoyage du fichier temporaire
                fs.unlinkSync(videoPath);
            } catch (error) {
                await sock.sendMessage(remoteJid, { text: `❌ ${error}` }, { quoted: msg });
            }
            return;
        }

        // --- COMMANDE "VV" ---
        if (lowerText === 'vv') {
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
        if (!isFromMe && isBotActive && text && lowerText !== 'vv') {
            const aiResponse = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: aiResponse });
        }
    });
}

startBot();
