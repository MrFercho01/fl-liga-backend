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
