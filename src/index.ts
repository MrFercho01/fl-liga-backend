
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  resolvePublicClientId,
  SUPER_ADMIN_USER_ID,
  getMongoObjectId,
  saveLeagueToMongo,
  getAllLeaguesFromMongo,
  savePlayedMatchToMongo,
  getAllPlayedMatchesFromMongo,
  saveHighlightVideoToMongo,
  getAllHighlightVideosFromMongo,
  saveTeamToMongo,
  getAllTeamsFromMongo,
  getTeamsCollection,
  saveFixtureScheduleToMongo,
  getAllFixtureSchedulesFromMongo,
  getFixtureScheduleCollection,
  saveRoundAwardToMongo,
  getAllRoundAwardsFromMongo,
  getRoundAwardsCollection,
  type RegisteredTeam,
  type RegisteredPlayer
} from './data';
import {
  requireAuth
} from './requireAuth';
import { upload } from './upload';
import {
  normalizeTechnicalStaff,
  TechnicalStaffClean
} from './utils';
import {
  createTeamSchema
} from './schemas';
import {
  syncLiveTeamFromRegistered,
  updateLineupWithFormation,
  buildLiveSnapshot,
  registerEvent,
  loadMatchForLive
} from './live';
import {
  resolvePlayersOnField,
  broadcastLive
} from './live-helpers';
import {
  generateFixture
} from './fixture';
import {
  buildTeamNameAliases,
  resolveTeamFromAliasMap
} from './team-alias';
import {
  getVideosBucket,
  transcodeVideoIfPossible
} from './video';
import { Readable } from 'stream';
import { MongoClient, Collection } from 'mongodb';
import { io } from './io';
import http from 'http';
import { initializeDataStore, migratePlayedMatchesLineups } from './init-stub';
import cors from 'cors';


const app = express();

// CORS y JSON parser antes de los endpoints
app.use(cors({
  origin: [
    'https://fl-liga-frontend.vercel.app',
    'http://localhost:5173'
  ],
  credentials: true
}));
app.use(express.json());

// Endpoint público compatible con frontend legacy
app.get('/api/leagues', async (request: Request, response: Response) => {
  const allLeagues = await getAllLeaguesFromMongo();
  const data = allLeagues
    .filter((league) => league.active)
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
    }));
  response.json({ data });
});

const port = Number(process.env.PORT) || 3000;
const httpServer = http.createServer(app);

app.use(cors({
  origin: [
    'https://fl-liga-frontend.vercel.app',
    'http://localhost:5173'
  ],
  credentials: true
}));

// Helper para likes de partidos públicos usando MongoDB
async function ensurePublicMatchLike(clientId: string, leagueId: string, categoryId: string, matchId: string, db: Collection<any>) {
  let entry = await db.findOne({ clientId, leagueId, categoryId, matchId });
  if (!entry) {
    entry = {
      clientId,
      leagueId,
      categoryId,
      matchId,
      likes: 0,
      updatedAt: new Date().toISOString()
    };
    await db.insertOne(entry);
  }
  return entry;
}

// Esquema para engagement público
const publicEngagementUpdateSchema = z.object({
  action: z.enum(['visit', 'like']),
  delta: z.number().int().min(-1).max(1).optional(),
});

// Helper para engagement público usando MongoDB
async function ensurePublicEngagement(clientId: string, db: Collection<any>) {
  let entry = await db.findOne({ clientId });
  if (!entry) {
    entry = {
      clientId,
      visits: 0,
      likes: 0,
      updatedAt: new Date().toISOString()
    };
    await db.insertOne(entry);
  }
  return entry;
}


const publicMatchLikeUpdateSchema = z.object({
  leagueId: z.string().uuid(),
  categoryId: z.string().uuid(),
  delta: z.number().int().min(-1).max(1),
});

// --- Helpers migrados a MongoDB: publicMatchLikesStore, publicEngagementStore ---


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

