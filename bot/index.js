const express = require('express');
const { InteractionType, InteractionResponseType, verifyKey } = require('discord-interactions');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * FIREBASE INITIALIZATION (Global Scope)
 */
function fixKey(key) {
    if (!key) {
        console.log("❌ fixKey: Key is null or undefined");
        return null;
    }
    let k = key.trim();
    console.log(`🔍 fixKey: Input length: ${k.length}`);

    // Convert string literal \n to actual newlines
    k = k.replace(/\\n/g, '\n');

    const header = '-----BEGIN PRIVATE KEY-----';
    const footer = '-----END PRIVATE KEY-----';

    if (k.includes(header)) {
        console.log("🛠️ fixKey: PEM header detected. Reconstructing standard format...");

        // Extract strictly what's between headers, ignoring any surrounding junk
        const startIdx = k.indexOf(header) + header.length;
        const endIdx = k.indexOf(footer);

        if (endIdx === -1) {
            console.error("❌ fixKey: No footer found!");
            return k; // Fallback to raw
        }

        let base64Part = k.substring(startIdx, endIdx).replace(/\s/g, '');

        // Re-insert newlines every 64 characters (standard PEM)
        const lines = base64Part.match(/.{1,64}/g) || [];
        const cleanKey = `${header}\n${lines.join('\n')}\n${footer}\n`;

        console.log(`✅ fixKey: Key healed. Final length: ${cleanKey.length} (Lines: ${lines.length})`);
        return cleanKey;
    }

    console.log("⚠️ fixKey: No header found. Returning processed raw string.");
    return k;
}

// Global initialization flag
let isFirebaseReady = false;

if (!admin.apps.length) {
    try {
        console.log("🔥 Initializing Global Firebase Admin...");
        const privateKey = fixKey(process.env.V2S_FIREBASE_PRIVATE_KEY);

        if (privateKey) {
            console.log("🔑 Hex of first 10 processed chars:", Buffer.from(privateKey.substring(0, 10)).toString('hex'));
        }

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.V2S_FIREBASE_PROJECT_ID,
                clientEmail: process.env.V2S_FIREBASE_CLIENT_EMAIL,
                privateKey: privateKey,
            }),
            databaseURL: process.env.V2S_FIREBASE_DATABASE_URL
        });
        isFirebaseReady = true;
        console.log("✅ Firebase Admin READY.");
    } catch (err) {
        console.error("💥 CRITICAL: Firebase Init Failed:", err.message);
        // Do NOT crash the process here so health checks can still pass
    }
}

// Lazy accessors to prevent crashes
function getDb() {
    if (!isFirebaseReady) throw new Error("Firebase not initialized accurately (Check Key)");
    return admin.firestore();
}
function getRtdb() {
    if (!isFirebaseReady) throw new Error("Firebase not initialized accurately (Check Key)");
    return admin.database();
}

/**
 * MIDDLEWARE: Raw Body Capture
 * Discord signature verification requires the UNMODIFIED raw body bytes.
 */
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

/**
 * HEALTH CHECK (GET)
 */
app.get('/', (req, res) => {
    res.send("✈️ Virtual Skies Bot is ONLINE (IBM Code Engine Application). Ready for HTTP interactions.");
});

/**
 * INTERACTION ENDPOINT (POST)
 */
