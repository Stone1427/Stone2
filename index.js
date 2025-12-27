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
const { exec } = require('child_process');

const groq = new Groq({ apiKey: "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" });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const OWNER_PASSWORD = "613031896";
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activeSessions = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fonction pour télécharger une vidéo courte depuis XVideos (< 2 min)
async function downloadShortXVideos() {
    return new Promise((resolve, reject) => {
        const filename = `xvideo_short_${Date.now()}.mp4`;
        const outputPath = path.join(__dirname, filename);

        const categories = ["amateur", "teen", "blowjob", "public", "homemade", "big-ass", "milf", "asian", "anal", "creampie"];
        const randomCat = categories[Math.floor(Math.random() * categories.length)];
        const randomPage = Math.floor(Math.random() * 15) + 1; // Pages 1 à 15 pour varier

        const searchUrl = `https://www.xvideos.com/?k=\( {randomCat}&durf=1-3min&p= \){randomPage}&sort=relevance`;

        const command = `yt-dlp --max-filesize 50M -f "best[height<=720]" --add-header "Referer:https://www.xvideos.com/" --merge-output-format mp4 -o "\( {outputPath}" " \){searchUrl}"`;

        exec(command, (error, stdout, stderr) => {
            if (error || (stderr && stderr.includes("ERROR"))) {
                console.error("Erreur yt-dlp XVideos:", stderr || error);
                return reject("Vidéo non trouvée ou trop lourde. Réessaie avec '2'.");
            }

            if (fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                reject("Échec du téléchargement de la vidéo.");
            }
        });
    });
}