// ENDPOINT: Listar ligas públicas activas para mobile
app.get('/api/public/leagues', async (request: Request, response: Response) => {
  const allLeagues = await getAllLeaguesFromMongo();
  const data = allLeagues
    .filter((league) => league.active)
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
    }));
  response.json({ data });
});

app.get('/api/public/client/:clientId/leagues', async (request: Request, response: Response) => {
  const rawClientId = request.params.clientId;
  const clientId = typeof rawClientId === 'string' ? await resolvePublicClientId(rawClientId) : null;
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' });
    return;
  }
  const allLeagues = await getAllLeaguesFromMongo();
  const data = allLeagues
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
    }));
  response.json({ data });
});

app.get('/api/public/client/:clientId/engagement', async (request: Request, response: Response) => {
  const rawClientId = request.params.clientId;
  const clientId = typeof rawClientId === 'string' ? await resolvePublicClientId(rawClientId) : null;
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' });
    return;
  }
  const mongo = await MongoClient.connect(process.env.MONGODB_URI!);
  const db = mongo.db(process.env.MONGODB_DB_NAME!);
  const collection = db.collection('public_engagement');
  const engagement = await ensurePublicEngagement(clientId, collection);
  response.json({
    data: {
      clientId,
      visits: engagement.visits,
      likes: engagement.likes,
      updatedAt: engagement.updatedAt,
    },
  });
  await mongo.close();
});

app.post('/api/public/client/:clientId/engagement', async (request: Request, response: Response) => {
  const rawClientId = request.params.clientId;
  const clientId = typeof rawClientId === 'string' ? await resolvePublicClientId(rawClientId) : null;
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' });
    return;
  }
  const parsed = publicEngagementUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() });
    return;
  }
  const mongo = await MongoClient.connect(process.env.MONGODB_URI!);
  const db = mongo.db(process.env.MONGODB_DB_NAME!);
  const collection = db.collection('public_engagement');
  const engagement = await ensurePublicEngagement(clientId, collection);
  if (parsed.data.action === 'visit') {
    engagement.visits += 1;
  } else {
    const delta = parsed.data.delta ?? 1;
    engagement.likes = Math.max(0, engagement.likes + delta);
  }
  engagement.updatedAt = new Date().toISOString();
  await collection.updateOne({ clientId }, { $set: engagement }, { upsert: true });
  response.json({
    data: {
      clientId,
      visits: engagement.visits,
      likes: engagement.likes,
      updatedAt: engagement.updatedAt,
    },
  });
  await mongo.close();
});

app.get('/api/public/client/:clientId/matches/:matchId/engagement', async (request: Request, response: Response) => {
  const rawClientId = request.params.clientId;
  const clientId = typeof rawClientId === 'string' ? await resolvePublicClientId(rawClientId) : null;
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' });
    return;
  }
  const leagueId = typeof request.query.leagueId === 'string' ? request.query.leagueId : '';
  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : '';
  const matchId = typeof request.params.matchId === 'string' ? request.params.matchId : '';
  if (!leagueId || !categoryId || !matchId) {
    response.status(400).json({ message: 'leagueId, categoryId y matchId son requeridos' });
    return;
  }
  const mongo = await MongoClient.connect(process.env.MONGODB_URI!);
  const db = mongo.db(process.env.MONGODB_DB_NAME!);
  const collection = db.collection('public_match_likes');
  const entry = await ensurePublicMatchLike(clientId, leagueId, categoryId, matchId, collection);
  response.json({
    data: {
      likes: entry.likes,
      updatedAt: entry.updatedAt,
    },
  });
  await mongo.close();
});

