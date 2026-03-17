import { RegisteredTeam } from './data';

/**
 * Genera alias posibles para un nombre de equipo (mayúsculas, minúsculas, sin tildes, etc).
 */
export function buildTeamNameAliases(name: string): string[] {
  const base = name.trim();
  const lower = base.toLowerCase();
  const noSpaces = lower.replace(/\s+/g, '');
  return [base, lower, noSpaces];
}

/**
 * Busca un equipo por alias en un mapa { alias: RegisteredTeam }.
 */
export function resolveTeamFromAliasMap(aliasMap: Record<string, RegisteredTeam>, name: string): RegisteredTeam | undefined {
  const aliases = buildTeamNameAliases(name);
  for (const alias of aliases) {
    if (aliasMap[alias]) return aliasMap[alias];
  }
  return undefined;
}
