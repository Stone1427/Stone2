require('dotenv').config();
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
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');
const Jimp = require('jimp');
const FormData = require('form-data');

// --- CONFIGURATION ---
const GROQ_API_KEY = process.env.GROQ_API_KEY || "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";
const ADMIN_NUMBERS = ['224613031896', '16062620863'];

const groq = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const activeSessions = new Map();
const hostingStates = new Map();
const messageCache = new Map(); // Pour l'Anti-Delete

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- FONCTIONS UTILITAIRES ---

async function uploadToCatbox(buffer, filename) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', buffer, filename);
        const res = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders()
        });
        return res.data;
    } catch (e) { return null; }
}

async function convertToOpus(inputPath) {
    return new Promise((resolve, reject) => {
        const outputPath = inputPath.replace(/\.[^.]+$/, '.ogg');
        const command = `ffmpeg -i "${inputPath}" -c:a libopus -ac 1 -ar 48000 -map_metadata -1 "${outputPath}" -y`;
        exec(command, (error) => {
            if (error) reject(error);
            else resolve(outputPath);
        });
    });
}

async function downloadYouTubeMP3(query) {
    return new Promise((resolve, reject) => {
        const filename = `audio_${Date.now()}.mp3`;
        const outputPath = path.join(TEMP_DIR, filename);
        const command = `yt-dlp --max-filesize 15M -f "bestaudio" --extract-audio --audio-format mp3 -o "${outputPath}" "ytsearch1:${query}"`;
        exec(command, (error) => {
            if (error) return reject("Erreur.");
            if (fs.existsSync(outputPath)) resolve(outputPath);
            else reject("Échec.");
        });
    });
}

async function getGroqResponse(userMessage) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Tu es Stone 2, un bot WhatsApp puissant créé par Moussa Kamara. Sois bref, utile et professionnel." },
                { role: "user", content: userMessage }
            ],
            model: "llama-3.1-8b-instant",
        });
        return completion.choices[0]?.message?.content || "Désolé, je n'ai pas pu traiter votre demande.";
    } catch (e) { return "⚠️ IA actuellement indisponible."; }
}