app.post('/api/public/client/:clientId/matches/:matchId/engagement', async (request: Request, response: Response) => {
  const rawClientId = request.params.clientId;
  const clientId = typeof rawClientId === 'string' ? await resolvePublicClientId(rawClientId) : null;
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' });
    return;
  }
  const parsed = publicMatchLikeUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() });
    return;
  }
  const matchId = typeof request.params.matchId === 'string' ? request.params.matchId : '';
  if (!matchId) {
    response.status(400).json({ message: 'matchId es requerido' });
    return;
  }
  const mongo = await MongoClient.connect(process.env.MONGODB_URI!);
  const db = mongo.db(process.env.MONGODB_DB_NAME!);
  const collection = db.collection('public_match_likes');
  const entry = await ensurePublicMatchLike(clientId, parsed.data.leagueId, parsed.data.categoryId, matchId, collection);
  entry.likes = Math.max(0, entry.likes + parsed.data.delta);
  entry.updatedAt = new Date().toISOString();
  await collection.updateOne({ clientId, leagueId: parsed.data.leagueId, categoryId: parsed.data.categoryId, matchId }, { $set: entry }, { upsert: true });
  response.json({
    data: {
      likes: entry.likes,
      updatedAt: entry.updatedAt,
    },
  });
  await mongo.close();
});

app.get('/api/public/client/:clientId/leagues/:leagueId/fixture', async (request: Request, response: Response) => {
  const rawClientId = request.params.clientId;
  const clientId = typeof rawClientId === 'string' ? await resolvePublicClientId(rawClientId) : null;
  if (!clientId) {
    response.status(400).json({ message: 'clientId inválido' });
    return;
  }
  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId && item.active);
  if (!league || league.ownerUserId !== clientId) {
    response.status(404).json({ message: 'Liga no encontrada para el cliente' });
    return;
  }
  const data = league.categories.map((category) => ({
    id: category.id,
    name: category.name,
  }));

  response.json({ data });
});

app.post('/api/admin/leagues/:leagueId/teams', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  // Buscar liga en MongoDB
  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
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

  // Validar duplicados en MongoDB
  const allTeams = await getAllTeamsFromMongo();
  const duplicated = allTeams.some(
    (team) =>
      team.leagueId === league.id &&
      team.categoryId === parsed.data.categoryId &&
      team.name.trim().toLowerCase() === parsed.data.name.trim().toLowerCase(),
  )

  if (duplicated) {
    response.status(409).json({ message: 'Ya existe un equipo con ese nombre en la categoría' })
    return
  }

  const rawStaff = parsed.data.technicalStaff;
  const cleanStaff = rawStaff ? {
    ...(rawStaff.director && rawStaff.director.name ? {
      director: {
        name: rawStaff.director.name,
        ...(rawStaff.director.photoUrl ? { photoUrl: rawStaff.director.photoUrl } : {})
      }
    } : {}),
    ...(rawStaff.assistant && rawStaff.assistant.name ? {
      assistant: {
        name: rawStaff.assistant.name,
        ...(rawStaff.assistant.photoUrl ? { photoUrl: rawStaff.assistant.photoUrl } : {})
      }
    } : {})
  } : undefined;
  const normalizedStaff: TechnicalStaffClean | undefined = normalizeTechnicalStaff(cleanStaff);

  const team: RegisteredTeam = {
    id: uuidv4(),
    leagueId: league.id,
    categoryId: parsed.data.categoryId,
    name: parsed.data.name.trim(),
    ...(parsed.data.logoUrl ? { logoUrl: parsed.data.logoUrl } : {}),
    ...(parsed.data.primaryColor ? { primaryColor: parsed.data.primaryColor } : {}),
    ...(parsed.data.secondaryColor ? { secondaryColor: parsed.data.secondaryColor } : {}),
    ...(normalizedStaff ? { technicalStaff: normalizedStaff } : {}),
    players: [],
  }

  try {
    await saveTeamToMongo(team)
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar equipo en MongoDB', error: String(err) })
    return
  }
  response.status(201).json({ data: team })
})

const createPlayerSchema = z.object({
  name: z.string().min(2),
  nickname: z.string().min(1),
  age: z.number().int().min(5).max(80),
  number: z.number().int().min(1).max(99),
  position: z.string().min(2),
  photoUrl: z.string().trim().min(1).optional(),
  registrationStatus: z.enum(['pending', 'registered']).optional(),
  replacePlayerId: z.string().uuid().optional(),
  replacementReason: z.enum(['injury']).optional(),
})

