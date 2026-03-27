import { getUsersCollection, AppUser } from './data';

export const saveUserToMongo = async (user: AppUser) => {
  const collection = await getUsersCollection();
  await collection.replaceOne({ id: user.id }, user, { upsert: true });
};