app.post('/', async (req, res) => {
    console.log("📩 Discord POST interaction received");

    const signature = req.get('X-Signature-Ed25519');
    const timestamp = req.get('X-Signature-Timestamp');
    const body = req.rawBody;
    const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

    console.log("🔍 Verification details:");
    console.log("- Signature present:", !!signature);
    console.log("- Timestamp present:", !!timestamp);
    console.log("- Raw Body present:", !!body, body ? `(Size: ${body.length})` : "");
    console.log("- Public Key status:", !!PUBLIC_KEY ? 'Loaded' : 'MISSING');

    // 1. Verify Signature
    try {
        console.log("💎 Calling verifyKey...");
        const isValid = verifyKey(body, signature, timestamp, PUBLIC_KEY);
        console.log("💎 Verification result:", isValid);

        if (!isValid) {
            console.error("❌ DISCORD SIG VERIFICATION FAILED");
            return res.status(401).send('Invalid request signature');
        }
    } catch (err) {
        console.error("💥 CRASH during verifyKey:", err.message);
        return res.status(500).send('Internal verification error');
    }

    console.log("✅ VERIFICATION SUCCESS. Parsing interaction...");
    const interaction = req.body;
    console.log("ℹ️ Interaction Type:", interaction.type);

    // 2. Handle PING (Discord verification check)
    if (interaction.type === InteractionType.PING) {
        console.log("👋 PING received. Sending PONG...");
        return res.json({ type: InteractionResponseType.PONG });
    }

    // 3. Command Execution
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const { name } = interaction.data;
        console.log(`🤖 Command Executing: /${name}`);

        if (!isFirebaseReady) {
            return response(res, "⚠️ VA Database is currently offline (Key error). Please contact admin or check startup logs.");
        }

        try {
            if (name === 'ping') {
                return res.json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: 'Pong! ✈️ IBM Application Dispatch is online.' }
                });
            }

            if (name === 'who') {
                const data = (await getRtdb().ref('live_flights').once('value')).val();
                if (!data) return response(res, "No pilots flying. 🛫");
                const active = Object.values(data).filter(f => Date.now() - f.lastContact < 600000);
                if (!active.length) return response(res, "No active pilots. 🛫");
                const flightList = active.map(f => `**${f.callsign}**: ${f.dep} ➔ ${f.arr} | ${f.aircraft}`).join('\n');
                return responseEmbed(res, "📡 Live Ops", 0x00AE86, `**${active.length}** pilots flying:\n\n${flightList}`);
            }

            if (name === 'stats') {
                const [pireps, users] = await Promise.all([getDb().collection('pireps').get(), getDb().collection('users').get()]);
                let hours = 0;
                pireps.forEach(d => {
                    const t = (d.data().stats && d.data().stats.flightTime) || d.data().flightTime || "0";
                    hours += t.includes(':') ? (parseInt(t.split(':')[0]) + parseInt(t.split(':')[1]) / 60) : (parseFloat(t) || 0);
                });
                return responseEmbed(res, "📊 VA Stats", 0x5865F2, `Pilots: ${users.size} | Flights: ${pireps.size} | Hours: ${Math.round(hours)}`);
            }

            if (name === 'pilot') {
                const options = interaction.data.options || [];
                const username = options.length > 0 ? options[0].value : null;
                if (!username) return response(res, "Please provide a pilot username.");

                const snap = await getDb().collection('users').where('username', '==', username).limit(1).get();
                if (snap.empty) return response(res, `Pilot ${username} not found.`);
                const user = snap.docs[0].data();
                const pSnap = await getDb().collection('pireps').where('username', '==', username).get();
                return responseEmbed(res, `👨‍✈️ Profile: ${username}`, 0xf1c40f, `Flights: ${pSnap.size}`, user.profilePic);
            }
        } catch (err) {
            console.error(`💥 Error executing /${name}:`, err.message);
            return response(res, `❌ Error accessing database: ${err.message}`);
        }
    }

    return res.status(400).json({ error: 'Unknown interaction type' });
});

/**
 * HELPERS
 */
function response(res, content) {
    return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content }
    });
}

function responseEmbed(res, title, color, description, thumb) {
    const embed = { title, color, description, footer: { text: 'Virtual Skies IBM Application' } };
    if (thumb) embed.thumbnail = { url: thumb };
    return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { embeds: [embed] }
    });
}

app.listen(PORT, () => {
    console.log(`✅ Bot server is UP and listening on port ${PORT}`);
    console.log(`🔑 DISCORD_PUBLIC_KEY status: ${process.env.DISCORD_PUBLIC_KEY ? 'Present' : 'MISSING'}`);
});