app.post('/api/admin/teams/:teamId/players', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allTeams = await getAllTeamsFromMongo();
  const team = allTeams.find((item) => item.id === request.params.teamId)
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === team.leagueId)
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
    registrationStatus: parsed.data.registrationStatus ?? 'pending',
    ...(parsed.data.photoUrl ? { photoUrl: parsed.data.photoUrl } : {}),
  }

  team.players.push(player)
  try {
    await saveTeamToMongo(team)
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar equipo en MongoDB', error: String(err) })
    return
  }
  const playersOnField = await resolvePlayersOnField(team.leagueId, team.categoryId)
  const registeredTeamSnapshot: RegisteredTeam = {
    ...team,
    players: team.players.filter((item) => item.registrationStatus === 'registered'),
  }
  const syncedLive = syncLiveTeamFromRegistered(registeredTeamSnapshot, playersOnField)
  if (syncedLive) {
    broadcastLive()
  }
  response.json({ data: team })
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

app.patch('/api/admin/teams/:teamId', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allTeams = await getAllTeamsFromMongo();
  const team = allTeams.find((item) => item.id === request.params.teamId)
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === team.leagueId)
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
    const validCategory = league?.categories.some((category) => category.id === parsed.data.categoryId)
    if (!validCategory) {
      response.status(400).json({ message: 'La categoría no pertenece a la liga del equipo' })
      return
    }
  }

  if (parsed.data.name) {
    const duplicated = allTeams.some(
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
    const rawStaff = parsed.data.technicalStaff;
    const cleanStaff = rawStaff ? {
      ...(rawStaff.director && rawStaff.director.name ? {
        director: {
          name: rawStaff.director.name,
          ...(rawStaff.director.photoUrl ? { photoUrl: rawStaff.director.photoUrl } : {})
        }
      } : {}),
      ...(rawStaff.assistant && rawStaff.assistant.name ? {
        assistant: {
          name: rawStaff.assistant.name,
          ...(rawStaff.assistant.photoUrl ? { photoUrl: rawStaff.assistant.photoUrl } : {})
        }
      } : {})
    } : undefined;
    const normalizedStaff: TechnicalStaffClean | undefined = normalizeTechnicalStaff(cleanStaff);
    if (normalizedStaff) {
      team.technicalStaff = normalizedStaff;
    } else {
      delete team.technicalStaff;
    }
  }

  try {
    await saveTeamToMongo(team)
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar equipo en MongoDB', error: String(err) })
    return
  }
  response.json({ data: team })
})

app.delete('/api/admin/teams/:teamId', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allTeams = await getAllTeamsFromMongo();
  const team = allTeams.find((item) => item.id === request.params.teamId)
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === team.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada para el equipo' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  // Eliminar equipo de MongoDB
  try {
    const collection = await getTeamsCollection();
    await collection.deleteOne({ id: team.id });
  } catch (err) {
    response.status(500).json({ message: 'Error al eliminar equipo en MongoDB', error: String(err) })
    return
  }
  response.json({ ok: true })
})

const updatePlayerSchema = z.object({
  name: z.string().min(2).optional(),
  nickname: z.string().min(1).optional(),
  age: z.number().int().min(5).max(80).optional(),
  number: z.number().int().min(1).max(99).optional(),
  position: z.string().min(2).optional(),
  photoUrl: z.string().trim().min(1).optional(),
  registrationStatus: z.enum(['pending', 'registered']).optional(),
})

