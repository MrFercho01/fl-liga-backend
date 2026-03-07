import fs from 'node:fs'
import path from 'node:path'

export interface RuleSet {
  playersOnField: number
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
}

export interface RegisteredTeam {
  id: string
  leagueId: string
  categoryId: string
  name: string
  logoUrl?: string
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
    type: 'shot' | 'goal' | 'penalty_goal' | 'penalty_miss' | 'yellow' | 'red' | 'double_yellow' | 'assist' | 'substitution'
    teamName: string
    playerName: string
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

type LocalSnapshot = {
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

const defaultSuperAdminName = process.env.SUPER_ADMIN_NAME?.trim() || 'MrFercho'
const defaultSuperAdminEmail = process.env.SUPER_ADMIN_EMAIL?.trim() || 'mrfercho@flliga.local'
const defaultSuperAdminPassword = process.env.SUPER_ADMIN_PASSWORD?.trim() || '1623Fercho.'

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

const loadLocalData = () => {
  if (!fs.existsSync(localDbPath)) return

  try {
    const raw = fs.readFileSync(localDbPath, 'utf-8')
    const parsed = JSON.parse(raw) as LocalSnapshot

    const fallbackUsers = [...usersStore]
    hydrateStore(usersStore, parsed.users, fallbackUsers)
    hydrateStore(leaguesStore, parsed.leagues)
    hydrateStore(teamsStore, parsed.teams)
    hydrateStore(fixtureScheduleStore, parsed.fixtureSchedule)
    hydrateStore(roundAwardsStore, parsed.roundAwards)
    hydrateStore(playedMatchesStore, parsed.playedMatches)
    hydrateStore(auditLogsStore, parsed.auditLogs)
    hydrateStore(publicEngagementStore, parsed.publicEngagement)
    hydrateStore(publicMatchLikesStore, parsed.publicMatchLikes)
    hydrateStore(clientAccessTokensStore, parsed.clientAccessTokens)
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

  if (!hadLeague || !hadTeams || !hadSchedule || !hasSuperAdmin) {
    persistLocalData()
  }
}

const applyLocalBaseOnlyMode = () => {
  const enabled = (process.env.FL_LOCAL_BASE_ONLY ?? '1') !== '0'
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
  const snapshot: LocalSnapshot = {
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
  }

  fs.writeFileSync(localDbPath, JSON.stringify(snapshot, null, 2), 'utf-8')
}

loadLocalData()
ensureSeedData()
applyLocalBaseOnlyMode()
persistLocalData()
