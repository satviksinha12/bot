
const { InteractionType, InteractionResponseType, verifyKey } = require('discord-interactions');
const admin = require('firebase-admin');

async function main(params) {
    const signature = params.__ow_headers['x-signature-ed25519'];
    const timestamp = params.__ow_headers['x-signature-timestamp'];
    const body = params.__ow_body;
    const PUBLIC_KEY = params.DISCORD_PUBLIC_KEY;

    if (!verifyKey(body, signature, timestamp, PUBLIC_KEY)) {
        return { statusCode: 401, body: { error: 'Invalid request' } };
    }

    const interaction = JSON.parse(body);

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: params.FIREBASE_PROJECT_ID,
                clientEmail: params.FIREBASE_CLIENT_EMAIL,
                privateKey: params.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
            databaseURL: params.FIREBASE_DATABASE_URL
        });
    }
    const db = admin.firestore();
    const rtdb = admin.database();

    if (interaction.type === InteractionType.PING) {
        return { statusCode: 200, body: { type: InteractionResponseType.PONG } };
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const { name } = interaction.data;

        if (name === 'ping') return response("Pong! ✈️ IBM Serverless Dispatch is online.");

        if (name === 'who') {
            const data = (await rtdb.ref('live_flights').once('value')).val();
            if (!data) return response("No pilots flying. 🛫");
            const active = Object.values(data).filter(f => Date.now() - f.lastContact < 600000);
            if (!active.length) return response("No active pilots. 🛫");
            return responseEmbed("📡 Live Ops", 0x00AE86, active.map(f => `**${f.callsign}**: ${f.dep}➔${f.arr}`).join('\n'));
        }

        if (name === 'stats') {
            const [pireps, users] = await Promise.all([db.collection('pireps').get(), db.collection('users').get()]);
            let hours = 0;
            pireps.forEach(d => {
                const t = d.data().flightTime || "0";
                hours += t.includes(':') ? (parseInt(t.split(':')[0]) + parseInt(t.split(':')[1]) / 60) : (parseFloat(t) || 0);
            });
            return responseEmbed("📊 VA Stats", 0x5865F2, `Pilots: ${users.size} | Flights: ${pireps.size} | Hours: ${Math.round(hours)}`);
        }

        if (name === 'pilot') {
            const username = interaction.data.options[0].value;
            const snap = await db.collection('users').where('username', '==', username).limit(1).get();
            if (snap.empty) return response(`Pilot ${username} not found.`);
            const user = snap.docs[0].data();
            const pSnap = await db.collection('pireps').where('username', '==', username).get();
            return responseEmbed(`👨‍✈️ Profile: ${username}`, 0xf1c40f, `Flights: ${pSnap.size}`, user.profilePic);
        }
    }
    return { statusCode: 400, body: { error: 'Unknown' } };
}

function response(content) { return { statusCode: 200, body: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content } } }; }
function responseEmbed(title, color, description, thumb) {
    const embed = { title, color, description, footer: { text: 'Virtual Skies IBM Serverless' } };
    if (thumb) embed.thumbnail = { url: thumb };
    return { statusCode: 200, body: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { embeds: [embed] } } };
}
exports.main = main;
