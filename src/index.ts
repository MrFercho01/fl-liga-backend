import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import multer from 'multer'
import { Readable } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Server } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import ffmpegPath from 'ffmpeg-static'
import {
  auditLogsStore,
  clientAccessTokensStore,
  ensureOperationalSeedData,
  fixtureScheduleStore,
  flushPersistQueue,
  getMongoObjectId,
  getVideosBucket,
  initializeDataStore,
  leaguesStore,
  persistLocalData,
  playedMatchesStore,
  publicEngagementStore,
  publicMatchLikesStore,
  refreshStoresFromMongoSnapshot,
  roundAwardsStore,
  type RegisteredPlayer,
  type RegisteredTeam,
  SUPER_ADMIN_USER_ID,
  teamsStore,
  usersStore,
} from './data'
import { generateFixture } from './fixture'
import {
  buildLiveSnapshot,
  loadMatchForLive,
  registerEvent,
  setMatchStatusAction,
  setTimerAction,
  updateLineupWithFormation,
  updateSettings,
} from './live'
import { sendClientAccessCredentialsEmail } from './mail'

const app = express()
const port = Number(process.env.PORT ?? 4000)
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: true,
  },
})

const authTokens = new Map<string, { userId: string; expiresAt: number }>()
const loginAttempts = new Map<string, { count: number; blockedUntil: number }>()
const maxLoginAttempts = 5
const loginBlockMs = 10 * 60 * 1000
const tokenTtlMs = 8 * 60 * 60 * 1000

type AuthContext = {
  id: string
  name: string
  organizationName?: string
  email: string
  role: 'super_admin' | 'client_admin'
}

const sanitizeUser = (user: { id: string; name: string; organizationName?: string; email: string; role: 'super_admin' | 'client_admin' }): AuthContext => ({
  id: user.id,
  name: user.name,
  ...(user.organizationName ? { organizationName: user.organizationName } : {}),
  email: user.email,
  role: user.role,
})

const getRequestIp = (request: express.Request) =>
  (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || request.ip || 'unknown-ip'

const resolveUserFromRequest = (request: express.Request): AuthContext | null => {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null

  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return null

  const session = authTokens.get(token)
  if (!session) return null

  if (Date.now() > session.expiresAt) {
    authTokens.delete(token)
    return null
  }

  const user = usersStore.find((item) => item.id === session.userId && item.active)
  if (!user) return null

  return sanitizeUser(user)
}

const requireAuth = (request: express.Request, response: express.Response): AuthContext | null => {
  const user = resolveUserFromRequest(request)
  if (!user) {
    response.status(401).json({ message: 'Sesión no válida. Inicia sesión.' })
    return null
  }

  return user
}

const requireSuperAdmin = (request: express.Request, response: express.Response): AuthContext | null => {
  const user = requireAuth(request, response)
  if (!user) return null

  if (user.role !== 'super_admin') {
    response.status(403).json({ message: 'Acceso solo para super admin' })
    return null
  }

  return user
}

const broadcastLive = () => {
  io.emit('live:update', buildLiveSnapshot())
}

app.use(
  cors({
    origin: true,
  }),
)
app.use(express.json({ limit: '12mb' }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
  },
})

const transcodeVideoIfPossible = async (buffer: Buffer) => {
  const binary = ffmpegPath || process.env.FFMPEG_PATH || ''
  if (!binary) {
    return { buffer, mimetype: 'video/mp4', transcoded: false }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fl-liga-video-'))
  const inputPath = path.join(tempDir, 'input.bin')
  const outputPath = path.join(tempDir, 'output.mp4')

  try {
    await fs.writeFile(inputPath, buffer)

    await new Promise<void>((resolve, reject) => {
      const process = spawn(binary, [
        '-y',
        '-i',
        inputPath,
        '-vf',
        'scale=w=854:h=480:force_original_aspect_ratio=decrease',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '30',
        '-movflags',
        '+faststart',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        outputPath,
      ])

      process.once('error', reject)
      process.once('close', (code) => {
        if (code === 0) {
          resolve()
          return
        }
        reject(new Error(`ffmpeg exit code ${String(code)}`))
      })
    })

    const output = await fs.readFile(outputPath)
    return { buffer: output, mimetype: 'video/mp4', transcoded: true }
  } catch {
    return { buffer, mimetype: 'video/mp4', transcoded: false }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

const loginSchema = z.object({
  identifier: z.string().min(2),
  password: z.string().min(3),
  accessToken: z.string().min(12).optional(),
})

const isClientAccessTokenActive = (entry: { active: boolean; expiresAt: string }) => {
  if (!entry.active) return false
  const expiresAtMs = new Date(entry.expiresAt).getTime()
  return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
}

const findValidClientAccessToken = (rawToken: string) => {
  const token = rawToken.trim()
  if (!token) return null

  const entry = clientAccessTokensStore.find((item) => item.token === token)
  if (!entry || !isClientAccessTokenActive(entry)) return null

  const clientUser = usersStore.find((item) => item.id === entry.clientUserId && item.active && item.role === 'client_admin')
  if (!clientUser) return null

  return { entry, clientUser }
}

const createAuthSession = (userId: string) => {
  const token = randomUUID()
  authTokens.set(token, { userId, expiresAt: Date.now() + tokenTtlMs })
  return token
}

app.post('/api/auth/login', (request, response) => {
  const parsed = loginSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Credenciales inválidas' })
    return
  }

  const normalizedIdentifier = parsed.data.identifier.trim().toLowerCase()
  const loginKey = `${normalizedIdentifier}|${getRequestIp(request)}`
  const requestIp = getRequestIp(request)
  const attempts = loginAttempts.get(loginKey)
  if (attempts && attempts.blockedUntil > Date.now()) {
    const waitMinutes = Math.ceil((attempts.blockedUntil - Date.now()) / 60000)
    response.status(429).json({ message: `Demasiados intentos. Intenta en ${waitMinutes} min.` })
    return
  }

  const user = usersStore.find(
    (item) =>
      item.active &&
      (item.email.toLowerCase() === normalizedIdentifier || item.name.trim().toLowerCase() === normalizedIdentifier) &&
      item.password === parsed.data.password,
  )

  if (!user) {
    const current = loginAttempts.get(loginKey)
    const nextCount = (current?.count ?? 0) + 1
    const blockedUntil = nextCount >= maxLoginAttempts ? Date.now() + loginBlockMs : 0
    loginAttempts.set(loginKey, { count: nextCount, blockedUntil })

    auditLogsStore.unshift({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      userId: 'unknown',
      userEmail: normalizedIdentifier,
      action: 'login_failed',
      ip: requestIp,
      details: `Intento #${nextCount}`,
    })
    persistLocalData()

    response.status(401).json({ message: 'Usuario/correo o contraseña incorrectos' })
    return
  }

  if (user.role === 'client_admin') {
    const accessToken = parsed.data.accessToken?.trim() ?? ''
    if (!accessToken) {
      response.status(403).json({ message: 'Debes ingresar un token de acceso válido' })
      return
    }

    const validated = findValidClientAccessToken(accessToken)
    if (!validated || validated.clientUser.id !== user.id) {
      response.status(403).json({ message: 'Token inválido, vencido o no corresponde al cliente' })
      return
    }

    if (user.mustChangePassword) {
      response.status(428).json({
        message: 'Debes cambiar tu contraseña temporal antes de ingresar',
        code: 'MUST_CHANGE_PASSWORD',
      })
      return
    }
  }

  loginAttempts.delete(loginKey)

  const token = createAuthSession(user.id)

  auditLogsStore.unshift({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    userId: user.id,
    userEmail: user.email,
    action: 'login_success',
    ip: requestIp,
  })
  persistLocalData()

  response.json({
    data: {
      token,
      user: sanitizeUser(user),
    },
  })
})

const validateClientTokenSchema = z.object({
  accessToken: z.string().min(12),
})

app.post('/api/auth/client-token/validate', (request, response) => {
  const parsed = validateClientTokenSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Token inválido' })
    return
  }

  const validated = findValidClientAccessToken(parsed.data.accessToken)
  if (!validated) {
    response.status(403).json({ message: 'Token inválido o vencido' })
    return
  }

  response.json({
    data: {
      client: sanitizeUser(validated.clientUser),
      expiresAt: validated.entry.expiresAt,
    },
  })
})

const registerClientWithTokenSchema = z.object({
  accessToken: z.string().min(12),
  fullName: z.string().trim().min(4),
  organizationName: z.string().trim().min(2),
  email: z.string().email(),
  password: z.string().min(4),
})

app.post('/api/auth/client/register', (request, response) => {
  const parsed = registerClientWithTokenSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const validated = findValidClientAccessToken(parsed.data.accessToken)
  if (!validated) {
    response.status(403).json({ message: 'Token inválido o vencido' })
    return
  }

  const duplicated = usersStore.some(
    (item) =>
      item.id !== validated.clientUser.id &&
      item.active &&
      item.email.trim().toLowerCase() === parsed.data.email.trim().toLowerCase(),
  )
  if (duplicated) {
    response.status(409).json({ message: 'El email ya está registrado' })
    return
  }

  validated.clientUser.name = parsed.data.fullName.trim()
  validated.clientUser.organizationName = parsed.data.organizationName.trim()
  validated.clientUser.email = parsed.data.email.trim().toLowerCase()
  validated.clientUser.password = parsed.data.password
  validated.clientUser.mustChangePassword = false
  validated.clientUser.active = true

  const token = createAuthSession(validated.clientUser.id)
  persistLocalData()

  response.status(201).json({
    data: {
      token,
      user: sanitizeUser(validated.clientUser),
    },
  })
})

const resetClientPasswordWithTokenSchema = z.object({
  accessToken: z.string().min(12),
  email: z.string().email(),
  password: z.string().min(4),
  currentPassword: z.string().min(4).optional(),
})

app.post('/api/auth/client/reset-password', (request, response) => {
  const parsed = resetClientPasswordWithTokenSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const validated = findValidClientAccessToken(parsed.data.accessToken)
  if (!validated) {
    response.status(403).json({ message: 'Token inválido o vencido' })
    return
  }

  if (validated.clientUser.email.trim().toLowerCase() !== parsed.data.email.trim().toLowerCase()) {
    response.status(403).json({ message: 'El correo no coincide con el cliente del token' })
    return
  }

  if (validated.clientUser.mustChangePassword) {
    if (!parsed.data.currentPassword || validated.clientUser.password !== parsed.data.currentPassword) {
      response.status(403).json({ message: 'Contraseña temporal incorrecta' })
      return
    }
  }

  validated.clientUser.password = parsed.data.password
  validated.clientUser.mustChangePassword = false
  validated.clientUser.active = true
  persistLocalData()

  response.json({ data: { ok: true } })
})

app.get('/api/auth/me', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return
  response.json({ data: user })
})