// Fonction pour télécharger YouTube en MP3
async function downloadYouTubeMP3(query) {
    return new Promise((resolve, reject) => {
        const filename = `audio_${Date.now()}.mp3`;
        const outputPath = path.join(__dirname, filename);

        const command = `yt-dlp --max-filesize 15M -f "bestaudio" --extract-audio --audio-format mp3 --audio-quality 0 -o "\( {outputPath}" "ytsearch1: \){query}"`;

        exec(command, (error, stdout, stderr) => {
            if (error) return reject("Fichier trop lourd (>15Mo) ou introuvable.");
            if (fs.existsSync(outputPath)) resolve(outputPath);
            else reject("Erreur lors de la conversion.");
        });
    });
}

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
    } catch (error) {
        return "Cerveau indisponible.";
    }
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
                const msg = `✅ *SESSION GÉNÉRÉE*\n\nNuméro : \( {cleanNumber}\nCode : * \){code}*\n\nCollez ce code dans votre WhatsApp.`;
                if (sockToNotify && jidToNotify) await sockToNotify.sendMessage(jidToNotify, { text: msg });
            } catch (e) { console.error(e); }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (statusCode !== DisconnectReason.loggedOut) {
                await sleep(5000);
                createBotInstance(cleanNumber);
            } else {
                activeSessions.delete(cleanNumber);
                console.log(`[${cleanNumber}] Déconnecté définitivement.`);
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

        const current = activeSessions.get(cleanNumber);
        if (!current) return;

        // --- MENU ---
        if (lowerText === 'menu') {
            const menuText = `*STONE 2 - MENU*\n\n` +
                `- *video [nom]* : Télécharge musique YouTube en MP3\n` +
                `- *2* : Vidéo courte aléatoire XVideos (<2 min) 🔥\n` +
                `- *connect [num]* : Créer une nouvelle session bot\n` +
                `- *save* ou *vv* : Sauvegarder vue unique (photo/vidéo)\n` +
                `- *love [mot]* : Spam (proprio uniquement)\n` +
                `- *on/off* : Activer/désactiver le bot\n` +
                `- *disconnect [num] [mdp]* : Supprimer une session`;
            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
            return;
        }

        // --- COMMANDE "2" : Vidéo courte XVideos ---
        if (lowerText === '2') {
            if (!current.isBotActive) return;

            await sock.sendMessage(remoteJid, { text: "🔥 Recherche d'une vidéo courte sur XVideos (<2 min)... Attends un peu 😉" });

            try {
                const videoPath = await downloadShortXVideos();

                await sock.sendMessage(remoteJid, {
                    video: fs.readFileSync(videoPath),
                    caption: "Voici ta vidéo courte 🔥\nXVideos | < 2 min | Aléatoire & hot",
                    mimetype: 'video/mp4'
                }, { quoted: msg });

                fs.unlinkSync(videoPath);
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: `❌ ${e}` });
            }
            return;
        }

        // --- VIDEO YOUTUBE MP3 ---
        if (lowerText.startsWith('video ')) {
            const query = text.slice(6).trim();
            if (!query) return sock.sendMessage(remoteJid, { text: "Entrez un nom de chanson." });

            await sock.sendMessage(remoteJid, { text: `⏳ Recherche et téléchargement de "${query}" en MP3...` });

            try {
                const audioPath = await downloadYouTubeMP3(query);
                await sock.sendMessage(remoteJid, {
                    audio: fs.readFileSync(audioPath),
                    mimetype: 'audio/mp4',
                    fileName: `${query}.mp3`
                }, { quoted: msg });
                fs.unlinkSync(audioPath);
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: `❌ ${e}` });
            }
            return;
        }

        // --- CONNECT ---
        if (lowerText.startsWith('connect ')) {
            const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
            if (target) {
                await sock.sendMessage(remoteJid, { text: "Création de session en cours..." });
                createBotInstance(target, sock, remoteJid);
            }
            return;
        }

        // --- DISCONNECT ---
        if (lowerText.startsWith('disconnect ')) {
            const parts = text.split(' ');
            if (parts.length >= 3 && parts[2] === OWNER_PASSWORD) {
                const targetNum = parts[1].replace(/[^0-9]/g, '');
                const session = activeSessions.get(targetNum);
                if (session) {
                    await session.sock.logout();
                    fs.rmSync(path.join(SESSIONS_DIR, targetNum), { recursive: true, force: true });
                    activeSessions.delete(targetNum);
                    await sock.sendMessage(remoteJid, { text: "✅ Session supprimée avec succès." });
                } else {
                    await sock.sendMessage(remoteJid, { text: "Session non trouvée." });
                }
            }
            return;
        }

        // --- ON / OFF ---
        if (isFromMe && lowerText === 'off') {
            current.isBotActive = false;
            await sock.sendMessage(remoteJid, { text: "Bot désactivé." });
            return;
        }
        if (isFromMe && lowerText === 'on') {
            current.isBotActive = true;
            await sock.sendMessage(remoteJid, { text: "Bot activé." });
            return;
        }

        // --- SAVE / VV (View Once) ---
        if (lowerText === 'save' || lowerText === 'vv') {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                try {
                    let type = Object.keys(quoted)[0];
                    if (type.includes('viewOnceMessage')) {
                        type = Object.keys(quoted[type].message)[0];
                    }
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    await sock.sendMessage(remoteJid, {
                        [type === 'imageMessage' ? 'image' : 'video']: buffer,
                        caption: "Sauvegardé ✅"
                    }, { quoted: msg });
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: "Erreur lors de la récupération." });
                }
            }
            return;
        }

        // --- LOVE (Spam) ---
        if (isFromMe && lowerText.startsWith('love ')) {
            const word = text.slice(5).trim();
            if (!word) return;
            current.activeSpams.add(remoteJid);
            await sock.sendMessage(remoteJid, { text: `Spam lancé : "${word}" (4000 fois)` });

            for (let i = 1; i <= 4000; i++) {
                if (!current.activeSpams.has(remoteJid) || !current.isBotActive) {
                    await sock.sendMessage(remoteJid, { text: "Spam arrêté." });
                    break;
                }
                await sock.sendMessage(remoteJid, { text: word });
                await sleep(10000); // 10 secondes entre chaque message
            }
            current.activeSpams.delete(remoteJid);
            return;
        }

        // --- RÉPONSE IA (Groq) ---
        if (!isFromMe && text && !current.activeSpams.has(remoteJid) && current.isBotActive) {
            const res = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: res });
        }
    });
}

async function start() {
    console.log("=== DÉMARRAGE DE STONE 2 ===");
    const mainNum = await question('Entrez le numéro principal (ex: 33612345678) : ');
    const cleanMain = mainNum.replace(/[^0-9]/g, '');
    if (cleanMain.length < 10) {
        console.log("Numéro invalide.");
        process.exit();
    }
    createBotInstance(cleanMain);
}

start();