function logMessage(sessionNum, msg, type, content) {
    const time = new Date().toLocaleTimeString();
    const sender = msg.key.remoteJid.split('@')[0];
    const pushName = msg.pushName || "Inconnu";
    
    console.log(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║ 🕒 HEURE   : ${time}`);
    console.log(`║ 📱 BOT     : [${sessionNum}]`);
    console.log(`║ 👤 DE      : ${pushName} (${sender})`);
    console.log(`║ 📂 TYPE    : ${type.toUpperCase()}`);
    console.log(`╟──────────────────────────────────────────────────────────────────────────────╢`);
    const lines = content.match(/.{1,74}/g) || [content];
    lines.forEach(line => console.log(`║ 💬 MSG     : ${line.padEnd(74)} ║`));
    console.log(`╚══════════════════════════════════════════════════════════════════════════════╝`);
}

// --- LOGIQUE DU BOT ---

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
                if (sockToNotify && jidToNotify) await sockToNotify.sendMessage(jidToNotify, { text: `✅ *CODE DE CONNEXION : ${code}*` });
            } catch (e) {}
        }, 2000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if ((lastDisconnect?.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut) {
                await sleep(3000);
                createBotInstance(cleanNumber);
            }
        } else if (connection === 'open') { console.log(`[${cleanNumber}] ✅ SESSION OUVERTE`); }
    });

    // Gestion de l'Anti-Delete
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.message === null) {
                const key = update.key;
                const cached = messageCache.get(key.id);
                if (cached) {
                    console.log(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
                    console.log(`║ ⚠️  ALERTE : MESSAGE SUPPRIMÉ PAR L'UTILISATEUR                             ║`);
                    console.log(`║ 🕒 HEURE   : ${new Date().toLocaleTimeString()}`);
                    console.log(`║ 👤 DE      : ${cached.pushName} (${key.remoteJid.split('@')[0]})`);
                    console.log(`╟──────────────────────────────────────────────────────────────────────────────╢`);
                    const lines = cached.text.match(/.{1,74}/g) || [cached.text];
                    lines.forEach(line => console.log(`║ 🗑️  ANCIEN  : ${line.padEnd(74)} ║`));
                    console.log(`╚══════════════════════════════════════════════════════════════════════════════╝`);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();
        const senderNumber = remoteJid.split('@')[0].replace(/[^0-9]/g, '');
        const isAdmin = ADMIN_NUMBERS.includes(senderNumber);

        const current = activeSessions.get(cleanNumber);
        if (!current) return;

        // Mise en cache pour Anti-Delete
        if (text) {
            messageCache.set(msg.key.id, { text, pushName: msg.pushName || "Inconnu" });
            if (messageCache.size > 1000) messageCache.delete(messageCache.keys().next().value);
        }

        // Logging stylisé
        let msgType = Object.keys(msg.message)[0];
        logMessage(cleanNumber, msg, msgType, text || "[Média]");

        // --- COMMANDES ---

        if (isFromMe) {
            if (lowerText === 'on') { current.isBotActive = true; return sock.sendMessage(remoteJid, { text: "✅ Stone 2 activé." }); }
            if (lowerText === 'off') { current.isBotActive = false; return sock.sendMessage(remoteJid, { text: "🛑 Stone 2 désactivé." }); }
        }

        if (lowerText === 'menu') {
            const menu = `*STONE 2 - MENU*\n\n- *on* / *off* : Contrôle IA\n- *video [nom]* : YouTube MP3\n- *connect [num]* : Créer bot (Admins)\n- *save* / *vv* : Sauver média\n- *s* / *sticker* : Créer sticker\n- *host* : Héberger un média\n- *rappel [temps] [texte]* : Rappel\n- *love [mot] [délai]* : Spam\n- *alt-delete* : Supprimer mes messages\n- *alt-kick* : Vider le groupe\n- *disconnect [num]* (Admins)\n\n*Statut :* ${current.isBotActive ? 'ACTIF ✅' : 'INACTIF 🛑'}`;
            await sock.sendMessage(remoteJid, { image: { url: 'https://files.catbox.moe/6uhomx.png' }, caption: menu }, { quoted: msg });
            
            // Audio du menu
            try {
                const audioUrl = 'https://files.catbox.moe/azu9je.mp3';
                const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
                const tempPath = path.join(TEMP_DIR, `menu_${Date.now()}.mp3`);
                fs.writeFileSync(tempPath, response.data);
                const opusPath = await convertToOpus(tempPath);
                await sock.sendMessage(remoteJid, { audio: fs.readFileSync(opusPath), mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
                fs.unlinkSync(tempPath); fs.unlinkSync(opusPath);
            } catch (e) {}
            return;
        }

        // Gestion des sessions (Admins uniquement)
        if (lowerText.startsWith('connect ')) {
            if (!isAdmin) return sock.sendMessage(remoteJid, { text: "❌ Réservé aux admins." });
            const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
            if (target) {
                await sock.sendMessage(remoteJid, { text: `⏳ Initialisation pour ${target}...` });
                createBotInstance(target, sock, remoteJid);
            }
            return;
        }

        if (lowerText.startsWith('disconnect ')) {
            if (!isAdmin) return sock.sendMessage(remoteJid, { text: "❌ Réservé aux admins." });
            const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
            if (activeSessions.has(target)) {
                const session = activeSessions.get(target);
                await session.sock.logout();
                activeSessions.delete(target);
                await sock.sendMessage(remoteJid, { text: `✅ Session ${target} déconnectée.` });
            }
            return;
        }

        if (lowerText === 'host') {
            hostingStates.set(remoteJid, true);
            await sock.sendMessage(remoteJid, { text: "📤 *MODE HÉBERGEMENT*\nEnvoyez votre média maintenant." }, { quoted: msg });
            return;
        }

        if (hostingStates.has(remoteJid)) {
            const mType = msg.message.imageMessage ? 'image' : (msg.message.videoMessage ? 'video' : (msg.message.audioMessage ? 'audio' : null));
            if (mType) {
                hostingStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: "⏳ Hébergement..." });
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const ext = mType === 'image' ? 'png' : (mType === 'video' ? 'mp4' : 'mp3');
                    const link = await uploadToCatbox(buffer, `file.${ext}`);
                    await sock.sendMessage(remoteJid, { text: link ? `✅ *LIEN :* ${link}` : "❌ Erreur." }, { quoted: msg });
                } catch (e) { await sock.sendMessage(remoteJid, { text: "❌ Échec." }); }
                return;
            }
        }

        if (!current.isBotActive) return;

        // --- OUTILS ---

        if (lowerText.startsWith('video ')) {
            const query = text.slice(6).trim();
            if (query) {
                await sock.sendMessage(remoteJid, { text: "⏳ Recherche et téléchargement..." });
                downloadYouTubeMP3(query).then(p => {
                    sock.sendMessage(remoteJid, { audio: fs.readFileSync(p), mimetype: 'audio/mp4' }, { quoted: msg });
                    fs.unlinkSync(p);
                }).catch(() => sock.sendMessage(remoteJid, { text: "❌ Erreur." }));
            }
            return;
        }

        if (lowerText === 's' || lowerText === 'sticker') {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const target = quoted ? { message: quoted } : msg;
            const isVideo = target.message.videoMessage;
            const isImage = target.message.imageMessage;

            if (isImage || isVideo) {
                await sock.sendMessage(remoteJid, { text: "⏳ Création du sticker..." });
                try {
                    const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const inputPath = path.join(TEMP_DIR, `stk_${Date.now()}.${isVideo ? 'mp4' : 'png'}`);
                    const outputPath = path.join(TEMP_DIR, `stk_${Date.now()}.webp`);
                    fs.writeFileSync(inputPath, buffer);

                    const cmd = isVideo 
                        ? `ffmpeg -i "${inputPath}" -vcodec libwebp -filter:v "fps=fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -loop 0 -preset default -an -vsync 0 -s 512:512 "${outputPath}"`
                        : `ffmpeg -i "${inputPath}" -vcodec libwebp -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" "${outputPath}"`;

                    exec(cmd, async (err) => {
                        if (!err) await sock.sendMessage(remoteJid, { sticker: fs.readFileSync(outputPath) }, { quoted: msg });
                        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    });
                } catch (e) {}
            }
            return;
        }

        if (lowerText === 'alt-delete') {
            await sock.sendMessage(remoteJid, { text: "🧹 *NETTOYAGE PROFOND EN COURS...*" });
            try {
                const history = await sock.fetchMessagesFromWA(remoteJid, 50);
                const toDelete = history.filter(m => m.key.fromMe);
                for (const m of toDelete) {
                    await sock.sendMessage(remoteJid, { delete: m.key });
                }
            } catch (e) {}
            return;
        }

        if (lowerText === 'alt-kick') {
            if (!remoteJid.endsWith('@g.us')) return;
            try {
                const group = await sock.groupMetadata(remoteJid);
                const participants = group.participants.map(p => p.id);
                const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                for (const p of participants) {
                    if (p !== botId && !ADMIN_NUMBERS.some(a => p.includes(a))) {
                        await sock.groupParticipantsUpdate(remoteJid, [p], "remove");
                    }
                }
            } catch (e) {}
            return;
        }

        if (lowerText.startsWith('rappel ')) {
            const input = text.slice(7).trim();
            const match = input.match(/^(\d+)([smhj])\s+(.+)$/i);
            if (match) {
                const amount = parseInt(match[1]);
                const unit = match[2].toLowerCase();
                const task = match[3];
                let duration = amount * (unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000);
                await sock.sendMessage(remoteJid, { text: `✅ Rappel programmé dans ${amount}${unit}.` }, { quoted: msg });
                setTimeout(() => sock.sendMessage(remoteJid, { text: `⏰ *RAPPEL :* ${task}` }), duration);
            }
            return;
        }

        if (isFromMe && lowerText.startsWith('love ')) {
            const fullArgs = text.slice(5).trim().split(' ');
            let word, delay;
            const lastArg = fullArgs[fullArgs.length - 1];
            if (/^\d+$/.test(lastArg) && fullArgs.length > 1) {
                delay = parseInt(lastArg) * 1000;
                word = fullArgs.slice(0, -1).join(' ');
            } else {
                delay = 0;
                word = fullArgs.join(' ');
            }
            if (word) {
                current.activeSpams.add(remoteJid);
                await sock.sendMessage(remoteJid, { text: `🚀 *SPAM ACTIVÉ*\nDélai: ${delay/1000}s` });
                for (let i = 1; i <= 4000; i++) {
                    if (!current.activeSpams.has(remoteJid) || !current.isBotActive) break;
                    await sock.sendMessage(remoteJid, { text: word });
                    if (delay > 0) await sleep(delay);
                }
                current.activeSpams.delete(remoteJid);
            }
            return;
        }

        if (lowerText === 'save' || lowerText === 'vv') {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                try {
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    let type = Object.keys(quoted)[0];
                    if (type.includes('viewOnceMessage')) type = Object.keys(quoted[type].message)[0];
                    await sock.sendMessage(remoteJid, { [type === 'imageMessage' ? 'image' : 'video']: buffer, caption: "✅ Sauvegardé." }, { quoted: msg });
                } catch (e) {}
            }
            return;
        }

        // IA
        if (!isFromMe && text && !['menu', 'save', 'vv', 's', 'sticker', 'host'].includes(lowerText) && !lowerText.startsWith('connect ') && !lowerText.startsWith('video ')) {
            getGroqResponse(text).then(res => {
                sock.sendMessage(remoteJid, { text: res });
            }).catch(() => {});
        }
    });
}

async function start() {
    console.log("\n--- STONE 2 : RESTAURATION COMPLÈTE ---");
    const mainNum = await question('Numéro principal (ex: 224613931896xx) : ');
    createBotInstance(mainNum.replace(/[^0-9]/g, ''));
}

start();
