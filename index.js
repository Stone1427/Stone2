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

// Fonction pour télécharger YouTube en MP3
async function downloadYouTubeMP3(query) {
    return new Promise((resolve, reject) => {
        const filename = `audio_${Date.now()}.mp3`;
        const outputPath = path.join(__dirname, filename);
        
        // Recherche la première vidéo et télécharge l'audio en MP3 (max 15MB)
        const command = `yt-dlp --max-filesize 15M -f "bestaudio" --extract-audio --audio-format mp3 --audio-quality 0 -o "${outputPath}" "ytsearch1:${query}"`;
        
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
            } catch (e) {}
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
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerText = text.toLowerCase();

        const current = activeSessions.get(cleanNumber);
        if (!current) return;

        // --- COMMANDE MENU ---
        if (lowerText === 'menu') {
            const menuText = `*STONE 2 - MENU*\n\n- *video [nom]* : Musique MP3 YouTube\n- *connect [num]* : Créer bot\n- *save* : Sauver statut\n- *vv* : Voir message unique\n- *love [mot]* : Spam\n- *on/off* : Contrôle\n- *disconnect [num] [mdp]*`;
            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
            return;
        }

        // --- COMMANDE VIDEO (YOUTUBE MP3) ---
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
                fs.unlinkSync(audioPath); // Supprimer après envoi
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: `❌ ${e}` });
            }
            return;
        }

        // --- AUTRES COMMANDES (CONNECT, DISCONNECT, ON/OFF, SAVE, VV, LOVE) ---
        if (lowerText.startsWith('connect ')) {
            const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
            if (target) createBotInstance(target, sock, remoteJid);
            return;
        }

        if (lowerText.startsWith('disconnect ')) {
            const parts = text.split(' ');
            if (parts[2] === OWNER_PASSWORD) {
                const targetNum = parts[1].replace(/[^0-9]/g, '');
                const session = activeSessions.get(targetNum);
                if (session) {
                    await session.sock.logout();
                    fs.rmSync(path.join(SESSIONS_DIR, targetNum), { recursive: true, force: true });
                    await sock.sendMessage(remoteJid, { text: "✅ Supprimé." });
                }
            }
            return;
        }

        if (isFromMe && lowerText === 'off') { current.isBotActive = false; await sock.sendMessage(remoteJid, { text: "Off." }); return; }
        if (isFromMe && lowerText === 'on') { current.isBotActive = true; await sock.sendMessage(remoteJid, { text: "On." }); return; }

        if (!current.isBotActive) return;

        if (lowerText === 'save' || lowerText === 'vv') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                try {
                    let type = Object.keys(quoted)[0];
                    if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') type = Object.keys(quoted[type].message)[0];
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    await sock.sendMessage(remoteJid, { [type === 'imageMessage' ? 'image' : 'video']: buffer, caption: "Fait ✅" }, { quoted: msg });
                } catch (e) {}
            }
            return;
        }

        if (isFromMe && lowerText.startsWith('love ')) {
            const word = text.slice(5).trim();
            current.activeSpams.add(remoteJid);
            for (let i = 1; i <= 4000; i++) {
                if (!current.activeSpams.has(remoteJid) || !current.isBotActive) break;
                await sock.sendMessage(remoteJid, { text: word });
                await sleep(10000);
            }
            current.activeSpams.delete(remoteJid);
            return;
        }

        if (!isFromMe && text && !['menu', 'save', 'vv'].includes(lowerText) && !lowerText.startsWith('connect ') && !lowerText.startsWith('video ')) {
            const res = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: res });
        }
    });
}

async function start() {
    console.log("--- DÉMARRAGE STONE 2 + YOUTUBE ---");
    const mainNum = await question('Numéro principal : ');
    createBotInstance(mainNum.replace(/[^0-9]/g, ''));
}

start();
