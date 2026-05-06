import { emitLiveUpdate, emitToRoom } from './io';
import { v4 as uuidv4 } from 'uuid'
import type { RegisteredTeam } from './data'

export type LiveEventType =
  | 'shot'
  | 'goal'
  | 'own_goal'
  | 'penalty_goal'
  | 'penalty_miss'
  | 'yellow'
  | 'red'
  | 'double_yellow'
  | 'assist'
  | 'substitution'
  | 'staff_yellow'
  | 'staff_red'

export type LiveStaffRole = 'director' | 'assistant'

export interface Player {
  id: string
  name: string
  nickname: string
  number: number
  position: string
  age: number
  photoUrl?: string
  registrationStatus?: 'pending' | 'registered'
}

export interface TeamStats {
  shots: number
  goals: number
  yellows: number
  reds: number
  assists: number
}

export interface PlayerStats {
  shots: number
  goals: number
  yellows: number
  reds: number
  assists: number
}

export interface TeamLive {
  id: string
  name: string
  technicalStaff?: {
    director?: { name: string; photoUrl?: string }
    assistant?: { name: string; photoUrl?: string }
  }
  players: Player[]
  starters: string[]
  substitutes: string[]
  formationKey?: string
  redCarded: string[]
  staffDiscipline: {
    director: { name?: string; yellows: number; reds: number; sentOff: boolean }
    assistant: { name?: string; yellows: number; reds: number; sentOff: boolean }
  }
  stats: TeamStats
  playerStats: Record<string, PlayerStats>
}

export interface MatchSettings {
  playersOnField: number
  matchMinutes: number
  breakMinutes: number
  homeHasBye: boolean
  awayHasBye: boolean
}

export interface MatchTimer {
  running: boolean
  startedAt: number | null
  elapsedSeconds: number
}

export type LiveMatchPhase = 'first_half' | 'second_half' | 'penalty_shootout'

export interface PenaltyKick {
  team: 'home' | 'away'
  result: 'goal' | 'miss'
}

export interface PenaltyShootoutData {
  kicks: PenaltyKick[]
  homeScore: number
  awayScore: number
}

export interface MatchEvent {
  id: string
  timestamp: string
  teamId: string
  playerId: string | null
  substitutionInPlayerId?: string
  type: LiveEventType
  staffRole?: LiveStaffRole
  minute: number
  elapsedSeconds: number
  clock: string
}

export interface LiveMatch {
  id: string
  leagueName: string
  categoryName: string
  status: 'scheduled' | 'live' | 'finished'
  phase?: LiveMatchPhase
  homeTeam: TeamLive
  awayTeam: TeamLive
  settings: MatchSettings
  timer: MatchTimer
  events: MatchEvent[]
  penaltyShootout?: PenaltyShootoutData
}

/** All in-memory live match stores, keyed by matchId */
export const liveStores = new Map<string, LiveMatch>()

// ─── Pure helpers ─────────────────────────────────────────────────────────────

const emptyStats = (): TeamStats => ({ shots: 0, goals: 0, yellows: 0, reds: 0, assists: 0 })
const emptyPlayerStats = (): PlayerStats => ({ shots: 0, goals: 0, yellows: 0, reds: 0, assists: 0 })
const emptyStaffDiscipline = (name?: string) => ({ ...(name ? { name } : {}), yellows: 0, reds: 0, sentOff: false })

const createTeamFromRegistered = (team: RegisteredTeam, playersOnField: number): TeamLive => {
  const players = team.players.map((p) => ({
    id: p.id,
    name: p.name,
    nickname: p.nickname,
    number: p.number,
    position: p.position,
    age: p.age,
    ...(p.photoUrl ? { photoUrl: p.photoUrl } : {}),
    ...(p.registrationStatus ? { registrationStatus: p.registrationStatus } : {}),
  }))
  const starters = players.slice(0, playersOnField).map((p) => p.id)
  const substitutes = players.slice(playersOnField).map((p) => p.id)
  const playerStats: Record<string, PlayerStats> = {}
  players.forEach((p) => { playerStats[p.id] = emptyPlayerStats() })
  return {
    id: team.id,
    name: team.name,
    ...(team.technicalStaff ? { technicalStaff: team.technicalStaff } : {}),
    players,
    starters,
    substitutes,
    redCarded: [],
    staffDiscipline: {
      director: emptyStaffDiscipline(team.technicalStaff?.director?.name),
      assistant: emptyStaffDiscipline(team.technicalStaff?.assistant?.name),
    },
    stats: emptyStats(),
    playerStats,
  }
}

