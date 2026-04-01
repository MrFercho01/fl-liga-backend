
// Script para actualizar el campo status en la colección played_matches
// - Marca como "finished" todos los partidos jugados que no tengan status o tengan status vacío
// - Permite marcar partidos específicos con cualquier estado personalizado (ejemplo: "disabled")
//
// Uso: Ejecuta este script con Node.js en el backend conectado a tu MongoDB

const { MongoClient } = require('mongodb');

const MONGO_URI = 'mongodb+srv://fl_liga_user:1623Fercho@flstore.3yoejzl.mongodb.net/?appName=flstore';
const DB_NAME = 'fl-liga';
const COLLECTION = 'played_matches';

// Lista de partidos a actualizar a un estado específico
// Ejemplo: [{ matchId: "manual__2__e3a74de0...", status: "disabled" }]
const customStatusUpdates = [
  // { matchId: "manual__2__e3a74de0-a6af-4b31-9b9d-3898c32cd55c__3c4f044b-893a-4724-8b...", status: "disabled" },
];

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const collection = db.collection(COLLECTION);

    // Actualiza TODOS los partidos a 'finished', sin importar el estado actual
    const updateFinished = await collection.updateMany(
      {},
      { $set: { status: "finished" } }
    );
    console.log(`Partidos actualizados a 'finished': ${updateFinished.modifiedCount}`);

  // 2. Actualiza partidos a estados personalizados
  let customCount = 0;
  for (const upd of customStatusUpdates) {
    const res = await collection.updateMany(
      { matchId: upd.matchId },
      { $set: { status: upd.status } }
    );
    customCount += res.modifiedCount;
    if (res.modifiedCount > 0) {
      console.log(`Partido ${upd.matchId} actualizado a '${upd.status}'`);
    }
  }
  if (customStatusUpdates.length === 0) {
    console.log('No se especificaron partidos para actualizar a estados personalizados.');
  } else {
    console.log(`Total partidos actualizados a estados personalizados: ${customCount}`);
  }

  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
