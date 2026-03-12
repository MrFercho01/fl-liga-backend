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

const localDbPath = path.resolve(__dirname, '..', 'data-local.json')

export type LocalSnapshot = {
  users?: AppUser[]
  leagues?: League[]
  teams?: RegisteredTeam[]
  fixtureSchedule?: FixtureScheduleEntry[]
  roundAwards?: RoundAwardsEntry[]
  playedMatches?: PlayedMatchRecord[]
  auditLogs?: AuditLogEntry[]
  publicEngagement?: PublicEngagementEntry[]
  publicMatchLikes?: PublicMatchLikeEntry[]
  clientAccessTokens?: ClientAccessTokenEntry[]
}

type MongoSnapshotDocument = {
  _id: string
  snapshot: LocalSnapshot
  updatedAt: string
}

const defaultSuperAdminName = process.env.SUPER_ADMIN_NAME?.trim() || 'MrFercho'
const defaultSuperAdminEmail = process.env.SUPER_ADMIN_EMAIL?.trim() || 'mrfercho@flliga.local'
const defaultSuperAdminPassword = process.env.SUPER_ADMIN_PASSWORD?.trim() || '1623Fercho.'
const mongoUri = process.env.MONGODB_URI?.trim() || ''
const mongoDbName = process.env.MONGODB_DB_NAME?.trim() || 'fl_liga'
const mongoCollectionName = process.env.MONGODB_COLLECTION_NAME?.trim() || 'app_state'
const mongoStateDocumentId = process.env.MONGODB_STATE_DOCUMENT_ID?.trim() || 'main'

let mongoClient: MongoClient | null = null
let mongoDb: Db | null = null
let mongoCollection: Collection<MongoSnapshotDocument> | null = null
let videosBucket: GridFSBucket | null = null
let persistQueue: Promise<void> = Promise.resolve()

export const usersStore: AppUser[] = [
  {
    id: SUPER_ADMIN_USER_ID,
    name: defaultSuperAdminName,
    email: defaultSuperAdminEmail,
    password: defaultSuperAdminPassword,
    role: 'super_admin',
    active: true,
  },
]

export const leaguesStore: League[] = []

export const teamsStore: RegisteredTeam[] = []

export const fixtureScheduleStore: FixtureScheduleEntry[] = []

export const roundAwardsStore: RoundAwardsEntry[] = []

export const playedMatchesStore: PlayedMatchRecord[] = []

export const auditLogsStore: AuditLogEntry[] = []

export const publicEngagementStore: PublicEngagementEntry[] = []

export const publicMatchLikesStore: PublicMatchLikeEntry[] = []

export const clientAccessTokensStore: ClientAccessTokenEntry[] = []

const seedLeagueId = '11111111-1111-4111-8111-111111111111'
const seedCategoryId = '11111111-1111-4111-8111-111111111112'
const seedTeams: RegisteredTeam[] = [
  {
    id: '11111111-1111-4111-8111-111111111201',
    leagueId: seedLeagueId,
    categoryId: seedCategoryId,
    name: 'Barcelona SC Femenino',
    players: [],
  },
  {
    id: '11111111-1111-4111-8111-111111111202',
    leagueId: seedLeagueId,
    categoryId: seedCategoryId,
    name: 'Emelec Femenino',
    players: [],
  },
  {
    id: '11111111-1111-4111-8111-111111111203',
    leagueId: seedLeagueId,
    categoryId: seedCategoryId,
    name: 'Delfín Femenino',
    players: [],
  },
  {
    id: '11111111-1111-4111-8111-111111111204',
    leagueId: seedLeagueId,
    categoryId: seedCategoryId,
    name: 'Orense Femenino',
    players: [],
  },
]

