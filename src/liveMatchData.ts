import { mongoDb } from './data';
// Definición mínima local para evitar error de compilación
export interface LiveMatch {
  id: string;
  [key: string]: any;
}

export const getLiveMatchesCollection = async () => {
  if (!mongoDb) throw new Error('MongoDB no configurado');
  return mongoDb.collection<LiveMatch>('live_matches');
};

export const getLiveMatchById = async (id: string): Promise<LiveMatch | null> => {
  const collection = await getLiveMatchesCollection();
  return collection.findOne({ id });
};

export const saveLiveMatchToMongo = async (match: LiveMatch) => {
  const collection = await getLiveMatchesCollection();
  await collection.replaceOne({ id: match.id }, match, { upsert: true });
};
