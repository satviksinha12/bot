const express = require('express');
const { InteractionType, InteractionResponseType, verifyKey } = require('discord-interactions');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 8080;

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
    const signature = req.get('X-Signature-Ed25519');
    const timestamp = req.get('X-Signature-Timestamp');
    const body = req.rawBody;

    const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

    // 1. Verify Signature
    if (!signature || !timestamp || !verifyKey(body, signature, timestamp, PUBLIC_KEY)) {
        console.error("❌ DISCORD SIG VERIFICATION FAILED");
        return res.status(401).send('Invalid request signature');
    }

    const interaction = req.body;

    // 2. Handle PING
    if (interaction.type === InteractionType.PING) {
        return res.json({ type: InteractionResponseType.PONG });
    }

    // 3. Initialize Firebase
    if (!admin.apps.length) {
        try {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.V2S_FIREBASE_PROJECT_ID,
                    clientEmail: process.env.V2S_FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.V2S_FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                }),
                databaseURL: process.env.V2S_FIREBASE_DATABASE_URL
            });
        } catch (err) {
            console.error("Firebase Init Error:", err.message);
        }
    }
    const db = admin.firestore();
    const rtdb = admin.database();

    // 4. Handle Commands
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const { name } = interaction.data;

        if (name === 'ping') {
            return res.json({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: { content: 'Pong! ✈️ IBM Application Dispatch is online.' }
            });
        }

        if (name === 'who') {
            const data = (await rtdb.ref('live_flights').once('value')).val();
            if (!data) return response(res, "No pilots flying. 🛫");
            const active = Object.values(data).filter(f => Date.now() - f.lastContact < 600000);
            if (!active.length) return response(res, "No active pilots. 🛫");
            const flightList = active.map(f => `**${f.callsign}**: ${f.dep} ➔ ${f.arr} | ${f.aircraft}`).join('\n');
            return responseEmbed(res, "📡 Live Ops", 0x00AE86, `**${active.length}** pilots flying:\n\n${flightList}`);
        }

        if (name === 'stats') {
            const [pireps, users] = await Promise.all([db.collection('pireps').get(), db.collection('users').get()]);
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

            const snap = await db.collection('users').where('username', '==', username).limit(1).get();
            if (snap.empty) return response(res, `Pilot ${username} not found.`);
            const user = snap.docs[0].data();
            const pSnap = await db.collection('pireps').where('username', '==', username).get();
            return responseEmbed(res, `👨‍✈️ Profile: ${username}`, 0xf1c40f, `Flights: ${pSnap.size}`, user.profilePic);
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
    console.log(`✅ Bot app listening on port ${PORT}`);
});
