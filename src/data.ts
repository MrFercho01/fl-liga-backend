// --- Persistencia granular de usuarios ---
export const getUsersCollection = async () => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  return mongoDb!.collection<AppUser>('users');
};

export const getAllUsersFromMongo = async (): Promise<AppUser[]> => {
  const collection = await getUsersCollection();
  return collection.find({}).toArray();
};
// --- Persistencia granular de equipos ---
export const getTeamsCollection = async () => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  return mongoDb!.collection<RegisteredTeam>('teams');
};

export const saveTeamToMongo = async (team: RegisteredTeam) => {
  console.log('Guardando equipo en MongoDB:', JSON.stringify(team, null, 2));
  const collection = await getTeamsCollection();
  await collection.replaceOne({ id: team.id }, team, { upsert: true });
};

export const getAllTeamsFromMongo = async (): Promise<RegisteredTeam[]> => {
  const collection = await getTeamsCollection();
  return collection.find({}).toArray();
};

// --- Persistencia granular de fixture/schedule ---
export const getFixtureScheduleCollection = async () => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  return mongoDb!.collection<FixtureScheduleEntry>('fixture_schedule');
};

export const saveFixtureScheduleToMongo = async (entry: FixtureScheduleEntry) => {
  console.log('Guardando fixture schedule en MongoDB:', JSON.stringify(entry, null, 2));
  const collection = await getFixtureScheduleCollection();
  await collection.replaceOne({ leagueId: entry.leagueId, categoryId: entry.categoryId, matchId: entry.matchId }, entry, { upsert: true });
};

export const getAllFixtureSchedulesFromMongo = async (): Promise<FixtureScheduleEntry[]> => {
  const collection = await getFixtureScheduleCollection();
  return collection.find({}).toArray();
};

// --- Persistencia granular de premios de ronda ---
export const getRoundAwardsCollection = async () => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  return mongoDb!.collection<RoundAwardsEntry>('round_awards');
};

export const saveRoundAwardToMongo = async (entry: RoundAwardsEntry) => {
  console.log('Guardando round award en MongoDB:', JSON.stringify(entry, null, 2));
  const collection = await getRoundAwardsCollection();
  await collection.replaceOne({ leagueId: entry.leagueId, categoryId: entry.categoryId, round: entry.round }, entry, { upsert: true });
};

export const getAllRoundAwardsFromMongo = async (): Promise<RoundAwardsEntry[]> => {
  const collection = await getRoundAwardsCollection();
  return collection.find({}).toArray();
};
// --- Persistencia granular: Partidos jugados y videos destacados ---
export const getPlayedMatchesCollection = async () => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  return mongoDb!.collection<PlayedMatchRecord>('played_matches');
};

export const savePlayedMatchToMongo = async (match: PlayedMatchRecord) => {
  console.log('Guardando played match en MongoDB:', JSON.stringify(match, null, 2));
  const collection = await getPlayedMatchesCollection();
  await collection.insertOne(match);
};

export const getAllPlayedMatchesFromMongo = async (): Promise<PlayedMatchRecord[]> => {
  const collection = await getPlayedMatchesCollection();
  return collection.find({}).toArray();
};

export const getHighlightVideosCollection = async () => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  return mongoDb!.collection<MatchHighlightVideo>('highlight_videos');
};

export const saveHighlightVideoToMongo = async (video: MatchHighlightVideo) => {
  console.log('Guardando highlight video en MongoDB:', JSON.stringify(video, null, 2));
  const collection = await getHighlightVideosCollection();
  await collection.insertOne(video);
};

export const getAllHighlightVideosFromMongo = async (): Promise<MatchHighlightVideo[]> => {
  const collection = await getHighlightVideosCollection();
  return collection.find({}).toArray();
};
// --- Persistencia granular de ligas ---
export const getLeaguesCollection = async () => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  return mongoDb!.collection<League>('leagues');
};

export const saveLeagueToMongo = async (league: League) => {
  console.log('Guardando liga en MongoDB:', JSON.stringify(league, null, 2));
  const collection = await getLeaguesCollection();
  await collection.insertOne(league);
};

