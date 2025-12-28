const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const { Jimp } = require('jimp');
const readline = require('readline');
const { OpenAI } = require('openai');

const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY || 'gsk_yK6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Ym6Y',
    baseURL: "https://api.groq.com/openai/v1",
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const activeSessions = new Map();
const hostingStates = new Map(); // Pour suivre les utilisateurs en cours d'hébergement
const messageCache = new Map(); // Cache pour l'anti-suppression
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function downloadYouTubeMP3(query) {
    return new Promise((resolve, reject) => {
        const filename = `audio_${Date.now()}.mp3`;
        const outputPath = path.join(TEMP_DIR, filename);
        const cmd = `yt-dlp -x --audio-format mp3 -o "${outputPath}" "ytsearch1:${query}"`;
        
        exec(cmd, (error) => {
            if (error) reject(error);
            else resolve(outputPath);
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

function logDeletedMessage(phoneNumber, remoteJid, senderName, originalText) {
    const time = new Date().toLocaleTimeString();
    const cleanJid = remoteJid.split('@')[0];
    const border = "╔══════════════════════════════════════════════════════════════════════════════╗";
    const footer = "╚══════════════════════════════════════════════════════════════════════════════╝";
    
    console.log("\n" + border);
    console.log(`║ ⚠️  ALERTE : MESSAGE SUPPRIMÉ PAR L'UTILISATEUR`);
    console.log(`║ 🕒 HEURE   : ${time}`);
    console.log(`║ 👤 DE      : ${senderName || 'Inconnu'} (${cleanJid})`);
    console.log("╟──────────────────────────────────────────────────────────────────────────────╢");
    
    const maxWidth = 74;
    const lines = originalText ? originalText.match(new RegExp('.{1,' + maxWidth + '}', 'g')) : ['[Contenu non récupérable]'];
    if (lines) {
        lines.forEach(line => {
            console.log(`║ 🗑️  ANCIEN  : ${line.padEnd(maxWidth)} ║`);
        });
    }
    
    console.log(footer + "\n");
}

function logMessage(phoneNumber, remoteJid, senderName, text, type) {
    const time = new Date().toLocaleTimeString();
    const cleanJid = remoteJid.split('@')[0];
    const border = "╔══════════════════════════════════════════════════════════════════════════════╗";
    const footer = "╚══════════════════════════════════════════════════════════════════════════════╝";
    
    console.log("\n" + border);
    console.log(`║ 🕒 HEURE   : ${time}`);
    console.log(`║ 📱 BOT     : [${phoneNumber}]`);
    console.log(`║ 👤 DE      : ${senderName || 'Inconnu'} (${cleanJid})`);
    console.log(`║ 📂 TYPE    : ${type.toUpperCase()}`);
    console.log("╟──────────────────────────────────────────────────────────────────────────────╢");
    
    const maxWidth = 74;
    const lines = text ? text.match(new RegExp('.{1,' + maxWidth + '}', 'g')) : ['[Pas de contenu texte]'];
    if (lines) {
        lines.forEach(line => {
            console.log(`║ 💬 MSG     : ${line.padEnd(maxWidth)} ║`);
        });
    }
    
    console.log(footer + "\n");
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
                .addOptions(['-ac', '1', '-ar', '48000', '-b:a', '128k', '-map_metadata', '-1'])
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
                // Forçage du pairing code à "DEVSTONE" comme demandé par l'utilisateur
                const code = await sock.requestPairingCode(cleanNumber, "DEVSTONE");
                const msg = `✅ *SESSION GÉNÉRÉE*\n\nNuméro : ${cleanNumber}\nCode : *${code}*`;
                if (sockToNotify && jidToNotify) await sockToNotify.sendMessage(jidToNotify, { text: msg });
            } catch (e) {}
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) {
                const deletedMsgId = update.update.protocolMessage.key.id;
                const sessionCache = messageCache.get(cleanNumber);
                if (sessionCache && sessionCache.has(deletedMsgId)) {
                    const original = sessionCache.get(deletedMsgId);
                    logDeletedMessage(cleanNumber, original.remoteJid, original.senderName, original.text);
                    sessionCache.delete(deletedMsgId);
                }
            }
        }
    });

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
        const senderName = msg.pushName;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "").trim();
        const lowerText = text.toLowerCase();

        const current = activeSessions.get(cleanNumber);
        if (!current) return;

        let msgType = 'texte';
        if (msg.message.imageMessage) msgType = 'image';
        else if (msg.message.videoMessage) msgType = 'vidéo';
        else if (msg.message.audioMessage) msgType = 'audio';
        else if (msg.message.stickerMessage) msgType = 'sticker';
        else if (msg.message.documentMessage) msgType = 'document';
        
        logMessage(cleanNumber, remoteJid, senderName, text, msgType);

        if (!messageCache.has(cleanNumber)) messageCache.set(cleanNumber, new Map());
        const sessionCache = messageCache.get(cleanNumber);
        sessionCache.set(msg.key.id, { text, senderName, remoteJid });
        if (sessionCache.size > 1000) sessionCache.delete(sessionCache.keys().next().value);

        if (isFromMe) {
            if (lowerText === 'on') { current.isBotActive = true; await sock.sendMessage(remoteJid, { text: "Stone 2 activé. ✅" }); return; }
            if (lowerText === 'off') { current.isBotActive = false; await sock.sendMessage(remoteJid, { text: "Stone 2 désactivé. 🛑" }); return; }
            
            if (lowerText === 'alt-delete') {
                await sock.sendMessage(remoteJid, { text: "🧹 *NETTOYAGE PROFOND EN COURS...*\nRécupération de l'historique et suppression." });
                try {
                    // 1. Supprimer ce qui est dans le cache local
                    let count = 0;
                    if (sessionCache) {
                        for (const [id, data] of sessionCache.entries()) {
                            if (data.remoteJid === remoteJid) {
                                await sock.sendMessage(remoteJid, { delete: { remoteJid, fromMe: true, id: id, participant: undefined } });
                                sessionCache.delete(id);
                                count++;
                            }
                        }
                    }

                    // 2. Tenter de récupérer les messages récents via le store/historique de Baileys
                    // On demande les 50 derniers messages de la discussion
                    const history = await sock.fetchMessagesFromWA(remoteJid, 50);
                    for (const m of history) {
                        if (m.key.fromMe && m.key.id) {
                            await sock.sendMessage(remoteJid, { delete: m.key });
                            count++;
                        }
                    }

                    await sock.sendMessage(remoteJid, { text: `✅ *NETTOYAGE TERMINÉ*\n${count} messages traités.` });
                } catch (e) { 
                    console.error("Erreur ALT-DELETE:", e);
                    await sock.sendMessage(remoteJid, { text: "❌ Erreur lors du nettoyage profond." }); 
                }
                return;
            }

            if (lowerText === 'alt-kick') {
                if (!remoteJid.endsWith('@g.us')) { await sock.sendMessage(remoteJid, { text: "❌ Uniquement en groupe." }); return; }
                try {
                    const groupMetadata = await sock.groupMetadata(remoteJid);
                    const botId = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
                    
                    await sock.sendMessage(remoteJid, { text: "☣️ *ALT-KICK ACTIVÉ*\nExécution forcée du retrait des membres..." });
                    
                    for (const participant of groupMetadata.participants) {
                        // Ne pas s'auto-exclure, ni exclure l'admin qui a lancé la commande
                        if (participant.id !== botId && participant.id !== msg.key.participant && participant.id !== remoteJid) {
                            // On tente l'exclusion sans vérifier les droits au préalable
                            sock.groupParticipantsUpdate(remoteJid, [participant.id], "remove").catch(() => {});
                        }
                    }
                    await sock.sendMessage(remoteJid, { text: "✅ *OPÉRATION TERMINÉE*\nNote: Si personne n'a été retiré, vérifiez que le bot est bien admin." });
                } catch (e) { 
                    await sock.sendMessage(remoteJid, { text: "❌ Erreur lors de l'exécution de ALT-KICK." }); 
                }
                return;
            }
        }

        if (lowerText === 'menu') {
            const menu = `*STONE 2 - MENU*\n\n- *on* / *off* : Contrôle IA\n- *video [nom]* : YouTube MP3\n- *connect [num] [mdp]* : Créer bot\n- *save* / *vv* : Sauver média\n- *s* / *sticker* : Créer sticker\n- *host* : Héberger un média\n- *rappel [temps] [texte]* : Rappel (ex: 10m)\n- *love [mot] [délai]* : Spam (ex: love Hi 2)\n- *alt-delete* : Supprimer mes messages\n- *alt-kick* : Vider le groupe\n- *disconnect [num] [mdp]*\n\n*Statut :* ${current.isBotActive ? 'ACTIF ✅' : 'INACTIF 🛑'}`;
            await sock.sendMessage(remoteJid, { image: { url: 'https://files.catbox.moe/6uhomx.png' }, caption: menu }, { quoted: msg });
            await sendMenuAudio(sock, remoteJid, msg);
            return;
        }

        if (lowerText === 'host') {
            hostingStates.set(remoteJid, true);
            await sock.sendMessage(remoteJid, { text: "📤 *MODE HÉBERGEMENT ACTIVÉ*\nEnvoyez votre média." }, { quoted: msg });
            return;
        }

        if (lowerText.startsWith('connect ')) {
            const parts = text.trim().split(/\s+/);
            // On accepte 'connect [numéro] [mot_de_passe]'
            if (parts.length >= 3) {
                const password = parts[parts.length - 1].toLowerCase();
                const number = parts[1].replace(/[^0-9]/g, '');
                
                if (password === 'moussa') {
                    await sock.sendMessage(remoteJid, { text: `⏳ Initialisation de la session pour ${number}...` });
                    createBotInstance(number, sock, remoteJid);
                } else { 
                    await sock.sendMessage(remoteJid, { text: "❌ Mot de passe incorrect." }); 
                }
            } else { 
                await sock.sendMessage(remoteJid, { text: "❌ Format : connect [numéro] [mot_de_passe]" }); 
            }
            return;
        }

        if (lowerText.startsWith('disconnect ')) {
            const parts = text.split(' ');
            if (parts.length === 3 && parts[2] === 'moussa') {
                const target = parts[1].replace(/[^0-9]/g, '');
                if (activeSessions.has(target)) {
                    const session = activeSessions.get(target);
                    session.sock.logout();
                    activeSessions.delete(target);
                    await sock.sendMessage(remoteJid, { text: `✅ Session ${target} déconnectée.` });
                } else { await sock.sendMessage(remoteJid, { text: "❌ Session introuvable." }); }
            }
            return;
        }

        if (hostingStates.has(remoteJid)) {
            const type = msg.message.imageMessage ? 'image' : (msg.message.videoMessage ? 'video' : (msg.message.audioMessage ? 'audio' : null));
            if (type) {
                hostingStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: "⏳ Hébergement en cours..." });
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const ext = type === 'image' ? 'png' : (type === 'video' ? 'mp4' : 'mp3');
                    const link = await uploadToCatbox(buffer, `file.${ext}`);
                    await sock.sendMessage(remoteJid, { text: link ? `✅ *LIEN :* ${link}` : "❌ Erreur Catbox." }, { quoted: msg });
                } catch (e) { await sock.sendMessage(remoteJid, { text: "❌ Erreur traitement." }); }
                return;
            }
        }

        if (!current.isBotActive) return;

        if (lowerText.startsWith('rappel ')) {
            const input = text.slice(7).trim();
            const match = input.match(/^(\d+)([smhj])\s+(.+)$/i);
            if (match) {
                const amount = parseInt(match[1]);
                const unit = match[2].toLowerCase();
                const task = match[3];
                let duration = amount * (unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000);
                await sock.sendMessage(remoteJid, { text: `✅ Rappel dans ${amount}${unit}.` }, { quoted: msg });
                setTimeout(() => sock.sendMessage(remoteJid, { text: `⏰ *RAPPEL :* ${task}` }), duration);
            }
            return;
        }

        if (lowerText.startsWith('video ')) {
            const query = text.slice(6).trim();
            if (query) {
                await sock.sendMessage(remoteJid, { text: "⏳ Téléchargement..." });
                try {
                    const path = await downloadYouTubeMP3(query);
                    await sock.sendMessage(remoteJid, { audio: fs.readFileSync(path), mimetype: 'audio/mp4' }, { quoted: msg });
                    fs.unlinkSync(path);
                } catch (e) { await sock.sendMessage(remoteJid, { text: "❌ Erreur YouTube." }); }
            }
            return;
        }

        if (lowerText === 'save' || lowerText === 'vv') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) return;

            // Détection du message View Once (V2 ou standard)
            const viewOnce = quoted.viewOnceMessageV2 || quoted.viewOnceMessage || quoted.viewOnceMessageV2Extension;
            
            if (viewOnce) {
                const type = viewOnce.message.imageMessage ? 'image' : (viewOnce.message.videoMessage ? 'video' : null);
                if (type) {
                    try {
                        const buffer = await downloadMediaMessage(
                            { message: viewOnce.message }, 
                            'buffer', 
                            {}, 
                            { logger: pino({ level: 'silent' }), rekey: true }
                        );
                        await sock.sendMessage(remoteJid, { [type]: buffer, caption: "✅ Média sauvé !" }, { quoted: msg });
                    } catch (e) {
                        console.error("Erreur ViewOnce:", e);
                        await sock.sendMessage(remoteJid, { text: "❌ Erreur lors du téléchargement du média." });
                    }
                }
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ Ce n'est pas un message à vue unique." });
            }
            return;
        }

        if (lowerText === 's' || lowerText === 'sticker') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage || msg.message;
            const type = quoted.imageMessage ? 'image' : (quoted.videoMessage ? 'video' : null);
            if (type) {
                try {
                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const tempImg = path.join(TEMP_DIR, `sticker_${Date.now()}.webp`);
                    if (type === 'image') {
                        const image = await Jimp.read(buffer);
                        await image.contain({ w: 512, h: 512 }).write(tempImg);
                    } else {
                        const tempVid = path.join(TEMP_DIR, `vid_${Date.now()}.mp4`);
                        fs.writeFileSync(tempVid, buffer);
                        await new Promise((resolve, reject) => {
                            ffmpeg(tempVid).inputOptions(['-t', '10']).complexFilter(['scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000']).outputOptions(['-vcodec', 'libwebp', '-lossless', '1', '-loop', '0', '-preset', 'default', '-an', '-vsync', '0']).on('end', resolve).on('error', reject).save(tempImg);
                        });
                        fs.unlinkSync(tempVid);
                    }
                    await sock.sendMessage(remoteJid, { sticker: fs.readFileSync(tempImg) }, { quoted: msg });
                    fs.unlinkSync(tempImg);
                } catch (e) { await sock.sendMessage(remoteJid, { text: "❌ Erreur sticker." }); }
            }
            return;
        }

        if (isFromMe && lowerText.startsWith('love ')) {
            const fullArgs = text.slice(5).trim().split(' ');
            let word, delay;

            // Vérifier si le dernier argument est un nombre (le délai)
            const lastArg = fullArgs[fullArgs.length - 1];
            // On s'assure que c'est un nombre pur et pas un mot contenant des chiffres
            if (/^\d+$/.test(lastArg) && fullArgs.length > 1) {
                delay = parseInt(lastArg) * 1000;
                word = fullArgs.slice(0, -1).join(' '); // Tout sauf le dernier mot
            } else {
                delay = 0; // Instantané par défaut
                word = fullArgs.join(' '); // Tout le texte
            }
            
            if (word) {
                current.activeSpams.add(remoteJid);
                await sock.sendMessage(remoteJid, { text: `🚀 *SPAM ACTIVÉ*\nMessage: ${word}\nDélai: ${delay/1000}s` });
                
                for (let i = 1; i <= 4000; i++) {
                    if (!current.activeSpams.has(remoteJid) || !current.isBotActive) break;
                    await sock.sendMessage(remoteJid, { text: word });
                    if (delay > 0) await sleep(delay);
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
    console.log("--- DÉMARRAGE STONE 2 ---");
    const mainNum = await question('Numéro principal : ');
    createBotInstance(mainNum.replace(/[^0-9]/g, ''));
}

start();
