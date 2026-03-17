import { leaguesStore } from './data';

/**
 * Devuelve la cantidad de jugadores en cancha para una liga/categoría.
 * Busca en la liga y categoría correspondiente.
 */
export function resolvePlayersOnField(leagueId: string, categoryId: string): number {
  const league = leaguesStore.find(l => l.id === leagueId);
  const category = league?.categories.find(c => c.id === categoryId);
  return category?.rules.playersOnField || 11;
}

/**
 * Simula un broadcast en vivo (puede ser WebSocket, etc). Aquí solo loguea.
 */
export function broadcastLive(): void {
  // Aquí se podría integrar con WebSocket, etc. Por ahora solo loguea.
  // console.log('Broadcast live event');
}
