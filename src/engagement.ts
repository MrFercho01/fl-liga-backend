// Devuelve o inicializa el engagement público para un clientId
export async function ensurePublicEngagement(clientId: string, collection: any) {
  let engagement = await collection.findOne({ clientId });
  if (!engagement) {
    engagement = {
      clientId,
      visits: 0,
      likes: 0,
      updatedAt: new Date().toISOString(),
    };
    await collection.insertOne(engagement);
  }
  return engagement;
}
