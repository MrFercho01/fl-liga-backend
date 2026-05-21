// Script para crear índices óptimos en la colección played_matches
// Ejecutar: node backend/scripts/create-played-matches-indexes.js
const { MongoClient } = require('mongodb');

// Cambia la URI por la de tu entorno
const uri = process.env.MONGO_URI || 'mongodb+srv://<usuario>:<password>@<cluster-url>/fl_liga?retryWrites=true&w=majority';

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('fl_liga');
    const collection = db.collection('played_matches');

    // Índices sugeridos según consultas frecuentes:
    // 1. Por cliente (ej: clientId), liga (leagueId), categoría (categoryId)
    // 2. Compuesto para búsquedas combinadas
    const result1 = await collection.createIndex({ clientId: 1 });
    const result2 = await collection.createIndex({ leagueId: 1 });
    const result3 = await collection.createIndex({ categoryId: 1 });
    // Índice compuesto para búsquedas conjuntas
    const result4 = await collection.createIndex({ clientId: 1, leagueId: 1, categoryId: 1 });

    console.log('Índices creados:', { result1, result2, result3, result4 });
  } catch (err) {
    console.error('Error creando índices:', err);
  } finally {
    await client.close();
  }
}

main();