const seedLeague: League = {
  id: seedLeagueId,
  name: 'Liga Interbancaria Femenina - Región Costa',
  slug: 'liga-interbancaria-femenina-region-costa',
  country: 'Ecuador - Costa',
  season: 2026,
  slogan: 'La mejor liga de bancos',
  themeColor: '#0ea5e9',
  active: true,
  ownerUserId: SUPER_ADMIN_USER_ID,
  categories: [
    {
      id: seedCategoryId,
      name: 'Categoría Única',
      minAge: 14,
      maxAge: null,
      rules: {
        playersOnField: 11,
        maxRegisteredPlayers: 25,
        matchMinutes: 90,
        breakMinutes: 15,
        allowDraws: true,
        pointsWin: 3,
        pointsDraw: 1,
        pointsLoss: 0,
        courtsCount: 1,
        resolveDrawByPenalties: false,
        playoffQualifiedTeams: 4,
        playoffHomeAway: false,
        finalStageRoundOf16Enabled: false,
        finalStageRoundOf8Enabled: false,
        finalStageQuarterFinalsEnabled: true,
        finalStageSemiFinalsEnabled: true,
        finalStageFinalEnabled: true,
        finalStageTwoLegged: false,
        finalStageRoundOf16TwoLegged: false,
        finalStageRoundOf8TwoLegged: false,
        finalStageQuarterFinalsTwoLegged: false,
        finalStageSemiFinalsTwoLegged: false,
        finalStageFinalTwoLegged: false,
        doubleRoundRobin: false,
        regularSeasonRounds: 3,
      },
    },
  ],
}

const seedFixtureSchedule: FixtureScheduleEntry[] = [
  {
    leagueId: seedLeagueId,
    categoryId: seedCategoryId,
    matchId: 'manual__1__11111111-1111-4111-8111-111111111201__11111111-1111-4111-8111-111111111202',
    round: 1,
    scheduledAt: '2026-03-15T17:00:00.000Z',
    venue: 'Cancha Principal Costa',
  },
  {
    leagueId: seedLeagueId,
    categoryId: seedCategoryId,
    matchId: 'manual__1__11111111-1111-4111-8111-111111111203__11111111-1111-4111-8111-111111111204',
    round: 1,
    scheduledAt: '2026-03-15T19:00:00.000Z',
    venue: 'Cancha Principal Costa',
  },
]

const hydrateStore = <T>(target: T[], source: T[] | undefined, fallback?: T[]) => {
  target.length = 0
  if (source && source.length > 0) {
    target.push(...source)
    return
  }

  if (fallback && fallback.length > 0) {
    target.push(...fallback)
  }
}

const hydrateAllStores = (snapshot: LocalSnapshot, fallbackUsers?: AppUser[]) => {
  hydrateStore(usersStore, snapshot.users, fallbackUsers)
  hydrateStore(leaguesStore, snapshot.leagues)
  hydrateStore(teamsStore, snapshot.teams)
  hydrateStore(fixtureScheduleStore, snapshot.fixtureSchedule)
  hydrateStore(roundAwardsStore, snapshot.roundAwards)
  hydrateStore(playedMatchesStore, snapshot.playedMatches)
  hydrateStore(auditLogsStore, snapshot.auditLogs)
  hydrateStore(publicEngagementStore, snapshot.publicEngagement)
  hydrateStore(publicMatchLikesStore, snapshot.publicMatchLikes)
  hydrateStore(clientAccessTokensStore, snapshot.clientAccessTokens)
}

const buildSnapshot = (): LocalSnapshot => ({
  users: usersStore,
  leagues: leaguesStore,
  teams: teamsStore,
  fixtureSchedule: fixtureScheduleStore,
  roundAwards: roundAwardsStore,
  playedMatches: playedMatchesStore,
  auditLogs: auditLogsStore,
  publicEngagement: publicEngagementStore,
  publicMatchLikes: publicMatchLikesStore,
  clientAccessTokens: clientAccessTokensStore,
})

const hasMongoConfigured = () => mongoUri.length > 0

