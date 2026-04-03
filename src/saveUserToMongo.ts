import { getUsersCollection, AppUser } from './data';
import { v4 as uuidv4 } from 'uuid';

export const saveUserToMongo = async (user: AppUser) => {
  // Si es client_admin, asegúrate de que tenga un publicPortalPath único
  if (user.role === 'client_admin') {
    if (!user.publicPortalPath) {
      // Genera un path único tipo /cliente/{slug-o-id}
      const slug = user.organizationName
        ? user.organizationName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        : null;
      user.publicPortalPath = slug ? `/cliente/${slug}` : `/cliente/${user.id}`;
    }
  }
  const collection = await getUsersCollection();
  await collection.replaceOne({ id: user.id }, user, { upsert: true });
};