app.post('/api/auth/logout', (request, response) => {
  const user = resolveUserFromRequest(request)
  const requestIp = getRequestIp(request)

  const authHeader = request.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '').trim()
    if (token) {
      authTokens.delete(token)
    }
  }

  if (user) {
    auditLogsStore.unshift({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      userId: user.id,
      userEmail: user.email,
      action: 'logout',
      ip: requestIp,
    })
    persistLocalData()
  }

  response.json({ ok: true })
})

app.get('/api/admin/audit-logs', (request, response) => {
  const user = requireSuperAdmin(request, response)
  if (!user) return

  response.json({ data: auditLogsStore.slice(0, 300) })
})

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'FL Liga API' })
})

app.get('/api/live/match', (_request, response) => {
  response.json({ data: buildLiveSnapshot() })
})

app.get('/api/leagues', async (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  await refreshStoresFromMongoSnapshot()

  ensureOperationalSeedData()

  if (user.role === 'super_admin') {
    response.json({ data: leaguesStore })
    return
  }

  response.json({ data: leaguesStore.filter((league) => league.ownerUserId === user.id) })
})

app.get('/api/admin/users', (request, response) => {
  const user = requireSuperAdmin(request, response)
  if (!user) return

  ensureOperationalSeedData()

  const data = usersStore.map((user) => {
    const leagues = leaguesStore.filter((league) => league.ownerUserId === user.id)
    return {
      id: user.id,
      name: user.name,
      ...(user.organizationName ? { organizationName: user.organizationName } : {}),
      email: user.email,
      role: user.role,
      active: user.active,
      publicRouteAlias: buildPublicClientAlias(user),
      publicPortalPath: buildPublicClientPath(user),
      leagues,
      leaguesCount: leagues.length,
    }
  })

  response.json({ data })
})

const createClientUserSchema = z.object({
  name: z.string().trim().min(2),
  organizationName: z.string().trim().min(2),
  email: z.string().email(),
  password: z.string().min(4).optional(),
})

app.post('/api/admin/client-users', (request, response) => {
  const user = requireSuperAdmin(request, response)
  if (!user) return

  const parsed = createClientUserSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const normalizedEmail = parsed.data.email.trim().toLowerCase()
  const existing = usersStore.find((item) => item.email.trim().toLowerCase() === normalizedEmail)
  if (existing) {
    response.status(409).json({ message: 'El email ya está registrado' })
    return
  }

  const nextUser = {
    id: `client-${randomUUID().slice(0, 8)}`,
    name: parsed.data.name.trim(),
    organizationName: parsed.data.organizationName.trim(),
    email: normalizedEmail,
    password: parsed.data.password?.trim() || randomUUID().slice(0, 12),
    mustChangePassword: false,
    role: 'client_admin' as const,
    active: true,
  }

  usersStore.push(nextUser)
  persistLocalData()

  response.status(201).json({
    data: sanitizeUser(nextUser),
  })
})