const formatClock = (seconds: number) => {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ─── Per-match operations ──────────────────────────────────────────────────────

const getStore = (matchId: string): LiveMatch | null => liveStores.get(matchId) ?? null

export const getElapsedSeconds = (matchId: string): number => {
  const store = getStore(matchId)
  if (!store) return 0
  if (!store.timer.running || !store.timer.startedAt) return store.timer.elapsedSeconds
  return store.timer.elapsedSeconds + Math.max(Math.floor((Date.now() - store.timer.startedAt) / 1000), 0)
}

export const getCurrentMinute = (matchId: string): number => Math.floor(getElapsedSeconds(matchId) / 60)

const findTeam = (store: LiveMatch, teamId: string): TeamLive | null => {
  if (store.homeTeam.id === teamId) return store.homeTeam
  if (store.awayTeam.id === teamId) return store.awayTeam
  return null
}

const findOpponentTeam = (store: LiveMatch, teamId: string): TeamLive | null => {
  if (store.homeTeam.id === teamId) return store.awayTeam
  if (store.awayTeam.id === teamId) return store.homeTeam
  return null
}

const decrement = (value: number): number => Math.max(0, value - 1)

export const syncLiveTeamFromRegistered = (matchId: string, team: RegisteredTeam, playersOnField: number): boolean => {
  const store = getStore(matchId)
  if (!store) return false
  const liveTeam = findTeam(store, team.id)
  if (!liveTeam) return false

  const players = team.players.map((p) => ({
    id: p.id,
    name: p.name,
    nickname: p.nickname,
    number: p.number,
    position: p.position,
    age: p.age,
    ...(p.photoUrl ? { photoUrl: p.photoUrl } : {}),
    ...(p.registrationStatus ? { registrationStatus: p.registrationStatus } : {}),
  }))

  const availableIds = new Set(players.map((p) => p.id))
  liveTeam.players = players
  liveTeam.redCarded = liveTeam.redCarded.filter((id) => availableIds.has(id))

  const redCardedIds = new Set(liveTeam.redCarded)
  const preservedStarters = liveTeam.starters.filter((id) => availableIds.has(id) && !redCardedIds.has(id))
  const startersSet = new Set(preservedStarters)

  for (const p of players) {
    if (preservedStarters.length >= playersOnField) break
    if (!startersSet.has(p.id) && !redCardedIds.has(p.id)) {
      preservedStarters.push(p.id)
      startersSet.add(p.id)
    }
  }

  liveTeam.starters = preservedStarters.slice(0, Math.max(0, playersOnField))
  liveTeam.substitutes = players.map((p) => p.id).filter((id) => !startersSet.has(id) && !redCardedIds.has(id))

  const nextPlayerStats: Record<string, PlayerStats> = {}
  players.forEach((p) => { nextPlayerStats[p.id] = liveTeam.playerStats[p.id] ?? emptyPlayerStats() })
  liveTeam.playerStats = nextPlayerStats

  if (team.technicalStaff) liveTeam.technicalStaff = team.technicalStaff
  else delete liveTeam.technicalStaff

  liveTeam.staffDiscipline = {
    director: {
      ...liveTeam.staffDiscipline.director,
      ...(team.technicalStaff?.director?.name ? { name: team.technicalStaff.director.name } : {}),
    },
    assistant: {
      ...liveTeam.staffDiscipline.assistant,
      ...(team.technicalStaff?.assistant?.name ? { name: team.technicalStaff.assistant.name } : {}),
    },
  }
  return true
}

/** Syncs a team across ALL active live match stores. Returns updated matchIds. */
export const syncTeamInAllMatches = (team: RegisteredTeam, playersOnField: number): string[] => {
  const updated: string[] = []
  for (const matchId of liveStores.keys()) {
    if (syncLiveTeamFromRegistered(matchId, team, playersOnField)) updated.push(matchId)
  }
  return updated
}

export const updateLineup = (matchId: string, teamId: string, starters: string[], substitutes: string[]) => {
  const store = getStore(matchId)
  if (!store) return { ok: false as const, message: 'Partido no encontrado en memoria' }
  const team = findTeam(store, teamId)
  if (!team) return { ok: false as const, message: 'Equipo no encontrado' }

  const availableIds = new Set(team.players.map((p) => p.id))
  const validStarters = starters.filter((id) => availableIds.has(id) && !team.redCarded.includes(id))
  const validSubstitutes = substitutes.filter((id) => availableIds.has(id) && !validStarters.includes(id))

  if (validStarters.length > store.settings.playersOnField) {
    return { ok: false as const, message: 'Titulares exceden el maximo permitido por regla' }
  }

  team.starters = validStarters
  team.substitutes = validSubstitutes
  return { ok: true as const }
}

export const updateLineupWithFormation = (
  matchId: string,
  teamId: string,
  starters: string[],
  substitutes: string[],
  formationKey?: string,
) => {
  const result = updateLineup(matchId, teamId, starters, substitutes)
  if (!result.ok) return result
  const store = getStore(matchId)!
  const team = findTeam(store, teamId)!
  if (formationKey?.trim()) team.formationKey = formationKey.trim()
  return { ok: true as const }
}

export const setTimerAction = (matchId: string, action: 'start' | 'stop' | 'reset') => {
  const store = getStore(matchId)
  if (!store) return

  if (action === 'start' && !store.timer.running) {
    store.timer.running = true
    store.timer.startedAt = Date.now()
    store.status = 'live'
    return
  }

  if (action === 'stop' && store.timer.running) {
    store.timer.elapsedSeconds = getElapsedSeconds(matchId)
    store.timer.running = false
    store.timer.startedAt = null
    return
  }

  if (action === 'reset') {
    const resetTeam = (team: TeamLive) => {
      team.stats = emptyStats()
      team.redCarded = []
      delete team.formationKey
      team.starters = []
      team.substitutes = team.players.map((p) => p.id)
      team.playerStats = team.players.reduce<Record<string, PlayerStats>>((acc, p) => {
        acc[p.id] = emptyPlayerStats()
        return acc
      }, {})
      team.staffDiscipline = {
        director: emptyStaffDiscipline(team.technicalStaff?.director?.name),
        assistant: emptyStaffDiscipline(team.technicalStaff?.assistant?.name),
      }
    }
    store.timer = { running: false, startedAt: null, elapsedSeconds: 0 }
    store.status = 'scheduled'
    store.events = []
    resetTeam(store.homeTeam)
    resetTeam(store.awayTeam)
  }
}

export const setMatchStatusAction = (matchId: string, action: 'finish') => {
  const store = getStore(matchId)
  if (!store) return
  if (action === 'finish') {
    store.timer.elapsedSeconds = getElapsedSeconds(matchId)
    store.timer.running = false
    store.timer.startedAt = null
    store.status = 'finished'
  }
}

const applyStatByEvent = (store: LiveMatch, team: TeamLive, eventType: LiveEventType, playerId: string | null, staffRole?: LiveStaffRole) => {
  const opponent = findOpponentTeam(store, team.id)
  if (eventType === 'staff_yellow' || eventType === 'staff_red') {
    if (!staffRole) return
    const s = team.staffDiscipline[staffRole]
    if (eventType === 'staff_yellow') s.yellows += 1
    if (eventType === 'staff_red') { s.reds += 1; s.sentOff = true }
    return
  }
  if (eventType === 'shot') team.stats.shots += 1
  if (eventType === 'goal') team.stats.goals += 1
  if (eventType === 'own_goal' && opponent) opponent.stats.goals += 1
  if (eventType === 'penalty_goal') { team.stats.goals += 1; team.stats.shots += 1 }
  if (eventType === 'penalty_miss') team.stats.shots += 1
  if (eventType === 'yellow') team.stats.yellows += 1
  if (eventType === 'red') team.stats.reds += 1
  if (eventType === 'double_yellow') { team.stats.yellows += 1; team.stats.reds += 1 }
  if (eventType === 'assist') team.stats.assists += 1
  if (!playerId) return
  const ps = team.playerStats[playerId]
  if (!ps) return
  if (eventType === 'shot') ps.shots += 1
  if (eventType === 'goal') ps.goals += 1
  if (eventType === 'penalty_goal') { ps.goals += 1; ps.shots += 1 }
  if (eventType === 'penalty_miss') ps.shots += 1
  if (eventType === 'yellow') ps.yellows += 1
  if (eventType === 'red') ps.reds += 1
  if (eventType === 'double_yellow') { ps.yellows += 1; ps.reds += 1 }
  if (eventType === 'assist') ps.assists += 1
  if (eventType === 'red' || eventType === 'double_yellow') {
    if (!team.redCarded.includes(playerId)) team.redCarded.push(playerId)
  }
}

const reverseStatByEvent = (store: LiveMatch, team: TeamLive, eventType: LiveEventType, playerId: string | null, staffRole?: LiveStaffRole) => {
  const opponent = findOpponentTeam(store, team.id)
  if (eventType === 'staff_yellow' || eventType === 'staff_red') {
    if (!staffRole) return
    const s = team.staffDiscipline[staffRole]
    if (eventType === 'staff_yellow') s.yellows = decrement(s.yellows)
    if (eventType === 'staff_red') {
      s.reds = decrement(s.reds)
      s.sentOff = s.reds > 0
    }
    return
  }

  if (eventType === 'shot') team.stats.shots = decrement(team.stats.shots)
  if (eventType === 'goal') team.stats.goals = decrement(team.stats.goals)
  if (eventType === 'own_goal' && opponent) opponent.stats.goals = decrement(opponent.stats.goals)
  if (eventType === 'penalty_goal') {
    team.stats.goals = decrement(team.stats.goals)
    team.stats.shots = decrement(team.stats.shots)
  }
  if (eventType === 'penalty_miss') team.stats.shots = decrement(team.stats.shots)
  if (eventType === 'yellow') team.stats.yellows = decrement(team.stats.yellows)
  if (eventType === 'red') team.stats.reds = decrement(team.stats.reds)
  if (eventType === 'double_yellow') {
    team.stats.yellows = decrement(team.stats.yellows)
    team.stats.reds = decrement(team.stats.reds)
  }
  if (eventType === 'assist') team.stats.assists = decrement(team.stats.assists)
  if (!playerId) return

  const ps = team.playerStats[playerId]
  if (!ps) return
  if (eventType === 'shot') ps.shots = decrement(ps.shots)
  if (eventType === 'goal') ps.goals = decrement(ps.goals)
  if (eventType === 'penalty_goal') {
    ps.goals = decrement(ps.goals)
    ps.shots = decrement(ps.shots)
  }
  if (eventType === 'penalty_miss') ps.shots = decrement(ps.shots)
  if (eventType === 'yellow') ps.yellows = decrement(ps.yellows)
  if (eventType === 'red') ps.reds = decrement(ps.reds)
  if (eventType === 'double_yellow') {
    ps.yellows = decrement(ps.yellows)
    ps.reds = decrement(ps.reds)
  }
  if (eventType === 'assist') ps.assists = decrement(ps.assists)
  if (eventType === 'red' || eventType === 'double_yellow') {
    if (ps.reds <= 0) team.redCarded = team.redCarded.filter((id) => id !== playerId)
  }
}

const resetTeamStatsAndDiscipline = (team: TeamLive) => {
  team.stats = emptyStats()
  team.redCarded = []
  const nextPlayerStats: Record<string, PlayerStats> = {}
  team.players.forEach((p) => {
    nextPlayerStats[p.id] = emptyPlayerStats()
  })
  team.playerStats = nextPlayerStats
  team.staffDiscipline = {
    director: emptyStaffDiscipline(team.technicalStaff?.director?.name),
    assistant: emptyStaffDiscipline(team.technicalStaff?.assistant?.name),
  }
}

const rebuildMatchStatsFromEvents = (store: LiveMatch) => {
  resetTeamStatsAndDiscipline(store.homeTeam)
  resetTeamStatsAndDiscipline(store.awayTeam)

  // Events are stored newest first; replay oldest -> newest for deterministic rebuild.
  const chronological = [...store.events].reverse()
  chronological.forEach((event) => {
    const team = findTeam(store, event.teamId)
    if (!team) return
    applyStatByEvent(store, team, event.type, event.playerId, event.staffRole)
  })
}

export const registerEvent = (
  matchId: string,
  teamId: string,
  eventType: LiveEventType,
  playerId: string | null,
  options?: { staffRole?: LiveStaffRole; substitutionInPlayerId?: string },
) => {
  const store = getStore(matchId)
  if (!store) return { ok: false as const, message: 'Partido no encontrado en memoria' }
  if (store.status === 'scheduled') return { ok: false as const, message: 'Debes iniciar el partido para registrar eventos' }
  if (store.status === 'finished') return { ok: false as const, message: 'Partido finalizado: no se pueden registrar mas eventos' }
  const team = findTeam(store, teamId)
  if (!team) return { ok: false as const, message: 'Equipo no encontrado' }

  if (eventType === 'staff_yellow' || eventType === 'staff_red') {
    if (playerId !== null) return { ok: false as const, message: 'Eventos de DT/AT no deben incluir jugadora' }
    if (options?.substitutionInPlayerId) return { ok: false as const, message: 'Eventos de DT/AT no deben incluir jugadora de cambio' }
    const staffRole = options?.staffRole
    if (!staffRole) return { ok: false as const, message: 'Debes indicar si la tarjeta es para DT o AT' }
    const staffName = team.technicalStaff?.[staffRole]?.name?.trim()
    if (!staffName) return { ok: false as const, message: staffRole === 'director' ? 'Este equipo no tiene DT registrado' : 'Este equipo no tiene AT registrado' }
    applyStatByEvent(store, team, eventType, null, staffRole)
    const e1 = getElapsedSeconds(matchId)
    store.events.unshift({ id: uuidv4(), timestamp: new Date().toISOString(), teamId, playerId: null, type: eventType, staffRole, minute: Math.floor(e1 / 60), elapsedSeconds: e1, clock: formatClock(e1) })
    return { ok: true as const }
  }

  if (eventType === 'substitution') {
    if (!playerId) return { ok: false as const, message: 'Debes indicar la jugadora que sale' }
    const inId = options?.substitutionInPlayerId
    if (!inId) return { ok: false as const, message: 'Debes indicar la jugadora que entra' }
    if (inId === playerId) return { ok: false as const, message: 'Las jugadoras del cambio deben ser distintas' }
    if (!team.players.some((p) => p.id === inId)) return { ok: false as const, message: 'Jugador que entra no inscrito en el equipo' }
    if (team.redCarded.includes(inId)) return { ok: false as const, message: 'Jugador que entra expulsado: no puede reingresar' }
  }

  if (playerId) {
    if (!team.players.some((p) => p.id === playerId)) return { ok: false as const, message: 'Jugador no inscrito en el equipo' }
    if (team.redCarded.includes(playerId)) return { ok: false as const, message: 'Jugador expulsado: no puede registrar mas acciones' }
    if (eventType !== 'substitution' && !team.starters.includes(playerId)) return { ok: false as const, message: 'Solo jugadores en cancha pueden registrar este evento' }
  }

  applyStatByEvent(store, team, eventType, playerId)
  const e2 = getElapsedSeconds(matchId)
  store.events.unshift({
    id: uuidv4(), timestamp: new Date().toISOString(), teamId, playerId,
    ...(eventType === 'substitution' && options?.substitutionInPlayerId ? { substitutionInPlayerId: options.substitutionInPlayerId } : {}),
    type: eventType, minute: Math.floor(e2 / 60), elapsedSeconds: e2, clock: formatClock(e2),
  })
  return { ok: true as const }
}

export const undoLastEvent = (matchId: string) => {
  const store = getStore(matchId)
  if (!store) return { ok: false as const, message: 'Partido no encontrado en memoria' }
  if (store.status === 'finished') return { ok: false as const, message: 'Partido finalizado: no se pueden anular eventos' }
  if (store.events.length === 0) return { ok: false as const, message: 'No hay eventos para anular' }

  const lastEvent = store.events.shift()
  if (!lastEvent) return { ok: false as const, message: 'No hay eventos para anular' }

  const team = findTeam(store, lastEvent.teamId)
  if (!team) return { ok: false as const, message: 'Equipo del evento no encontrado' }

  reverseStatByEvent(store, team, lastEvent.type, lastEvent.playerId, lastEvent.staffRole)
  return { ok: true as const, event: lastEvent }
}

export const removeEventById = (matchId: string, eventId: string) => {
  const store = getStore(matchId)
  if (!store) return { ok: false as const, message: 'Partido no encontrado en memoria' }
  if (store.status === 'finished') return { ok: false as const, message: 'Partido finalizado: no se pueden eliminar eventos' }

  const targetIndex = store.events.findIndex((event) => event.id === eventId)
  if (targetIndex === -1) return { ok: false as const, message: 'Evento no encontrado' }

  const [removed] = store.events.splice(targetIndex, 1)
  rebuildMatchStatsFromEvents(store)
  return { ok: true as const, event: removed }
}

export const updateSettings = (matchId: string, payload: Partial<MatchSettings>) => {
  const store = getStore(matchId)
  if (!store) return
  store.settings = { ...store.settings, ...payload }
}

export const loadMatchForLive = (
  matchId: string,
  payload: {
    leagueName: string
    categoryName: string
    homeTeam: RegisteredTeam
    awayTeam: RegisteredTeam
    playersOnField: number
    matchMinutes: number
    breakMinutes: number
  },
) => {
  liveStores.set(matchId, {
    id: matchId,
    leagueName: payload.leagueName,
    categoryName: payload.categoryName,
    homeTeam: createTeamFromRegistered(payload.homeTeam, payload.playersOnField),
    awayTeam: createTeamFromRegistered(payload.awayTeam, payload.playersOnField),
    settings: {
      playersOnField: payload.playersOnField,
      matchMinutes: payload.matchMinutes,
      breakMinutes: payload.breakMinutes,
      homeHasBye: false,
      awayHasBye: false,
    },
    timer: { running: false, startedAt: null, elapsedSeconds: 0 },
    status: 'scheduled',
    events: [],
  })
}

// ─── Penalty shootout ─────────────────────────────────────────────────────────

export const startPenaltyShootout = (matchId: string): { ok: boolean; message: string } => {
  const store = getStore(matchId)
  if (!store) return { ok: false, message: 'Partido no encontrado' }
  if (store.status !== 'live') return { ok: false, message: 'El partido debe estar en estado live' }
  if (store.phase === 'penalty_shootout') return { ok: false, message: 'La tanda de penales ya está activa' }
  store.phase = 'penalty_shootout'
  store.penaltyShootout = { kicks: [], homeScore: 0, awayScore: 0 }
  return { ok: true, message: 'Tanda de penales iniciada' }
}

export const registerPenaltyKick = (
  matchId: string,
  team: 'home' | 'away',
  result: 'goal' | 'miss',
): { ok: boolean; message: string } => {
  const store = getStore(matchId)
  if (!store) return { ok: false, message: 'Partido no encontrado' }
  if (store.phase !== 'penalty_shootout') return { ok: false, message: 'La tanda de penales no está activa' }
  if (!store.penaltyShootout) store.penaltyShootout = { kicks: [], homeScore: 0, awayScore: 0 }
  store.penaltyShootout.kicks.push({ team, result })
  if (result === 'goal') {
    if (team === 'home') store.penaltyShootout.homeScore += 1
    else store.penaltyShootout.awayScore += 1
  }
  return { ok: true, message: 'Tiro registrado' }
}

export const buildLiveSnapshot = (matchId: string): LiveMatch & { currentMinute: number } => {
  const store = getStore(matchId)
  if (!store) {
    return {
      id: matchId, leagueName: '', categoryName: '', status: 'scheduled',
      homeTeam: { id: '', name: '', players: [], starters: [], substitutes: [], redCarded: [], staffDiscipline: { director: { yellows: 0, reds: 0, sentOff: false }, assistant: { yellows: 0, reds: 0, sentOff: false } }, stats: emptyStats(), playerStats: {} },
      awayTeam: { id: '', name: '', players: [], starters: [], substitutes: [], redCarded: [], staffDiscipline: { director: { yellows: 0, reds: 0, sentOff: false }, assistant: { yellows: 0, reds: 0, sentOff: false } }, stats: emptyStats(), playerStats: {} },
      settings: { playersOnField: 0, matchMinutes: 0, breakMinutes: 0, homeHasBye: false, awayHasBye: false },
      timer: { running: false, startedAt: null, elapsedSeconds: 0 },
      events: [],
      currentMinute: 0,
    }
  }
  return {
    ...store,
    timer: { ...store.timer, elapsedSeconds: getElapsedSeconds(matchId) },
    currentMinute: getCurrentMinute(matchId),
  }
}

/** Returns snapshots of ALL active in-memory matches */
export const buildAllLiveSnapshots = (): Array<LiveMatch & { currentMinute: number }> =>
  Array.from(liveStores.keys()).map((id) => buildLiveSnapshot(id))

/**
 * Broadcasts the snapshot of a specific match:
 *  - to socket room `match:<matchId>` -> event `live:update`  (per-match subscribers)
 *  - to ALL connected clients         -> event `live:all`     (ClientPortal multi-match view)
 */
export const broadcastLive = (matchId: string): void => {
  emitToRoom(`match:${matchId}`, 'live:update', buildLiveSnapshot(matchId))
  emitLiveUpdate('live:all', buildAllLiveSnapshots())
}
