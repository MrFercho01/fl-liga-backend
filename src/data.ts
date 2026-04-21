// --- Engagement de partidos ---
export const getMatchEngagement = async (clientId: string, matchId: string) => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  const collection = mongoDb!.collection<{ clientId: string; matchId: string; likes: number; visits: number; updatedAt: string }>('match_engagement');
  const found = await collection.findOne({ clientId, matchId });
  if (found) return found;
  const newEngagement = { clientId, matchId, likes: 0, visits: 0, updatedAt: new Date().toISOString() };
  await collection.insertOne(newEngagement);
  return newEngagement;
};

export const saveMatchEngagement = async (clientId: string, matchId: string, data: { likes?: number; visits?: number }) => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  const collection = mongoDb!.collection('match_engagement');
  const update: any = { updatedAt: new Date().toISOString() };
  if (typeof data.likes === 'number') update.likes = data.likes;
  if (typeof data.visits === 'number') update.visits = data.visits;
  await collection.updateOne({ clientId, matchId }, { $set: update }, { upsert: true });
  return await collection.findOne({ clientId, matchId });
};

// --- Fixture de liga por cliente ---
export const getLeagueFixture = async (clientId: string, leagueId: string) => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  // Busca todos los schedules de la liga para el cliente
  const collection = mongoDb!.collection('fixture_schedule');
  const fixtures = await collection.find({ leagueId }).toArray();
  return fixtures;
};

// --- Ligas por cliente ---
export const getLeaguesByClientId = async (clientId: string) => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  // Busca ligas donde el ownerUserId coincida con el clientId
  const collection = mongoDb!.collection('leagues');
  const leagues = await collection.find({ ownerUserId: clientId }).toArray();
  return leagues;
};

// --- Engagement general de cliente ---
export const getClientEngagement = async (clientId: string) => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  const collection = mongoDb!.collection<{ clientId: string; visits: number; likes: number; updatedAt: string }>('public_engagement');
  const found = await collection.findOne({ clientId });
  if (found) return found;
  const newEngagement = { clientId, visits: 0, likes: 0, updatedAt: new Date().toISOString() };
  await collection.insertOne(newEngagement);
  return newEngagement;
};

export const saveClientEngagement = async (clientId: string, data: { visits?: number; likes?: number }) => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  const collection = mongoDb!.collection('public_engagement');
  const update: any = { updatedAt: new Date().toISOString() };
  if (typeof data.visits === 'number') update.visits = data.visits;
  if (typeof data.likes === 'number') update.likes = data.likes;
  await collection.updateOne({ clientId }, { $set: update }, { upsert: true });
  return await collection.findOne({ clientId });
};
// --- Persistencia granular de tokens de acceso de cliente ---
export const getClientAccessTokensCollection = async () => {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  return mongoDb!.collection<ClientAccessTokenEntry>('client_access_tokens');
};

export const getAllClientAccessTokensFromMongo = async (): Promise<ClientAccessTokenEntry[]> => {
  const collection = await getClientAccessTokensCollection();
  return collection.find({}).toArray();
};

export const getClientAccessTokenByToken = async (token: string): Promise<ClientAccessTokenEntry | null> => {
  const collection = await getClientAccessTokensCollection();
  return collection.findOne({ token });
};

export const getClientAccessTokenById = async (id: string): Promise<ClientAccessTokenEntry | null> => {
  const collection = await getClientAccessTokensCollection();
  return collection.findOne({ id });
};

export const saveClientAccessTokenToMongo = async (entry: ClientAccessTokenEntry) => {
  const collection = await getClientAccessTokensCollection();
  await collection.replaceOne({ id: entry.id }, entry, { upsert: true });
};

export const revokeClientAccessTokenInMongo = async (id: string, revokedAt: string) => {
  const collection = await getClientAccessTokensCollection();
  await collection.updateOne({ id }, { $set: { active: false, revokedAt } });
};

export const renewClientAccessTokenInMongo = async (id: string, expiresAt: string) => {
  const collection = await getClientAccessTokensCollection();
  await collection.updateOne(
    { id },
    { $set: { expiresAt, active: true }, $unset: { revokedAt: "" } }
  );
}
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
// Utilidad para normalizar o validar clientId público (acepta slug o UUID)
export async function resolvePublicClientId(clientId: string): Promise<string | null> {
  if (typeof clientId !== 'string' || !clientId.trim()) return null;
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (uuidRegex.test(clientId.trim())) return clientId.trim();
  // Buscar por slug o nombre de organización en users
  const usersCollection = await getUsersCollection();
  const user = await usersCollection.findOne({
    $or: [
      { slug: clientId.trim() },
      { organizationName: new RegExp(clientId.trim(), 'i') }
    ]
  });
  return user ? user.id : null;
}
import fs from 'node:fs'
import path from 'node:path'
import { GridFSBucket, MongoClient, ObjectId, type Collection, type Db } from 'mongodb'

// Inicializa el índice compuesto para la colección de partidos jugados
export async function ensurePlayedMatchesIndexes() {
  if (!hasMongoConfigured()) throw new Error('MongoDB no configurado');
  if (!mongoDb) await connectMongo();
  const collection = mongoDb!.collection('played_matches');
  // Índice para búsquedas rápidas por estado y matchId
  await collection.createIndex({ status: 1, matchId: 1 });
}

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
  publicPortalPath?: string // Nuevo campo para link público del cliente
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
  leagueId: string;
}

export interface PlayedMatchPlayerStats {
  playerId: string
  playerName: string
  teamId: string
  lastActiveAt?: string
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
  status: 'finished' | 'disabled' | 'cancelled' | 'live';
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

// LOG de depuración para monitorear variables de entorno
console.log('---[DEBUG]---')
console.log('MONGODB_URI:', process.env.MONGODB_URI)
console.log('MONGODB_DB_NAME:', process.env.MONGODB_DB_NAME)
console.log('MONGODB_COLLECTION_NAME:', process.env.MONGODB_COLLECTION_NAME)
console.log('MONGODB_STATE_DOCUMENT_ID:', process.env.MONGODB_STATE_DOCUMENT_ID)
console.log('---[END DEBUG]---')

const mongoUri = process.env.MONGODB_URI?.trim() || ''
const mongoDbName = process.env.MONGODB_DB_NAME?.trim() || 'fl_liga'
let mongoClient: MongoClient | null = null
export let mongoDb: Db | null = null
let videosBucket: GridFSBucket | null = null

const hasMongoConfigured = () => mongoUri.length > 0

export const connectMongo = async () => {
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
