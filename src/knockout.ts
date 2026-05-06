import { v4 as uuidv4 } from 'uuid'
import type { FixtureScheduleEntry } from './data'

// ─── Types ─────────────────────────────────────────────────────────────────

export type KnockoutFormat =
  | 'final_2'
  | 'semi_4'
  | 'quarter_8'
  | 'r16_16'
  | 'r32_32'

export type KnockoutSeedingMethod = 'intelligent' | 'random'

export interface KnockoutTeamEntry {
  teamId: string
  teamName: string
  position: number // position in group-stage standings
}

export interface KnockoutMatch {
  id: string                    // unique id for this match
  slot: number                  // 0-indexed position in round
  homeTeamId: string | null     // null = TBD (awaiting previous round)
  awayTeamId: string | null     // null = TBD or bye
  homeTeamName: string | null
  awayTeamName: string | null
  isBye: boolean                // true if awayTeam is a bye → homeTeam auto-advances
  homeGoals: number | null
  awayGoals: number | null
  penaltyHome: number | null
  penaltyAway: number | null
  winnerId: string | null
  winnerName: string | null
  status: 'pending' | 'finished'
  // Feeding: which previous round slot feeds each team into this match
  homeFromRoundIdx: number | null
  homeFromSlot: number | null
  awayFromRoundIdx: number | null
  awayFromSlot: number | null
  // Fixture integration
  fixtureRound: number          // high number (1001+) so it appears after regular season
}

export interface KnockoutRound {
  index: number
  name: string                  // 'Dieciseisavos', 'Octavos', 'Cuartos de final', 'Semifinales', 'Final'
  fixtureRound: number
  matches: KnockoutMatch[]
}

export interface KnockoutBracket {
  id: string
  leagueId: string
  categoryId: string
  format: KnockoutFormat
  seedingMethod: KnockoutSeedingMethod
  qualifiedTeams: KnockoutTeamEntry[]
  rounds: KnockoutRound[]
  createdAt: string
  updatedAt: string
}

// ─── Format helpers ─────────────────────────────────────────────────────────

export interface KnockoutFormatOption {
  format: KnockoutFormat
  label: string
  teamsNeeded: number
  roundNames: string[]
}

const ROUND_NAMES_BY_SIZE: Record<number, string> = {
  32: 'Treintaidosavos',
  16: 'Dieciseisavos',
  8: 'Octavos de final',
  4: 'Cuartos de final',
  2: 'Semifinales',
  1: 'Final',
}

const FIXTURE_ROUND_BASE = 1001

/** Returns the list of format options compatible with N teams.
 *  A format is compatible if teamsNeeded <= n (extra teams get byes). */
export const getAvailableFormats = (n: number): KnockoutFormatOption[] => {
  const options: KnockoutFormatOption[] = []

  if (n >= 2) {
    options.push({
      format: 'final_2',
      label: 'Final directa (2 equipos)',
      teamsNeeded: 2,
      roundNames: ['Final'],
    })
  }
  if (n >= 3) {
    options.push({
      format: 'semi_4',
      label: 'Semifinales + Final (4 equipos)',
      teamsNeeded: 4,
      roundNames: ['Semifinales', 'Final'],
    })
  }
  if (n >= 5) {
    options.push({
      format: 'quarter_8',
      label: 'Cuartos + Semis + Final (8 equipos)',
      teamsNeeded: 8,
      roundNames: ['Cuartos de final', 'Semifinales', 'Final'],
    })
  }
  if (n >= 9) {
    options.push({
      format: 'r16_16',
      label: 'Dieciseisavos + Cuartos + Semis + Final (16 equipos)',
      teamsNeeded: 16,
      roundNames: ['Dieciseisavos', 'Cuartos de final', 'Semifinales', 'Final'],
    })
  }
  if (n >= 17) {
    options.push({
      format: 'r32_32',
      label: 'Treintaidosavos + ... + Final (32 equipos)',
      teamsNeeded: 32,
      roundNames: ['Treintaidosavos', 'Dieciseisavos', 'Cuartos de final', 'Semifinales', 'Final'],
    })
  }

  return options
}