const updateClientUserSchema = z
  .object({
    name: z.string().trim().min(2).optional(),
    organizationName: z.string().trim().min(2).optional(),
    email: z.string().email().optional(),
    active: z.boolean().optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, { message: 'Debe enviar al menos un campo' })

app.patch('/api/admin/client-users/:userId', (request, response) => {
  const user = requireSuperAdmin(request, response)
  if (!user) return

  const parsed = updateClientUserSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const client = usersStore.find((item) => item.id === request.params.userId && item.role === 'client_admin')
  if (!client) {
    response.status(404).json({ message: 'Cliente no encontrado' })
    return
  }

  if (parsed.data.email !== undefined) {
    const normalizedEmail = parsed.data.email.trim().toLowerCase()
    const existing = usersStore.find(
      (item) => item.id !== client.id && item.email.trim().toLowerCase() === normalizedEmail,
    )
    if (existing) {
      response.status(409).json({ message: 'El email ya está registrado' })
      return
    }
    client.email = normalizedEmail
  }

  if (parsed.data.name !== undefined) {
    client.name = parsed.data.name.trim()
  }

  if (parsed.data.organizationName !== undefined) {
    client.organizationName = parsed.data.organizationName.trim()
  }

  if (parsed.data.active !== undefined) {
    client.active = parsed.data.active

    if (!client.active) {
      const now = new Date().toISOString()
      clientAccessTokensStore.forEach((token) => {
        if (token.clientUserId === client.id && token.active) {
          token.active = false
          token.revokedAt = now
        }
      })
    }
  }

  persistLocalData()

  response.json({
    data: {
      id: client.id,
      name: client.name,
      ...(client.organizationName ? { organizationName: client.organizationName } : {}),
      email: client.email,
      role: client.role,
      active: client.active,
    },
  })
})

app.post('/api/admin/client-users/:userId/reset-temporary-password', (request, response) => {
  const user = requireSuperAdmin(request, response)
  if (!user) return

  const client = usersStore.find((item) => item.id === request.params.userId && item.role === 'client_admin')
  if (!client) {
    response.status(404).json({ message: 'Cliente no encontrado' })
    return
  }

  const temporaryPassword = `Tmp-${randomUUID().slice(0, 8)}`
  client.password = temporaryPassword
  client.mustChangePassword = true
  client.active = true

  persistLocalData()

  response.json({
    data: {
      id: client.id,
      name: client.name,
      temporaryPassword,
      active: client.active,
    },
  })
})

app.get('/api/admin/client-access-tokens', (request, response) => {
  const user = requireSuperAdmin(request, response)
  if (!user) return

  let shouldPersist = false
  const nowIso = new Date().toISOString()

  const data = clientAccessTokensStore
    .slice()
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map((item) => {
      const effectiveActive = isClientAccessTokenActive(item)
      if (item.active && !effectiveActive) {
        item.active = false
        if (!item.revokedAt) {
          item.revokedAt = nowIso
        }
        shouldPersist = true
      }

      const client = usersStore.find((candidate) => candidate.id === item.clientUserId)
      return {
        id: item.id,
        clientUserId: item.clientUserId,
        clientName: client?.name ?? item.clientUserId,
        clientEmail: client?.email ?? '',
        ...(client?.organizationName ? { organizationName: client.organizationName } : {}),
        ...(client
          ? {
              publicRouteAlias: buildPublicClientAlias(client),
              publicPortalPath: buildPublicClientPath(client),
            }
          : {}),
        token: item.token,
        expiresAt: item.expiresAt,
        active: effectiveActive,
        createdAt: item.createdAt,
        ...(item.revokedAt ? { revokedAt: item.revokedAt } : {}),
      }
    })

  if (shouldPersist) {
    persistLocalData()
  }

  response.json({ data })
})

const createClientAccessTokenSchema = z.object({
  clientUserId: z.string(),
  expiresAt: z.string(),
})

app.post('/api/admin/client-access-tokens', (request, response) => {
  const user = requireSuperAdmin(request, response)
  if (!user) return

  const parsed = createClientAccessTokenSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const client = usersStore.find((item) => item.id === parsed.data.clientUserId && item.active && item.role === 'client_admin')
  if (!client) {
    response.status(404).json({ message: 'Cliente no encontrado' })
    return
  }

  const expiresAtMs = new Date(parsed.data.expiresAt).getTime()
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    response.status(400).json({ message: 'La fecha de caducidad debe ser futura' })
    return
  }

  const entry = {
    id: uuidv4(),
    clientUserId: client.id,
    token: `cli_${randomUUID().replace(/-/g, '')}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
    active: true,
    createdAt: new Date().toISOString(),
  }

  const temporaryPassword = `Tmp-${randomUUID().slice(0, 8)}`

  queueMicrotask(async () => {
    client.password = temporaryPassword
    client.mustChangePassword = true
    clientAccessTokensStore.push(entry)
    persistLocalData()

    let emailMessageId: string | undefined
    let emailError: string | undefined

    try {
      const emailResult = await sendClientAccessCredentialsEmail({
        to: client.email,
        clientName: client.name,
        ...(client.organizationName ? { organizationName: client.organizationName } : {}),
        accessToken: entry.token,
        temporaryPassword,
        expiresAt: entry.expiresAt,
      })
      emailMessageId = emailResult.messageId
    } catch (error) {
      emailError = error instanceof Error ? error.message : 'No se pudo enviar correo al cliente'
    }

    response.status(201).json({
      data: {
        ...entry,
        clientName: client.name,
        clientEmail: client.email,
        ...(client.organizationName ? { organizationName: client.organizationName } : {}),
        publicRouteAlias: buildPublicClientAlias(client),
        publicPortalPath: buildPublicClientPath(client),
        temporaryPassword,
        ...(emailMessageId ? { emailMessageId } : {}),
        ...(emailError ? { emailError } : {}),
      },
    })
  })
})

app.patch('/api/admin/client-access-tokens/:tokenId/revoke', (request, response) => {
  const user = requireSuperAdmin(request, response)
  if (!user) return

  const token = clientAccessTokensStore.find((item) => item.id === request.params.tokenId)
  if (!token) {
    response.status(404).json({ message: 'Token no encontrado' })
    return
  }

  token.active = false
  token.revokedAt = new Date().toISOString()
  persistLocalData()

  response.json({ data: token })
})

const renewClientAccessTokenSchema = z.object({
  expiresAt: z.string(),
})

app.patch('/api/admin/client-access-tokens/:tokenId/renew', (request, response) => {
  const user = requireSuperAdmin(request, response)
  if (!user) return

  const parsed = renewClientAccessTokenSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const token = clientAccessTokensStore.find((item) => item.id === request.params.tokenId)
  if (!token) {
    response.status(404).json({ message: 'Token no encontrado' })
    return
  }

  const expiresAtMs = new Date(parsed.data.expiresAt).getTime()
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    response.status(400).json({ message: 'La fecha de caducidad debe ser futura' })
    return
  }

  token.expiresAt = new Date(expiresAtMs).toISOString()
  token.active = true
  delete token.revokedAt
  persistLocalData()

  response.json({ data: token })
})

app.get('/api/leagues/:leagueId/categories', async (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  await refreshStoresFromMongoSnapshot()

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  response.json({ data: league.categories })
})

const normalizeClientAlias = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const buildPublicClientAlias = (user: {
  id: string
  name: string
  organizationName?: string
  email: string
}) => {
  const organizationAlias = normalizeClientAlias(user.organizationName ?? '')
  if (organizationAlias) return organizationAlias

  const ownedLeagueAlias = normalizeClientAlias(
    leaguesStore.find((league) => league.ownerUserId === user.id && league.active)?.slug ?? '',
  )
  if (ownedLeagueAlias) return ownedLeagueAlias

  const nameAlias = normalizeClientAlias(user.name)
  if (nameAlias) return nameAlias

  const emailAlias = normalizeClientAlias(user.email.split('@')[0] ?? '')
  if (emailAlias) return emailAlias

  return normalizeClientAlias(user.id)
}

const buildPublicClientPath = (user: {
  id: string
  name: string
  organizationName?: string
  email: string
}) => `/cliente/${encodeURIComponent(buildPublicClientAlias(user))}`

const resolvePublicClientId = (rawClientId: string) => {
  const normalized = normalizeClientAlias(rawClientId)
  if (!normalized) return null

  const activeClients = usersStore.filter((user) => user.active && (user.role === 'client_admin' || user.role === 'super_admin'))
  if (activeClients.length === 0) return null

  const exactById = activeClients.find((user) => normalizeClientAlias(user.id) === normalized)
  if (exactById) return exactById.id

  const byOrganization = activeClients.find((user) => normalizeClientAlias(user.organizationName ?? '') === normalized)
  if (byOrganization) return byOrganization.id

  const byOwnedLeagueSlug = leaguesStore.find((league) => normalizeClientAlias(league.slug) === normalized && league.active)
  if (byOwnedLeagueSlug) return byOwnedLeagueSlug.ownerUserId

  const byEmail = activeClients.find((user) => normalizeClientAlias(user.email.split('@')[0] ?? '') === normalized)
  if (byEmail) return byEmail.id

  const byName = activeClients.find((user) => normalizeClientAlias(user.name) === normalized)
  if (byName) return byName.id

  const orderMatch = normalized.match(/^cliente-?(\d+)$/)
  if (orderMatch) {
    const position = Number(orderMatch[1])
    if (Number.isFinite(position) && position > 0 && position <= activeClients.length) {
      const sortedClients = [...activeClients].sort((left, right) => left.name.localeCompare(right.name, 'es'))
      return sortedClients[position - 1]?.id ?? null
    }
  }

  return null
}

const normalizeTeamLabel = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

const findTeamByLeagueCategoryAndName = (leagueId: string, categoryId: string, teamName: string) => {
  const normalizedName = normalizeTeamLabel(teamName)
  return teamsStore.find(
    (team) =>
      team.leagueId === leagueId &&
      team.categoryId === categoryId &&
      normalizeTeamLabel(team.name) === normalizedName,
  )
}

const resolvePlayersOnField = (leagueId: string, categoryId: string) => {
  const league = leaguesStore.find((item) => item.id === leagueId)
  const category = league?.categories.find((item) => item.id === categoryId)
  return Math.max(1, category?.rules.playersOnField ?? 11)
}

const buildFallbackLineupSnapshot = (
  leagueId: string,
  categoryId: string,
  team: RegisteredTeam | undefined,
  recordPlayers: Array<{ playerId: string; playerName: string }>,
) => {
  const playersOnField = resolvePlayersOnField(leagueId, categoryId)

  const sourceIds = team
    ? team.players.slice().sort((left, right) => left.number - right.number).map((player) => player.id)
    : recordPlayers
      .slice()
      .sort((left, right) => left.playerName.localeCompare(right.playerName, 'es'))
      .map((player) => player.playerId)

  const uniqueIds = Array.from(new Set(sourceIds.filter(Boolean)))
  if (uniqueIds.length === 0) return null

  const starters = uniqueIds.slice(0, playersOnField)
  const substitutes = uniqueIds.slice(playersOnField)

  return {
    starters,
    substitutes,
  }
}

const migratePlayedMatchesLineups = () => {
  let migrated = 0

  playedMatchesStore.forEach((match) => {
    const needsHome = !match.homeLineup || match.homeLineup.starters.length === 0
    const needsAway = !match.awayLineup || match.awayLineup.starters.length === 0
    if (!needsHome && !needsAway) return

    const homeTeam = findTeamByLeagueCategoryAndName(match.leagueId, match.categoryId, match.homeTeamName)
    const awayTeam = findTeamByLeagueCategoryAndName(match.leagueId, match.categoryId, match.awayTeamName)

    const homePlayers = match.players
      .filter((player) => normalizeTeamLabel(player.teamName) === normalizeTeamLabel(match.homeTeamName))
      .map((player) => ({ playerId: player.playerId, playerName: player.playerName }))

    const awayPlayers = match.players
      .filter((player) => normalizeTeamLabel(player.teamName) === normalizeTeamLabel(match.awayTeamName))
      .map((player) => ({ playerId: player.playerId, playerName: player.playerName }))

    const nextHome = needsHome
      ? buildFallbackLineupSnapshot(match.leagueId, match.categoryId, homeTeam, homePlayers)
      : match.homeLineup

    const nextAway = needsAway
      ? buildFallbackLineupSnapshot(match.leagueId, match.categoryId, awayTeam, awayPlayers)
      : match.awayLineup

    if (!nextHome && !nextAway) return

    if (nextHome) {
      match.homeLineup = {
        starters: nextHome.starters,
        substitutes: nextHome.substitutes,
        ...(match.homeLineup?.formationKey ? { formationKey: match.homeLineup.formationKey } : {}),
      }
    }

    if (nextAway) {
      match.awayLineup = {
        starters: nextAway.starters,
        substitutes: nextAway.substitutes,
        ...(match.awayLineup?.formationKey ? { formationKey: match.awayLineup.formationKey } : {}),
      }
    }

    migrated += 1
  })

  if (migrated > 0) {
    persistLocalData()
  }

  return migrated
}

const ensurePublicEngagement = (clientId: string) => {
  let entry = publicEngagementStore.find((item) => item.clientId === clientId)
  if (!entry) {
    entry = {
      clientId,
      visits: 0,
      likes: 0,
      updatedAt: new Date().toISOString(),
    }
    publicEngagementStore.push(entry)
  }

  return entry
}

app.get('/api/public/clients', async (_request, response) => {
  await refreshStoresFromMongoSnapshot()

  const data = usersStore
    .filter((user) => user.active && user.role === 'client_admin')
    .map((user) => {
      const leagues = leaguesStore
        .filter((league) => league.ownerUserId === user.id && league.active)
        .map((league) => ({
          id: league.id,
          name: league.name,
          slug: league.slug,
          country: league.country,
          season: league.season,
          themeColor: league.themeColor,
          backgroundImageUrl: league.backgroundImageUrl,
          logoUrl: league.logoUrl,
          categories: league.categories.map((category) => ({
            id: category.id,
            name: category.name,
          })),
        }))

      return {
        id: user.id,
        name: user.name,
        ...(user.organizationName ? { organizationName: user.organizationName } : {}),
        publicRouteAlias: buildPublicClientAlias(user),
        publicPortalPath: buildPublicClientPath(user),
        leagues,
      }
    })
    .filter((user) => user.leagues.length > 0)

  response.json({ data })
})

app.get('/api/public/client/:clientId/leagues', async (request, response) => {
  await refreshStoresFromMongoSnapshot()

  const clientId = resolvePublicClientId(request.params.clientId ?? '')
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' })
    return
  }

  const data = leaguesStore
    .filter((league) => league.ownerUserId === clientId && league.active)
    .map((league) => ({
      id: league.id,
      name: league.name,
      slug: league.slug,
      country: league.country,
      season: league.season,
      slogan: league.slogan,
      themeColor: league.themeColor,
      backgroundImageUrl: league.backgroundImageUrl,
      logoUrl: league.logoUrl,
      categories: league.categories.map((category) => ({
        id: category.id,
        name: category.name,
      })),
    }))

  response.json({ data })
})

app.get('/api/public/client/:clientId/engagement', (request, response) => {
  const clientId = resolvePublicClientId(request.params.clientId ?? '')
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' })
    return
  }

  const engagement = ensurePublicEngagement(clientId)
  response.json({
    data: {
      clientId,
      visits: engagement.visits,
      likes: engagement.likes,
      updatedAt: engagement.updatedAt,
    },
  })
})

const publicEngagementUpdateSchema = z.object({
  action: z.enum(['visit', 'like']),
  delta: z.number().int().min(-1).max(1).optional(),
})

const ensurePublicMatchLike = (clientId: string, leagueId: string, categoryId: string, matchId: string) => {
  let entry = publicMatchLikesStore.find(
    (item) =>
      item.clientId === clientId &&
      item.leagueId === leagueId &&
      item.categoryId === categoryId &&
      item.matchId === matchId,
  )

  if (!entry) {
    entry = {
      clientId,
      leagueId,
      categoryId,
      matchId,
      likes: 0,
      updatedAt: new Date().toISOString(),
    }
    publicMatchLikesStore.push(entry)
  }

  return entry
}

app.post('/api/public/client/:clientId/engagement', (request, response) => {
  const clientId = resolvePublicClientId(request.params.clientId ?? '')
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' })
    return
  }

  const parsed = publicEngagementUpdateSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const engagement = ensurePublicEngagement(clientId)
  if (parsed.data.action === 'visit') {
    engagement.visits += 1
  } else {
    const delta = parsed.data.delta ?? 1
    engagement.likes = Math.max(0, engagement.likes + delta)
  }
  engagement.updatedAt = new Date().toISOString()

  persistLocalData()

  response.json({
    data: {
      clientId,
      visits: engagement.visits,
      likes: engagement.likes,
      updatedAt: engagement.updatedAt,
    },
  })
})

app.get('/api/public/client/:clientId/matches/:matchId/engagement', (request, response) => {
  const clientId = resolvePublicClientId(request.params.clientId ?? '')
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' })
    return
  }

  const leagueId = typeof request.query.leagueId === 'string' ? request.query.leagueId : ''
  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  if (!leagueId || !categoryId) {
    response.status(400).json({ message: 'leagueId y categoryId son requeridos' })
    return
  }

  const entry = ensurePublicMatchLike(clientId, leagueId, categoryId, request.params.matchId)
  response.json({
    data: {
      likes: entry.likes,
      updatedAt: entry.updatedAt,
    },
  })
})

const publicMatchLikeUpdateSchema = z.object({
  leagueId: z.string().uuid(),
  categoryId: z.string().uuid(),
  delta: z.number().int().min(-1).max(1),
})

const parseMatchIdentity = (matchId: string) => {
  if (matchId.startsWith('manual__')) {
    const [prefix, rawRound, homeTeamId, awayTeamId] = matchId.split('__')
    const parsedRound = Number(rawRound)
    if (prefix === 'manual' && Number.isFinite(parsedRound) && homeTeamId && awayTeamId) {
      return { round: parsedRound, homeTeamId, awayTeamId }
    }
  }

  if (matchId.startsWith('manual-')) {
    const parsed = matchId.replace('manual-', '')
    const firstDash = parsed.indexOf('-')
    if (firstDash > 0) {
      const parsedRound = Number(parsed.slice(0, firstDash))
      const ids = parsed.slice(firstDash + 1).split('-')
      if (Number.isFinite(parsedRound) && ids.length >= 10) {
        const homeTeamId = ids.slice(0, 5).join('-')
        const awayTeamId = ids.slice(5).join('-')
        if (homeTeamId && awayTeamId) {
          return { round: parsedRound, homeTeamId, awayTeamId }
        }
      }
    }
  }

  const parts = matchId.split('-')
  if (parts.length === 12) {
    const parsedRound = Number(parts[0])
    const homeTeamId = parts.slice(2, 7).join('-')
    const awayTeamId = parts.slice(7, 12).join('-')
    if (Number.isFinite(parsedRound) && homeTeamId.length === 36 && awayTeamId.length === 36) {
      return { round: parsedRound, homeTeamId, awayTeamId }
    }
  }

  return null
}

const isTeamActive = (team: { active?: boolean }) => team.active !== false

app.post('/api/public/client/:clientId/matches/:matchId/engagement', (request, response) => {
  const clientId = resolvePublicClientId(request.params.clientId ?? '')
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' })
    return
  }

  const parsed = publicMatchLikeUpdateSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const entry = ensurePublicMatchLike(clientId, parsed.data.leagueId, parsed.data.categoryId, request.params.matchId)
  entry.likes = Math.max(0, entry.likes + parsed.data.delta)
  entry.updatedAt = new Date().toISOString()
  persistLocalData()

  response.json({
    data: {
      likes: entry.likes,
      updatedAt: entry.updatedAt,
    },
  })
})

app.get('/api/public/client/:clientId/leagues/:leagueId/fixture', async (request, response) => {
  await refreshStoresFromMongoSnapshot()

  const clientId = resolvePublicClientId(request.params.clientId ?? '')
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' })
    return
  }

  const league = leaguesStore.find((item) => item.id === request.params.leagueId && item.active)
  if (!league || league.ownerUserId !== clientId) {
    response.status(404).json({ message: 'Liga no encontrada para el cliente' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  const category = league.categories.find((item) => item.id === categoryId)
  if (!category) {
    response.status(400).json({ message: 'categoryId inválido para la liga seleccionada' })
    return
  }

  const categoryTeams = teamsStore.filter(
    (team) => team.leagueId === league.id && team.categoryId === categoryId && isTeamActive(team),
  )
  const activeTeamIds = new Set(categoryTeams.map((team) => team.id))
  const activeTeamNameKeys = new Set(categoryTeams.map((team) => normalizeTeamLabel(team.name)))
  const rounds = generateFixture(categoryTeams)
  const playerMetaById = new Map<string, { name: string; photoUrl?: string; teamName: string }>()
  categoryTeams.forEach((team) => {
    team.players.forEach((player) => {
      playerMetaById.set(player.id, {
        name: player.name,
        ...(player.photoUrl ? { photoUrl: player.photoUrl } : {}),
        teamName: team.name,
      })
    })
  })
  const teams = categoryTeams.map((team) => ({
    id: team.id,
    name: team.name,
    logoUrl: team.logoUrl,
    primaryColor: team.primaryColor,
    secondaryColor: team.secondaryColor,
    technicalStaff: team.technicalStaff,
    players: team.players,
  }))
  const schedule = fixtureScheduleStore.filter((entry) => {
    if (entry.leagueId !== league.id || entry.categoryId !== categoryId) return false
    const parsed = parseMatchIdentity(entry.matchId)
    if (!parsed) return true
    return activeTeamIds.has(parsed.homeTeamId) && activeTeamIds.has(parsed.awayTeamId)
  })

  const playedMatchesBase = playedMatchesStore.filter((item) => {
    if (item.leagueId !== league.id || item.categoryId !== categoryId) return false
    const homeActive = activeTeamNameKeys.has(normalizeTeamLabel(item.homeTeamName))
    const awayActive = activeTeamNameKeys.has(normalizeTeamLabel(item.awayTeamName))
    return homeActive && awayActive
  })

  const playedMatchIds = playedMatchesBase.map((item) => item.matchId)
  const playedMatches = playedMatchesBase
    .map((item) => {
      const mvpPlayer = item.playerOfMatchId ? playerMetaById.get(item.playerOfMatchId) : null

      return {
        matchId: item.matchId,
        round: item.round,
        homeTeamName: item.homeTeamName,
        awayTeamName: item.awayTeamName,
        homeGoals: item.homeStats.goals,
        awayGoals: item.awayStats.goals,
        finalMinute: item.finalMinute,
        events: item.events,
        ...(item.playerOfMatchId ? { playerOfMatchId: item.playerOfMatchId } : {}),
        ...(item.playerOfMatchName ? { playerOfMatchName: item.playerOfMatchName } : {}),
        ...(mvpPlayer?.photoUrl ? { playerOfMatchPhotoUrl: mvpPlayer.photoUrl } : {}),
        ...(mvpPlayer?.teamName ? { playerOfMatchTeamName: mvpPlayer.teamName } : {}),
        ...(item.homeLineup ? { homeLineup: item.homeLineup } : {}),
        ...(item.awayLineup ? { awayLineup: item.awayLineup } : {}),
        highlightVideos: item.highlightVideos,
        playedAt: item.playedAt,
      }
    })
  const roundAwards = roundAwardsStore
    .filter((item) => item.leagueId === league.id && item.categoryId === categoryId)
    .map((item) => {
      const roundBestPlayer = item.roundBestPlayerId ? playerMetaById.get(item.roundBestPlayerId) : null

      return {
        round: item.round,
        ...(item.roundBestPlayerId ? { roundBestPlayerId: item.roundBestPlayerId } : {}),
        ...(item.roundBestPlayerName ? { roundBestPlayerName: item.roundBestPlayerName } : {}),
        ...(item.roundBestPlayerTeamId ? { roundBestPlayerTeamId: item.roundBestPlayerTeamId } : {}),
        ...(item.roundBestPlayerTeamName ? { roundBestPlayerTeamName: item.roundBestPlayerTeamName } : {}),
        ...(roundBestPlayer?.photoUrl ? { roundBestPlayerPhotoUrl: roundBestPlayer.photoUrl } : {}),
        updatedAt: item.updatedAt,
      }
    })

  response.json({
    data: {
      league: {
        id: league.id,
        name: league.name,
        country: league.country,
        season: league.season,
        slogan: league.slogan,
        themeColor: league.themeColor,
        backgroundImageUrl: league.backgroundImageUrl,
        logoUrl: league.logoUrl,
      },
      category: {
        id: category.id,
        name: category.name,
      },
      teams,
      fixture: {
        teamsCount: teams.length,
        hasBye: teams.length % 2 !== 0,
        rounds,
      },
      schedule,
      playedMatchIds,
      playedMatches,
      roundAwards,
    },
  })
})

const updateCategoryRulesSchema = z.object({
  rules: z
    .object({
      playersOnField: z.number().int().min(5).max(11).optional(),
      maxRegisteredPlayers: z.number().int().min(5).max(60).optional(),
      matchMinutes: z.number().int().min(20).max(120).optional(),
      breakMinutes: z.number().int().min(0).max(30).optional(),
      allowDraws: z.boolean().optional(),
      pointsWin: z.number().int().min(0).max(10).optional(),
      pointsDraw: z.number().int().min(0).max(10).optional(),
      pointsLoss: z.number().int().min(0).max(10).optional(),
      courtsCount: z.number().int().min(1).max(20).optional(),
      resolveDrawByPenalties: z.boolean().optional(),
      playoffQualifiedTeams: z.number().int().min(2).max(32).optional(),
      playoffHomeAway: z.boolean().optional(),
      finalStageRoundOf16Enabled: z.boolean().optional(),
      finalStageRoundOf8Enabled: z.boolean().optional(),
      finalStageQuarterFinalsEnabled: z.boolean().optional(),
      finalStageSemiFinalsEnabled: z.boolean().optional(),
      finalStageFinalEnabled: z.boolean().optional(),
      finalStageTwoLegged: z.boolean().optional(),
      finalStageRoundOf16TwoLegged: z.boolean().optional(),
      finalStageRoundOf8TwoLegged: z.boolean().optional(),
      finalStageQuarterFinalsTwoLegged: z.boolean().optional(),
      finalStageSemiFinalsTwoLegged: z.boolean().optional(),
      finalStageFinalTwoLegged: z.boolean().optional(),
      doubleRoundRobin: z.boolean().optional(),
      regularSeasonRounds: z.number().int().min(1).max(60).optional(),
    })
    .strict(),
})

app.patch('/api/admin/leagues/:leagueId/categories/:categoryId/rules', async (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const leagueIndex = leaguesStore.findIndex((item) => item.id === request.params.leagueId)
  if (leagueIndex === -1) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  const league = leaguesStore[leagueIndex]
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = updateCategoryRulesSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const categoryIndex = league.categories.findIndex((category) => category.id === request.params.categoryId)
  if (categoryIndex === -1) {
    response.status(404).json({ message: 'Categoría no encontrada' })
    return
  }

  const category = league.categories[categoryIndex]
  if (!category) {
    response.status(404).json({ message: 'Categoría no encontrada' })
    return
  }

  const nextRules = { ...category.rules }
  const incomingRules = parsed.data.rules

  if (incomingRules.playersOnField !== undefined) nextRules.playersOnField = incomingRules.playersOnField
  if (incomingRules.maxRegisteredPlayers !== undefined) nextRules.maxRegisteredPlayers = incomingRules.maxRegisteredPlayers
  if (incomingRules.matchMinutes !== undefined) nextRules.matchMinutes = incomingRules.matchMinutes
  if (incomingRules.breakMinutes !== undefined) nextRules.breakMinutes = incomingRules.breakMinutes
  if (incomingRules.allowDraws !== undefined) nextRules.allowDraws = incomingRules.allowDraws
  if (incomingRules.pointsWin !== undefined) nextRules.pointsWin = incomingRules.pointsWin
  if (incomingRules.pointsDraw !== undefined) nextRules.pointsDraw = incomingRules.pointsDraw
  if (incomingRules.pointsLoss !== undefined) nextRules.pointsLoss = incomingRules.pointsLoss
  if (incomingRules.courtsCount !== undefined) nextRules.courtsCount = incomingRules.courtsCount
  if (incomingRules.resolveDrawByPenalties !== undefined) {
    nextRules.resolveDrawByPenalties = incomingRules.resolveDrawByPenalties
  }
  if (incomingRules.playoffQualifiedTeams !== undefined) {
    nextRules.playoffQualifiedTeams = incomingRules.playoffQualifiedTeams
  }
  if (incomingRules.playoffHomeAway !== undefined) nextRules.playoffHomeAway = incomingRules.playoffHomeAway
  if (incomingRules.finalStageRoundOf16Enabled !== undefined) {
    nextRules.finalStageRoundOf16Enabled = incomingRules.finalStageRoundOf16Enabled
  }
  if (incomingRules.finalStageRoundOf8Enabled !== undefined) {
    nextRules.finalStageRoundOf8Enabled = incomingRules.finalStageRoundOf8Enabled
  }
  if (incomingRules.finalStageQuarterFinalsEnabled !== undefined) {
    nextRules.finalStageQuarterFinalsEnabled = incomingRules.finalStageQuarterFinalsEnabled
  }
  if (incomingRules.finalStageSemiFinalsEnabled !== undefined) {
    nextRules.finalStageSemiFinalsEnabled = incomingRules.finalStageSemiFinalsEnabled
  }
  if (incomingRules.finalStageFinalEnabled !== undefined) {
    nextRules.finalStageFinalEnabled = incomingRules.finalStageFinalEnabled
  }
  if (incomingRules.finalStageTwoLegged !== undefined) {
    nextRules.finalStageTwoLegged = incomingRules.finalStageTwoLegged
    nextRules.playoffHomeAway = incomingRules.finalStageTwoLegged
  }
  if (incomingRules.finalStageRoundOf16TwoLegged !== undefined) {
    nextRules.finalStageRoundOf16TwoLegged = incomingRules.finalStageRoundOf16TwoLegged
  }
  if (incomingRules.finalStageRoundOf8TwoLegged !== undefined) {
    nextRules.finalStageRoundOf8TwoLegged = incomingRules.finalStageRoundOf8TwoLegged
  }
  if (incomingRules.finalStageQuarterFinalsTwoLegged !== undefined) {
    nextRules.finalStageQuarterFinalsTwoLegged = incomingRules.finalStageQuarterFinalsTwoLegged
  }
  if (incomingRules.finalStageSemiFinalsTwoLegged !== undefined) {
    nextRules.finalStageSemiFinalsTwoLegged = incomingRules.finalStageSemiFinalsTwoLegged
  }
  if (incomingRules.finalStageFinalTwoLegged !== undefined) {
    nextRules.finalStageFinalTwoLegged = incomingRules.finalStageFinalTwoLegged
  }
  if (incomingRules.doubleRoundRobin !== undefined) nextRules.doubleRoundRobin = incomingRules.doubleRoundRobin
  if (incomingRules.regularSeasonRounds !== undefined) nextRules.regularSeasonRounds = incomingRules.regularSeasonRounds

  const nextCategory = {
    ...category,
    rules: nextRules,
  }

  const nextLeague = {
    ...league,
    categories: league.categories.map((item, index) => (index === categoryIndex ? nextCategory : item)),
  }

  leaguesStore[leagueIndex] = nextLeague
  persistLocalData()
  await flushPersistQueue()

  response.json({ data: nextLeague })
})

app.get('/api/admin/leagues/:leagueId/teams', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  const filtered = categoryId
    ? teamsStore.filter((team) => team.leagueId === league.id && team.categoryId === categoryId)
    : teamsStore.filter((team) => team.leagueId === league.id)

  response.json({ data: filtered })
})

const createTeamSchema = z.object({
  name: z.string().min(2),
  categoryId: z.string().uuid(),
  active: z.boolean().optional(),
  logoUrl: z.string().trim().min(1).optional(),
  primaryColor: z.string().trim().min(1).optional(),
  secondaryColor: z.string().trim().min(1).optional(),
  technicalStaff: z
    .object({
      director: z
        .object({
          name: z.string().trim().min(2),
          photoUrl: z.string().trim().min(1).optional(),
        })
        .optional(),
      assistant: z
        .object({
          name: z.string().trim().min(2),
          photoUrl: z.string().trim().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
})

const normalizeTechnicalStaff = (staff: unknown) => {
  if (!staff) return undefined

  const parsed = staff as {
    director?: { name: string; photoUrl?: string | undefined } | undefined
    assistant?: { name: string; photoUrl?: string | undefined } | undefined
  }

  const director = parsed.director
    ? {
        name: parsed.director.name,
        ...(parsed.director.photoUrl ? { photoUrl: parsed.director.photoUrl } : {}),
      }
    : undefined

  const assistant = parsed.assistant
    ? {
        name: parsed.assistant.name,
        ...(parsed.assistant.photoUrl ? { photoUrl: parsed.assistant.photoUrl } : {}),
      }
    : undefined

  if (!director && !assistant) return undefined
  return {
    ...(director ? { director } : {}),
    ...(assistant ? { assistant } : {}),
  }
}

app.post('/api/admin/leagues/:leagueId/teams', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = createTeamSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const categoryExists = league.categories.some((category) => category.id === parsed.data.categoryId)
  if (!categoryExists) {
    response.status(400).json({ message: 'La categoría no pertenece a esta liga' })
    return
  }

  const duplicated = teamsStore.some(
    (team) =>
      team.leagueId === league.id &&
      team.categoryId === parsed.data.categoryId &&
      team.name.trim().toLowerCase() === parsed.data.name.trim().toLowerCase(),
  )

  if (duplicated) {
    response.status(409).json({ message: 'Ya existe un equipo con ese nombre en la categoría' })
    return
  }

  const normalizedStaff = normalizeTechnicalStaff(parsed.data.technicalStaff)

  const team: RegisteredTeam = {
    id: uuidv4(),
    leagueId: league.id,
    categoryId: parsed.data.categoryId,
    name: parsed.data.name.trim(),
    active: parsed.data.active ?? true,
    ...(parsed.data.logoUrl ? { logoUrl: parsed.data.logoUrl } : {}),
    ...(parsed.data.primaryColor ? { primaryColor: parsed.data.primaryColor } : {}),
    ...(parsed.data.secondaryColor ? { secondaryColor: parsed.data.secondaryColor } : {}),
    players: [],
  }

  if (normalizedStaff) {
    team.technicalStaff = normalizedStaff
  }

  teamsStore.push(team)
  persistLocalData()
  response.status(201).json({ data: team })
})

const createPlayerSchema = z.object({
  name: z.string().min(2),
  nickname: z.string().min(1),
  age: z.number().int().min(5).max(80),
  number: z.number().int().min(1).max(99),
  position: z.string().min(2),
  photoUrl: z.string().trim().min(1).optional(),
  replacePlayerId: z.string().uuid().optional(),
  replacementReason: z.enum(['injury']).optional(),
})

app.post('/api/admin/teams/:teamId/players', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const team = teamsStore.find((item) => item.id === request.params.teamId)
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const league = leaguesStore.find((item) => item.id === team.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada para el equipo' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = createPlayerSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const category = league.categories.find((item) => item.id === team.categoryId)
  const maxRegisteredPlayers = Math.max(5, category?.rules.maxRegisteredPlayers ?? 25)
  const replacingPlayerId = parsed.data.replacePlayerId
  const replacementReason = parsed.data.replacementReason

  if (replacingPlayerId && replacementReason !== 'injury') {
    response.status(400).json({ message: 'Para reemplazar una jugadora debes indicar motivo lesión' })
    return
  }

  if (replacingPlayerId) {
    const replacedIndex = team.players.findIndex((item) => item.id === replacingPlayerId)
    if (replacedIndex === -1) {
      response.status(404).json({ message: 'La jugadora a reemplazar no existe en el equipo' })
      return
    }
    team.players.splice(replacedIndex, 1)
  } else if (team.players.length >= maxRegisteredPlayers) {
    response.status(409).json({ message: `Cupo completo: máximo ${maxRegisteredPlayers} jugadoras. Elimina una o usa reemplazo por lesión.` })
    return
  }

  const duplicatedNumber = team.players.some((player) => player.number === parsed.data.number)
  if (duplicatedNumber) {
    response.status(409).json({ message: 'El número de camiseta ya existe en el equipo' })
    return
  }

  const player: RegisteredPlayer = {
    id: uuidv4(),
    name: parsed.data.name.trim(),
    nickname: parsed.data.nickname.trim(),
    age: parsed.data.age,
    number: parsed.data.number,
    position: parsed.data.position.trim().toUpperCase(),
    ...(parsed.data.photoUrl ? { photoUrl: parsed.data.photoUrl } : {}),
  }

  team.players.push(player)
  persistLocalData()
  response.status(201).json({ data: team })
})

const updateTeamSchema = z.object({
  name: z.string().min(2).optional(),
  categoryId: z.string().uuid().optional(),
  active: z.boolean().optional(),
  logoUrl: z.string().trim().min(1).optional(),
  primaryColor: z.string().trim().min(1).optional(),
  secondaryColor: z.string().trim().min(1).optional(),
  technicalStaff: z
    .object({
      director: z
        .object({
          name: z.string().trim().min(2),
          photoUrl: z.string().trim().min(1).optional(),
        })
        .optional(),
      assistant: z
        .object({
          name: z.string().trim().min(2),
          photoUrl: z.string().trim().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
})

app.patch('/api/admin/teams/:teamId', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const team = teamsStore.find((item) => item.id === request.params.teamId)
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const league = leaguesStore.find((item) => item.id === team.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada para el equipo' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = updateTeamSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  if (parsed.data.categoryId) {
    const league = leaguesStore.find((item) => item.id === team.leagueId)
    const validCategory = league?.categories.some((category) => category.id === parsed.data.categoryId)
    if (!validCategory) {
      response.status(400).json({ message: 'La categoría no pertenece a la liga del equipo' })
      return
    }
  }

  if (parsed.data.name) {
    const duplicated = teamsStore.some(
      (item) =>
        item.id !== team.id &&
        item.leagueId === team.leagueId &&
        item.categoryId === (parsed.data.categoryId ?? team.categoryId) &&
        item.name.trim().toLowerCase() === parsed.data.name?.trim().toLowerCase(),
    )

    if (duplicated) {
      response.status(409).json({ message: 'Ya existe un equipo con ese nombre en la categoría' })
      return
    }
  }

  team.name = parsed.data.name?.trim() ?? team.name
  team.categoryId = parsed.data.categoryId ?? team.categoryId
  if (parsed.data.active !== undefined) {
    team.active = parsed.data.active
  }
  if (parsed.data.logoUrl !== undefined) {
    team.logoUrl = parsed.data.logoUrl
  }
  if (parsed.data.primaryColor !== undefined) {
    team.primaryColor = parsed.data.primaryColor
  }
  if (parsed.data.secondaryColor !== undefined) {
    team.secondaryColor = parsed.data.secondaryColor
  }
  if (parsed.data.technicalStaff !== undefined) {
    const normalizedStaff = normalizeTechnicalStaff(parsed.data.technicalStaff)
    if (normalizedStaff) {
      team.technicalStaff = normalizedStaff
    } else {
      delete team.technicalStaff
    }
  }

  persistLocalData()

  response.json({ data: team })
})

app.delete('/api/admin/teams/:teamId', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const index = teamsStore.findIndex((item) => item.id === request.params.teamId)
  if (index === -1) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const team = teamsStore[index]
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const league = leaguesStore.find((item) => item.id === team.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada para el equipo' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  teamsStore.splice(index, 1)
  persistLocalData()
  response.json({ ok: true })
})

const updatePlayerSchema = z.object({
  name: z.string().min(2).optional(),
  nickname: z.string().min(1).optional(),
  age: z.number().int().min(5).max(80).optional(),
  number: z.number().int().min(1).max(99).optional(),
  position: z.string().min(2).optional(),
  photoUrl: z.string().trim().min(1).optional(),
})

app.patch('/api/admin/teams/:teamId/players/:playerId', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const team = teamsStore.find((item) => item.id === request.params.teamId)
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const league = leaguesStore.find((item) => item.id === team.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada para el equipo' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const player = team.players.find((item) => item.id === request.params.playerId)
  if (!player) {
    response.status(404).json({ message: 'Jugador no encontrado' })
    return
  }

  const parsed = updatePlayerSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  if (parsed.data.number !== undefined) {
    const duplicated = team.players.some((item) => item.id !== player.id && item.number === parsed.data.number)
    if (duplicated) {
      response.status(409).json({ message: 'El número de camiseta ya existe en el equipo' })
      return
    }
  }

  player.name = parsed.data.name?.trim() ?? player.name
  player.nickname = parsed.data.nickname?.trim() ?? player.nickname
  player.age = parsed.data.age ?? player.age
  player.number = parsed.data.number ?? player.number
  player.position = parsed.data.position?.trim().toUpperCase() ?? player.position
  if (parsed.data.photoUrl !== undefined) {
    player.photoUrl = parsed.data.photoUrl
  }

  persistLocalData()

  response.json({ data: team })
})

app.delete('/api/admin/teams/:teamId/players/:playerId', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const team = teamsStore.find((item) => item.id === request.params.teamId)
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const league = leaguesStore.find((item) => item.id === team.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada para el equipo' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const playerIndex = team.players.findIndex((item) => item.id === request.params.playerId)
  if (playerIndex === -1) {
    response.status(404).json({ message: 'Jugador no encontrado' })
    return
  }

  team.players.splice(playerIndex, 1)
  persistLocalData()
  response.json({ data: team })
})

app.get('/api/admin/leagues/:leagueId/fixture', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  if (!categoryId) {
    response.status(400).json({ message: 'categoryId es requerido' })
    return
  }

  const teams = teamsStore.filter(
    (team) => team.leagueId === league.id && team.categoryId === categoryId && isTeamActive(team),
  )
  const rounds = generateFixture(teams)

  response.json({
    data: {
      teamsCount: teams.length,
      hasBye: teams.length % 2 !== 0,
      rounds,
    },
  })
})

app.get('/api/admin/leagues/:leagueId/fixture-schedule', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  const activeTeamIds = new Set(
    teamsStore
      .filter((team) => team.leagueId === league.id && (!categoryId || team.categoryId === categoryId) && isTeamActive(team))
      .map((team) => team.id),
  )

  const data = fixtureScheduleStore.filter((item) => {
    if (item.leagueId !== league.id || (categoryId && item.categoryId !== categoryId)) return false
    const parsed = parseMatchIdentity(item.matchId)
    if (!parsed) return true
    return activeTeamIds.has(parsed.homeTeamId) && activeTeamIds.has(parsed.awayTeamId)
  })
  response.json({ data })
})

const setScheduleSchema = z.object({
  categoryId: z.string().uuid(),
  round: z.number().int().min(1),
  scheduledAt: z.string().min(4),
  venue: z.string().trim().min(1).max(120).optional(),
})

app.post('/api/admin/leagues/:leagueId/matches/:matchId/schedule', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = setScheduleSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido' })
    return
  }

  const existingIndex = fixtureScheduleStore.findIndex(
    (item) =>
      item.leagueId === league.id &&
      item.categoryId === parsed.data.categoryId &&
      item.matchId === request.params.matchId,
  )

  const next = {
    leagueId: league.id,
    categoryId: parsed.data.categoryId,
    matchId: request.params.matchId,
    round: parsed.data.round,
    scheduledAt: parsed.data.scheduledAt,
    ...(parsed.data.venue ? { venue: parsed.data.venue } : {}),
  }

  if (existingIndex === -1) {
    fixtureScheduleStore.push(next)
  } else {
    fixtureScheduleStore[existingIndex] = next
  }

  persistLocalData()

  response.json({ data: next })
})

app.delete('/api/admin/leagues/:leagueId/matches/:matchId/schedule', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  if (!categoryId) {
    response.status(400).json({ message: 'categoryId es requerido' })
    return
  }

  const existingIndex = fixtureScheduleStore.findIndex(
    (item) =>
      item.leagueId === league.id &&
      item.categoryId === categoryId &&
      item.matchId === request.params.matchId,
  )

  if (existingIndex === -1) {
    response.json({ data: { deleted: false } })
    return
  }

  fixtureScheduleStore.splice(existingIndex, 1)
  persistLocalData()

  response.json({ data: { deleted: true } })
})

app.get('/api/admin/leagues/:leagueId/round-awards', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  const round = typeof request.query.round === 'string' ? Number(request.query.round) : 0

  const data = roundAwardsStore.filter((item) => {
    if (item.leagueId !== league.id) return false
    if (categoryId && item.categoryId !== categoryId) return false
    if (round > 0 && item.round !== round) return false
    return true
  })

  response.json({ data })
})

const roundAwardsSchema = z.object({
  categoryId: z.string().uuid(),
  round: z.number().int().min(1),
  matchBestPlayers: z.array(
    z.object({
      matchKey: z.string().min(3),
      homeTeamId: z.string().uuid(),
      awayTeamId: z.string().uuid(),
      playerId: z.string().uuid(),
      playerName: z.string().min(1),
      teamId: z.string().uuid(),
      teamName: z.string().min(1),
    }),
  ),
  roundBestPlayerId: z.string().uuid().optional(),
  roundBestPlayerName: z.string().min(1).optional(),
  roundBestPlayerTeamId: z.string().uuid().optional(),
  roundBestPlayerTeamName: z.string().min(1).optional(),
})

app.post('/api/admin/leagues/:leagueId/round-awards', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = roundAwardsSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const next = {
    leagueId: league.id,
    categoryId: parsed.data.categoryId,
    round: parsed.data.round,
    matchBestPlayers: parsed.data.matchBestPlayers,
    ...(parsed.data.roundBestPlayerId ? { roundBestPlayerId: parsed.data.roundBestPlayerId } : {}),
    ...(parsed.data.roundBestPlayerName ? { roundBestPlayerName: parsed.data.roundBestPlayerName } : {}),
    ...(parsed.data.roundBestPlayerTeamId ? { roundBestPlayerTeamId: parsed.data.roundBestPlayerTeamId } : {}),
    ...(parsed.data.roundBestPlayerTeamName ? { roundBestPlayerTeamName: parsed.data.roundBestPlayerTeamName } : {}),
    updatedAt: new Date().toISOString(),
  }

  const existingIndex = roundAwardsStore.findIndex(
    (item) => item.leagueId === next.leagueId && item.categoryId === next.categoryId && item.round === next.round,
  )

  if (existingIndex === -1) {
    roundAwardsStore.push(next)
  } else {
    roundAwardsStore[existingIndex] = next
  }

  persistLocalData()
  response.json({ data: next })
})

app.get('/api/admin/leagues/:leagueId/round-awards-ranking', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''

  const pool = roundAwardsStore.filter(
    (item) =>
      item.leagueId === league.id &&
      (!categoryId || item.categoryId === categoryId) &&
      Boolean(item.roundBestPlayerId),
  )

  const rankingMap = new Map<string, { playerId: string; playerName: string; teamId: string; teamName: string; votes: number }>()

  pool.forEach((entry) => {
    if (!entry.roundBestPlayerId || !entry.roundBestPlayerName || !entry.roundBestPlayerTeamId || !entry.roundBestPlayerTeamName) return

    const key = entry.roundBestPlayerId
    const current = rankingMap.get(key)
    if (!current) {
      rankingMap.set(key, {
        playerId: entry.roundBestPlayerId,
        playerName: entry.roundBestPlayerName,
        teamId: entry.roundBestPlayerTeamId,
        teamName: entry.roundBestPlayerTeamName,
        votes: 1,
      })
      return
    }

    current.votes += 1
  })

  const data = Array.from(rankingMap.values()).sort((left, right) => {
    if (left.votes === right.votes) {
      return left.playerName.localeCompare(right.playerName, 'es', { sensitivity: 'base' })
    }
    return right.votes - left.votes
  })

  response.json({ data })
})

app.get('/api/admin/leagues/:leagueId/played-matches', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  const activeNameKeys = new Set(
    teamsStore
      .filter((team) => team.leagueId === league.id && (!categoryId || team.categoryId === categoryId) && isTeamActive(team))
      .map((team) => normalizeTeamLabel(team.name)),
  )

  const data = playedMatchesStore.filter((item) => {
    if (item.leagueId !== league.id || (categoryId && item.categoryId !== categoryId)) return false
    const homeActive = activeNameKeys.has(normalizeTeamLabel(item.homeTeamName))
    const awayActive = activeNameKeys.has(normalizeTeamLabel(item.awayTeamName))
    return homeActive && awayActive
  })
  response.json({ data })
})

const playedMatchSchema = z.object({
  matchId: z.string().min(3),
  leagueId: z.string().uuid(),
  categoryId: z.string().uuid(),
  round: z.number().int().min(1),
  finalMinute: z.number().int().min(0),
  homeTeamName: z.string().min(1),
  awayTeamName: z.string().min(1),
  homeStats: z.object({
    shots: z.number().int().min(0),
    goals: z.number().int().min(0),
    yellows: z.number().int().min(0),
    reds: z.number().int().min(0),
    assists: z.number().int().min(0),
  }),
  awayStats: z.object({
    shots: z.number().int().min(0),
    goals: z.number().int().min(0),
    yellows: z.number().int().min(0),
    reds: z.number().int().min(0),
    assists: z.number().int().min(0),
  }),
  penaltyShootout: z
    .object({
      home: z.number().int().min(0),
      away: z.number().int().min(0),
    })
    .optional(),
  playerOfMatchId: z.string().optional(),
  playerOfMatchName: z.string().optional(),
  homeLineup: z
    .object({
      starters: z.array(z.string()),
      substitutes: z.array(z.string()),
      formationKey: z.string().optional(),
    })
    .optional(),
  awayLineup: z
    .object({
      starters: z.array(z.string()),
      substitutes: z.array(z.string()),
      formationKey: z.string().optional(),
    })
    .optional(),
  players: z.array(
    z.object({
      playerId: z.string(),
      playerName: z.string(),
      teamId: z.string(),
      teamName: z.string(),
      position: z.string(),
      goals: z.number().int().min(0),
      assists: z.number().int().min(0),
      shots: z.number().int().min(0),
      yellows: z.number().int().min(0),
      reds: z.number().int().min(0),
      goalsConceded: z.number().int().min(0),
    }),
  ),
  goals: z.array(
    z.object({
      minute: z.number().int().min(0),
      clock: z.string(),
      teamName: z.string(),
      playerName: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      clock: z.string(),
      type: z.enum([
        'shot',
        'goal',
        'penalty_goal',
        'penalty_miss',
        'yellow',
        'red',
        'double_yellow',
        'assist',
        'substitution',
        'staff_yellow',
        'staff_red',
      ]),
      teamName: z.string(),
      playerName: z.string(),
      substitutionInPlayerName: z.string().optional(),
      staffRole: z.enum(['director', 'assistant']).optional(),
    }),
  ),
  highlightVideos: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
    }),
  ),
  playedAt: z.string(),
})

app.post('/api/admin/leagues/:leagueId/played-matches', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = playedMatchSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  if (parsed.data.leagueId !== league.id) {
    response.status(400).json({ message: 'leagueId no coincide con ruta' })
    return
  }

  const existingIndex = playedMatchesStore.findIndex(
    (item) => item.leagueId === league.id && item.categoryId === parsed.data.categoryId && item.matchId === parsed.data.matchId,
  )

  const normalizedHomeLineup = parsed.data.homeLineup
    ? {
      starters: parsed.data.homeLineup.starters,
      substitutes: parsed.data.homeLineup.substitutes,
      ...(parsed.data.homeLineup.formationKey ? { formationKey: parsed.data.homeLineup.formationKey } : {}),
    }
    : null

  const normalizedAwayLineup = parsed.data.awayLineup
    ? {
      starters: parsed.data.awayLineup.starters,
      substitutes: parsed.data.awayLineup.substitutes,
      ...(parsed.data.awayLineup.formationKey ? { formationKey: parsed.data.awayLineup.formationKey } : {}),
    }
    : null

  const nextRecord = {
    matchId: parsed.data.matchId,
    leagueId: parsed.data.leagueId,
    categoryId: parsed.data.categoryId,
    round: parsed.data.round,
    finalMinute: parsed.data.finalMinute,
    homeTeamName: parsed.data.homeTeamName,
    awayTeamName: parsed.data.awayTeamName,
    homeStats: parsed.data.homeStats,
    awayStats: parsed.data.awayStats,
    ...(parsed.data.penaltyShootout ? { penaltyShootout: parsed.data.penaltyShootout } : {}),
    ...(parsed.data.playerOfMatchId ? { playerOfMatchId: parsed.data.playerOfMatchId } : {}),
    ...(parsed.data.playerOfMatchName ? { playerOfMatchName: parsed.data.playerOfMatchName } : {}),
    ...(normalizedHomeLineup ? { homeLineup: normalizedHomeLineup } : {}),
    ...(normalizedAwayLineup ? { awayLineup: normalizedAwayLineup } : {}),
    players: parsed.data.players,
    goals: parsed.data.goals,
    events: parsed.data.events.map((event) => ({
      clock: event.clock,
      type: event.type,
      teamName: event.teamName,
      playerName: event.playerName,
      ...(event.substitutionInPlayerName ? { substitutionInPlayerName: event.substitutionInPlayerName } : {}),
      ...(event.staffRole ? { staffRole: event.staffRole } : {}),
    })),
    highlightVideos: parsed.data.highlightVideos,
    playedAt: parsed.data.playedAt,
  }

  if (existingIndex === -1) {
    playedMatchesStore.push(nextRecord)
  } else {
    playedMatchesStore[existingIndex] = nextRecord
  }

  persistLocalData()

  response.json({ data: nextRecord })
})

const addVideoSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1),
  url: z.string().min(10),
})

const uploadVideoSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().trim().min(1).optional(),
})

const buildPublicVideoUrl = (request: express.Request, videoId: string) => {
  const configured = process.env.PUBLIC_API_BASE_URL?.trim()
  if (configured) {
    return `${configured.replace(/\/$/, '')}/api/public/videos/${videoId}`
  }

  return `${request.protocol}://${request.get('host')}/api/public/videos/${videoId}`
}

app.post('/api/admin/leagues/:leagueId/played-matches/:matchId/videos', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = addVideoSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido' })
    return
  }

  const match = playedMatchesStore.find(
    (item) => item.leagueId === league.id && item.categoryId === parsed.data.categoryId && item.matchId === request.params.matchId,
  )

  if (!match) {
    response.status(404).json({ message: 'Partido jugado no encontrado' })
    return
  }

  const video = {
    id: uuidv4(),
    name: parsed.data.name,
    url: parsed.data.url,
  }

  match.highlightVideos.push(video)
  persistLocalData()
  response.json({ data: match })
})

