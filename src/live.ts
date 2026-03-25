import { httpServer } from './server-stub';
import { Server } from 'socket.io';
let io: Server | null = null;

/** Inicializa socket.io si no está inicializado */
function getIO(): Server {
  if (!io) {
    io = new Server(httpServer, { cors: { origin: '*' } });
  }
  return io;
}

/**
 * Emite un evento de actualización en vivo a todos los clientes conectados.
 * @param event Nombre del evento
 * @param data  Datos a enviar
 */
export function emitLiveUpdate(event: string, data: any) {
  getIO().emit(event, data);
}

/**
 * Broadcast general para notificar cambios en el partido en vivo.
 * Puede usarse para eventos globales.
 */
export function broadcastLive() {
  getIO().emit('live:broadcast', { timestamp: Date.now() });
}
import { v4 as uuidv4 } from 'uuid'
import type { RegisteredTeam } from './data'

export type LiveEventType =
  | 'shot'
  | 'goal'
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
    director?: {
      name: string
      photoUrl?: string
    }
    assistant?: {
      name: string
      photoUrl?: string
    }
  }
  players: Player[]
  starters: string[]
  substitutes: string[]
  formationKey?: string
  redCarded: string[]
  staffDiscipline: {
    director: {
      name?: string
      yellows: number
      reds: number
      sentOff: boolean
    }
    assistant: {
      name?: string
      yellows: number
      reds: number
      sentOff: boolean
    }
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
  homeTeam: TeamLive
  awayTeam: TeamLive
  settings: MatchSettings
  timer: MatchTimer
  events: MatchEvent[]
}

const positions = ['POR', 'DEF', 'MED', 'DEL']

const createPlayers = (prefix: string): Player[] => {
  return Array.from({ length: 18 }, (_, index) => ({
    id: uuidv4(),
    name: `${prefix} Jugador ${index + 1}`,
    nickname: `Apodo ${index + 1}`,
    number: index + 1,
    position: positions[index % positions.length] ?? 'MED',
    age: 18 + (index % 16),
  }))
}

const emptyStats = (): TeamStats => ({
  shots: 0,
  goals: 0,
  yellows: 0,
  reds: 0,
  assists: 0,
})

const emptyPlayerStats = (): PlayerStats => ({
  shots: 0,
  goals: 0,
  yellows: 0,
  reds: 0,
  assists: 0,
})

const emptyStaffDiscipline = (name?: string) => ({
  ...(name ? { name } : {}),
  yellows: 0,
  reds: 0,
  sentOff: false,
})

const createTeam = (name: string): TeamLive => {
  const players = createPlayers(name)
  const starters = players.slice(0, 11).map((player) => player.id)
  const substitutes = players.slice(11).map((player) => player.id)
  const playerStats: Record<string, PlayerStats> = {}
  players.forEach((player) => {
    playerStats[player.id] = emptyPlayerStats()
  })

  return {
    id: uuidv4(),
    name,
    players,
    starters,
    substitutes,
    redCarded: [],
    staffDiscipline: {
      director: emptyStaffDiscipline(),
      assistant: emptyStaffDiscipline(),
    },
    stats: emptyStats(),
    playerStats,
  }
}

