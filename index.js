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
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');

const groq = new Groq({ apiKey: "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" });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const OWNER_PASSWORD = "613031896";
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const activeSessions = new Map();
const hostingStates = new Map(); // Pour suivre les utilisateurs en cours d'hébergement
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function downloadYouTubeMP3(query) {
    return new Promise((resolve, reject) => {
        const filename = `audio_${Date.now()}.mp3`;
        const outputPath = path.join(__dirname, filename);
        const command = `yt-dlp --max-filesize 15M -f "bestaudio" --extract-audio --audio-format mp3 -o "${outputPath}" "ytsearch1:${query}"`;
        exec(command, (error) => {
            if (error) return reject("Trop lourd ou introuvable.");
            if (fs.existsSync(outputPath)) resolve(outputPath);
            else reject("Erreur conversion.");
        });
    });
}

async function createSticker(buffer, type) {
    const inputPath = path.join(TEMP_DIR, `input_${Date.now()}`);
    const outputPath = path.join(TEMP_DIR, `output_${Date.now()}.webp`);
    fs.writeFileSync(inputPath, buffer);

    return new Promise((resolve, reject) => {
        let ff = ffmpeg(inputPath);
        if (type === 'video') {
            ff = ff.addOptions([
                "-vcodec", "libwebp",
                "-vf", "scale='iw*min(512/iw,512/ih)':'ih*min(512/iw,512/ih)',format=rgba,pad=512:512:(512-iw)/2:(512-ih)/2:color=#00000000",
                "-lossless", "1",
                "-loop", "0",
                "-preset", "default",
                "-an",
                "-vsync", "0",
                "-s", "512:512"
            ]);
        } else {
            ff = ff.addOptions([
                "-vcodec", "libwebp",
                "-vf", "scale='iw*min(512/iw,512/ih)':'ih*min(512/iw,512/ih)',format=rgba,pad=512:512:(512-iw)/2:(512-ih)/2:color=#00000000"
            ]);
        }

        ff.save(outputPath)
            .on('end', () => {
                const result = fs.readFileSync(outputPath);
                fs.unlinkSync(inputPath);
                fs.unlinkSync(outputPath);
                resolve(result);
            })
            .on('error', (err) => {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                reject(err);
            });
    });
}