app.post('/api/admin/leagues/:leagueId/played-matches/:matchId/videos/upload', upload.single('video'), async (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = uploadVideoSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const file = request.file
  if (!file) {
    response.status(400).json({ message: 'Debes adjuntar un archivo de video' })
    return
  }

  if (!file.mimetype.startsWith('video/')) {
    response.status(400).json({ message: 'El archivo debe ser un video válido' })
    return
  }

  const match = playedMatchesStore.find(
    (item) => item.leagueId === league.id && item.categoryId === parsed.data.categoryId && item.matchId === request.params.matchId,
  )

  if (!match) {
    response.status(404).json({ message: 'Partido jugado no encontrado' })
    return
  }

  const bucket = await getVideosBucket()
  if (!bucket) {
    response.status(503).json({
      message: 'Upload de videos requiere MongoDB activo. Configura MONGODB_URI en backend.',
    })
    return
  }

  const safeName = parsed.data.name?.trim() || file.originalname || `video-${Date.now()}.mp4`

  try {
    const optimized = await transcodeVideoIfPossible(file.buffer)
    const finalName = optimized.transcoded
      ? safeName.replace(/\.[^.]+$/, '').concat('.mp4')
      : safeName

    const uploadStream = bucket.openUploadStream(finalName, {
      metadata: {
        contentType: optimized.mimetype,
        leagueId: league.id,
        categoryId: parsed.data.categoryId,
        matchId: match.matchId,
        uploadedBy: user.id,
      },
    })

    await new Promise<void>((resolve, reject) => {
      Readable.from(optimized.buffer)
        .pipe(uploadStream)
        .on('error', reject)
        .on('finish', () => resolve())
    })

    const fileId = uploadStream.id?.toString() ?? ''
    if (!fileId) {
      response.status(500).json({ message: 'No se pudo generar identificador de video' })
      return
    }

    const video = {
      id: uuidv4(),
      name: finalName,
      url: buildPublicVideoUrl(request, fileId),
    }

    match.highlightVideos.push(video)
    persistLocalData()
    response.json({ data: match })
  } catch {
    response.status(500).json({ message: 'No se pudo procesar/cargar el video' })
  }
})