const formatToSlots: Record<KnockoutFormat, number> = {
  final_2: 2,
  semi_4: 4,
  quarter_8: 8,
  r16_16: 16,
  r32_32: 32,
}

const formatToRoundNames: Record<KnockoutFormat, string[]> = {
  final_2: ['Final'],
  semi_4: ['Semifinales', 'Final'],
  quarter_8: ['Cuartos de final', 'Semifinales', 'Final'],
  r16_16: ['Dieciseisavos', 'Cuartos de final', 'Semifinales', 'Final'],
  r32_32: ['Treintaidosavos', 'Dieciseisavos', 'Cuartos de final', 'Semifinales', 'Final'],
}

// ─── Seeding logic ──────────────────────────────────────────────────────────

/** Intelligent seeding: produces bracket pairings so that
 *  if all higher-seeded teams win, finals are 1v2, semis are 1v4 and 2v3, etc.
 *  Returns pairs [homeIdx, awayIdx] of seeds (0-indexed) for each QR1 slot.
 *  For byes, awayIdx is -1. */
const buildSeedingPairs = (slots: number, teamCount: number): [number, number][] => {
  // Start with ordered seed numbers [1..slots] (1-indexed)
  // and arrange them in the standard bracket pairing for one round
  const arrange = (seeds: number[]): number[] => {
    if (seeds.length === 1) return seeds
    const half = seeds.length / 2
    const top = seeds.slice(0, half)
    const bottom = [...seeds.slice(half)].reverse()
    const result: number[] = []
    for (let i = 0; i < top.length; i++) {
      result.push(top[i]!, bottom[i]!)
    }
    return result
  }

  const ordered = arrange(Array.from({ length: slots }, (_, i) => i + 1))
  const pairs: [number, number][] = []
  for (let i = 0; i < ordered.length; i += 2) {
    const homeIdx = (ordered[i] ?? 1) - 1    // 0-indexed seed
    const awayIdx = (ordered[i + 1] ?? 1) - 1
    const isByeSlot = homeIdx < teamCount && awayIdx >= teamCount
    pairs.push([homeIdx, isByeSlot ? -1 : awayIdx])
  }
  return pairs
}

// ─── Build bracket ──────────────────────────────────────────────────────────