const connectMongo = async () => {
  if (!hasMongoConfigured()) return null
  if (mongoCollection) return mongoCollection

  mongoClient = new MongoClient(mongoUri)
  await mongoClient.connect()
  const db = mongoClient.db(mongoDbName)
  mongoDb = db
  videosBucket = new GridFSBucket(db, { bucketName: 'highlight_videos' })
  mongoCollection = db.collection<MongoSnapshotDocument>(mongoCollectionName)
  return mongoCollection
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

const readMongoSnapshot = async () => {
  const collection = await connectMongo()
  if (!collection) return null
  return collection.findOne({ _id: mongoStateDocumentId })
}

const persistMongoSnapshot = async (snapshot: LocalSnapshot) => {
  const collection = await connectMongo()
  if (!collection) return

  await collection.updateOne(
    { _id: mongoStateDocumentId },
    {
      $set: {
        snapshot,
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  )
}

const queueMongoPersist = (snapshot: LocalSnapshot) => {
  if (!hasMongoConfigured()) return

  persistQueue = persistQueue
    .then(async () => {
      await persistMongoSnapshot(snapshot)
    })
    .catch((error) => {
      console.error('No se pudo persistir snapshot en MongoDB:', error)
    })
}

const loadLocalData = () => {
  if (!fs.existsSync(localDbPath)) return

  try {
    const raw = fs.readFileSync(localDbPath, 'utf-8')
    const parsed = JSON.parse(raw) as LocalSnapshot

    const fallbackUsers = [...usersStore]
    hydrateAllStores(parsed, fallbackUsers)
  } catch {
    // si el archivo local está corrupto, se mantiene estado en memoria por defecto
  }
}

const ensureSeedData = () => {
  const hasCostaLeague = leaguesStore.some((league) => league.id === seedLeagueId)
  if (!hasCostaLeague) {
    leaguesStore.push(seedLeague)
  }

  const hasCostaTeams = teamsStore.some((team) => team.leagueId === seedLeagueId && team.categoryId === seedCategoryId)
  if (!hasCostaTeams) {
    teamsStore.push(...seedTeams)
  }

  const hasFirstRoundSchedule = fixtureScheduleStore.some(
    (entry) => entry.leagueId === seedLeagueId && entry.categoryId === seedCategoryId && entry.round === 1,
  )
  if (!hasFirstRoundSchedule) {
    fixtureScheduleStore.push(...seedFixtureSchedule)
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

const ensureRoundOneFinishedMatch = ({
  homeTeamKeyword,
  awayTeamKeyword,
  homeGoals,
  awayGoals,
  playedAt,
}: {
  homeTeamKeyword: string
  awayTeamKeyword: string
  homeGoals: number
  awayGoals: number
  playedAt: string
}) => {
  const homeTeam = teamsStore.find((team) => normalizeFixtureTeamName(team.name).includes(homeTeamKeyword))
  const awayTeam = teamsStore.find(
    (team) =>
      team.leagueId === homeTeam?.leagueId &&
      team.categoryId === homeTeam?.categoryId &&
      normalizeFixtureTeamName(team.name).includes(awayTeamKeyword),
  )

  if (!homeTeam || !awayTeam) return false

  const canonicalMatchId = `manual__1__${homeTeam.id}__${awayTeam.id}`
  const homeDisplayName = withBancoPrefix(homeTeam.name)
  const awayDisplayName = withBancoPrefix(awayTeam.name)

  const matchedPlayedIndexes: number[] = []
  playedMatchesStore.forEach((item, index) => {
    if (item.leagueId !== homeTeam.leagueId || item.categoryId !== homeTeam.categoryId || item.round !== 1) return
    const normalizedHome = normalizeFixtureTeamName(item.homeTeamName)
    const normalizedAway = normalizeFixtureTeamName(item.awayTeamName)
    const direct = normalizedHome.includes(homeTeamKeyword) && normalizedAway.includes(awayTeamKeyword)
    const reverse = normalizedHome.includes(awayTeamKeyword) && normalizedAway.includes(homeTeamKeyword)
    if (direct || reverse) {
      matchedPlayedIndexes.push(index)
    }
  })

  let changed = false

  let record: PlayedMatchRecord
  if (matchedPlayedIndexes.length > 0) {
    const primaryIndex = matchedPlayedIndexes[0]!
    record = playedMatchesStore[primaryIndex]!

    for (let index = matchedPlayedIndexes.length - 1; index >= 1; index -= 1) {
      const removeIndex = matchedPlayedIndexes[index]!
      playedMatchesStore.splice(removeIndex, 1)
      changed = true
    }
  } else {
    record = {
      matchId: canonicalMatchId,
      leagueId: homeTeam.leagueId,
      categoryId: homeTeam.categoryId,
      round: 1,
      finalMinute: 30,
      homeTeamName: homeDisplayName,
      awayTeamName: awayDisplayName,
      homeStats: { shots: 0, goals: homeGoals, yellows: 0, reds: 0, assists: 0 },
      awayStats: { shots: 0, goals: awayGoals, yellows: 0, reds: 0, assists: 0 },
      players: [],
      goals: [],
      events: [],
      highlightVideos: [],
      playedAt,
    }
    playedMatchesStore.push(record)
    changed = true
  }

  if (record.matchId !== canonicalMatchId) {
    record.matchId = canonicalMatchId
    changed = true
  }
  if (record.homeTeamName !== homeDisplayName) {
    record.homeTeamName = homeDisplayName
    changed = true
  }
  if (record.awayTeamName !== awayDisplayName) {
    record.awayTeamName = awayDisplayName
    changed = true
  }
  if (record.round !== 1) {
    record.round = 1
    changed = true
  }
  if (record.finalMinute !== 30) {
    record.finalMinute = 30
    changed = true
  }
  if (record.homeStats.goals !== homeGoals || record.awayStats.goals !== awayGoals) {
    record.homeStats.goals = homeGoals
    record.awayStats.goals = awayGoals
    changed = true
  }
  if ((record.playedAt ?? '') !== playedAt) {
    record.playedAt = playedAt
    changed = true
  }

  const goalEvents = record.events.filter((event) => event.type === 'goal' || event.type === 'penalty_goal')
  const expectedGoals = homeGoals + awayGoals
  if (goalEvents.length < expectedGoals || record.goals.length < expectedGoals) {
    const timeline = buildGoalTimeline(homeGoals, awayGoals, homeDisplayName, awayDisplayName)
    record.goals = timeline.goals
    record.events = timeline.events
    changed = true
  }

  const matchedScheduleIndexes: number[] = []
  fixtureScheduleStore.forEach((entry, index) => {
    if (entry.leagueId !== homeTeam.leagueId || entry.categoryId !== homeTeam.categoryId || entry.round !== 1) return
    const normalizedMatchId = normalizeFixtureTeamName(entry.matchId)
    const homeInId = normalizedMatchId.includes(homeTeam.id)
    const awayInId = normalizedMatchId.includes(awayTeam.id)
    const reverseInId = normalizedMatchId.includes(awayTeam.id) && normalizedMatchId.includes(homeTeam.id)
    if ((homeInId && awayInId) || reverseInId) {
      matchedScheduleIndexes.push(index)
    }
  })

  let scheduleEntry: FixtureScheduleEntry
  if (matchedScheduleIndexes.length > 0) {
    const primaryIndex = matchedScheduleIndexes[0]!
    scheduleEntry = fixtureScheduleStore[primaryIndex]!

    for (let index = matchedScheduleIndexes.length - 1; index >= 1; index -= 1) {
      const removeIndex = matchedScheduleIndexes[index]!
      fixtureScheduleStore.splice(removeIndex, 1)
      changed = true
    }
  } else {
    scheduleEntry = {
      leagueId: homeTeam.leagueId,
      categoryId: homeTeam.categoryId,
      matchId: canonicalMatchId,
      round: 1,
      scheduledAt: playedAt,
      status: 'scheduled',
    }
    fixtureScheduleStore.push(scheduleEntry)
    changed = true
  }

  if (scheduleEntry.matchId !== canonicalMatchId) {
    scheduleEntry.matchId = canonicalMatchId
    changed = true
  }
  if ((scheduleEntry.scheduledAt ?? '') !== playedAt) {
    scheduleEntry.scheduledAt = playedAt
    changed = true
  }
  if (scheduleEntry.status !== 'scheduled') {
    scheduleEntry.status = 'scheduled'
    changed = true
  }

  return changed
}

const ensureRoundOnePostponedProdubancoVsSolidario = () => {
  const produbanco = teamsStore.find((team) => normalizeFixtureTeamName(team.name).includes('produbanco'))
  const solidario = teamsStore.find(
    (team) =>
      team.leagueId === produbanco?.leagueId &&
      team.categoryId === produbanco?.categoryId &&
      normalizeFixtureTeamName(team.name).includes('solidario'),
  )

  if (!produbanco || !solidario) return false

  const pairMatch = fixtureScheduleStore.find(
    (entry) =>
      entry.leagueId === produbanco.leagueId &&
      entry.categoryId === produbanco.categoryId &&
      entry.round === 1 &&
      (entry.matchId === `manual__1__${produbanco.id}__${solidario.id}` ||
        entry.matchId === `manual__1__${solidario.id}__${produbanco.id}`),
  )

  const postponedIsoDate = '2026-03-07T17:30:00-05:00'

  if (pairMatch) {
    let changed = false
    if (pairMatch.status !== 'postponed') {
      pairMatch.status = 'postponed'
      changed = true
    }
    if ((pairMatch.scheduledAt ?? '') !== postponedIsoDate) {
      pairMatch.scheduledAt = postponedIsoDate
      changed = true
    }
    if (!pairMatch.venue?.trim()) {
      pairMatch.venue = 'Partido postergado'
      changed = true
    }
    return changed
  }

  fixtureScheduleStore.push({
    leagueId: produbanco.leagueId,
    categoryId: produbanco.categoryId,
    matchId: `manual__1__${produbanco.id}__${solidario.id}`,
    round: 1,
    scheduledAt: postponedIsoDate,
    venue: 'Partido postergado',
    status: 'postponed',
  })

  return true
}

const ensureRoundOneAustroVsPacificoFromPlayed = () => {
  return ensureRoundOneFinishedMatch({
    homeTeamKeyword: 'austro',
    awayTeamKeyword: 'pacifico',
    homeGoals: 0,
    awayGoals: 2,
    playedAt: '2026-03-07T16:00:00-05:00',
  })
}

const normalizePlayersRegistrationStatus = () => {
  let updated = false

  teamsStore.forEach((team) => {
    team.players.forEach((player) => {
      if (!player.registrationStatus) {
        player.registrationStatus = 'registered'
        updated = true
      }
    })
  })

  return updated
}

export const ensureOperationalSeedData = () => {
  const hadLeague = leaguesStore.some((league) => league.id === seedLeagueId)
  const hadTeams = teamsStore.some((team) => team.leagueId === seedLeagueId && team.categoryId === seedCategoryId)
  const hadSchedule = fixtureScheduleStore.some(
    (entry) => entry.leagueId === seedLeagueId && entry.categoryId === seedCategoryId && entry.round === 1,
  )

  const hasSuperAdmin = usersStore.some((user) => user.id === SUPER_ADMIN_USER_ID)
  if (!hasSuperAdmin) {
    usersStore.unshift({
      id: SUPER_ADMIN_USER_ID,
      name: defaultSuperAdminName,
      email: defaultSuperAdminEmail,
      password: defaultSuperAdminPassword,
      role: 'super_admin',
      active: true,
    })
  }

  ensureSeedData()
  const injectedPostponedMatch = ensureRoundOnePostponedProdubancoVsSolidario()
  const injectedAustroPacificoMatch = ensureRoundOneAustroVsPacificoFromPlayed()
  const injectedBolivarianoAtlantidaMatch = ensureRoundOneFinishedMatch({
    homeTeamKeyword: 'bolivariano',
    awayTeamKeyword: 'atlantida',
    homeGoals: 5,
    awayGoals: 0,
    playedAt: '2026-03-07T16:30:00-05:00',
  })
  const injectedGuayaquilPichinchaMatch = ensureRoundOneFinishedMatch({
    homeTeamKeyword: 'guayaquil',
    awayTeamKeyword: 'pichincha',
    homeGoals: 4,
    awayGoals: 1,
    playedAt: '2026-03-07T17:00:00-05:00',
  })
  const normalizedPlayerRegistrationStatus = normalizePlayersRegistrationStatus()

  if (
    !hadLeague ||
    !hadTeams ||
    !hadSchedule ||
    !hasSuperAdmin ||
    injectedPostponedMatch ||
    injectedAustroPacificoMatch ||
    injectedBolivarianoAtlantidaMatch ||
    injectedGuayaquilPichinchaMatch ||
    normalizedPlayerRegistrationStatus
  ) {
    persistLocalData()
  }
}

const applyLocalBaseOnlyMode = () => {
  const flagEnabled = (process.env.FL_LOCAL_BASE_ONLY ?? '0') === '1'
  const isProduction = (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production'
  const mongoConfigured = hasMongoConfigured()
  const enabled = flagEnabled && !isProduction && !mongoConfigured

  if (flagEnabled && isProduction) {
    console.warn('FL_LOCAL_BASE_ONLY=1 ignorado en producción para evitar reseteo de datos.')
  }

  if (flagEnabled && mongoConfigured) {
    console.warn('FL_LOCAL_BASE_ONLY=1 ignorado porque MongoDB está configurado.')
  }

  if (!enabled) return

  usersStore.length = 0
  usersStore.push({
    id: SUPER_ADMIN_USER_ID,
    name: defaultSuperAdminName,
    email: defaultSuperAdminEmail,
    password: defaultSuperAdminPassword,
    role: 'super_admin',
    active: true,
  })

  leaguesStore.length = 0
  leaguesStore.push({
    ...seedLeague,
    categories: seedLeague.categories.map((category) => ({
      ...category,
      rules: { ...category.rules },
    })),
  })

  teamsStore.length = 0
  teamsStore.push(...seedTeams.map((team) => ({ ...team, players: [] })))

  fixtureScheduleStore.length = 0
  fixtureScheduleStore.push(...seedFixtureSchedule.map((entry) => ({ ...entry })))

  roundAwardsStore.length = 0
  playedMatchesStore.length = 0
  auditLogsStore.length = 0
  publicEngagementStore.length = 0
  publicMatchLikesStore.length = 0
  clientAccessTokensStore.length = 0
}

export const persistLocalData = () => {
  const snapshot = buildSnapshot()

  fs.writeFileSync(localDbPath, JSON.stringify(snapshot, null, 2), 'utf-8')
  queueMongoPersist(snapshot)
}

export const flushPersistQueue = async () => {
  await persistQueue
}

export const refreshStoresFromMongoSnapshot = async () => {
  if (!hasMongoConfigured()) return false

  try {
    const mongoDoc = await readMongoSnapshot()
    if (!mongoDoc?.snapshot) return false

    const fallbackUsers = [...usersStore]
    hydrateAllStores(mongoDoc.snapshot, fallbackUsers)
    return true
  } catch (error) {
    console.error('No se pudo refrescar estado desde MongoDB:', error)
    return false
  }
}

export const initializeDataStore = async () => {
  let loadedFromMongo = false
  const fallbackUsers = [...usersStore]

  if (hasMongoConfigured()) {
    try {
      const mongoDoc = await readMongoSnapshot()
      if (mongoDoc?.snapshot) {
        hydrateAllStores(mongoDoc.snapshot, fallbackUsers)
        loadedFromMongo = true
      }
    } catch (error) {
      console.error('No se pudo cargar estado desde MongoDB. Se usará persistencia local.', error)
    }
  }

  if (!loadedFromMongo) {
    loadLocalData()
  }

  ensureSeedData()
  applyLocalBaseOnlyMode()
  persistLocalData()
}