app.delete('/api/admin/leagues/:leagueId/played-matches/:matchId/videos/:videoId', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const league = leaguesStore.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = String(request.query.categoryId ?? '')
  const match = playedMatchesStore.find(
    (item) => item.leagueId === league.id && item.categoryId === categoryId && item.matchId === request.params.matchId,
  )

  if (!match) {
    response.status(404).json({ message: 'Partido jugado no encontrado' })
    return
  }

  const videoIdx = match.highlightVideos.findIndex((v) => v.id === request.params.videoId)
  if (videoIdx === -1) {
    response.status(404).json({ message: 'Video no encontrado' })
    return
  }

  match.highlightVideos.splice(videoIdx, 1)
  persistLocalData()
  response.json({ data: match })
})

app.get('/api/public/videos/:videoId', async (request, response) => {
  const bucket = await getVideosBucket()
  if (!bucket) {
    response.status(404).json({ message: 'Video no disponible' })
    return
  }

  const fileId = getMongoObjectId(request.params.videoId)
  if (!fileId) {
    response.status(400).json({ message: 'ID de video inválido' })
    return
  }

  try {
    const fileDoc = await bucket.find({ _id: fileId }).next()
    if (!fileDoc) {
      response.status(404).json({ message: 'Video no encontrado' })
      return
    }

    const totalSize = Number(fileDoc.length ?? 0)
    const contentType = ((fileDoc.metadata as { contentType?: string } | undefined)?.contentType) || 'video/mp4'
    const range = request.headers.range

    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Cache-Control', 'public, max-age=3600')
    response.setHeader('Content-Type', contentType)

    if (range && totalSize > 0) {
      const [startText = '', endText = ''] = range.replace(/bytes=/, '').split('-')
      const start = Number.parseInt(startText, 10)
      const end = endText ? Number.parseInt(endText, 10) : totalSize - 1

      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= totalSize || start > end) {
        response.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end()
        return
      }

      response.status(206)
      response.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`)
      response.setHeader('Content-Length', String(end - start + 1))

      bucket.openDownloadStream(fileId, { start, end: end + 1 }).pipe(response)
      return
    }

    response.setHeader('Content-Length', String(totalSize))
    bucket.openDownloadStream(fileId).pipe(response)
  } catch {
    response.status(500).json({ message: 'No se pudo transmitir el video' })
  }
})

const loadLiveMatchSchema = z.object({
  leagueId: z.string().uuid(),
  categoryId: z.string().uuid(),
  homeTeamId: z.string().uuid(),
  awayTeamId: z.string().uuid(),
})

app.post('/api/admin/live/load-match', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const parsed = loadLiveMatchSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido' })
    return
  }

  const league = leaguesStore.find((item) => item.id === parsed.data.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const category = league.categories.find((item) => item.id === parsed.data.categoryId)
  if (!category) {
    response.status(404).json({ message: 'Categoría no encontrada' })
    return
  }

  const homeTeam = teamsStore.find(
    (item) => item.id === parsed.data.homeTeamId && item.leagueId === league.id && item.categoryId === category.id,
  )
  const awayTeam = teamsStore.find(
    (item) => item.id === parsed.data.awayTeamId && item.leagueId === league.id && item.categoryId === category.id,
  )

  if (!homeTeam || !awayTeam) {
    response.status(404).json({ message: 'Equipos no encontrados para la liga/categoría seleccionada' })
    return
  }

  loadMatchForLive({
    leagueName: league.name,
    categoryName: category.name,
    homeTeam,
    awayTeam,
    playersOnField: category.rules.playersOnField,
    matchMinutes: category.rules.matchMinutes,
    breakMinutes: category.rules.breakMinutes,
  })

  broadcastLive()
  response.json({ data: buildLiveSnapshot() })
})

const ruleSchema = z.object({
  playersOnField: z.number().int().min(5).max(11),
  maxRegisteredPlayers: z.number().int().min(5).max(60).optional().default(25),
  matchMinutes: z.number().int().min(20).max(120),
  breakMinutes: z.number().int().min(0).max(30),
  allowDraws: z.boolean(),
  pointsWin: z.number().int().min(0).max(10),
  pointsDraw: z.number().int().min(0).max(10),
  pointsLoss: z.number().int().min(0).max(10),
  courtsCount: z.number().int().min(1).max(20).optional().default(1),
  resolveDrawByPenalties: z.boolean().optional().default(false),
  playoffQualifiedTeams: z.number().int().min(2).max(32).optional().default(8),
  playoffHomeAway: z.boolean().optional().default(false),
  finalStageRoundOf16Enabled: z.boolean().optional().default(false),
  finalStageRoundOf8Enabled: z.boolean().optional().default(false),
  finalStageQuarterFinalsEnabled: z.boolean().optional().default(true),
  finalStageSemiFinalsEnabled: z.boolean().optional().default(true),
  finalStageFinalEnabled: z.boolean().optional().default(true),
  finalStageTwoLegged: z.boolean().optional().default(false),
  finalStageRoundOf16TwoLegged: z.boolean().optional().default(false),
  finalStageRoundOf8TwoLegged: z.boolean().optional().default(false),
  finalStageQuarterFinalsTwoLegged: z.boolean().optional().default(false),
  finalStageSemiFinalsTwoLegged: z.boolean().optional().default(false),
  finalStageFinalTwoLegged: z.boolean().optional().default(false),
  doubleRoundRobin: z.boolean().optional().default(false),
  regularSeasonRounds: z.number().int().min(1).max(60).optional().default(9),
})

const categorySchema = z.object({
  name: z.string().min(2),
  minAge: z.number().int().min(5),
  maxAge: z.number().int().min(5).nullable(),
  rules: ruleSchema,
})

const createLeagueSchema = z.object({
  name: z.string().min(3),
  slug: z.string().min(3),
  country: z.string().min(2),
  season: z.number().int().min(2000).max(2100).default(2026),
  slogan: z.string().trim().min(2).optional(),
  themeColor: z.string().trim().regex(/^#([0-9a-fA-F]{6})$/).optional(),
  backgroundImageUrl: z.string().trim().min(1).optional(),
  active: z.boolean().default(true),
  logoUrl: z.string().trim().min(1).optional(),
  categories: z.array(categorySchema).min(1),
})

app.post('/api/admin/leagues', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const parsed = createLeagueSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const duplicatedSlug = leaguesStore.some(
    (league) => league.slug === parsed.data.slug && league.season === parsed.data.season,
  )
  if (duplicatedSlug) {
    response.status(409).json({ message: 'Ya existe una liga con ese slug para la misma temporada' })
    return
  }

  const league = {
    id: uuidv4(),
    name: parsed.data.name,
    slug: parsed.data.slug,
    country: parsed.data.country,
    season: parsed.data.season,
    ...(parsed.data.slogan ? { slogan: parsed.data.slogan } : {}),
    ...(parsed.data.themeColor ? { themeColor: parsed.data.themeColor } : {}),
    ...(parsed.data.backgroundImageUrl ? { backgroundImageUrl: parsed.data.backgroundImageUrl } : {}),
    active: parsed.data.active,
    ownerUserId: user.role === 'super_admin' ? SUPER_ADMIN_USER_ID : user.id,
    ...(parsed.data.logoUrl ? { logoUrl: parsed.data.logoUrl } : {}),
    categories: parsed.data.categories.map((category) => ({
      ...category,
      id: uuidv4(),
    })),
  }

  leaguesStore.push(league)
  persistLocalData()
  response.status(201).json({ data: league })
})

const updateLeagueSchema = createLeagueSchema.partial()

app.patch('/api/admin/leagues/:leagueId', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const leagueIndex = leaguesStore.findIndex((item) => item.id === request.params.leagueId)
  if (leagueIndex === -1) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  const currentLeague = leaguesStore[leagueIndex]
  if (!currentLeague) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && currentLeague.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const parsed = updateLeagueSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  const payload = parsed.data

  const nextSlug = payload.slug ?? currentLeague.slug
  const nextSeason = payload.season ?? currentLeague.season
  const duplicatedSlug = leaguesStore.some(
    (league) => league.id !== currentLeague.id && league.slug === nextSlug && league.season === nextSeason,
  )
  if (duplicatedSlug) {
    response.status(409).json({ message: 'Ya existe una liga con ese slug para la misma temporada' })
    return
  }

  const nextLeague = {
    ...currentLeague,
    name: payload.name ?? currentLeague.name,
    slug: payload.slug ?? currentLeague.slug,
    country: payload.country ?? currentLeague.country,
    season: payload.season ?? currentLeague.season,
    active: payload.active ?? currentLeague.active,
    categories: payload.categories
      ? payload.categories.map((category) => ({
          ...category,
          id: uuidv4(),
        }))
      : currentLeague.categories,
  }

  if (payload.logoUrl !== undefined) {
    nextLeague.logoUrl = payload.logoUrl
  }

  if (payload.themeColor !== undefined) {
    if (payload.themeColor) {
      nextLeague.themeColor = payload.themeColor
    } else {
      delete nextLeague.themeColor
    }
  }

  if (payload.backgroundImageUrl !== undefined) {
    if (payload.backgroundImageUrl) {
      nextLeague.backgroundImageUrl = payload.backgroundImageUrl
    } else {
      delete nextLeague.backgroundImageUrl
    }
  }

  if (payload.slogan !== undefined) {
    if (payload.slogan) {
      nextLeague.slogan = payload.slogan
    } else {
      delete nextLeague.slogan
    }
  }

  leaguesStore[leagueIndex] = nextLeague
  persistLocalData()

  response.json({ data: leaguesStore[leagueIndex] })
})

app.delete('/api/admin/leagues/:leagueId', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const index = leaguesStore.findIndex((item) => item.id === request.params.leagueId)
  if (index === -1) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  const league = leaguesStore[index]
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const leagueId = leaguesStore[index]?.id
  leaguesStore.splice(index, 1)

  if (leagueId) {
    const remaining = teamsStore.filter((team) => team.leagueId !== leagueId)
    teamsStore.length = 0
    teamsStore.push(...remaining)

    const remainingSchedule = fixtureScheduleStore.filter((item) => item.leagueId !== leagueId)
    fixtureScheduleStore.length = 0
    fixtureScheduleStore.push(...remainingSchedule)

    const remainingRoundAwards = roundAwardsStore.filter((item) => item.leagueId !== leagueId)
    roundAwardsStore.length = 0
    roundAwardsStore.push(...remainingRoundAwards)

    const remainingPlayed = playedMatchesStore.filter((item) => item.leagueId !== leagueId)
    playedMatchesStore.length = 0
    playedMatchesStore.push(...remainingPlayed)
  }

  persistLocalData()

  response.json({ ok: true })
})

const timerActionSchema = z.object({
  action: z.enum(['start', 'stop', 'reset', 'finish']),
})

app.post('/api/admin/live/timer', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const parsed = timerActionSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido' })
    return
  }

  if (parsed.data.action === 'finish') {
    setMatchStatusAction('finish')
  } else {
    setTimerAction(parsed.data.action)
  }
  broadcastLive()
  response.json({ data: buildLiveSnapshot() })
})

const liveSettingsSchema = z.object({
  playersOnField: z.number().int().min(5).max(11).optional(),
  matchMinutes: z.number().int().min(20).max(120).optional(),
  breakMinutes: z.number().int().min(0).max(30).optional(),
  homeHasBye: z.boolean().optional(),
  awayHasBye: z.boolean().optional(),
})

app.patch('/api/admin/live/settings', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const parsed = liveSettingsSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido' })
    return
  }

  const payload: {
    playersOnField?: number
    matchMinutes?: number
    breakMinutes?: number
    homeHasBye?: boolean
    awayHasBye?: boolean
  } = {}

  if (parsed.data.playersOnField !== undefined) payload.playersOnField = parsed.data.playersOnField
  if (parsed.data.matchMinutes !== undefined) payload.matchMinutes = parsed.data.matchMinutes
  if (parsed.data.breakMinutes !== undefined) payload.breakMinutes = parsed.data.breakMinutes
  if (parsed.data.homeHasBye !== undefined) payload.homeHasBye = parsed.data.homeHasBye
  if (parsed.data.awayHasBye !== undefined) payload.awayHasBye = parsed.data.awayHasBye

  updateSettings(payload)
  broadcastLive()
  response.json({ data: buildLiveSnapshot() })
})

const lineupSchema = z.object({
  teamId: z.string().uuid(),
  starters: z.array(z.string().uuid()),
  substitutes: z.array(z.string().uuid()),
  formationKey: z.string().trim().min(1).optional(),
})

app.post('/api/admin/live/lineup', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const parsed = lineupSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido' })
    return
  }

  const result = updateLineupWithFormation(
    parsed.data.teamId,
    parsed.data.starters,
    parsed.data.substitutes,
    parsed.data.formationKey,
  )
  if (!result.ok) {
    response.status(400).json({ message: result.message })
    return
  }

  broadcastLive()
  response.json({ data: buildLiveSnapshot() })
})

const liveEventSchema = z.object({
  teamId: z.string().uuid(),
  playerId: z.string().uuid().nullable(),
  substitutionInPlayerId: z.string().uuid().optional(),
  staffRole: z.enum(['director', 'assistant']).optional(),
  type: z.enum([
    'shot',
    'goal',
    'penalty_goal',
    'penalty_miss',
    'yellow',
    'red',
    'double_yellow',
    'assist',
    'substitution',
    'staff_yellow',
    'staff_red',
  ]),
})

app.post('/api/admin/live/events', (request, response) => {
  const user = requireAuth(request, response)
  if (!user) return

  const parsed = liveEventSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido' })
    return
  }

  const result = registerEvent(
    parsed.data.teamId,
    parsed.data.type,
    parsed.data.playerId,
    {
      ...(parsed.data.staffRole ? { staffRole: parsed.data.staffRole } : {}),
      ...(parsed.data.substitutionInPlayerId ? { substitutionInPlayerId: parsed.data.substitutionInPlayerId } : {}),
    },
  )
  if (!result.ok) {
    response.status(400).json({ message: result.message })
    return
  }

  broadcastLive()
  response.json({ data: buildLiveSnapshot() })
})

io.on('connection', (socket) => {
  socket.emit('live:update', buildLiveSnapshot())
})

const startServer = async () => {
  await initializeDataStore()

  const migratedLineupsCount = migratePlayedMatchesLineups()
  if (migratedLineupsCount > 0) {
    persistLocalData()
    console.log(`Migración de lineups históricos completada: ${migratedLineupsCount} partidos actualizados.`)
  }

  httpServer.listen(port, () => {
    console.log(`FL Liga API corriendo en http://localhost:${port}`)
  })
}

startServer().catch((error) => {
  console.error('No se pudo iniciar FL Liga API:', error)
  process.exit(1)
})
