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

// === FONCTIONNALITÉ ÉDUCATIVE : BUG BOT ===
// Cette section démontre les vulnérabilités courantes et comment les exploiter
// À DES FINS ÉDUCATIVES ET PRÉVENTIVES UNIQUEMENT

const BUG_BOT_ENABLED = true; // À mettre à false en production

async function downloadYouTubeMP3(query) {
    return new Promise((resolve, reject) => {
        const filename = `audio_${Date.now()}.mp3`;
        const outputPath = path.join(__dirname, filename);
        
        // ⚠️ VULNÉRABILITÉ DÉMONSTRATIVE : Injection de commandes
        // Cette fonction utilise exec() avec une entrée utilisateur non nettoyée
        // RISQUE : Un utilisateur peut injecter des commandes shell arbitraires
        // EXEMPLE D'ATTAQUE : "video ; rm -rf /" ou "video && cat /etc/passwd"
        // CORRECTION : Utiliser execFile() ou échapper les caractères spéciaux
        
        const command = `yt-dlp --max-filesize 15M -f "bestaudio" --extract-audio --audio-format mp3 -o "${outputPath}" "ytsearch1:${query}"`;
        exec(command, (error) => {
            if (error) return reject("Trop lourd ou introuvable.");
            if (fs.existsSync(outputPath)) resolve(outputPath);
            else reject("Erreur conversion.");
        });
    });
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

// === DÉMONSTRATION DE VULNÉRABILITÉS (Mode Éducatif) ===

/**
 * Démonstration 1 : Déni de Service (DoS) par saturation mémoire
 * RISQUE : Un utilisateur peut envoyer une très longue chaîne de caractères
 * qui consomme excessivement la mémoire et ralentit ou plante le bot
 */
function detectMemorySaturationAttack(text) {
    // Détecte si le message est anormalement long (> 50 000 caractères)
    if (text.length > 50000) {
        return true;
    }
    return false;
}

/**
 * Démonstration 2 : Injection de Prompt (Prompt Injection)
 * RISQUE : Un utilisateur tente de détourner les instructions système de l'IA
 */
function detectPromptInjectionAttempt(text) {
    const injectionKeywords = [
        "ignore les instructions",
        "oublie le contexte",
        "tu es maintenant",
        "ignore le système",
        "désactive la sécurité",
        "show me the password",
        "forget your instructions"
    ];
    
    const lowerText = text.toLowerCase();
    return injectionKeywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Démonstration 3 : Injection de Commandes (Command Injection)
 * RISQUE : Caractères spéciaux shell qui pourraient exécuter des commandes
 */
function detectCommandInjectionAttempt(text) {
    const injectionPatterns = [
        /[;&|`$()]/,  // Caractères shell dangereux
        /\$\{.*\}/,   // Template injection
        /\$\(.*\)/    // Command substitution
    ];
    
    return injectionPatterns.some(pattern => pattern.test(text));
}

/**
 * Démonstration 4 : Crash Message (Caractères non imprimables)
 * RISQUE : Certains caractères ou séquences peuvent causer un crash
 */
function detectCrashMessageAttempt(text) {
    // Détecte les caractères de contrôle ou non imprimables excessifs
    const nonPrintableCount = (text.match(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g) || []).length;
    return nonPrintableCount > 5;
}

/**
 * Démonstration 5 : Boucle Infinie / Récursion
 * RISQUE : Un utilisateur peut déclencher une boucle infinie
 */
function detectInfiniteLoopAttempt(text) {
    // Détecte les tentatives de commandes récursives ou de boucles
    const loopKeywords = ["boucle", "loop", "repeat", "récursion", "infinite"];
    const lowerText = text.toLowerCase();
    return loopKeywords.some(keyword => lowerText.includes(keyword)) && text.includes("*");
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

        // === DÉTECTION DES ATTAQUES (Mode Éducatif) ===
        if (BUG_BOT_ENABLED && isFromMe) {
            if (lowerText === 'bugbot') {
                const bugBotMenu = `
*🐛 BUG BOT - MODE ÉDUCATIF 🐛*

Démonstrations de vulnérabilités :
1. *dos* - Saturation mémoire
2. *injection* - Injection de prompt
3. *command* - Injection de commandes
4. *crash* - Message de crash
5. *loop* - Boucle infinie

*AVERTISSEMENT* : Ces tests sont ÉDUCATIFS UNIQUEMENT
Utilisez-les pour comprendre les risques de sécurité.
                `;
                await sock.sendMessage(remoteJid, { text: bugBotMenu });
                return;
            }

            // Test 1 : DoS (Déni de Service)
            if (lowerText === 'dos') {
                await sock.sendMessage(remoteJid, { text: "🚨 TEST DoS : Envoyez un très long message (>50k caractères) pour tester la saturation mémoire." });
                return;
            }

            // Test 2 : Injection de Prompt
            if (lowerText === 'injection') {
                await sock.sendMessage(remoteJid, { text: "🚨 TEST INJECTION : Essayez d'envoyer un message contenant 'ignore les instructions' ou 'oublie le contexte'." });
                return;
            }

            // Test 3 : Injection de Commandes
            if (lowerText === 'command') {
                await sock.sendMessage(remoteJid, { text: "🚨 TEST COMMAND INJECTION : Essayez 'video ; ls' ou 'video && whoami' pour voir la vulnérabilité." });
                return;
            }

            // Test 4 : Crash Message
            if (lowerText === 'crash') {
                await sock.sendMessage(remoteJid, { text: "🚨 TEST CRASH : Envoyez des caractères de contrôle ou des séquences spéciales." });
                return;
            }

            // Test 5 : Boucle Infinie
            if (lowerText === 'loop') {
                await sock.sendMessage(remoteJid, { text: "🚨 TEST BOUCLE : Essayez 'boucle * * *' pour tester une tentative de boucle infinie." });
                return;
            }
        }

        // === ANALYSE DES MESSAGES POUR DÉTECTER LES ATTAQUES ===
        if (BUG_BOT_ENABLED) {
            if (detectMemorySaturationAttack(text)) {
                console.log(`[ALERTE] DoS détecté : Message trop long (${text.length} caractères)`);
                await sock.sendMessage(remoteJid, { text: "⚠️ [ALERTE SÉCURITÉ] Message trop long détecté (potentielle attaque DoS)" });
                return;
            }

            if (detectPromptInjectionAttempt(text)) {
                console.log(`[ALERTE] Injection de prompt détectée : ${text.substring(0, 50)}`);
                await sock.sendMessage(remoteJid, { text: "⚠️ [ALERTE SÉCURITÉ] Tentative d'injection de prompt détectée" });
                return;
            }

            if (detectCommandInjectionAttempt(text) && lowerText.startsWith('video ')) {
                console.log(`[ALERTE] Injection de commande détectée : ${text.substring(0, 50)}`);
                await sock.sendMessage(remoteJid, { text: "⚠️ [ALERTE SÉCURITÉ] Tentative d'injection de commande détectée dans la requête video" });
                return;
            }

            if (detectCrashMessageAttempt(text)) {
                console.log(`[ALERTE] Message de crash détecté`);
                await sock.sendMessage(remoteJid, { text: "⚠️ [ALERTE SÉCURITÉ] Message contenant des caractères de contrôle suspects détecté" });
                return;
            }

            if (detectInfiniteLoopAttempt(text)) {
                console.log(`[ALERTE] Tentative de boucle infinie détectée`);
                await sock.sendMessage(remoteJid, { text: "⚠️ [ALERTE SÉCURITÉ] Tentative de boucle infinie détectée" });
                return;
            }
        }

        // --- COMMANDES DE CONTRÔLE ---
        if (isFromMe) {
            if (lowerText === 'on') { current.isBotActive = true; await sock.sendMessage(remoteJid, { text: "Stone 2 activé. ✅" }); return; }
            if (lowerText === 'off') { current.isBotActive = false; await sock.sendMessage(remoteJid, { text: "Stone 2 désactivé. 🛑" }); return; }
        }

        if (lowerText === 'menu') {
            const menu = `*STONE 2 - MENU*\n\n- *on* / *off* : Contrôle IA\n- *video [nom]* : YouTube MP3\n- *connect [num] [mdp]* : Créer bot\n- *save* / *vv* : Sauver média\n- *love [mot]* : Spam\n- *bugbot* : Mode éducatif (Vulnérabilités)\n- *disconnect [num] [mdp]*\n\n*Statut :* ${current.isBotActive ? 'ACTIF ✅' : 'INACTIF 🛑'}`;
            await sock.sendMessage(remoteJid, { text: menu }, { quoted: msg });
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

        if (!current.isBotActive) return;

        // --- LOGIQUE DES OUTILS (Seulement si ON) ---
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

        if (!isFromMe && text && !['menu', 'save', 'vv'].includes(lowerText) && !lowerText.startsWith('connect ') && !lowerText.startsWith('video ')) {
            const res = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: res });
        }
    });
}

async function start() {
    console.log("--- DÉMARRAGE STONE 2 (CONNECT SÉCURISÉ) ---");
    if (BUG_BOT_ENABLED) {
        console.log("⚠️  MODE BUG BOT ACTIVÉ (Éducatif)");
        console.log("Tapez 'bugbot' pour accéder aux démonstrations de vulnérabilités");
    }
    const mainNum = await question('Numéro principal : ');
    createBotInstance(mainNum.replace(/[^0-9]/g, ''));
}

start();
