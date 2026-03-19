import { getLeaguesCollection } from './data';

export async function deleteLeagueFromMongo(leagueId: string) {
  const collection = await getLeaguesCollection();
  await collection.deleteOne({ id: leagueId });
};