export const buildBracket = (params: {
  leagueId: string
  categoryId: string
  format: KnockoutFormat
  seedingMethod: KnockoutSeedingMethod
  qualifiedTeams: KnockoutTeamEntry[]  // ordered by position ASC (position 1 = best)
}): KnockoutBracket => {
  const { leagueId, categoryId, format, seedingMethod, qualifiedTeams } = params
  const slots = formatToSlots[format]
  const roundNames = formatToRoundNames[format]
  const roundCount = roundNames.length

  // Pad or truncate team list to `slots`
  const teams: (KnockoutTeamEntry | null)[] = [...qualifiedTeams.slice(0, slots)]
  while (teams.length < slots) teams.push(null)

  // Determine first-round pairings
  let pairs: [number, number][]
  if (seedingMethod === 'intelligent') {
    pairs = buildSeedingPairs(slots, qualifiedTeams.length)
  } else {
    // Random: shuffle indices then pair
    const indices = Array.from({ length: slots }, (_, i) => i)
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = tmp;
    }
    pairs = []
    for (let i = 0; i < indices.length; i += 2) {
      const homeIdx = indices[i] ?? 0
      const awayIdx = indices[i + 1] ?? 0
      pairs.push([homeIdx, awayIdx >= qualifiedTeams.length ? -1 : awayIdx])
    }
  }

  // Build rounds structure
  const rounds: KnockoutRound[] = []
  for (let ri = 0; ri < roundCount; ri++) {
    const matchesInRound = slots / Math.pow(2, ri + 1)
    const fixtureRound = FIXTURE_ROUND_BASE + ri
    const matches: KnockoutMatch[] = []

    for (let slot = 0; slot < matchesInRound; slot++) {
      const matchId = uuidv4()
      const pair = pairs[slot] ?? [0, -1]
      const isBye = ri === 0 && pair[1] === -1
      const homeTeam = ri === 0 ? (teams[pair[0]] ?? null) : null
      const awayTeam = ri === 0 && !isBye ? (teams[pair[1] === -1 ? 0 : pair[1]] ?? null) : null

      matches.push({
        id: matchId,
        slot,
        homeTeamId: homeTeam?.teamId ?? null,
        awayTeamId: isBye ? null : (awayTeam?.teamId ?? null),
        homeTeamName: homeTeam?.teamName ?? null,
        awayTeamName: isBye ? 'BYE' : (awayTeam?.teamName ?? null),
        isBye,
        homeGoals: null,
        awayGoals: null,
        penaltyHome: null,
        penaltyAway: null,
        winnerId: null,
        winnerName: null,
        status: isBye ? 'finished' : 'pending',  // bye matches auto-finish
        homeFromRoundIdx: ri > 0 ? ri - 1 : null,
        homeFromSlot: ri > 0 ? slot * 2 : null,
        awayFromRoundIdx: ri > 0 ? ri - 1 : null,
        awayFromSlot: ri > 0 ? slot * 2 + 1 : null,
        fixtureRound,
      })

      // Auto-advance bye winner
      if (isBye && homeTeam) {
        const byeMatch = matches[slot]!
        byeMatch.winnerId = homeTeam.teamId
        byeMatch.winnerName = homeTeam.teamName
      }
    }

    rounds.push({ index: ri, name: roundNames[ri]!, fixtureRound, matches })
  }

  // Propagate bye winners into round 2 if first round has byes
  const round0 = rounds[0]
  const round1 = rounds[1]
  if (rounds.length > 1 && round0 && round1) {
    for (const r1match of round0.matches) {
      if (r1match.isBye && r1match.winnerId) {
        // Find where this slot feeds into round 2
        for (const r2match of round1.matches) {
          if (r2match.homeFromRoundIdx === 0 && r2match.homeFromSlot === r1match.slot) {
            r2match.homeTeamId = r1match.winnerId
            r2match.homeTeamName = r1match.winnerName
          }
          if (r2match.awayFromRoundIdx === 0 && r2match.awayFromSlot === r1match.slot) {
            r2match.awayTeamId = r1match.winnerId
            r2match.awayTeamName = r1match.winnerName
          }
        }
      }
    }
  }

  return {
    id: uuidv4(),
    leagueId,
    categoryId,
    format,
    seedingMethod,
    qualifiedTeams,
    rounds,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// ─── Build matchId for fixture schedule ────────────────────────────────────

/** Encodes a KnockoutMatch as a fixture matchId compatible with existing parser.
 *  Format: ko__<bracketId>__<homeTeamId>__<awayTeamId>__r<roundIdx>__s<slot>
 *  The existing parser reads parts[2] as homeTeamId and parts[3] as awayTeamId. */
export const buildKnockoutMatchId = (
  bracketId: string,
  roundIdx: number,
  slot: number,
  homeTeamId: string,
  awayTeamId: string,
): string => `ko__${bracketId}__${homeTeamId}__${awayTeamId}__r${roundIdx}__s${slot}`

/** Parse a knockout matchId → returns parts or null if not a knockout id */
export const parseKnockoutMatchId = (matchId: string) => {
  if (!matchId.startsWith('ko__')) return null
  const parts = matchId.split('__')
  if (parts.length < 6) return null
  return {
    bracketId: parts[1]!,
    homeTeamId: parts[2]!,
    awayTeamId: parts[3]!,
    roundIdx: parseInt(parts[4]!.replace('r', ''), 10),
    slot: parseInt(parts[5]!.replace('s', ''), 10),
  }
}

// ─── Generate fixture entries for a round ──────────────────────────────────

/** Builds FixtureScheduleEntry records for all ready (both teams known) matches in a round. */
export const buildFixtureEntriesForRound = (
  bracket: KnockoutBracket,
  roundIdx: number,
): FixtureScheduleEntry[] => {
  const round = bracket.rounds[roundIdx]
  if (!round) return []
  const bracketId = bracket.id

  const entries: FixtureScheduleEntry[] = []
  for (const match of round.matches) {
    if (!match.homeTeamId || !match.awayTeamId || match.isBye) continue
    const homeId = match.homeTeamId
    const awayId = match.awayTeamId
    entries.push({
      leagueId: bracket.leagueId,
      categoryId: bracket.categoryId,
      matchId: buildKnockoutMatchId(bracketId, roundIdx, match.slot, homeId, awayId),
      round: round.fixtureRound,
      scheduledAt: '',   // admin will set date/time later
      status: 'scheduled',
    })
  }
  return entries
}

// ─── Advance winner ─────────────────────────────────────────────────────────

export interface AdvanceWinnerResult {
  updatedBracket: KnockoutBracket
  /** New fixture entries to create (next-round match if both teams are now known) */
  newFixtureEntries: FixtureScheduleEntry[]
}

/** Records result in a knockout match and propagates winner to the next round.
 *  Returns the updated bracket and any new fixture entries to persist. */
export const advanceWinner = (
  bracket: KnockoutBracket,
  knockoutMatchId: string,          // the KnockoutMatch.id (uuid)
  winnerId: string,
  winnerName: string,
  homeGoals: number,
  awayGoals: number,
  penaltyHome: number | null,
  penaltyAway: number | null,
): AdvanceWinnerResult => {
  // Deep-clone to avoid mutation
  const updated: KnockoutBracket = JSON.parse(JSON.stringify(bracket))

  // Find the match
  let foundRoundIdx = -1
  let foundSlot = -1
  for (const round of updated.rounds) {
    for (const match of round.matches) {
      if (match.id === knockoutMatchId) {
        match.homeGoals = homeGoals
        match.awayGoals = awayGoals
        match.penaltyHome = penaltyHome
        match.penaltyAway = penaltyAway
        match.winnerId = winnerId
        match.winnerName = winnerName
        match.status = 'finished'
        foundRoundIdx = round.index
        foundSlot = match.slot
        break
      }
    }
    if (foundRoundIdx !== -1) break
  }

  if (foundRoundIdx === -1) {
    return { updatedBracket: bracket, newFixtureEntries: [] }
  }

  const newFixtureEntries: FixtureScheduleEntry[] = []
  const nextRoundIdx = foundRoundIdx + 1

  if (nextRoundIdx >= updated.rounds.length) {
    // This was the final — no next round
    updated.updatedAt = new Date().toISOString()
    return { updatedBracket: updated, newFixtureEntries }
  }

  const nextRound = updated.rounds[nextRoundIdx]
  if (!nextRound) {
    updated.updatedAt = new Date().toISOString()
    return { updatedBracket: updated, newFixtureEntries }
  }

  // Find which slot in nextRound this feeds
  for (const nextMatch of nextRound.matches) {
    let changed = false
    if (nextMatch.homeFromRoundIdx === foundRoundIdx && nextMatch.homeFromSlot === foundSlot) {
      nextMatch.homeTeamId = winnerId
      nextMatch.homeTeamName = winnerName
      changed = true
    }
    if (nextMatch.awayFromRoundIdx === foundRoundIdx && nextMatch.awayFromSlot === foundSlot) {
      nextMatch.awayTeamId = winnerId
      nextMatch.awayTeamName = winnerName
      changed = true
    }

    // If both slots are now filled, create the fixture entry
    if (changed && nextMatch.homeTeamId && nextMatch.awayTeamId && nextMatch.status === 'pending') {
      newFixtureEntries.push({
        leagueId: updated.leagueId,
        categoryId: updated.categoryId,
        matchId: buildKnockoutMatchId(
          updated.id,
          nextRoundIdx,
          nextMatch.slot,
          nextMatch.homeTeamId as string,
          nextMatch.awayTeamId as string,
        ),
        round: nextRound.fixtureRound,
        scheduledAt: '',
        status: 'scheduled',
      })
    }
  }

  updated.updatedAt = new Date().toISOString()
  return { updatedBracket: updated, newFixtureEntries }
}