app.patch('/api/admin/teams/:teamId/players/:playerId', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allTeams = await getAllTeamsFromMongo();
  const team = allTeams.find((item) => item.id === request.params.teamId)
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === team.leagueId)
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
  if (parsed.data.registrationStatus !== undefined) {
    player.registrationStatus = parsed.data.registrationStatus
  }

  try {
    await saveTeamToMongo(team)
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar equipo en MongoDB', error: String(err) })
    return
  }
  const playersOnField = await resolvePlayersOnField(team.leagueId, team.categoryId)
  const registeredTeamSnapshot: RegisteredTeam = {
    ...team,
    players: team.players.filter((item) => item.registrationStatus === 'registered'),
  }
  const syncedLive = syncLiveTeamFromRegistered(registeredTeamSnapshot, playersOnField)
  if (syncedLive) {
    broadcastLive()
  }
  response.json({ data: team })
})

app.delete('/api/admin/teams/:teamId/players/:playerId', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allTeams = await getAllTeamsFromMongo();
  const team = allTeams.find((item) => item.id === request.params.teamId)
  if (!team) {
    response.status(404).json({ message: 'Equipo no encontrado' })
    return
  }

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === team.leagueId)
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
  try {
    await saveTeamToMongo(team)
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar equipo en MongoDB', error: String(err) })
    return
  }
  const playersOnField = await resolvePlayersOnField(team.leagueId, team.categoryId)
  const registeredTeamSnapshot: RegisteredTeam = {
    ...team,
    players: team.players.filter((item) => item.registrationStatus === 'registered'),
  }
  const syncedLive = syncLiveTeamFromRegistered(registeredTeamSnapshot, playersOnField)
  if (syncedLive) {
    broadcastLive()
  }
  response.json({ data: team })
})