export const getAllLeaguesFromMongo = async (): Promise<League[]> => {
  const collection = await getLeaguesCollection();
  return collection.find({}).toArray();
};
// Utilidad para normalizar o validar clientId público
export function resolvePublicClientId(clientId: string): string | null {
  if (typeof clientId !== 'string' || !clientId.trim()) return null;
  // Si el clientId es un UUID válido, lo retorna, si no retorna null
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (uuidRegex.test(clientId.trim())) return clientId.trim();
  // Si hay algún mapeo especial, agregar aquí
  return null;
}
import fs from 'node:fs'
import path from 'node:path'
import { GridFSBucket, MongoClient, ObjectId, type Collection, type Db } from 'mongodb'

export interface RuleSet {
  playersOnField: number
  maxRegisteredPlayers?: number
  matchMinutes: number
  breakMinutes: number
  allowDraws: boolean
  pointsWin: number
  pointsDraw: number
  pointsLoss: number
  courtsCount?: number
  resolveDrawByPenalties?: boolean
  playoffQualifiedTeams?: number
  playoffHomeAway?: boolean
  finalStageRoundOf16Enabled?: boolean
  finalStageRoundOf8Enabled?: boolean
  finalStageQuarterFinalsEnabled?: boolean
  finalStageSemiFinalsEnabled?: boolean
  finalStageFinalEnabled?: boolean
  finalStageTwoLegged?: boolean
  finalStageRoundOf16TwoLegged?: boolean
  finalStageRoundOf8TwoLegged?: boolean
  finalStageQuarterFinalsTwoLegged?: boolean
  finalStageSemiFinalsTwoLegged?: boolean
  finalStageFinalTwoLegged?: boolean
  doubleRoundRobin?: boolean
  regularSeasonRounds?: number
}

export interface Category {
  id: string
  name: string
  minAge: number
  maxAge: number | null
  rules: RuleSet
}

export interface League {
  id: string
  name: string
  slug: string
  country: string
  season: number
  slogan?: string
  themeColor?: string
  backgroundImageUrl?: string
  active: boolean
  ownerUserId: string
  logoUrl?: string
  categories: Category[]
}

export interface AppUser {
  id: string
  name: string
  organizationName?: string
  email: string
  password: string
  mustChangePassword?: boolean
  role: 'super_admin' | 'client_admin'
  active: boolean
}

export interface RegisteredPlayer {
  id: string
  name: string
  nickname: string
  age: number
  number: number
  position: string
  photoUrl?: string
  registrationStatus?: 'pending' | 'registered'
}

export interface RegisteredTeam {
  id: string
  leagueId: string
  categoryId: string
  name: string
  active?: boolean
  logoUrl?: string
  primaryColor?: string
  secondaryColor?: string
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
  players: RegisteredPlayer[]
}

export interface FixtureMatch {
  homeTeamId: string
  awayTeamId: string | null
  hasBye: boolean
}

export interface FixtureRound {
  round: number
  matches: FixtureMatch[]
}

export interface MatchGoal {
  minute: number
  clock: string
  teamName: string
  playerName: string
}

export interface MatchHighlightVideo {
  id: string
  name: string
  url: string
}

export interface PlayedMatchPlayerStats {
  playerId: string
  playerName: string
  teamId: string
  teamName: string
  position: string
  goals: number
  assists: number
  shots: number
  yellows: number
  reds: number
  goalsConceded: number
}

export interface PlayedMatchRecord {
  matchId: string
  leagueId: string
  categoryId: string
  round: number
  finalMinute: number
  homeTeamName: string
  awayTeamName: string
  homeStats: {
    shots: number
    goals: number
    yellows: number
    reds: number
    assists: number
  }
  awayStats: {
    shots: number
    goals: number
    yellows: number
    reds: number
    assists: number
  }
  penaltyShootout?: {
    home: number
    away: number
  }
  playerOfMatchId?: string
  playerOfMatchName?: string
  homeLineup?: {
    starters: string[]
    substitutes: string[]
    formationKey?: string
  }
  awayLineup?: {
    starters: string[]
    substitutes: string[]
    formationKey?: string
  }
  players: PlayedMatchPlayerStats[]
  goals: MatchGoal[]
  events: Array<{
    clock: string
    type:
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
    teamName: string
    playerName: string
    substitutionInPlayerName?: string
    staffRole?: 'director' | 'assistant'
  }>
  highlightVideos: MatchHighlightVideo[]
  playedAt: string
}

