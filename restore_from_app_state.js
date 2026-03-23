const { MongoClient } = require('mongodb');
const fs = require('fs');

// Cambia esto por tu URI de conexión de MongoDB Atlas
const MONGODB_URI = 'mongodb+srv://fl_liga_user:1623Fercho@flstore.3yoejzl.mongodb.net/?appName=flstore';
const DB_NAME = 'fl_liga'; // O el nombre de tu base de datos

async function main() {
  const appState = JSON.parse(fs.readFileSync('app_state.json', 'utf8'));
  const snapshot = appState.snapshot || appState[0]?.snapshot;

  if (!snapshot) {
    console.error('No se encontró el campo snapshot en el archivo.');
    process.exit(1);
  }

  const collections = {
    users: 'users',
    leagues: 'leagues',
    teams: 'teams',
    fixtureSchedule: 'fixture_schedule',
    roundAwards: 'round_awards',
    playedMatches: 'played_matches',
    auditLogs: 'audit_logs',
    publicEngagement: 'public_engagement',
    publicMatchLikes: 'public_match_likes',
    clientAccessTokens: 'client_access_tokens',
  };

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(DB_NAME);

    for (const [key, collectionName] of Object.entries(collections)) {
      const data = snapshot[key];
      if (Array.isArray(data) && data.length > 0) {
        const col = db.collection(collectionName);
        await col.deleteMany({});
        await col.insertMany(data);
        console.log(`Restaurados ${data.length} documentos en ${collectionName}`);
      } else {
        console.log(`No hay datos para ${collectionName}`);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});