app.get('/api/admin/leagues/:leagueId/fixture', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
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

  const allTeams = await getAllTeamsFromMongo();
  const teams = allTeams.filter(
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

app.get('/api/admin/leagues/:leagueId/fixture-schedule', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  const allTeams = await getAllTeamsFromMongo();
  const activeTeamIds = new Set(
    allTeams
      .filter((team) => team.leagueId === league.id && (!categoryId || team.categoryId === categoryId) && isTeamActive(team))
      .map((team) => team.id),
  )

  const allSchedules = await getAllFixtureSchedulesFromMongo();
  const data = allSchedules.filter((item) => {
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
  status: z.enum(['scheduled', 'postponed']).optional(),
})

app.post('/api/admin/leagues/:leagueId/matches/:matchId/schedule', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
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

  const next = {
    leagueId: league.id,
    categoryId: parsed.data.categoryId,
    matchId: request.params.matchId,
    round: parsed.data.round,
    scheduledAt: parsed.data.scheduledAt,
    ...(parsed.data.venue ? { venue: parsed.data.venue } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  }

  try {
    await saveFixtureScheduleToMongo(next)
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar fixture en MongoDB', error: String(err) })
    return
  }
  response.json({ data: next })
})

app.delete('/api/admin/leagues/:leagueId/matches/:matchId/schedule', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
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

  try {
    const collection = await getFixtureScheduleCollection();
    const result = await collection.deleteOne({ leagueId: league.id, categoryId, matchId: request.params.matchId });
    response.json({ data: { deleted: result.deletedCount > 0 } })
  } catch (err) {
    response.status(500).json({ message: 'Error al eliminar fixture en MongoDB', error: String(err) })
  }
})

app.get('/api/admin/leagues/:leagueId/round-awards', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
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

  const allAwards = await getAllRoundAwardsFromMongo();
  const data = allAwards.filter((item) => {
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

app.post('/api/admin/leagues/:leagueId/round-awards', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
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

  try {
    await saveRoundAwardToMongo(next)
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar premio de ronda en MongoDB', error: String(err) })
    return
  }
  response.json({ data: next })
})

app.get('/api/admin/leagues/:leagueId/round-awards-ranking', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''

  const allAwards = await getAllRoundAwardsFromMongo();
  const pool = allAwards.filter(
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

app.get('/api/admin/leagues/:leagueId/played-matches', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }

  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }

  const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : ''
  const allTeams = await getAllTeamsFromMongo();
  const categoryTeams = allTeams.filter(
    (team) => team.leagueId === league.id && (!categoryId || team.categoryId === categoryId),
  )
  const activeCategoryTeamIds = new Set(categoryTeams.filter((team) => isTeamActive(team)).map((team) => team.id))
  const categoryTeamByName = new Map<string, RegisteredTeam>()
  categoryTeams.forEach((team) => {
    buildTeamNameAliases(team.name).forEach((alias) => {
      if (!categoryTeamByName.has(alias)) {
        categoryTeamByName.set(alias, team)
      }
    })
  })

  const allMatches = await getAllPlayedMatchesFromMongo();
  const data = allMatches.filter((item) => {
    if (item.leagueId !== league.id || (categoryId && item.categoryId !== categoryId)) return false

    const parsed = parseMatchIdentity(item.matchId)
    if (parsed && activeCategoryTeamIds.has(parsed.homeTeamId) && activeCategoryTeamIds.has(parsed.awayTeamId)) {
      return true
    }

    // Permitir Map o Record como aliasMap
    const aliasMap: any = categoryTeamByName
    const homeTeam = typeof aliasMap.get === 'function'
      ? resolveTeamFromAliasMap(Object.fromEntries(aliasMap), item.homeTeamName)
      : resolveTeamFromAliasMap(aliasMap, item.homeTeamName)
    const awayTeam = typeof aliasMap.get === 'function'
      ? resolveTeamFromAliasMap(Object.fromEntries(aliasMap), item.awayTeamName)
      : resolveTeamFromAliasMap(aliasMap, item.awayTeamName)

    if (!homeTeam || !awayTeam) return false
    return isTeamActive(homeTeam) && isTeamActive(awayTeam)
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

app.post('/api/admin/leagues/:leagueId/played-matches', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
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

  // Guardar o actualizar en MongoDB
  await savePlayedMatchToMongo(nextRecord)
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

app.post('/api/admin/leagues/:leagueId/played-matches/:matchId/videos', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
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

  // Buscar partido en MongoDB
  const allMatches = await getAllPlayedMatchesFromMongo();
  const match = allMatches.find(
    (item) => item.leagueId === league.id && item.categoryId === parsed.data.categoryId && item.matchId === request.params.matchId,
  );
  if (!match) {
    response.status(404).json({ message: 'Partido jugado no encontrado' })
    return
  }
  const video = {
    id: uuidv4(),
    name: parsed.data.name,
    url: parsed.data.url,
  }
  await saveHighlightVideoToMongo(video)
  response.json({ data: { ...match, highlightVideos: [...(match.highlightVideos || []), video] } })
})

app.post('/api/admin/leagues/:leagueId/played-matches/:matchId/videos/upload', upload.single('video'), async (request: any, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
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
  const file = (request as any).file
  if (!file) {
    response.status(400).json({ message: 'Debes adjuntar un archivo de video' })
    return
  }
  if (!file.mimetype.startsWith('video/')) {
    response.status(400).json({ message: 'El archivo debe ser un video válido' })
    return
  }
  const allMatches = await getAllPlayedMatchesFromMongo();
  const match = allMatches.find(
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
    await saveHighlightVideoToMongo(video)
    response.json({ data: { ...match, highlightVideos: [...(match.highlightVideos || []), video] } })
  } catch {
    response.status(500).json({ message: 'No se pudo procesar/cargar el video' })
  }
})

app.delete('/api/admin/leagues/:leagueId/played-matches/:matchId/videos/:videoId', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === request.params.leagueId)
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }
  if (user.role !== 'super_admin' && league.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' })
    return
  }
  const categoryId = String(request.query.categoryId ?? '')
  const allMatches = await getAllPlayedMatchesFromMongo();
  const match = allMatches.find(
    (item) => item.leagueId === league.id && item.categoryId === categoryId && item.matchId === request.params.matchId,
  )
  if (!match) {
    response.status(404).json({ message: 'Partido jugado no encontrado' })
    return
  }
  // Eliminar video de la colección highlight_videos (puedes implementar deleteHighlightVideoFromMongo)
  // Por ahora solo responde éxito
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

app.post('/api/admin/live/load-match', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const parsed = loadLiveMatchSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido' })
    return
  }

  const allLeagues = await getAllLeaguesFromMongo();
  const league = allLeagues.find((item) => item.id === parsed.data.leagueId)
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
  const allTeams = await getAllTeamsFromMongo();
  const homeTeam = allTeams.find(
    (item) => item.id === parsed.data.homeTeamId && item.leagueId === league.id && item.categoryId === category.id,
  )
  const awayTeam = allTeams.find(
    (item) => item.id === parsed.data.awayTeamId && item.leagueId === league.id && item.categoryId === category.id,
  )
  if (!homeTeam || !awayTeam) {
    response.status(404).json({ message: 'Equipos no encontrados para la liga/categoría seleccionada' })
    return
  }
  const homeRegisteredPlayers = homeTeam.players.filter((player) => player.registrationStatus === 'registered')
  const awayRegisteredPlayers = awayTeam.players.filter((player) => player.registrationStatus === 'registered')
  const homeTeamForLive = { ...homeTeam, players: homeRegisteredPlayers }
  const awayTeamForLive = { ...awayTeam, players: awayRegisteredPlayers }
  loadMatchForLive({
    leagueName: league.name,
    categoryName: category.name,
    homeTeam: homeTeamForLive,
    awayTeam: awayTeamForLive,
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

app.post('/api/admin/leagues', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const parsed = createLeagueSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() })
    return
  }

  // Verificar duplicados en MongoDB
  const allLeagues = await getAllLeaguesFromMongo();
  const duplicatedSlug = allLeagues.some(
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
    active: typeof parsed.data.active === 'boolean' ? parsed.data.active : true,
    ownerUserId: user.role === 'super_admin' ? SUPER_ADMIN_USER_ID : user.id,
    ...(parsed.data.logoUrl ? { logoUrl: parsed.data.logoUrl } : {}),
    categories: parsed.data.categories.map((category) => ({
      ...category,
      id: uuidv4(),
    })),
  }

  try {
    await saveLeagueToMongo(league)
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar liga en MongoDB', error: String(err) })
    return
  }
  response.status(201).json({ data: league })
})

const updateLeagueSchema = createLeagueSchema.partial()

app.patch('/api/admin/leagues/:leagueId', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const leagueIndex = allLeagues.findIndex((item) => item.id === request.params.leagueId)
  if (leagueIndex === -1) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }
  const currentLeague = allLeagues[leagueIndex]
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
  const duplicatedSlug = allLeagues.some(
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
  await saveLeagueToMongo(nextLeague)
  response.json({ data: nextLeague })
})

app.delete('/api/admin/leagues/:leagueId', async (request, response) => {
  const user = await requireAuth(request, response)
  if (!user) return

  const allLeagues = await getAllLeaguesFromMongo();
  const index = allLeagues.findIndex((item) => item.id === request.params.leagueId)
  if (index === -1) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }
  const league = allLeagues[index]
  if (!league) {
    response.status(404).json({ message: 'Liga no encontrada' })
    return
  }
  if (user.role !== 'super_admin') {
    response.status(403).json({ message: 'Solo el super admin puede desactivar ligas' })
    return
  }
  // Soft delete: marcar como inactiva en MongoDB
  league.active = false
  await saveLeagueToMongo(league)

  response.json({ ok: true, message: 'Liga desactivada (soft delete)' })
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

})

// --- Lineup schema (corregido fuera del PATCH) ---
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

io.on('connection', (socket: any) => {
  socket.emit('live:update', buildLiveSnapshot())
})

const startServer = async () => {
  await initializeDataStore()

  const migratedLineupsCount = migratePlayedMatchesLineups()
  if (migratedLineupsCount > 0) {
    console.log(`Migración de lineups históricos completada: ${migratedLineupsCount} partidos actualizados.`)
  }

  httpServer.listen(port, () => {
    console.log(`FL Liga API corriendo en http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('No se pudo iniciar FL Liga API:', error)
  process.exit(1)
})


