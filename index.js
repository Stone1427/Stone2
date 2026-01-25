    const cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
    const sessionPath = path.join(SESSIONS_DIR, cleanNumber);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
    });

    activeSessions.set(cleanNumber, { sock, isBotActive: false, activeSpams: new Set() });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                const msg = `✅ *SESSION GÉNÉRÉE*\n\nNuméro : ${cleanNumber}\nCode : *${code}*`;
                console.log(`Code d'appairage pour ${cleanNumber} : ${code}`);
                if (sockToNotify && jidToNotify) {
                    await sockToNotify.sendMessage(jidToNotify, { text: msg });
                }
            } catch (e) {
                console.error("Erreur lors de la demande du code :", e);
            }
        }, 5000);
    }

    sock.ev.on("creds.update", saveCreds);

    // Anti-suppression (Log des messages supprimés)
    sock.ev.on("messages.update", async (updates) => {
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

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            if ((lastDisconnect?.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut) {
                await sleep(5000);
                createBotInstance(cleanNumber);
            }
        } else if (connection === "open") { console.log(`[${cleanNumber}] ✅ CONNECTÉ (Statut: OFF)`); }
    });

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === "status@broadcast") return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const senderName = msg.pushName;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "").trim();
        const lowerText = text.toLowerCase();

        const current = activeSessions.get(cleanNumber);
        if (!current) return;

        // Détermination du type de message pour les logs
        let msgType = "texte";
        if (msg.message.imageMessage) msgType = "image";
        else if (msg.message.videoMessage) msgType = "vidéo";
        else if (msg.message.audioMessage) msgType = "audio";
        else if (msg.message.stickerMessage) msgType = "sticker";
        else if (msg.message.documentMessage) msgType = "document";

        // Mise en cache pour anti-suppression et alt-delete
        if (!messageCache.has(cleanNumber)) messageCache.set(cleanNumber, new Map());
        const sessionCache = messageCache.get(cleanNumber);
        sessionCache.set(msg.key.id, { text, senderName, remoteJid });
        if (sessionCache.size > 1000) sessionCache.delete(sessionCache.keys().next().value);

        // Logs console
        logMessage(cleanNumber, remoteJid, senderName, text, msgType);

        // --- COMMANDES PROPRIÉTAIRE (isFromMe) ---
        if (isFromMe) {
            if (lowerText === "on") { current.isBotActive = true; await sock.sendMessage(remoteJid, { text: "Stone 2 activé. ✅" }); return; }
            if (lowerText === "off") { current.isBotActive = false; await sock.sendMessage(remoteJid, { text: "Stone 2 désactivé. 🛑" }); return; }
            
            // Nettoyage profond (alt-delete)
            if (lowerText === "alt-delete") {
                await sock.sendMessage(remoteJid, { text: "🧹 *NETTOYAGE PROFOND EN COURS...*\nRécupération de l'historique et suppression." });
                let count = 0;
                try {
                    if (sessionCache) {
                        for (const [id, data] of sessionCache.entries()) {
                            if (data.remoteJid === remoteJid) {
                                await sock.sendMessage(remoteJid, { delete: { remoteJid, fromMe: true, id: id, participant: undefined } });
                                sessionCache.delete(id);
                                count++;
                            }
                        }
                    }
                    const history = await sock.fetchMessagesFromWA(remoteJid, 50);