async function uploadToCatbox(buffer, filename) {
    const tempPath = path.join(TEMP_DIR, `upload_${Date.now()}_${filename}`);
    fs.writeFileSync(tempPath, buffer);
    try {
        const { execSync } = require('child_process');
        const cmd = `curl -F "reqtype=fileupload" -F "fileToUpload=@${tempPath}" https://catbox.moe/user/api.php`;
        const link = execSync(cmd).toString().trim();
        return link;
    } catch (e) {
        console.error("Catbox upload error:", e);
        return null;
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
}

async function sendMenuAudio(sock, remoteJid, quoted) {
    const audioUrl = 'https://files.catbox.moe/azu9je.mp3';
    const tempInput = path.join(TEMP_DIR, `menu_in_${Date.now()}.mp3`);
    const tempOutput = path.join(TEMP_DIR, `menu_out_${Date.now()}.opus`);

    try {
        const response = await axios({ url: audioUrl, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempInput);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        await new Promise((resolve, reject) => {
            ffmpeg(tempInput)
                .audioCodec('libopus')
                .toFormat('ogg')
                .addOptions([
                    '-ac', '1',
                    '-ar', '48000',
                    '-b:a', '128k',
                    '-map_metadata', '-1'
                ])
                .on('end', resolve)
                .on('error', reject)
                .save(tempOutput);
        });

        await sock.sendMessage(remoteJid, { 
            audio: fs.readFileSync(tempOutput), 
            mimetype: 'audio/ogg; codecs=opus', 
            ptt: true 
        }, { quoted });

    } catch (e) {
        console.error("Erreur audio menu:", e);
    } finally {
        if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
        if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    }
}

async function getGroqResponse(userMessage) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [{ role: "system", content: "Tu es Stone 2, créé par Moussa Kamara." }, { role: "user", content: userMessage }],
            model: "llama-3.1-8b-instant",
        });
        return completion.choices[0]?.message?.content || "Désolé, je bug.";
    } catch (e) { return "IA indisponible."; }
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

    activeSessions.set(cleanNumber, { sock, isBotActive: false, activeSpams: new Set() });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                const msg = `✅ *SESSION GÉNÉRÉE*\n\nNuméro : ${cleanNumber}\nCode : *${code}*`;
                if (sockToNotify && jidToNotify) await sockToNotify.sendMessage(jidToNotify, { text: msg });
            } catch (e) {}
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if ((lastDisconnect?.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut) {
                await sleep(5000);
                createBotInstance(cleanNumber);
            }
        } else if (connection === 'open') { console.log(`[${cleanNumber}] ✅ CONNECTÉ (Statut: OFF)`); }
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

        // --- COMMANDES DE CONTRÔLE ---
        if (isFromMe) {
            if (lowerText === 'on') { current.isBotActive = true; await sock.sendMessage(remoteJid, { text: "Stone 2 activé. ✅" }); return; }
            if (lowerText === 'off') { current.isBotActive = false; await sock.sendMessage(remoteJid, { text: "Stone 2 désactivé. 🛑" }); return; }
        }

        if (lowerText === 'menu') {
            const menu = `*STONE 2 - MENU*\n\n- *on* / *off* : Contrôle IA\n- *video [nom]* : YouTube MP3\n- *connect [num] [mdp]* : Créer bot\n- *save* / *vv* : Sauver média\n- *s* / *sticker* : Créer sticker\n- *host* : Héberger un média\n- *rappel [temps] [texte]* : Rappel (ex: 10m)\n- *love [mot]* : Spam\n- *disconnect [num] [mdp]*\n\n*Statut :* ${current.isBotActive ? 'ACTIF ✅' : 'INACTIF 🛑'}`;
            await sock.sendMessage(remoteJid, { 
                image: { url: 'https://files.catbox.moe/6uhomx.png' }, 
                caption: menu 
            }, { quoted: msg });
            await sendMenuAudio(sock, remoteJid, msg);
            return;
        }

        if (lowerText === 'host') {
            hostingStates.set(remoteJid, true);
            await sock.sendMessage(remoteJid, { text: "📤 *MODE HÉBERGEMENT ACTIVÉ*\n\nVeuillez envoyer votre média (image, vidéo ou audio) maintenant." }, { quoted: msg });
            return;
        }

        // --- COMMANDE CONNECT SÉCURISÉE ---
        if (lowerText.startsWith('connect ')) {
            const parts = text.split(' ');
            const target = parts[1]?.replace(/[^0-9]/g, '');
            const pass = parts[2];

            if (pass !== OWNER_PASSWORD) {
                return sock.sendMessage(remoteJid, { text: "❌ Mot de passe incorrect pour la connexion." });
            }
            if (target) {
                await sock.sendMessage(remoteJid, { text: `🔄 Création sécurisée pour ${target}...` });
                createBotInstance(target, sock, remoteJid);
            }
            return;
        }

        // --- COMMANDE DISCONNECT SÉCURISÉE ---
        if (lowerText.startsWith('disconnect ')) {
            const parts = text.split(' ');
            if (parts[2] === OWNER_PASSWORD) {
                const targetNum = parts[1].replace(/[^0-9]/g, '');
                const session = activeSessions.get(targetNum);
                if (session) {
                    await session.sock.logout();
                    fs.rmSync(path.join(SESSIONS_DIR, targetNum), { recursive: true, force: true });
                    activeSessions.delete(targetNum);
                    await sock.sendMessage(remoteJid, { text: "✅ Session supprimée." });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ Mot de passe incorrect." });
            }
            return;
        }

        // --- GESTION DE L'HÉBERGEMENT (Prioritaire) ---
        if (hostingStates.has(remoteJid)) {
            const quoted = msg.message;
            const type = quoted.imageMessage ? 'image' : (quoted.videoMessage ? 'video' : (quoted.audioMessage ? 'audio' : null));
            
            if (type) {
                hostingStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: "⏳ Téléchargement et hébergement sur Catbox en cours..." });
                try {
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const ext = type === 'image' ? 'png' : (type === 'video' ? 'mp4' : 'mp3');
                    const link = await uploadToCatbox(buffer, `file.${ext}`);
                    if (link) {
                        await sock.sendMessage(remoteJid, { text: `✅ *HÉBERGEMENT RÉUSSI*\n\nLien : ${link}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "❌ Erreur lors de l'hébergement sur Catbox." });
                    }
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: "❌ Erreur lors du traitement du média." });
                }
                return;
            }
        }

        if (!current.isBotActive) return;

        // --- LOGIQUE DES OUTILS (Seulement si ON) ---
        if (lowerText.startsWith('rappel ')) {
            const input = text.slice(7).trim();
            const match = input.match(/^(\d+)([smhj])\s+(.+)$/i);
            
            if (match) {
                const amount = parseInt(match[1]);
                const unit = match[2].toLowerCase();
                const task = match[3];
                
                let duration = amount;
                if (unit === 's') duration *= 1000;
                else if (unit === 'm') duration *= 60 * 1000;
                else if (unit === 'h') duration *= 60 * 60 * 1000;
                else if (unit === 'j') duration *= 24 * 60 * 60 * 1000;

                await sock.sendMessage(remoteJid, { text: `✅ Rappel programmé dans *${amount}${unit}* pour : _${task}_` }, { quoted: msg });

                setTimeout(async () => {
                    await sock.sendMessage(remoteJid, { 
                        text: `⏰ *RAPPEL* ⏰\n\nBonjour ! C'est l'heure de : *${task}*` 
                    });
                }, duration);
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ Format incorrect. Exemple : *rappel 10m Faire les courses*" }, { quoted: msg });
            }
            return;
        }


        if (lowerText.startsWith('video ')) {
            const query = text.slice(6).trim();
            if (query) {
                await sock.sendMessage(remoteJid, { text: "⏳ Téléchargement..." });
                try {
                    const audioPath = await downloadYouTubeMP3(query);
                    await sock.sendMessage(remoteJid, { audio: fs.readFileSync(audioPath), mimetype: 'audio/mp4', fileName: `${query}.mp3` }, { quoted: msg });
                    fs.unlinkSync(audioPath);
                } catch (e) { await sock.sendMessage(remoteJid, { text: `❌ ${e}` }); }
            }
            return;
        }

        if (lowerText === 'save' || lowerText === 'vv') {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                try {
                    let type = Object.keys(quoted)[0];
                    if (type.includes('viewOnceMessage')) type = Object.keys(quoted[type].message)[0];
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    await sock.sendMessage(remoteJid, { [type === 'imageMessage' ? 'image' : 'video']: buffer, caption: "Fait ✅" }, { quoted: msg });
                } catch (e) {}
            }
            return;
        }

        if (lowerText === 's' || lowerText === 'sticker') {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || msg.message;
            const type = quoted.imageMessage ? 'image' : (quoted.videoMessage ? 'video' : null);
            
            if (type) {
                await sock.sendMessage(remoteJid, { text: "⏳ Création du sticker..." });
                try {
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const sticker = await createSticker(buffer, type);
                    await sock.sendMessage(remoteJid, { sticker: sticker }, { quoted: msg });
                } catch (e) {
                    console.error(e);
                    await sock.sendMessage(remoteJid, { text: "❌ Erreur lors de la création du sticker." });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ Veuillez répondre à une image ou une vidéo avec la commande *!s*." });
            }
            return;
        }

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

        if (!isFromMe && text && !['menu', 'save', 'vv', 's', 'sticker'].includes(lowerText) && !lowerText.startsWith('connect ') && !lowerText.startsWith('video ')) {
            const res = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: res });
        }
    });
}

async function start() {
    console.log("--- DÉMARRAGE STONE 2 (CONNECT SÉCURISÉ) ---");
    const mainNum = await question('Numéro principal : ');
    createBotInstance(mainNum.replace(/[^0-9]/g, ''));
}

start();