export interface FixtureScheduleEntry {
  leagueId: string
  categoryId: string
  matchId: string
  round: number
  scheduledAt: string
  venue?: string
  status?: 'scheduled' | 'postponed'
}

export interface RoundMatchBestPlayer {
  matchKey: string
  homeTeamId: string
  awayTeamId: string
  playerId: string
  playerName: string
  teamId: string
  teamName: string
}

export interface RoundAwardsEntry {
  leagueId: string
  categoryId: string
  round: number
  matchBestPlayers: RoundMatchBestPlayer[]
  roundBestPlayerId?: string
  roundBestPlayerName?: string
  roundBestPlayerTeamId?: string
  roundBestPlayerTeamName?: string
  updatedAt: string
}

export interface AuditLogEntry {
  id: string
  timestamp: string
  userId: string
  userEmail: string
  action: 'login_success' | 'login_failed' | 'logout'
  ip: string
  details?: string
}

export interface PublicEngagementEntry {
  clientId: string
  visits: number
  likes: number
  updatedAt: string
}

export interface PublicMatchLikeEntry {
  clientId: string
  leagueId: string
  categoryId: string
  matchId: string
  likes: number
  updatedAt: string
}

export interface ClientAccessTokenEntry {
  id: string
  clientUserId: string
  token: string
  expiresAt: string
  active: boolean
  createdAt: string
  revokedAt?: string
}

export const SUPER_ADMIN_USER_ID = 'super-admin'

const mongoUri = process.env.MONGODB_URI?.trim() || ''
const mongoDbName = process.env.MONGODB_DB_NAME?.trim() || 'fl_liga'
let mongoClient: MongoClient | null = null
let mongoDb: Db | null = null
let videosBucket: GridFSBucket | null = null

const hasMongoConfigured = () => mongoUri.length > 0

const connectMongo = async () => {
  if (!hasMongoConfigured()) return null
  if (mongoDb) return mongoDb
  mongoClient = new MongoClient(mongoUri)
  await mongoClient.connect()
  mongoDb = mongoClient.db(mongoDbName)
  videosBucket = new GridFSBucket(mongoDb, { bucketName: 'highlight_videos' })
  return mongoDb
}

export const getVideosBucket = async (): Promise<GridFSBucket | null> => {
  await connectMongo()
  return videosBucket
}

export const getMongoObjectId = (id: string) => {
  try {
    return new ObjectId(id)
  } catch {
    return null
  }
}
const normalizeFixtureTeamName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bbanco\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

const withBancoPrefix = (value: string) => (normalizeFixtureTeamName(value).includes('banco') ? value : `Banco ${value}`)

const buildGoalTimeline = (homeGoals: number, awayGoals: number, homeTeamName: string, awayTeamName: string) => {
  const defaultMinutes = [4, 8, 12, 16, 20, 24, 27, 30]
  const goals: MatchGoal[] = []
  const events: PlayedMatchRecord['events'] = []

  for (let index = 0; index < homeGoals; index += 1) {
    const minute = defaultMinutes[index] ?? (31 + index)
    const clock = `${minute}'`
    const playerName = `Gol ${index + 1}`
    goals.push({ minute, clock, teamName: homeTeamName, playerName })
    events.push({ clock, type: 'goal', teamName: homeTeamName, playerName })
  }

  for (let index = 0; index < awayGoals; index += 1) {
    const minute = defaultMinutes[index] ?? (31 + index)
    const clock = `${minute}'`
    const playerName = `Gol ${index + 1}`
    goals.push({ minute, clock, teamName: awayTeamName, playerName })
    events.push({ clock, type: 'goal', teamName: awayTeamName, playerName })
  }

  goals.sort((left, right) => left.minute - right.minute)
  events.sort((left, right) => Number(left.clock.replace("'", '')) - Number(right.clock.replace("'", '')))

  return { goals, events }
}


// Función eliminada: toda la lógica de stores en memoria migrada a MongoDB granular.
// Si se requiere funcionalidad similar, implementar usando helpers de MongoDB.
// (La función ensureRoundOneFinishedMatch ha sido eliminada y cerrada correctamente)
//


// Eliminadas funciones y lógica de stores en memoria. Toda la persistencia y lógica debe ser granular y en MongoDB.



// Eliminadas funciones de snapshot, persistencia local y stores en memoria. Toda la lógica es granular y MongoDB.
