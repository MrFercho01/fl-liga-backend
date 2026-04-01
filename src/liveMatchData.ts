import { mongoDb } from './data';
// Definición mínima local para evitar error de compilación
export interface LiveMatch {
  id: string;
  [key: string]: any;
}

export const getPlayedMatchesCollection = async () => {
  if (!mongoDb) throw new Error('MongoDB no configurado');
  return mongoDb.collection<LiveMatch>('played_matches');
};

export const getPlayedMatchById = async (id: string): Promise<LiveMatch | null> => {
  const collection = await getPlayedMatchesCollection();
  return collection.findOne({ id });
};

export const saveLiveMatchToMongo = async (match: LiveMatch) => {
  const collection = await getPlayedMatchesCollection();
  await collection.replaceOne({ id: match.id }, match, { upsert: true });
};
