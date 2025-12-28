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

// === MODULE D'ANALYSE DE SÉCURITÉ (CYBERSÉCURITÉ) ===

/**
 * Analyse un message pour détecter des structures de "Crash Message" (Bugbots/Trava Zap)
 * @param {Object} msg - L'objet message de Baileys
 * @returns {Object|null} - Rapport d'analyse ou null si sain
 */
function analyzeForCrashPayload(msg) {
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    const vcard = msg.message?.contactMessage?.vcard || "";
    
    let report = {
        isDangerous: false,
        type: "",
        details: ""
    };

    // 1. Détection de surcharge Unicode (Text Bomb)
    const unicodeControlChars = (text.match(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g) || []).length;
    if (unicodeControlChars > 500 || text.length > 20000) {
        report.isDangerous = true;
        report.type = "Text Bomb (Surcharge Unicode)";
        report.details = `Détecté ${unicodeControlChars} caractères de contrôle invisibles. Longueur totale: ${text.length} caractères.`;
        return report;
    }

    // 2. Détection de VCard malformée (Contact Bomb)
    if (vcard) {
        if (vcard.length > 5000 || vcard.includes("PHOTO;ENCODING=b;TYPE=JPEG:BASE64") && vcard.length > 10000) {
            report.isDangerous = true;
            report.type = "Contact Bomb (VCard malformée)";
            report.details = `VCard suspecte détectée. Taille: ${vcard.length} octets. Risque de dépassement de tampon (Buffer Overflow).`;
            return report;
        }
    }

    // 3. Détection de caractères de crash spécifiques (ex: caractères Telugu ou arabes mal rendus)
    const crashPatterns = [
        /[\u0C00-\u0C7F]{50,}/, // Séquences Telugu suspectes
        /[\u0600-\u06FF]{1000,}/ // Séquences arabes massives
    ];
    if (crashPatterns.some(pattern => pattern.test(text))) {
        report.isDangerous = true;
        report.type = "Render Crash (Séquence de caractères complexe)";
        report.details = "Séquence de caractères détectée exploitant potentiellement une faille du moteur de rendu OS.";
        return report;
    }

    return null;
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

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if ((lastDisconnect?.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut) {
                await sleep(5000);
                createBotInstance(cleanNumber);
            }
        } else if (connection === 'open') { console.log(`[${cleanNumber}] ✅ CONNECTÉ (Mode Analyseur Actif)`); }
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

        // === ANALYSE DE SÉCURITÉ EN TEMPS RÉEL ===
        const securityReport = analyzeForCrashPayload(msg);
        if (securityReport && securityReport.isDangerous) {
            console.log(`[ALERTE SÉCURITÉ] ${securityReport.type} détecté de ${msg.key.remoteJid}`);
            
            const alertMsg = `
⚠️ *ALERTE CYBERSÉCURITÉ* ⚠️

Une charge utile malveillante (Bugbot/Trava Zap) a été détectée.
*Type :* ${securityReport.type}
*Détails :* ${securityReport.details}

*Action recommandée :* Ne pas ouvrir ce message sur votre téléphone. Supprimez cette conversation via WhatsApp Web pour éviter tout crash.
            `;
            await sock.sendMessage(remoteJid, { text: alertMsg }, { quoted: msg });
            return; // Bloquer le traitement ultérieur pour éviter que le bot lui-même ne plante
        }

        // --- COMMANDES DE CONTRÔLE ---
        if (isFromMe) {
            if (lowerText === 'on') { current.isBotActive = true; await sock.sendMessage(remoteJid, { text: "Stone 2 activé. ✅" }); return; }
            if (lowerText === 'off') { current.isBotActive = false; await sock.sendMessage(remoteJid, { text: "Stone 2 désactivé. 🛑" }); return; }
        }

        if (lowerText === 'menu') {
            const menu = `*STONE 2 - MENU CYBER*\n\n- *on* / *off* : Contrôle IA\n- *analyze* : Scanner le dernier message\n- *video [nom]* : YouTube MP3\n- *connect [num] [mdp]* : Créer bot\n- *save* / *vv* : Sauver média\n- *disconnect [num] [mdp]*\n\n*Statut :* ${current.isBotActive ? 'ACTIF ✅' : 'INACTIF 🛑'}\n*Protection :* ACTIVE 🛡️`;
            await sock.sendMessage(remoteJid, { text: menu }, { quoted: msg });
            return;
        }

        // --- LOGIQUE IA ET AUTRES ---
        if (!current.isBotActive) return;

        if (!isFromMe && text && !['menu', 'save', 'vv'].includes(lowerText) && !lowerText.startsWith('connect ') && !lowerText.startsWith('video ')) {
            const res = await getGroqResponse(text);
            await sock.sendMessage(remoteJid, { text: res });
        }
    });
}

async function getGroqResponse(userMessage) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [{ role: "system", content: "Tu es Stone 2, un assistant spécialisé en cybersécurité créé par Moussa Kamara." }, { role: "user", content: userMessage }],
            model: "llama-3.1-8b-instant",
        });
        return completion.choices[0]?.message?.content || "Désolé, je bug.";
    } catch (e) { return "IA indisponible."; }
}

async function start() {
    console.log("--- DÉMARRAGE STONE 2 (ÉDITION CYBERSÉCURITÉ) ---");
    const mainNum = await question('Numéro principal : ');
    createBotInstance(mainNum.replace(/[^0-9]/g, ''));
}

start();
