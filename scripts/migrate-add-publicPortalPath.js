// Script de migración para agregar el campo publicPortalPath a todos los usuarios client_admin
// Ejecutar: node backend/scripts/migrate-add-publicPortalPath.js
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://fl_liga_user:1623Fercho@flstore.3yoejzl.mongodb.net/?appName=flstore';
const DB_NAME = 'fl_liga';

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const users = db.collection('users');

  const admins = await users.find({ role: 'client_admin' }).toArray();
  let updated = 0;
  for (const user of admins) {
    if (!user.publicPortalPath) {
      let slug = user.organizationName ? slugify(user.organizationName) : null;
      const path = slug ? `/cliente/${slug}` : `/cliente/${user.id}`;
      await users.updateOne({ id: user.id }, { $set: { publicPortalPath: path } });
      updated++;
      console.log(`Actualizado usuario ${user.name} (${user.id}): publicPortalPath = ${path}`);
    }
  }
  console.log(`Usuarios actualizados: ${updated}`);
  await client.close();
}

main().catch((err) => {
  console.error('Error en migración:', err);
  process.exit(1);
});