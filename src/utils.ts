import { getAllLeaguesFromMongo } from './data';

/**
 * Devuelve el número de jugadores en cancha según la configuración de la liga y categoría.
 * @param leagueId ID de la liga
 * @param categoryId ID de la categoría
 * @returns {Promise<number>} Número de jugadores en cancha
 */
export async function resolvePlayersOnField(leagueId: string, categoryId: string): Promise<number> {
  const leagues = await getAllLeaguesFromMongo();
  const league = leagues.find(l => l.id === leagueId);
  if (!league) throw new Error('Liga no encontrada');
  const category = league.categories.find(c => c.id === categoryId);
  if (!category) throw new Error('Categoría no encontrada');
  return category.rules.playersOnField;
}
// Tipo auxiliar para evitar undefined en propiedades internas
export type TechnicalStaffClean =
  | { director: { name: string; photoUrl?: string }; assistant?: { name: string; photoUrl?: string } }
  | { assistant: { name: string; photoUrl?: string }; director?: { name: string; photoUrl?: string } };
import { RegisteredTeam } from './data';

/**
 * Normaliza el staff técnico de un equipo, asegurando estructura y nombres.
 */
export function normalizeTechnicalStaff(
  technicalStaff: { director?: { name: string; photoUrl?: string }; assistant?: { name: string; photoUrl?: string } } | undefined
): TechnicalStaffClean | undefined {
  if (!technicalStaff) return undefined;
  const result: any = {};
  if (technicalStaff.director && typeof technicalStaff.director.name === 'string' && technicalStaff.director.name.trim()) {
    const director: { name: string; photoUrl?: string } = { name: technicalStaff.director.name.trim() };
    if (technicalStaff.director.photoUrl) director.photoUrl = technicalStaff.director.photoUrl;
    result.director = director;
  }
  if (technicalStaff.assistant && typeof technicalStaff.assistant.name === 'string' && technicalStaff.assistant.name.trim()) {
    const assistant: { name: string; photoUrl?: string } = { name: technicalStaff.assistant.name.trim() };
    if (technicalStaff.assistant.photoUrl) assistant.photoUrl = technicalStaff.assistant.photoUrl;
    result.assistant = assistant;
  }
  return Object.keys(result).length > 0 ? result as TechnicalStaffClean : undefined;
} 

/**
 * Intenta transcodificar un video para optimizar su peso/formato.
 * Por ahora, retorna el mismo buffer. Integrar ffmpeg u otro en el futuro.
 * @param {Buffer} videoBuffer - Buffer del video original
 * @returns {Promise<Buffer>} - Buffer del video transcodificado (o el original)
 */
export async function transcodeVideoIfPossible(videoBuffer: Buffer): Promise<Buffer> {
  // TODO: Integrar lógica real de transcodificación (ffmpeg, cloud, etc.)
  return videoBuffer;
}