const createTeamFromRegistered = (team: RegisteredTeam, playersOnField: number): TeamLive => {
  const players = team.players.map((player) => ({
    id: player.id,
    name: player.name,
    nickname: player.nickname,
    number: player.number,
    position: player.position,
    age: player.age,
    ...(player.photoUrl ? { photoUrl: player.photoUrl } : {}),
    ...(player.registrationStatus ? { registrationStatus: player.registrationStatus } : {}),
  }))

  const starters = players.slice(0, playersOnField).map((player) => player.id)
  const substitutes = players.slice(playersOnField).map((player) => player.id)
  const playerStats: Record<string, PlayerStats> = {}

  players.forEach((player) => {
    playerStats[player.id] = emptyPlayerStats()
  })

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

export const syncLiveTeamFromRegistered = (team: RegisteredTeam, playersOnField: number) => {
  const liveTeam =
    liveMatchStore.homeTeam.id === team.id
      ? liveMatchStore.homeTeam
      : liveMatchStore.awayTeam.id === team.id
        ? liveMatchStore.awayTeam
        : null

  if (!liveTeam) return false

  const players = team.players.map((player) => ({
    id: player.id,
    name: player.name,
    nickname: player.nickname,
    number: player.number,
    position: player.position,
    age: player.age,
    ...(player.photoUrl ? { photoUrl: player.photoUrl } : {}),
    ...(player.registrationStatus ? { registrationStatus: player.registrationStatus } : {}),
  }))

  const availableIds = new Set(players.map((player) => player.id))
  liveTeam.players = players
  liveTeam.redCarded = liveTeam.redCarded.filter((playerId) => availableIds.has(playerId))

  const redCardedIds = new Set(liveTeam.redCarded)
  const preservedStarters = liveTeam.starters.filter((playerId) => availableIds.has(playerId) && !redCardedIds.has(playerId))
  const startersSet = new Set(preservedStarters)

  for (const player of players) {
    if (preservedStarters.length >= playersOnField) break
    if (!startersSet.has(player.id) && !redCardedIds.has(player.id)) {
      preservedStarters.push(player.id)
      startersSet.add(player.id)
    }
  }

  const substitutes = players
    .map((player) => player.id)
    .filter((playerId) => !startersSet.has(playerId) && !redCardedIds.has(playerId))

  liveTeam.starters = preservedStarters.slice(0, Math.max(0, playersOnField))
  liveTeam.substitutes = substitutes

  const nextPlayerStats: Record<string, PlayerStats> = {}
  players.forEach((player) => {
    nextPlayerStats[player.id] = liveTeam.playerStats[player.id] ?? emptyPlayerStats()
  })
  liveTeam.playerStats = nextPlayerStats

  if (team.technicalStaff) {
    liveTeam.technicalStaff = team.technicalStaff
  } else {
    delete liveTeam.technicalStaff
  }

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

export const liveMatchStore: LiveMatch = {
  id: uuidv4(),
  leagueName: 'Liga Amateur Quito Norte',
  categoryName: 'Libre',
  status: 'scheduled',
  homeTeam: createTeam('FL Cóndores'),
  awayTeam: createTeam('FL Titanes'),
  settings: {
    playersOnField: 11,
    matchMinutes: 90,
    breakMinutes: 15,
    homeHasBye: false,
    awayHasBye: false,
  },
  timer: {
    running: false,
    startedAt: null,
    elapsedSeconds: 0,
  },
  events: [],
}

export const getElapsedSeconds = () => {
  if (!liveMatchStore.timer.running || !liveMatchStore.timer.startedAt) {
    return liveMatchStore.timer.elapsedSeconds
  }

  const delta = Math.floor((Date.now() - liveMatchStore.timer.startedAt) / 1000)
  return liveMatchStore.timer.elapsedSeconds + Math.max(delta, 0)
}

export const getCurrentMinute = () => Math.floor(getElapsedSeconds() / 60)

const formatClock = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  const left = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(left).padStart(2, '0')}`
}

const findTeam = (teamId: string) => {
  if (liveMatchStore.homeTeam.id === teamId) return liveMatchStore.homeTeam
  if (liveMatchStore.awayTeam.id === teamId) return liveMatchStore.awayTeam
  return null
}

export const updateLineup = (teamId: string, starters: string[], substitutes: string[]) => {
  const team = findTeam(teamId)
  if (!team) return { ok: false as const, message: 'Equipo no encontrado' }

  const availableIds = new Set(team.players.map((player) => player.id))
  const validStarters = starters.filter((id) => availableIds.has(id) && !team.redCarded.includes(id))
  const validSubstitutes = substitutes.filter((id) => availableIds.has(id) && !validStarters.includes(id))

  if (validStarters.length > liveMatchStore.settings.playersOnField) {
    return { ok: false as const, message: 'Titulares exceden el máximo permitido por regla' }
  }

  team.starters = validStarters
  team.substitutes = validSubstitutes

  return { ok: true as const }
}

export const updateLineupWithFormation = (
  teamId: string,
  starters: string[],
  substitutes: string[],
  formationKey?: string,
) => {
  const result = updateLineup(teamId, starters, substitutes)
  if (!result.ok) return result

  const team = findTeam(teamId)
  if (!team) return { ok: false as const, message: 'Equipo no encontrado' }

  if (formationKey && formationKey.trim()) {
    team.formationKey = formationKey.trim()
  }

  return { ok: true as const }
}

export const setTimerAction = (action: 'start' | 'stop' | 'reset') => {
  if (action === 'start' && !liveMatchStore.timer.running) {
    liveMatchStore.timer.running = true
    liveMatchStore.timer.startedAt = Date.now()
    liveMatchStore.status = 'live'
    return
  }

  if (action === 'stop' && liveMatchStore.timer.running) {
    liveMatchStore.timer.elapsedSeconds = getElapsedSeconds()
    liveMatchStore.timer.running = false
    liveMatchStore.timer.startedAt = null
    return
  }

  if (action === 'reset') {
    const resetTeamForRestart = (team: TeamLive) => {
      team.stats = emptyStats()
      team.redCarded = []
      delete team.formationKey
      team.starters = []
      team.substitutes = team.players.map((player) => player.id)
      team.playerStats = team.players.reduce<Record<string, PlayerStats>>((acc, player) => {
        acc[player.id] = emptyPlayerStats()
        return acc
      }, {})
      team.staffDiscipline = {
        director: emptyStaffDiscipline(team.technicalStaff?.director?.name),
        assistant: emptyStaffDiscipline(team.technicalStaff?.assistant?.name),
      }
    }

    liveMatchStore.timer.running = false
    liveMatchStore.timer.startedAt = null
    liveMatchStore.timer.elapsedSeconds = 0
    liveMatchStore.status = 'scheduled'
    liveMatchStore.events = []
    resetTeamForRestart(liveMatchStore.homeTeam)
    resetTeamForRestart(liveMatchStore.awayTeam)
  }
}

export const setMatchStatusAction = (action: 'finish') => {
  if (action === 'finish') {
    liveMatchStore.timer.elapsedSeconds = getElapsedSeconds()
    liveMatchStore.timer.running = false
    liveMatchStore.timer.startedAt = null
    liveMatchStore.status = 'finished'
  }
}

const applyStatByEvent = (team: TeamLive, eventType: LiveEventType, playerId: string | null, staffRole?: LiveStaffRole) => {
  if (eventType === 'staff_yellow' || eventType === 'staff_red') {
    if (!staffRole) return

    const staffStats = team.staffDiscipline[staffRole]
    if (eventType === 'staff_yellow') {
      staffStats.yellows += 1
    }
    if (eventType === 'staff_red') {
      staffStats.reds += 1
      staffStats.sentOff = true
    }
    return
  }

  if (eventType === 'shot') team.stats.shots += 1
  if (eventType === 'goal') team.stats.goals += 1
  if (eventType === 'penalty_goal') {
    team.stats.goals += 1
    team.stats.shots += 1
  }
  if (eventType === 'penalty_miss') team.stats.shots += 1
  if (eventType === 'yellow') team.stats.yellows += 1
  if (eventType === 'red') team.stats.reds += 1
  if (eventType === 'double_yellow') {
    team.stats.yellows += 1
    team.stats.reds += 1
  }
  if (eventType === 'assist') team.stats.assists += 1

  if (!playerId) return
  const stats = team.playerStats[playerId]
  if (!stats) return

  if (eventType === 'shot') stats.shots += 1
  if (eventType === 'goal') stats.goals += 1
  if (eventType === 'penalty_goal') {
    stats.goals += 1
    stats.shots += 1
  }
  if (eventType === 'penalty_miss') stats.shots += 1
  if (eventType === 'yellow') stats.yellows += 1
  if (eventType === 'red') stats.reds += 1
  if (eventType === 'double_yellow') {
    stats.yellows += 1
    stats.reds += 1
  }
  if (eventType === 'assist') stats.assists += 1

  if (eventType === 'red' || eventType === 'double_yellow') {
    if (!team.redCarded.includes(playerId)) {
      team.redCarded.push(playerId)
    }
  }
}

export const registerEvent = (
  teamId: string,
  eventType: LiveEventType,
  playerId: string | null,
  options?: { staffRole?: LiveStaffRole; substitutionInPlayerId?: string },
) => {
  if (liveMatchStore.status === 'scheduled') {
    return { ok: false as const, message: 'Debes iniciar el partido para registrar eventos' }
  }

  if (liveMatchStore.status === 'finished') {
    return { ok: false as const, message: 'Partido finalizado: no se pueden registrar más eventos' }
  }

  const team = findTeam(teamId)
  if (!team) return { ok: false as const, message: 'Equipo no encontrado' }

  if (eventType === 'staff_yellow' || eventType === 'staff_red') {
    if (playerId !== null) {
      return { ok: false as const, message: 'Eventos de DT/AT no deben incluir jugadora' }
    }

    if (options?.substitutionInPlayerId) {
      return { ok: false as const, message: 'Eventos de DT/AT no deben incluir jugadora de cambio' }
    }

    const staffRole = options?.staffRole
    if (!staffRole) {
      return { ok: false as const, message: 'Debes indicar si la tarjeta es para DT o AT' }
    }

    const staffName = team.technicalStaff?.[staffRole]?.name?.trim()
    if (!staffName) {
      return {
        ok: false as const,
        message: staffRole === 'director' ? 'Este equipo no tiene DT registrado' : 'Este equipo no tiene AT registrado',
      }
    }

    applyStatByEvent(team, eventType, null, staffRole)

    const elapsedSeconds = getElapsedSeconds()

    liveMatchStore.events.unshift({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      teamId,
      playerId: null,
      type: eventType,
      staffRole,
      minute: Math.floor(elapsedSeconds / 60),
      elapsedSeconds,
      clock: formatClock(elapsedSeconds),
    })

    return { ok: true as const }
  }

  if (eventType === 'substitution') {
    if (!playerId) {
      return { ok: false as const, message: 'Debes indicar la jugadora que sale' }
    }

    const incomingPlayerId = options?.substitutionInPlayerId
    if (!incomingPlayerId) {
      return { ok: false as const, message: 'Debes indicar la jugadora que entra' }
    }

    if (incomingPlayerId === playerId) {
      return { ok: false as const, message: 'Las jugadoras del cambio deben ser distintas' }
    }

    const incomingExists = team.players.some((player) => player.id === incomingPlayerId)
    if (!incomingExists) {
      return { ok: false as const, message: 'Jugador que entra no inscrito en el equipo' }
    }

    if (team.redCarded.includes(incomingPlayerId)) {
      return { ok: false as const, message: 'Jugador que entra expulsado: no puede reingresar' }
    }
  }

  if (playerId) {
    const exists = team.players.some((player) => player.id === playerId)
    if (!exists) return { ok: false as const, message: 'Jugador no inscrito en el equipo' }
    if (team.redCarded.includes(playerId)) {
      return { ok: false as const, message: 'Jugador expulsado: no puede registrar más acciones' }
    }
    if (eventType !== 'substitution' && !team.starters.includes(playerId)) {
      return { ok: false as const, message: 'Solo jugadores en cancha pueden registrar este evento' }
    }
  }

  applyStatByEvent(team, eventType, playerId)

  const elapsedSeconds = getElapsedSeconds()

  liveMatchStore.events.unshift({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    teamId,
    playerId,
    ...(eventType === 'substitution' && options?.substitutionInPlayerId
      ? { substitutionInPlayerId: options.substitutionInPlayerId }
      : {}),
    type: eventType,
    minute: Math.floor(elapsedSeconds / 60),
    elapsedSeconds,
    clock: formatClock(elapsedSeconds),
  })

  return { ok: true as const }
}

export const updateSettings = (payload: Partial<MatchSettings>) => {
  liveMatchStore.settings = {
    ...liveMatchStore.settings,
    ...payload,
  }
}

export const loadMatchForLive = (payload: {
  leagueName: string
  categoryName: string
  homeTeam: RegisteredTeam
  awayTeam: RegisteredTeam
  playersOnField: number
  matchMinutes: number
  breakMinutes: number
}) => {
  liveMatchStore.leagueName = payload.leagueName
  liveMatchStore.categoryName = payload.categoryName
  liveMatchStore.homeTeam = createTeamFromRegistered(payload.homeTeam, payload.playersOnField)
  liveMatchStore.awayTeam = createTeamFromRegistered(payload.awayTeam, payload.playersOnField)
  liveMatchStore.settings = {
    playersOnField: payload.playersOnField,
    matchMinutes: payload.matchMinutes,
    breakMinutes: payload.breakMinutes,
    homeHasBye: false,
    awayHasBye: false,
  }
  liveMatchStore.timer = {
    running: false,
    startedAt: null,
    elapsedSeconds: 0,
  }
  liveMatchStore.status = 'scheduled'
  liveMatchStore.events = []
}

export const buildLiveSnapshot = () => ({
  ...liveMatchStore,
  timer: {
    ...liveMatchStore.timer,
    elapsedSeconds: getElapsedSeconds(),
  },
  currentMinute: getCurrentMinute(),
})
