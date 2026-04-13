import { app } from './server-stub';

import { getPlayedMatchById, saveLiveMatchToMongo } from './liveMatchData';
import { getAllHighlightVideosFromMongo, getUsersCollection } from './data';
import { saveUserToMongo } from './saveUserToMongo';
import type { AppUser } from './data';
import 'dotenv/config';
import { resolvePlayersOnField } from './utils';
import { broadcastLive, emitLiveUpdate } from './live';
import { z } from 'zod';
import cors from 'cors';
import express from 'express';
import type { RegisteredTeam, RegisteredPlayer } from './data';
import { ensurePublicEngagement } from './engagement';
import { getTeamsCollection, connectMongo, getLeaguesCollection } from './data';
import { transcodeVideoIfPossible } from './utils';
import {
  getAllPlayedMatchesFromMongo,
  savePlayedMatchToMongo,
  saveHighlightVideoToMongo,
  getVideosBucket,
  getMongoObjectId
} from './data';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Collection, MongoClient } from 'mongodb';
import { Readable } from 'stream';
import multer from 'multer';
import { generateFixture } from './fixture';
import {
  syncLiveTeamFromRegistered,
  updateLineupWithFormation,
  registerEvent,
  buildLiveSnapshot,
  loadMatchForLive
} from './live';
import { setupSocketIO } from './io';
import { requireAuth } from './requireAuth';
import {
  getAllLeaguesFromMongo,
  saveLeagueToMongo,
  getAllClientAccessTokensFromMongo,
  saveClientAccessTokenToMongo,
  renewClientAccessTokenInMongo,
  getClientAccessTokenById,
  getClientAccessTokenByToken,
  revokeClientAccessTokenInMongo,
  getAllTeamsFromMongo,
  saveTeamToMongo,
  getAllFixtureSchedulesFromMongo,
  getFixtureScheduleCollection,
  saveFixtureScheduleToMongo,
  getAllRoundAwardsFromMongo,
  saveRoundAwardToMongo,
  getMatchEngagement,
  saveMatchEngagement,
  getLeagueFixture,
  getLeaguesByClientId,
  getClientEngagement,
  saveClientEngagement,
  getAllUsersFromMongo,
} from './data';
// ENDPOINTS AVANZADOS COMENTADOS PARA COMPILACIÓN LIMPIA
import { buildTeamNameAliases, resolveTeamFromAliasMap } from './team-alias';

// Importar SUPER_ADMIN_USER_ID
import { SUPER_ADMIN_USER_ID } from './data';

// Importar httpServer y port justo antes de arrancar el servidor para evitar duplicados
import { httpServer, port } from './server-stub';

// Inicializar índices de partidos jugados al arrancar el backend
import { ensurePlayedMatchesIndexes } from './data'

import { Request, Response, NextFunction } from 'express'

// Configuración CORS robusta: permitir FE producción y local
/*app.use(cors({
  origin: [
    'https://fl-liga-frontend.vercel.app',
    'http://localhost:5173'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));*/

// Middleware CORS robusto para Render y desarrollo local

app.use(cors({
  origin: [
    'http://localhost:5173', // FE local
    'https://fl-liga-frontend.vercel.app', // FE producción (ajusta si tu dominio es otro)
    'https://fl-liga-frontend.onrender.com', // FE en Render (si aplica)
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware para parsear JSON y formularios con límite aumentado
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Endpoint: obtener ligas según usuario autenticado (cliente: solo sus ligas, superadmin: todas)
app.get('/api/leagues', async (req, res) => {
  try {
    // Autenticación y obtención de usuario
    const user = await requireAuth(req, res);
    let leagues;
    if (user.role === 'super_admin' || user.id === SUPER_ADMIN_USER_ID) {
      leagues = await getAllLeaguesFromMongo();
    } else {
      leagues = (await getAllLeaguesFromMongo()).filter(l => l.ownerUserId === user.id);
    }
    res.json({ data: leagues });
  } catch (err) {
    console.error('[API] Error en /api/leagues:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Error al obtener ligas', error: String(err) });
    }
  }
});

// Endpoint: obtener equipos registrados de una liga y categoría (compatibilidad FE)
app.get('/api/admin/leagues/:leagueId/teams', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { categoryId } = req.query;
    if (!categoryId || typeof categoryId !== 'string') {
      return res.status(400).json({ message: 'Falta categoryId' });
    }
    // Traer todos los equipos y filtrar por liga y categoría
    const allTeams = await getAllTeamsFromMongo();
    const teams = allTeams.filter(t => t.leagueId === leagueId && t.categoryId === categoryId);
    res.json({ data: teams });
  } catch (err) {
    console.error('[API] Error en /api/admin/leagues/:leagueId/teams:', err);
    res.status(500).json({ message: 'Error al obtener equipos', error: String(err) });
  }
});

// Actualizar categorías de una liga
app.put('/api/admin/leagues/:leagueId/categories', requireAuth, async (req, res) => {
  try {
    let { leagueId } = req.params;
    const leagueIdStr = Array.isArray(leagueId) ? leagueId[0] : leagueId;
    if (!leagueIdStr) {
      console.log('[categorias] ID de liga inválido:', leagueId);
      return res.status(400).json({ ok: false, message: 'ID de liga inválido' });
    }
    const { categories } = req.body;
    if (!Array.isArray(categories)) {
      console.log('[categorias] Falta arreglo de categorías en body:', req.body);
      return res.status(400).json({ ok: false, message: 'Falta arreglo de categorías' });
    }
    // Validación mínima de categorías
    // Importar tipos reales
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Category, RuleSet } = require('./data');
    // Normalizar y validar reglas
    const cats = (Array.isArray(categories) ? categories : []).map((cat: any) => {
      // Si rules es null, dejarlo como null, si es objeto, validar campos mínimos
      let rules = cat.rules;
      if (rules && typeof rules === 'object') {
        // Solo tomar campos válidos de RuleSet
        rules = {
          playersOnField: rules.playersOnField ?? 0,
          matchMinutes: rules.matchMinutes ?? 0,
          breakMinutes: rules.breakMinutes ?? 0,
          allowDraws: !!rules.allowDraws,
          pointsWin: rules.pointsWin ?? 0,
          pointsDraw: rules.pointsDraw ?? 0,
          pointsLoss: rules.pointsLoss ?? 0,
        };
      } else {
        rules = null;
      }
      return {
        id: cat.id,
        name: cat.name,
        minAge: cat.minAge,
        maxAge: cat.maxAge ?? null,
        rules,
      };
    });
    for (const cat of cats) {
      if (!cat.id || !cat.name || typeof cat.minAge !== 'number' || typeof cat.maxAge === 'undefined') {
        console.log('[categorias] Datos de categoría inválidos:', cat);
        return res.status(400).json({ ok: false, message: 'Datos de categoría inválidos' });
      }
      // Validar reglas si existen
      if (cat.rules && typeof cat.rules.playersOnField !== 'number') {
        return res.status(400).json({ ok: false, message: 'Reglas de categoría inválidas' });
      }
    }
    console.log('[categorias] Actualizando categorías para liga:', leagueIdStr, 'Payload:', cats);
    const collection = await getLeaguesCollection();
    // Guardar las categorías y devolver el documento actualizado
    const result = await collection.findOneAndUpdate(
      { id: leagueIdStr },
      { $set: { categories: cats } },
      { returnDocument: 'after' }
    );
    const updatedLeague = result && 'value' in result ? result.value as { categories: typeof cats } : null;
    if (!updatedLeague) {
      console.log('[categorias] Liga no encontrada para id:', leagueIdStr);
      return res.status(404).json({ ok: false, message: 'Liga no encontrada' });
    }
    console.log('[categorias] Categorías actualizadas correctamente para liga:', leagueIdStr);
    res.json({ ok: true, message: 'Categorías actualizadas', data: updatedLeague.categories });
  } catch (err) {
    console.error('[categorias] Error al actualizar categorías:', err);
    res.status(500).json({ ok: false, message: 'Error al actualizar categorías', error: String(err) });
  }
});

// --- ENDPOINTS ADMIN ROUND AWARDS Y PLAYED MATCHES ---
// Obtener mejores jugadoras por fecha (todas las rondas de una liga/categoría)
app.get('/api/admin/leagues/:leagueId/round-awards', async (req, res) => {
  const { leagueId } = req.params;
  const { categoryId } = req.query;
  try {
    const all = await getAllRoundAwardsFromMongo();
    const filtered = all.filter(r => r.leagueId === leagueId && (!categoryId || r.categoryId === categoryId));
    res.json({ ok: true, data: filtered });
  } catch (e) {
    res.status(500).json({ ok: false, message: 'Error cargando mejores jugadoras por fecha' });
  }
});

// Guardar mejores jugadoras de la fecha
app.post('/api/admin/leagues/:leagueId/round-awards', async (req, res) => {
  const { leagueId } = req.params;
  const payload = req.body;
  try {
    const entry = { ...payload, leagueId, updatedAt: new Date().toISOString() };
    await saveRoundAwardToMongo(entry);
    res.json({ ok: true, data: entry });
  } catch (e) {
    res.status(500).json({ ok: false, message: 'Error guardando mejores jugadoras de la fecha' });
  }
});

// Ranking de jugadora de la fecha (acumulado por votos)
app.get('/api/admin/leagues/:leagueId/round-awards-ranking', async (req, res) => {
  const { leagueId } = req.params;
  const { categoryId } = req.query;
  try {
    const all = await getAllRoundAwardsFromMongo();
    const filtered = all.filter(r => r.leagueId === leagueId && (!categoryId || r.categoryId === categoryId));
    // Agrupar votos por jugadora
    const rankingMap = new Map();
    filtered.forEach(entry => {
      entry.matchBestPlayers.forEach(player => {
        const key = player.playerId + '|' + player.teamId;
        if (!rankingMap.has(key)) {
          rankingMap.set(key, {
            playerId: player.playerId,
            playerName: player.playerName,
            teamId: player.teamId,
            teamName: player.teamName,
            votes: 1,
          });
        } else {
          rankingMap.get(key).votes++;
        }
      });
    });
    const ranking = Array.from(rankingMap.values()).sort((a, b) => b.votes - a.votes);
    res.json({ ok: true, data: ranking });
  } catch (e) {
    res.status(500).json({ ok: false, message: 'Error cargando ranking de jugadora de la fecha' });
  }
});

// Partidos jugados por liga/categoría
app.get('/api/admin/leagues/:leagueId/played-matches', async (req, res) => {
  const { leagueId } = req.params;
  const { categoryId } = req.query;
  try {
    const all = await getAllPlayedMatchesFromMongo();
    const filtered = all.filter(m => m.leagueId === leagueId && (!categoryId || m.categoryId === categoryId));
    res.json({ ok: true, data: filtered });
  } catch (e) {
    res.status(500).json({ ok: false, message: 'Error cargando partidos jugados' });
  }
});


// Endpoint de logs de auditoría solo para super_admin
app.get('/api/admin/audit-logs', requireSuperAdmin, async (req, res) => {
  try {
    // Conexión a MongoDB (ajusta si ya tienes una instancia global)
    const client = new MongoClient(process.env.MONGODB_URI || 'mongodb+srv://fl_liga_user:1623Fercho@flstore.3yoejzl.mongodb.net/?appName=flstore');
    await client.connect();
    const db = client.db('fl_liga');
    const logs = await db.collection('audit_logs').find({}).sort({ timestamp: -1 }).limit(100).toArray();
    await client.close();
    res.json({ ok: true, data: logs });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Error al obtener logs', error: String(err) });
  }
});
// ...otras importaciones...

// Endpoint para obtener un token de acceso de cliente por ID
app.get('/api/admin/client-access-tokens/:tokenId', async (req, res) => {
  try {
    const { tokenId } = req.params;
    const token = await getClientAccessTokenById(tokenId);
    if (!token) {
      return res.status(404).json({ message: 'Token no encontrado' });
    }
    res.json({ data: token });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener token', error: String(err) });
  }
});

// Endpoint: Ranking acumulado de jugadora de la fecha por liga y categoría
app.get('/api/admin/leagues/:leagueId/round-awards-ranking', requireSuperAdmin, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { categoryId } = req.query;
    if (!categoryId || typeof categoryId !== 'string') {
      return res.status(400).json({ message: 'Falta categoryId' });
    }

    const allAwards = await getAllRoundAwardsFromMongo();
    const filtered = allAwards.filter(
      (a) => a.leagueId === leagueId && a.categoryId === categoryId
    );

    // Acumular votos por jugadora
    const votesMap = new Map();

    for (const award of filtered) {
      if (award.roundBestPlayerId && award.roundBestPlayerName && award.roundBestPlayerTeamId && award.roundBestPlayerTeamName) {
        const key = award.roundBestPlayerId;
        if (!votesMap.has(key)) {
          votesMap.set(key, {
            playerId: award.roundBestPlayerId,
            playerName: award.roundBestPlayerName,
            teamId: award.roundBestPlayerTeamId,
            teamName: award.roundBestPlayerTeamName,
            votes: 0,
          });
        }
        votesMap.get(key).votes += 1;
      }
    }

    const ranking = Array.from(votesMap.values()).sort((a, b) => b.votes - a.votes);

    res.json({ data: ranking });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener ranking de jugadora de la fecha', error: String(err) });
  }
});

;
// Middleware para validar super_admin (ajusta según tu lógica de autenticación real)
function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers['authorization'];
  if (auth && typeof auth === 'string' && auth.includes('super-admin')) {
    return next();
  }
  return res.status(403).json({ message: 'No autorizado' });
}

// Endpoint de logs de auditoría solo para super_admin
app.get('/api/admin/audit-logs', requireSuperAdmin, async (req, res) => {
  try {
    // Conexión a MongoDB (ajusta si ya tienes una conexión global)
    const uri = process.env.MONGODB_URI || 'mongodb+srv://fl_liga_user:1623Fercho@flstore.3yoejzl.mongodb.net/?appName=flstore';
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db('fl_liga');
    const collection = db.collection('audit_logs');
    // Trae los últimos 100 logs
    const logs = await collection.find({}).sort({ timestamp: -1 }).limit(100).toArray();
    await client.close();
    res.json({ data: logs });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener logs', error: String(err) });
  }
});

// Endpoint público: obtener fixture de una liga/categoría para un cliente
app.get('/api/public/client/:clientId/leagues/:leagueId/fixture', async (req, res) => {
  try {
    const { clientId, leagueId } = req.params;
    const { categoryId } = req.query;
    if (!categoryId) {
      console.warn(`[API] Faltante categoryId en fixture público`);
      return res.json({ data: {}, message: 'Falta categoryId' });
    }

    // Resolución de clientId (acepta slug o UUID)
    let resolvedClientId = clientId;
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    function normalize(str: string): string {
      return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[ -\u007f]/g, '')
        .replace(/[^a-z0-9]/g, '');
    }
    let user = null;
    if (!uuidRegex.test(clientId.trim())) {
      const usersCollection = await getUsersCollection();
      user = await usersCollection.findOne({ slug: clientId.trim() });
      if (!user) {
        const allUsers = await usersCollection.find({ role: 'client_admin', active: true }).toArray();
        user = allUsers.find(u => normalize(u.organizationName ?? '') === normalize(clientId)) || null;
      }
      if (user) {
        resolvedClientId = user.id;
        console.log(`[API] Cliente encontrado: ${user.organizationName} (${user.id})`);
      } else {
        console.warn(`[API] Cliente no encontrado para clientId: ${clientId}`);
        return res.json({ data: {}, message: 'Cliente no encontrado' });
      }
    }

    // Buscar liga y categoría
    const allLeagues = await getAllLeaguesFromMongo();
    const league = allLeagues.find(l => l.id === leagueId && l.ownerUserId === resolvedClientId && l.active);
    if (!league) {
      console.warn(`[API] Liga no encontrada o no pertenece al cliente: ${leagueId}`);
      return res.json({ data: {}, message: 'Liga no encontrada' });
    }
    const category = league.categories?.find(c => c.id === categoryId) || null;
    if (!category) {
      console.warn(`[API] Categoría no encontrada en la liga: ${categoryId}`);
      return res.json({ data: {}, message: 'Categoría no encontrada en la liga' });
    }

    // Buscar fixture schedule
    const allSchedules = await getAllFixtureSchedulesFromMongo();
    const schedule = allSchedules.filter(s => s.leagueId === leagueId && s.categoryId === categoryId);
    // Estructura de rondas
    type FixtureRound = { round: number, matches: { matchId: string }[] };
    const fixture: FixtureRound[] = [];
    for (const s of schedule) {
      let roundObj = fixture.find(r => r.round === s.round);
      if (!roundObj) {
        roundObj = { round: s.round, matches: [] };
        fixture.push(roundObj);
      }
      roundObj.matches.push({ matchId: s.matchId });
    }

    // Partidos jugados
    const allPlayed = await getAllPlayedMatchesFromMongo();
    const playedMatches = allPlayed.filter(m => m.leagueId === leagueId && m.categoryId === categoryId);
    const playedMatchIds = playedMatches.map(m => m.matchId);


    const allAwards = await getAllRoundAwardsFromMongo();
    const roundAwards = allAwards.filter(a => a.leagueId === leagueId && a.categoryId === categoryId);

    // Obtener equipos de la liga/categoría
    const allTeams = await getAllTeamsFromMongo();
    const teams = allTeams.filter(t => t.leagueId === leagueId && t.categoryId === categoryId);

    res.json({
      data: {
        league: {
          id: league.id,
          name: league.name,
          country: league.country,
          season: league.season,
          slogan: league.slogan,
          themeColor: league.themeColor,
          backgroundImageUrl: league.backgroundImageUrl,
          logoUrl: league.logoUrl
        },
        category: {
          id: category.id,
          name: category.name
        },
        fixture,
        schedule,
        playedMatchIds,
        playedMatches,
        roundAwards,
        teams // <-- ahora incluido en la respuesta
      }
    });
  } catch (err) {
    console.error('[API] Error en /api/public/client/:clientId/leagues/:leagueId/fixture:', err);
    res.json({ data: {}, message: 'Error al obtener fixture público' });
  }
});
// Endpoint público: obtener partidos jugados de una liga/categoría para un cliente
app.get('/api/public/client/:clientId/leagues/:leagueId/played-matches', async (req, res) => {
  try {
    const { clientId, leagueId } = req.params;
    const { categoryId } = req.query;
    if (!categoryId) {
      console.warn(`[API] Faltante categoryId en partidos jugados públicos`);
      return res.json({ data: [], message: 'Falta categoryId' });
    }

    // Resolución de clientId (acepta slug o UUID)
    let resolvedClientId = clientId;
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    function normalize(str: string): string {
      return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[ -\u007f]/g, '')
        .replace(/[^a-z0-9]/g, '');
    }
    let user = null;
    if (!uuidRegex.test(clientId.trim())) {
      const usersCollection = await getUsersCollection();
      user = await usersCollection.findOne({ slug: clientId.trim() });
      if (!user) {
        const allUsers = await usersCollection.find({ role: 'client_admin', active: true }).toArray();
        user = allUsers.find(u => normalize(u.organizationName ?? '') === normalize(clientId)) || null;
      }
      if (user) {
        resolvedClientId = user.id;
        console.log(`[API] Cliente encontrado: ${user.organizationName} (${user.id})`);
      } else {
        console.warn(`[API] Cliente no encontrado para clientId: ${clientId}`);
        return res.json({ data: [], message: 'Cliente no encontrado' });
      }
    }

    // Buscar liga y categoría
    const allLeagues = await getAllLeaguesFromMongo();
    const league = allLeagues.find(l => l.id === leagueId && l.ownerUserId === resolvedClientId && l.active);
    if (!league) {
      console.warn(`[API] Liga no encontrada o no pertenece al cliente: ${leagueId}`);
      return res.json({ data: [], message: 'Liga no encontrada' });
    }
    const category = league.categories?.find(c => c.id === categoryId) || null;
    if (!category) {
      console.warn(`[API] Categoría no encontrada en la liga: ${categoryId}`);
      return res.json({ data: [], message: 'Categoría no encontrada en la liga' });
    }

    // Buscar partidos jugados
    const allMatches = await getAllPlayedMatchesFromMongo();
    const matches = allMatches.filter(m => m.leagueId === leagueId && m.categoryId === categoryId);
    console.log(`[API] Partidos jugados públicos: cliente ${resolvedClientId}, liga ${leagueId}, categoría ${categoryId}, partidos ${matches.length}`);
    res.json({ data: matches });
  } catch (err) {
    console.error('[API] Error en /api/public/client/:clientId/leagues/:leagueId/played-matches:', err);
    res.json({ data: [], message: 'Error al obtener partidos jugados públicos' });
  }
});
// Endpoint público: obtener videos destacados de una liga/categoría para un cliente
app.get('/api/public/client/:clientId/leagues/:leagueId/highlight-videos', async (req, res) => {
  try {
    const { clientId, leagueId } = req.params;
    const { categoryId } = req.query;
    if (!categoryId) {
      console.warn(`[API] Faltante categoryId en videos públicos`);
      return res.json({ data: [], message: 'Falta categoryId' });
    }

    // Resolución de clientId (acepta slug o UUID)
    let resolvedClientId = clientId;
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    function normalize(str: string): string {
      return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[ -]/g, '')
        .replace(/[^a-z0-9]/g, '');
    }
    let user = null;
    if (!uuidRegex.test(clientId.trim())) {
      const usersCollection = await getUsersCollection();
      user = await usersCollection.findOne({ slug: clientId.trim() });
      if (!user) {
        const allUsers = await usersCollection.find({ role: 'client_admin', active: true }).toArray();
        user = allUsers.find(u => normalize(u.organizationName ?? '') === normalize(clientId)) || null;
      }
      if (user) {
        resolvedClientId = user.id;
        console.log(`[API] Cliente encontrado: ${user.organizationName} (${user.id})`);
      } else {
        console.warn(`[API] Cliente no encontrado para clientId: ${clientId}`);
        return res.json({ data: [], message: 'Cliente no encontrado' });
      }
    }

    // Buscar liga y categoría
    const allLeagues = await getAllLeaguesFromMongo();
    const league = allLeagues.find(l => l.id === leagueId && l.ownerUserId === resolvedClientId && l.active);
    if (!league) {
      console.warn(`[API] Liga no encontrada o no pertenece al cliente: ${leagueId}`);
      return res.json({ data: [], message: 'Liga no encontrada' });
    }
    const category = league.categories?.find(c => c.id === categoryId) || null;
    if (!category) {
      console.warn(`[API] Categoría no encontrada en la liga: ${categoryId}`);
      return res.json({ data: [], message: 'Categoría no encontrada en la liga' });
    }

    // Buscar videos destacados
    const allVideos = await getAllHighlightVideosFromMongo();
    // Algunos videos pueden no tener categoryId, filtrar solo por leagueId
    const videos = allVideos.filter(v => v.leagueId === leagueId && (!('categoryId' in v) || v.categoryId === categoryId));
    console.log(`[API] Videos públicos: cliente ${resolvedClientId}, liga ${leagueId}, categoría ${categoryId}, videos ${videos.length}`);
    res.json({ data: videos });
  } catch (err) {
    console.error('[API] Error en /api/public/client/:clientId/leagues/:leagueId/highlight-videos:', err);
    res.json({ data: [], message: 'Error al obtener videos públicos' });
  }
});
// Endpoint público: obtener equipos de una liga/categoría para un cliente
app.get('/api/public/client/:clientId/leagues/:leagueId/teams', async (req, res) => {
  try {
    const { clientId, leagueId } = req.params;
    const { categoryId } = req.query;
    if (!categoryId) {
      console.warn(`[API] Faltante categoryId en equipos públicos`);
      return res.json({ data: [], message: 'Falta categoryId' });
    }

    // Resolución de clientId (acepta slug o UUID)
    let resolvedClientId = clientId;
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    function normalize(str: string): string {
      return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[0-]/g, '')
        .replace(/[^a-z0-9]/g, '');
    }
    let user = null;
    if (!uuidRegex.test(clientId.trim())) {
      const usersCollection = await getUsersCollection();
      user = await usersCollection.findOne({ slug: clientId.trim() });
      if (!user) {
        const allUsers = await usersCollection.find({ role: 'client_admin', active: true }).toArray();
        user = allUsers.find(u => normalize(u.organizationName ?? '') === normalize(clientId)) || null;
      }
      if (user) {
        resolvedClientId = user.id;
        console.log(`[API] Cliente encontrado: ${user.organizationName} (${user.id})`);
      } else {
        console.warn(`[API] Cliente no encontrado para clientId: ${clientId}`);
        return res.json({ data: [], message: 'Cliente no encontrado' });
      }
    }

    // Buscar liga y categoría
    const allLeagues = await getAllLeaguesFromMongo();
    const league = allLeagues.find(l => l.id === leagueId && l.ownerUserId === resolvedClientId && l.active);
    if (!league) {
      console.warn(`[API] Liga no encontrada o no pertenece al cliente: ${leagueId}`);
      return res.json({ data: [], message: 'Liga no encontrada' });
    }
    const category = league.categories?.find(c => c.id === categoryId) || null;
    if (!category) {
      console.warn(`[API] Categoría no encontrada en la liga: ${categoryId}`);
      return res.json({ data: [], message: 'Categoría no encontrada en la liga' });
    }

    // Buscar equipos
    const allTeams = await getAllTeamsFromMongo();
    const teams = allTeams.filter(t => t.leagueId === leagueId && t.categoryId === categoryId);
    console.log(`[API] Equipos públicos: cliente ${resolvedClientId}, liga ${leagueId}, categoría ${categoryId}, equipos ${teams.length}`);
    res.json({ data: teams });
  } catch (err) {
    console.error('[API] Error en /api/public/client/:clientId/leagues/:leagueId/teams:', err);
    res.json({ data: [], message: 'Error al obtener equipos públicos' });
  }
});

// Registrar evento en vivo (persistente, multi-partido)
app.post('/api/admin/live/events', async (req, res) => {
  try {
    const { matchId, event } = req.body;
    if (!matchId || !event) return res.status(400).json({ message: 'Faltan datos: matchId y event' });
    const match = await getPlayedMatchById(matchId);
    if (!match) return res.status(404).json({ message: 'Partido en vivo no encontrado' });
    match.events = match.events || [];
    match.events.push(event);
    await saveLiveMatchToMongo(match);
    res.json({ data: { status: 'event-registered', event } });
  } catch (err) {
    res.status(500).json({ message: 'Error al registrar evento en vivo', error: String(err) });
  }
});

// Endpoint engagement público robusto
app.get('/api/public/client/:clientId/leagues/:leagueId/engagement', async (req, res) => {
  try {
    const { clientId, leagueId } = req.params as { clientId: string; leagueId: string };
    const { categoryId } = req.query as { categoryId?: string };
    if (!categoryId) {
      console.warn(`[API] Faltante categoryId en engagement público`);
      return res.json({ data: {}, message: 'Falta categoryId' });
    }
    const leagues = await getAllLeaguesFromMongo();
    const league = leagues.find(l => l.id === leagueId);
    if (!league) {
      console.warn(`[API] Liga no encontrada: ${leagueId}`);
      return res.json({ data: {}, message: 'Liga no encontrada' });
    }
    const category = league.categories.find((c: any) => c.id === categoryId);
    if (!category) {
      console.warn(`[API] Categoría no encontrada: ${categoryId}`);
      return res.json({ data: {}, message: 'Categoría no encontrada' });
    }
    // Engagement general del cliente (no por liga/categoría, por clientId)
    const engagement = await getClientEngagement(clientId);
    console.log(`[API] Engagement público: clientId ${clientId}, liga ${leagueId}, categoría ${categoryId}`);
    res.json({
      data: {
        league: {
          id: league.id,
          name: league.name
        },
        category: {
          id: category.id,
          name: category.name
        },
        engagement
      }
    });
  } catch (err) {
    console.error('[API] Error en /api/public/client/:clientId/leagues/:leagueId/engagement:', err);
    res.json({ data: {}, message: 'Error al obtener engagement público' });
  }
});
// Obtener partido en vivo real desde MongoDB (multi-partido)
app.get('/api/live/match', async (req, res) => {
  try {
    const matches = await getAllPlayedMatchesFromMongo();
    const liveMatches = matches
      .filter(m => m.status === 'live' && m.homeTeamName && m.awayTeamName)
      .map(m => ({
        ...m,
        homeTeam: { name: m.homeTeamName },
        awayTeam: { name: m.awayTeamName }
      }));
    res.json({ data: liveMatches });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener partidos en vivo', error: String(err) });
  }
});

// Guardar video destacado
app.post('/api/admin/leagues/:leagueId/highlight-videos', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const video = { ...req.body, leagueId };
    if (!video.id || !video.name || !video.url || !video.leagueId) {
      return res.status(400).json({ message: 'Faltan campos requeridos para el video destacado' });
    }
    await saveHighlightVideoToMongo(video);
    res.json({ data: video });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar video destacado', error: String(err) });
  }
});
// Obtener videos destacados de una liga
app.get('/api/admin/leagues/:leagueId/highlight-videos', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const videos = await getAllHighlightVideosFromMongo();
    const filtered = videos.filter((v) => v.leagueId === leagueId);
    res.json({ data: filtered });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener videos destacados', error: String(err) });
  }
});
// Guardar partido jugado
app.post('/api/admin/leagues/:leagueId/played-matches', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const match = { ...req.body, leagueId };
    await savePlayedMatchToMongo(match);
    res.json({ data: match });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar partido jugado', error: String(err) });
  }
});
// Obtener partidos jugados de una liga
app.get('/api/admin/leagues/:leagueId/played-matches', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { categoryId } = req.query;
    const matches = await getAllPlayedMatchesFromMongo();
    const filtered = matches.filter((m) => m.leagueId === leagueId && (!categoryId || m.categoryId === categoryId));
    res.json({ data: filtered });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener partidos jugados', error: String(err) });
  }
});
// Guardar premio de ronda
app.post('/api/admin/leagues/:leagueId/round-awards', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { categoryId, round, ...rest } = req.body;
    if (!categoryId || typeof round !== 'number') return res.status(400).json({ message: 'Faltan datos' });
    const entry = { leagueId, categoryId, round, ...rest };
    await saveRoundAwardToMongo(entry);
    res.json({ data: entry });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar premio de ronda', error: String(err) });
  }
});
// Obtener premios de ronda de una liga
app.get('/api/admin/leagues/:leagueId/round-awards', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const awards = await getAllRoundAwardsFromMongo();
    const filtered = awards.filter((a) => a.leagueId === leagueId);
    res.json({ data: filtered });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener premios de ronda', error: String(err) });
  }
});
// Eliminar schedule de un partido
app.delete('/api/admin/leagues/:leagueId/matches/:matchId/schedule', async (req, res) => {
  try {
    const { leagueId, matchId } = req.params;
    const { categoryId } = req.query;
    if (!categoryId) return res.status(400).json({ message: 'Falta categoryId' });
    const collection = await getFixtureScheduleCollection();
    await collection.deleteOne({ leagueId, matchId, categoryId });
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar schedule', error: String(err) });
  }
});
// Guardar schedule de un partido
app.post('/api/admin/leagues/:leagueId/matches/:matchId/schedule', async (req, res) => {
  try {
    const { leagueId, matchId } = req.params;
    const { categoryId, ...rest } = req.body;
    if (!categoryId) return res.status(400).json({ message: 'Falta categoryId' });
    const entry = { leagueId, matchId, categoryId, ...rest };
    await saveFixtureScheduleToMongo(entry);
    res.json({ data: entry });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar schedule', error: String(err) });
  }
});
// Schedule de una liga para administración
app.get('/api/admin/leagues/:leagueId/fixture-schedule', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { categoryId } = req.query;
    const schedules = await getAllFixtureSchedulesFromMongo();
    const filtered = schedules.filter((s) => s.leagueId === leagueId && (!categoryId || s.categoryId === categoryId));
    res.json({ data: filtered });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener fixture schedule', error: String(err) });
  }
});
// Fixture de una liga para administración
app.get('/api/admin/leagues/:leagueId/fixture', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const fixture = await getLeagueFixture('', leagueId);
    res.json({ data: fixture });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener fixture admin', error: String(err) });
  }
});
// Eliminar jugador de un equipo
app.delete('/api/admin/teams/:teamId/players/:playerId', async (req, res) => {
  try {
    const { teamId, playerId } = req.params;
    const teams = await getAllTeamsFromMongo();
    const team = teams.find((t) => t.id === teamId);
    if (!team) return res.status(404).json({ message: 'Equipo no encontrado' });
    const idx = team.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return res.status(404).json({ message: 'Jugador no encontrado' });
    team.players.splice(idx, 1);
    await saveTeamToMongo(team);
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar jugador', error: String(err) });
  }
});
// Agregar jugador a un equipo
app.post('/api/admin/teams/:teamId/players', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { name, nickname, age, number, position } = req.body;
    if (!name || !nickname || !age || !number || !position) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }
    const teams = await getAllTeamsFromMongo();
    const team = teams.find((t) => t.id === teamId);
    if (!team) return res.status(404).json({ message: 'Equipo no encontrado' });
    const newPlayer = {
      id: (Math.random().toString(36).slice(2) + Date.now()),
      name,
      nickname,
      age,
      number,
      position,
      registrationStatus: "registered" as const,
    };
    team.players.push(newPlayer);
    await saveTeamToMongo(team);
    res.json({ data: newPlayer });
  } catch (err) {
    res.status(500).json({ message: 'Error al agregar jugador', error: String(err) });
  }
});
// Eliminar un equipo
app.delete('/api/admin/teams/:teamId', async (req, res) => {
  try {
    const { teamId } = req.params;
    const teams = await getAllTeamsFromMongo();
    const team = teams.find((t) => t.id === teamId);
    if (!team) return res.status(404).json({ message: 'Equipo no encontrado' });
    const collection = await getTeamsCollection();
    await collection.deleteOne({ id: teamId });
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar equipo', error: String(err) });
  }
});
// Listar equipos de una liga y categoría
app.get('/api/admin/leagues/:leagueId/teams', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { categoryId } = req.query;
    const teams = await getAllTeamsFromMongo();
    const filtered = teams.filter((t) => t.leagueId === leagueId && t.categoryId === categoryId);
    res.json({ data: filtered });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener equipos', error: String(err) });
  }
});
// Crear equipo en una liga
app.post('/api/admin/leagues/:leagueId/teams', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { name, categoryId } = req.body;
    if (!name || !categoryId) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }
    const newTeam = {
      id: (Math.random().toString(36).slice(2) + Date.now()),
      leagueId,
      categoryId,
      name,
      active: true,
      players: [],
    };
    await saveTeamToMongo(newTeam);
    res.json({ data: newTeam });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear equipo', error: String(err) });
  }
});
// Fixture público de una liga
app.get('/api/public/client/:clientId/leagues/:leagueId/fixture', async (req, res) => {
  try {
    const { clientId, leagueId } = req.params;
    const { categoryId } = req.query;
    if (!categoryId) {
      console.warn(`[API] Faltante categoryId en fixture público`);
      return res.json({ data: {}, message: 'Falta categoryId' });
    }
    const leagues = await getAllLeaguesFromMongo();
    const league = leagues.find(l => l.id === leagueId);
    if (!league) {
      console.warn(`[API] Liga no encontrada: ${leagueId}`);
      return res.json({ data: {}, message: 'Liga no encontrada' });
    }
    const category = league.categories.find(c => c.id === categoryId);
    if (!category) {
      console.warn(`[API] Categoría no encontrada: ${categoryId}`);
      return res.json({ data: {}, message: 'Categoría no encontrada' });
    }
    const allTeams = await getAllTeamsFromMongo();
    const teams = allTeams.filter(t => t.leagueId === leagueId && t.categoryId === categoryId);
    const allSchedules = await getAllFixtureSchedulesFromMongo();
    const schedule = allSchedules.filter(s => s.leagueId === leagueId && s.categoryId === categoryId);
    type FixtureRound = { round: number, matches: { matchId: string }[] };
    const fixture: FixtureRound[] = [];
    for (const s of schedule) {
      let roundObj = fixture.find(r => r.round === s.round);
      if (!roundObj) {
        roundObj = { round: s.round, matches: [] };
        fixture.push(roundObj);
      }
      roundObj.matches.push({ matchId: s.matchId });
    }
    const allPlayed = await getAllPlayedMatchesFromMongo();
    const playedMatches = allPlayed.filter(m => m.leagueId === leagueId && m.categoryId === categoryId);
    const playedMatchIds = playedMatches.map(m => m.matchId);
    const allAwards = await getAllRoundAwardsFromMongo();
    const roundAwards = allAwards.filter(a => a.leagueId === leagueId && a.categoryId === categoryId);
    console.log(`[API] Fixture público: liga ${leagueId}, categoría ${categoryId}, equipos ${teams.length}, partidos ${playedMatches.length}`);
    res.json({
      data: {
        league: {
          id: league.id,
          name: league.name,
          country: league.country,
          season: league.season,
          slogan: league.slogan,
          themeColor: league.themeColor,
          backgroundImageUrl: league.backgroundImageUrl,
          logoUrl: league.logoUrl
        },
        category: {
          id: category.id,
          name: category.name
        },
        teams,
        fixture,
        schedule,
        playedMatchIds,
        playedMatches,
        roundAwards
      }
    });
  } catch (err) {
    console.error('[API] Error en /api/public/client/:clientId/leagues/:leagueId/fixture:', err);
    res.json({ data: {}, message: 'Error al obtener fixture público' });
  }
});
// Actualizar engagement de un partido público
app.post('/api/public/client/:clientId/matches/:matchId/engagement', async (req, res) => {
  try {
    const { clientId, matchId } = req.params;
    const { likes, visits } = req.body;
    const engagement = await getMatchEngagement(clientId, matchId);
    if (typeof likes === 'number') engagement.likes = likes;
    if (typeof visits === 'number') engagement.visits = visits;
    const updated = await saveMatchEngagement(clientId, matchId, { likes: engagement.likes, visits: engagement.visits });
    res.json({ data: updated });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar engagement de partido', error: String(err) });
  }
});

// Endpoint público robusto: engagement de un partido
app.get('/api/public/client/:clientId/matches/:matchId/engagement', async (req, res) => {
  try {
    const { clientId, matchId } = req.params;
    if (!matchId) {
      console.warn(`[API] Faltante matchId en engagement de partido público`);
      return res.json({ data: {}, message: 'Falta matchId' });
    }

    // Resolución de clientId (acepta slug o UUID)
    let resolvedClientId = clientId;
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    function normalize(str: string): string {
      return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[ -\u007f]/g, '')
        .replace(/[^a-z0-9]/g, '');
    }
    let user = null;
    if (!uuidRegex.test(clientId.trim())) {
      const usersCollection = await getUsersCollection();
      user = await usersCollection.findOne({ slug: clientId.trim() });
      if (!user) {
        const allUsers = await usersCollection.find({ role: 'client_admin', active: true }).toArray();
        user = allUsers.find(u => normalize(u.organizationName ?? '') === normalize(clientId)) || null;
      }
      if (user) {
        resolvedClientId = user.id;
        console.log(`[API] Cliente encontrado: ${user.organizationName} (${user.id})`);
      } else {
        console.warn(`[API] Cliente no encontrado para clientId: ${clientId}`);
        return res.json({ data: {}, message: 'Cliente no encontrado' });
      }
    }

    // Engagement de partido
    const engagement = await getMatchEngagement(resolvedClientId, matchId);
    console.log(`[API] Engagement público partido: cliente ${resolvedClientId}, matchId ${matchId}`);
    res.json({ data: engagement });
  } catch (err) {
    console.error('[API] Error en /api/public/client/:clientId/matches/:matchId/engagement:', err);
    res.json({ data: {}, message: 'Error al obtener engagement de partido' });
  }
});
// Actualizar engagement público de un cliente
app.post('/api/public/client/:clientId/engagement', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { action, delta } = req.body;
    const engagement = await getClientEngagement(clientId);
    if (!engagement) return res.status(404).json({ message: 'Engagement no encontrado' });
    if (action === 'visit') {
      engagement.visits += delta || 1;
    } else if (action === 'like') {
      engagement.likes += delta || 1;
    }
    const updated = await saveClientEngagement(clientId, { visits: engagement.visits, likes: engagement.likes });
    res.json({ data: updated });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar engagement público', error: String(err) });
  }
});
// Engagement público de un cliente
app.get('/api/public/client/:clientId/engagement', async (req, res) => {
  try {
    const { clientId } = req.params;
    const engagement = await getClientEngagement(clientId);
    res.json({ data: engagement });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener engagement público', error: String(err) });
  }
});
// Listar ligas públicas de un cliente
app.get('/api/public/client/:clientId/leagues', async (req, res) => {
  try {
    const { clientId } = req.params;
    let resolvedClientId = clientId;
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    function normalize(str: string): string {
      return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
    }
    let user = null;
    if (!uuidRegex.test(clientId.trim())) {
      const usersCollection = await getUsersCollection();
      user = await usersCollection.findOne({ slug: clientId.trim() });
      if (!user) {
        const allUsers = await usersCollection.find({ role: 'client_admin', active: true }).toArray();
        user = allUsers.find(u => normalize(u.organizationName ?? '') === normalize(clientId)) || null;
      }
      if (user) {
        resolvedClientId = user.id;
        console.log(`[API] Cliente encontrado: ${user.organizationName} (${user.id})`);
      } else {
        console.warn(`[API] Cliente no encontrado para clientId: ${clientId}`);
        return res.json({ data: [], message: 'Cliente no encontrado' });
      }
    }
    const allLeagues = await getAllLeaguesFromMongo();
    const leagues = allLeagues.filter(l => l.ownerUserId === resolvedClientId && l.active);
    console.log(`[API] Ligas encontradas para cliente ${resolvedClientId}: ${leagues.length}`);
    res.json({ data: leagues });
  } catch (err) {
    console.error('[API] Error en /api/public/client/:clientId/leagues:', err);
    // Siempre responder rápido para que el FE no quede esperando
    res.json({ data: [], message: 'Error al obtener ligas del cliente' });
  }
});
// Listar todas las ligas públicas
app.get('/api/public/leagues', async (req, res) => {
  try {
    const leagues = await getAllLeaguesFromMongo();
    res.json({ data: leagues });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener ligas públicas', error: String(err) });
  }
});
// Revocar un token de acceso de cliente
app.patch('/api/admin/client-access-tokens/:tokenId/revoke', async (req, res) => {
  try {
    const { tokenId } = req.params;
    const revokedAt = new Date().toISOString();
    await revokeClientAccessTokenInMongo(tokenId, revokedAt);
    res.json({ data: { id: tokenId, active: false, revokedAt } });
  } catch (err) {
    res.status(500).json({ message: 'Error al revocar token', error: String(err) });
  }
});
// Renovar expiración de un token de acceso de cliente
app.patch('/api/admin/client-access-tokens/:tokenId/renew', async (req, res) => {
  try {
    const { tokenId } = req.params;
    const { expiresAt } = req.body;
    if (!expiresAt) {
      return res.status(400).json({ message: 'Falta expiresAt' });
    }
    await renewClientAccessTokenInMongo(tokenId, expiresAt);
    res.json({ data: { id: tokenId, expiresAt, active: true } });
  } catch (err) {
    res.status(500).json({ message: 'Error al renovar token', error: String(err) });
  }
});
// Crear un nuevo token de acceso de cliente
app.post('/api/admin/client-access-tokens', async (req, res) => {
  try {
    const { clientUserId, expiresAt } = req.body;
    if (!clientUserId || !expiresAt) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }
    // Generar token y contraseña temporal
    const token = uuidv4();
    const temporaryPassword = Math.random().toString(36).slice(2, 10);
    const entry = {
      id: uuidv4(),
      clientUserId,
      token,
      expiresAt,
      active: true,
      createdAt: new Date().toISOString(),
    };
    await saveClientAccessTokenToMongo(entry);
    // Opcional: actualizar usuario con la contraseña temporal
    const users = await getAllUsersFromMongo();
    const user = users.find((u) => u.id === clientUserId);
    if (user) {
      user.password = temporaryPassword;
      user.mustChangePassword = true;
      await saveUserToMongo(user);
    }
    res.json({ data: { ...entry, temporaryPassword } });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear token de cliente', error: String(err) });
  }
});
// Listar todos los tokens de acceso de cliente
app.get('/api/admin/client-access-tokens', async (req, res) => {
  try {
    const tokens = await getAllClientAccessTokensFromMongo();
    res.json({ data: tokens });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener tokens de cliente', error: String(err) });
  }
});
// Obtener usuario client_admin específico
app.get('/api/admin/client-users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const users = await getAllUsersFromMongo();
    const user = users.find((u) => u.id === userId && u.role === 'client_admin');
    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    res.json({ data: user });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener usuario', error: String(err) });
  }
});
// Listar todos los usuarios client_admin
app.get('/api/admin/client-users', async (req, res) => {
  try {
    const users = await getAllUsersFromMongo();
    const clientUsers = users.filter((u) => u.role === 'client_admin');
    res.json({ data: clientUsers });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener client users', error: String(err) });
  }
});
// Regenerar contraseña temporal para client_admin
app.post('/api/admin/client-users/:userId/reset-temporary-password', async (req, res) => {
  try {
    const { userId } = req.params;
    const users = await getAllUsersFromMongo();
    const user = users.find((u) => u.id === userId && u.role === 'client_admin');
    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    // Generar nueva contraseña temporal
    const temporaryPassword = Math.random().toString(36).slice(2, 10);
    user.password = temporaryPassword;
    user.mustChangePassword = true;
    await saveUserToMongo(user);
    res.json({ data: { id: user.id, name: user.name, temporaryPassword, active: user.active } });
  } catch (err) {
    res.status(500).json({ message: 'Error al regenerar contraseña temporal', error: String(err) });
  }
});
// Actualizar usuario client_admin (asegura compatibilidad FE)
app.patch('/api/admin/client-users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, organizationName, email, active } = req.body;
    const users = await getAllUsersFromMongo();
    const user = users.find((u) => u.id === userId && u.role === 'client_admin');
    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    if (name !== undefined) user.name = name;
    if (organizationName !== undefined) user.organizationName = organizationName;
    if (email !== undefined) user.email = email;
    if (typeof active === 'boolean') user.active = active;
    await saveUserToMongo(user);
    res.json({ data: {
      id: user.id,
      name: user.name,
      organizationName: user.organizationName,
      email: user.email,
      role: user.role,
      active: user.active
    }});
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar cliente admin', error: String(err) });
  }
});
// Crear usuario client_admin
app.post('/api/admin/client-users', async (req, res) => {
  try {
    // Validar que req.body exista y sea objeto
    let body = req.body;
    if (!body || (typeof body !== 'object' && typeof body !== 'string')) {
      return res.status(400).json({
        message: 'No se recibió información del formulario. Verifica que el frontend envíe los datos como JSON.',
        code: 'NO_BODY',
      });
    }
    // Si el body viene como string (caso edge), intentar parsear
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          message: 'El formato de datos enviados no es válido (no es JSON).',
          code: 'INVALID_BODY',
        });
      }
    }
    const { name, organizationName, email, password } = body;
    // Validación básica
    if (!name || !organizationName || !email) {
      return res.status(400).json({
        message: 'Por favor completa todos los campos requeridos: nombre, empresa/liga y correo.',
        code: 'MISSING_FIELDS',
      });
    }
    const users = await getAllUsersFromMongo();
    if (users.some((u) => u.email === email)) {
      return res.status(409).json({
        message: 'Ya existe un usuario registrado con ese correo.',
        code: 'EMAIL_EXISTS',
      });
    }
    // Generar slug seguro para publicPortalPath
    const slug = organizationName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const newUser: AppUser = {
      id: (Math.random().toString(36).slice(2) + Date.now()),
      name,
      organizationName,
      email,
      password: password || '',
      role: 'client_admin',
      active: true,
      publicPortalPath: `/cliente/${slug}`,
      mustChangePassword: true,
    };
    try {
      await saveUserToMongo(newUser);
    } catch (mongoErr) {
      // Error técnico de base de datos
      const isSuperAdmin = req.headers['authorization'] && String(req.headers['authorization']).includes('super-admin');
      if (isSuperAdmin) {
        return res.status(500).json({
          message: 'Error técnico al guardar en base de datos',
          error: String(mongoErr),
          code: 'MONGO_ERROR',
        });
      } else {
        return res.status(500).json({
          message: 'No se pudo crear el cliente admin por un error interno. Por favor intenta más tarde o contacta soporte.',
          code: 'INTERNAL_ERROR',
        });
      }
    }
    res.json({ data: newUser });
  } catch (err) {
    // Error inesperado
    const isSuperAdmin = req.headers['authorization'] && String(req.headers['authorization']).includes('super-admin');
    if (isSuperAdmin) {
      res.status(500).json({
        message: 'Error técnico inesperado',
        error: String(err),
        code: 'UNEXPECTED_ERROR',
      });
    } else {
      res.status(500).json({
        message: 'No se pudo crear el cliente admin por un error inesperado. Intenta más tarde.',
        code: 'INTERNAL_ERROR',
      });
    }
  }
});
// Obtener todos los usuarios admin (super_admin y client_admin)
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await getAllUsersFromMongo();
    // El frontend espera un array de usuarios con sus ligas (puedes ajustar si necesitas incluir ligas)
    res.json({ data: users });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener usuarios', error: String(err) });
  }
});
// Logout de usuario (simple, solo responde ok)
app.post('/api/auth/logout', async (req, res) => {
  // El frontend solo espera confirmación, no es necesario invalidar token en este flujo
  res.json({ data: { ok: true } });
});
// Reset de password de cliente con accessToken
app.post('/api/auth/client/reset-password', async (req, res) => {
  try {
    const { accessToken, email, password, currentPassword } = req.body;
    if (!accessToken || !email || !password) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }
    // Validar accessToken
    const tokenDoc = await getClientAccessTokenByToken(accessToken);
    if (!tokenDoc || !tokenDoc.active) {
      return res.status(401).json({ message: 'Token inválido o revocado' });
    }
    if (tokenDoc.expiresAt && new Date(tokenDoc.expiresAt) < new Date()) {
      return res.status(401).json({ message: 'Token vencido' });
    }
    // Buscar usuario por email (insensible a mayúsculas/minúsculas y espacios)
    const users = await getAllUsersFromMongo();
    const inputEmail = (email || '').trim().toLowerCase();
    const user = users.find((u) => (u.email || '').trim().toLowerCase() === inputEmail && u.id === tokenDoc.clientUserId && u.active);
    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    // Si se envía currentPassword, validar que coincida
    if (currentPassword && user.password !== currentPassword) {
      return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    }
    // Actualizar password y quitar flag de cambio obligatorio
    user.password = password;
    user.mustChangePassword = false;
    await saveUserToMongo(user);
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(500).json({ message: 'Error al restablecer contraseña', error: String(err) });
  }
});
// Registro de cliente con accessToken

app.post('/api/auth/client/register', async (req, res) => {
  try {
    const { accessToken, fullName, organizationName, email, password } = req.body;
    if (!accessToken || !fullName || !organizationName || !email || !password) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }
    // Validar accessToken
    const tokenDoc = await getClientAccessTokenByToken(accessToken);
    if (!tokenDoc || !tokenDoc.active) {
      return res.status(401).json({ message: 'Token inválido o revocado' });
    }
    if (tokenDoc.expiresAt && new Date(tokenDoc.expiresAt) < new Date()) {
      return res.status(401).json({ message: 'Token vencido' });
    }
    // Verificar que el usuario no exista
    const users = await getAllUsersFromMongo();
    if (users.some((u: AppUser) => u.email === email)) {
      return res.status(409).json({ message: 'El email ya está registrado' });
    }
    // Crear usuario cliente
    const newUser: AppUser = {
      id: tokenDoc.clientUserId, // Asociar el id del token
      name: fullName,
      organizationName,
      email,
      password,
      role: 'client_admin',
      active: true,
    };
    // Guardar usuario en MongoDB
    await saveUserToMongo(newUser);
    // Recargar usuario para obtener publicPortalPath
    const usersReloaded = await getAllUsersFromMongo();
    const userWithPath = usersReloaded.find(u => u.id === newUser.id);
    res.json({ data: { token: newUser.id, user: userWithPath } });
  } catch (err) {
    res.status(500).json({ message: 'Error al registrar cliente', error: String(err) });
  }
});
// Cargar variables de entorno desde .env

/**
 * Inicializa la conexión y colecciones de MongoDB. Llama a connectMongo si es necesario.
 */
async function initializeDataStore() {
  if (typeof connectMongo === 'function') {
    await connectMongo();
  }
  // Aquí podrías crear índices o colecciones si es necesario
}

/**
 * Migra alineaciones de partidos jugados al nuevo formato si es necesario.
 * Devuelve el número de partidos migrados.
 */
async function migratePlayedMatchesLineups(): Promise<number> {
  // Aquí podrías recorrer todos los partidos jugados y actualizar alineaciones
  // Por ahora, solo retorna 0 (sin migraciones pendientes)
  return 0;
}


(async () => {
  try {
    await ensurePlayedMatchesIndexes();
    console.log('Índice { status: 1, matchId: 1 } en played_matches inicializado correctamente.');
  } catch (err) {
    console.error('Error al inicializar índice en played_matches:', err);
  }
})();

// --- SCHEMA y helpers para equipos ---

const createTeamSchema = z.object({
  name: z.string().min(2),
  categoryId: z.string().uuid(),
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
});

function normalizeTechnicalStaff(rawStaff: any) {
  if (!rawStaff) return undefined;
  const result: any = {};
  if (rawStaff.director && rawStaff.director.name) {
    result.director = { name: rawStaff.director.name };
    if (rawStaff.director.photoUrl) result.director.photoUrl = rawStaff.director.photoUrl;
  }
  if (rawStaff.assistant && rawStaff.assistant.name) {
    result.assistant = { name: rawStaff.assistant.name };
    if (rawStaff.assistant.photoUrl) result.assistant.photoUrl = rawStaff.assistant.photoUrl;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Helper para asegurar engagement público

// ...existing code...
// import { z } from 'zod'; // Eliminado duplicado

// Configuración de multer para upload de videos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB máximo
});


// Helpers y utilidades propias

// --- SCHEMAS ---
const publicEngagementUpdateSchema = z.object({
  action: z.enum(['visit', 'like']),
  delta: z.number().int().min(-1).max(1).optional(),
});

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

// Definir updateLeagueSchema (ajustar según necesidades reales)
// import { z } from 'zod'; // Eliminado duplicado
export const updateLeagueSchema = z.object({
  name: z.string().min(2).optional(),
  slug: z.string().min(2).optional(),
  country: z.string().min(2).optional(),
  season: z.string().min(2).optional(),
  slogan: z.string().optional(),
  themeColor: z.string().optional(),
  backgroundImageUrl: z.string().optional(),
  logoUrl: z.string().optional(),
  categories: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(2),
      rules: z.object({
        maxRegisteredPlayers: z.number().int().min(5).max(40).optional(),
      }).optional(),
    })
  ).optional(),
  active: z.boolean().optional(),
});

// ENDPOINTS FUNCIONALES PARA EL FRONTEND

// --- ENDPOINTS DE AUTENTICACIÓN Y USUARIOS (MongoDB real) ---
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, email, password, accessToken } = req.body;
    const users = await getAllUsersFromMongo();
    // Permitir login por identifier (email o name) o email
    const inputId = (identifier || email || '').trim().toLowerCase();
    const inputPassword = (password || '').trim();
    const user = users.find((u: any) => {
      const dbEmail = (u.email || '').trim().toLowerCase();
      const dbName = (u.name || '').trim().toLowerCase();
      const dbPassword = (u.password || '').trim();
      return (
        (dbEmail === inputId || dbName === inputId) &&
        dbPassword === inputPassword &&
        u.active === true
      );
    });
    if (!user) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }
    if (user.mustChangePassword) {
      return res.status(403).json({ code: 'MUST_CHANGE_PASSWORD', message: 'Debes cambiar tu contraseña antes de continuar.' });
    }
    res.json({ data: { token: user.id, user } });
  
  } catch (err) {
    res.status(500).json({ message: 'Error en login', error: String(err) });
  }
});

// Endpoint para obtener solo las ligas del usuario autenticado (client_admin)
  app.get('/api/admin/leagues', async (req, res) => {
    try {
      const auth = req.headers.authorization;
      if (!auth) return res.status(401).json({ message: 'No autenticado' });
      const userId = auth.replace('Bearer ', '');
      const users = await getAllUsersFromMongo();
      const user = users.find((u) => u.id === userId && u.active);
      if (!user) return res.status(401).json({ message: 'Usuario no encontrado' });
      // Si es client_admin, filtrar ligas por ownerUserId
      let leagues = [];
      if (user.role === 'client_admin') {
        leagues = await getLeaguesByClientId(user.id);
      } else {
        leagues = await getAllLeaguesFromMongo();
      }
      // Mapear ownerUserId a organizationName
      const userMap = new Map(users.map(u => [u.id, u.organizationName || u.name || '']));
      const leaguesWithOwner = leagues.map(l => ({
        ...l,
        ownerOrganizationName: userMap.get(l.ownerUserId) || l.ownerUserId
      }));
      res.json({ data: leaguesWithOwner });
    } catch (err) {
      res.status(500).json({ message: 'Error al obtener ligas', error: String(err) });
    }
  });

// Validar accessToken de cliente
app.post('/api/auth/client-token/validate', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ message: 'Falta accessToken' });
    }
    // Buscar el token en MongoDB
    const tokenDoc = await getClientAccessTokenByToken(accessToken);
    if (!tokenDoc || !tokenDoc.active) {
      return res.status(401).json({ message: 'Token inválido o revocado' });
    }
    // Validar expiración
    if (tokenDoc.expiresAt && new Date(tokenDoc.expiresAt) < new Date()) {
      return res.status(401).json({ message: 'Token vencido' });
    }
    // Buscar usuario cliente asociado
    const users = await getAllUsersFromMongo();
    const client = users.find((u: any) => u.id === tokenDoc.clientUserId && u.active);
    if (!client) {
      return res.status(404).json({ message: 'Cliente no encontrado' });
    }
    res.json({ data: { client: {
      id: client.id,
      name: client.name,
      organizationName: client.organizationName,
      email: client.email,
      role: client.role,
    }, expiresAt: tokenDoc.expiresAt } });
  } catch (err) {
    res.status(500).json({ message: 'Error al validar token', error: String(err) });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ message: 'No autenticado' });
    const userId = auth.replace('Bearer ', '');
    const users = await getAllUsersFromMongo();
    const user = users.find((u: { id: string; active: boolean }) => u.id === userId && u.active);
    if (!user) return res.status(401).json({ message: 'Usuario no encontrado' });
    res.json({ data: user });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener usuario', error: String(err) });
  }
});

// --- ENDPOINTS PÚBLICOS Y CLIENTE ---
app.get('/api/public/client/:clientId/matches/:matchId/engagement', async (req, res) => {
  try {
    const { clientId, matchId } = req.params;
    // Consulta engagement de partido en MongoDB
    const engagement = await getMatchEngagement(clientId, matchId);
    res.json({ data: engagement });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener engagement de partido', error: String(err) });
  }
});

app.post('/api/public/client/:clientId/matches/:matchId/engagement', async (req, res) => {
  try {
    const { clientId, matchId } = req.params;
    // Guarda engagement de partido en MongoDB
    const result = await saveMatchEngagement(clientId, matchId, req.body);
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar engagement de partido', error: String(err) });
  }
});

app.get('/api/public/client/:clientId/leagues/:leagueId/fixture', async (req, res) => {
  try {
    const { clientId, leagueId } = req.params;
    const { categoryId } = req.query;
    if (!categoryId) return res.status(400).json({ message: 'Falta categoryId' });

    // 1. Liga
    const allLeagues = await getAllLeaguesFromMongo();
    const league = allLeagues.find(l => l.id === leagueId);
    if (!league) return res.status(404).json({ message: 'Liga no encontrada' });

    // 2. Categoría
    const category = league.categories?.find(c => c.id === categoryId) || null;
    if (!category) return res.status(404).json({ message: 'Categoría no encontrada en la liga' });

    // 3. Equipos
    const allTeams = await getAllTeamsFromMongo();
    const teams = allTeams.filter(t => t.leagueId === leagueId && t.categoryId === categoryId);

    // 4. Fixture schedule
    const allSchedules = await getAllFixtureSchedulesFromMongo();
    const schedule = allSchedules.filter(s => s.leagueId === leagueId && s.categoryId === categoryId);

    // 5. Partidos jugados
    const allPlayedMatches = await getAllPlayedMatchesFromMongo();
    const playedMatches = allPlayedMatches.filter(m => m.leagueId === leagueId && m.categoryId === categoryId);
    const playedMatchIds = playedMatches.map(m => m.matchId);

    // 6. Premios de ronda
    const allRoundAwards = await getAllRoundAwardsFromMongo ? await getAllRoundAwardsFromMongo() : [];
    const roundAwards = allRoundAwards.filter(r => r.leagueId === leagueId && r.categoryId === categoryId);

    // 7. Fixture (estructura de rondas)
    // Si tienes una función para generar la estructura de rondas, úsala aquí. Si no, puedes dejarlo como schedule.
    // Por ahora, devolvemos el schedule como fixture.
    const fixture = schedule;

    res.json({
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
        fixture,
        schedule,
        playedMatchIds,
        playedMatches,
        roundAwards,
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener fixture', error: String(err) });
  }
});
app.get('/api/public/leagues', async (request, response) => {
  try {
    const leagues = await getAllLeaguesFromMongo();
    response.json({ data: leagues });
  } catch (err) {
    response.status(500).json({ message: 'Error al obtener ligas', error: String(err) });
  }
});

app.get('/api/public/client/:clientId/leagues', async (request, response) => {
  try {
    const { clientId } = request.params;
    const leagues = await getLeaguesByClientId(clientId);
    response.json({ data: leagues });
  } catch (err) {
    response.status(500).json({ message: 'Error al obtener ligas del cliente', error: String(err) });
  }
});

app.get('/api/public/client/:clientId/engagement', async (request, response) => {
  try {
    const { clientId } = request.params;
    const engagement = await getClientEngagement(clientId);
    response.json({ data: engagement });
  } catch (err) {
    response.status(500).json({ message: 'Error al obtener engagement', error: String(err) });
  }
});

app.post('/api/public/client/:clientId/engagement', async (request, response) => {
  try {
    const { clientId } = request.params;
    const result = await saveClientEngagement(clientId, request.body);
    response.json({ data: result });
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar engagement', error: String(err) });
  }
});

app.get('/api/public/client/:clientId/matches/:matchId/engagement', async (request, response) => {
  try {
    const { clientId, matchId } = request.params;
    const engagement = await getMatchEngagement(clientId, matchId);
    response.json({ data: engagement });
  } catch (err) {
    response.status(500).json({ message: 'Error al obtener engagement de partido', error: String(err) });
  }
});

app.post('/api/public/client/:clientId/matches/:matchId/engagement', async (request, response) => {
  try {
    const { clientId, matchId } = request.params;
    const result = await saveMatchEngagement(clientId, matchId, request.body);
    response.json({ data: result });
  } catch (err) {
    response.status(500).json({ message: 'Error al guardar engagement de partido', error: String(err) });
  }
});

app.get('/api/public/client/:clientId/leagues/:leagueId/fixture', async (request, response) => {
  try {
    const { clientId, leagueId } = request.params;
    const fixture = await getLeagueFixture(clientId, leagueId);
    response.json({ data: fixture });
  } catch (err) {
    response.status(500).json({ message: 'Error al obtener fixture', error: String(err) });
  }
});

// --- ENDPOINTS DE ADMINISTRACIÓN Y VIDEOS (MongoDB real) ---
// Aquí debes asegurarte de que cada endpoint de administración (equipos, ligas, videos, etc.) use funciones de acceso a MongoDB y nunca devuelva datos simulados ni vacíos.
// Ejemplo para equipos ya implementado abajo. Repite el patrón para el resto de recursos.

app.get('/api/public/client/:clientId/engagement', async (request: express.Request, response: express.Response) => {
  const clientId = request.params.clientId;
  const clientIdStr = Array.isArray(clientId) ? clientId[0] : clientId;
  if (!clientIdStr) {
    response.status(400).json({ message: 'clientId inválido' });
    return;
  }
  const mongo = await MongoClient.connect(process.env.MONGODB_URI!);
  const db = mongo.db(process.env.MONGODB_DB_NAME!);
  const collection = db.collection('public_engagement');
  const engagement = await ensurePublicEngagement(clientIdStr, collection);
  response.json({
    data: {
      clientId: clientIdStr,
      visits: engagement.visits,
      likes: engagement.likes,
      updatedAt: engagement.updatedAt,
    },
  });
  await mongo.close();
});

app.post('/api/public/client/:clientId/engagement', async (request: express.Request, response: express.Response) => {
  const clientId = request.params.clientId;
  const clientIdStr = Array.isArray(clientId) ? clientId[0] : clientId;
  if (!clientIdStr) {
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
  const engagement = await ensurePublicEngagement(clientIdStr, collection);
  if (parsed.data.action === 'visit') {
    engagement.visits += 1;
  } else {
    const delta = parsed.data.delta ?? 1;
    engagement.likes = Math.max(0, engagement.likes + delta);
  }
  engagement.updatedAt = new Date().toISOString();
  await collection.updateOne({ clientId: clientIdStr }, { $set: engagement }, { upsert: true });
  response.json({
    data: {
      clientId: clientIdStr,
      visits: engagement.visits,
      likes: engagement.likes,
      updatedAt: engagement.updatedAt,
    },
  });
  await mongo.close();
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
  const normalizedStaff: any = normalizeTechnicalStaff(cleanStaff);

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
});

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
    const normalizedStaff: any = normalizeTechnicalStaff(cleanStaff);
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

app.patch('/api/admin/leagues/:leagueId', async (request, response) => {
  const user = await requireAuth(request, response);
  if (!user) return;

  const allLeagues = await getAllLeaguesFromMongo();
  const leagueIndex = allLeagues.findIndex((item) => item.id === request.params.leagueId);
  if (leagueIndex === -1) {
    response.status(404).json({ message: 'Liga no encontrada' });
    return;
  }
  const currentLeague = allLeagues[leagueIndex];
  if (!currentLeague) {
    response.status(404).json({ message: 'Liga no encontrada' });
    return;
  }
  if (user.role !== 'super_admin' && currentLeague.ownerUserId !== user.id) {
    response.status(403).json({ message: 'No tienes acceso a esta liga' });
    return;
  }
  const parsed = updateLeagueSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: 'Payload inválido', errors: parsed.error.flatten() });
    return;
  }
  const payload = parsed.data;
  const nextSlug = payload.slug ?? currentLeague.slug;
  const nextSeason = payload.season ?? currentLeague.season;
  const duplicatedSlug = allLeagues.some(
    (league) => league.id !== currentLeague.id && league.slug === nextSlug && league.season === nextSeason,
  );
  if (duplicatedSlug) {
    response.status(409).json({ message: 'Ya existe una liga con ese slug para la misma temporada' });
    return;
  }
  const nextLeague = {
    ...currentLeague,
    name: payload.name ?? currentLeague.name,
    slug: payload.slug ?? currentLeague.slug,
    country: payload.country ?? currentLeague.country,
    season: typeof payload.season === 'string' ? Number(payload.season) : (payload.season ?? currentLeague.season),
    active: payload.active ?? currentLeague.active,
    categories: payload.categories
      ? payload.categories
          .map((catPayload) => {
            const original = currentLeague.categories.find(c => c.id === catPayload.id);
            if (!original) return null;
            return {
              id: catPayload.id,
              name: catPayload.name ?? original.name,
              minAge: original.minAge,
              maxAge: original.maxAge,
              rules: catPayload.rules ?? original.rules,
            };
          })
          .filter((c): c is typeof currentLeague.categories[number] => !!c)
      : currentLeague.categories,
    logoUrl: (payload.logoUrl !== undefined ? payload.logoUrl : currentLeague.logoUrl) || '',
    themeColor: (payload.themeColor !== undefined ? payload.themeColor : currentLeague.themeColor) || '',
    backgroundImageUrl: (payload.backgroundImageUrl !== undefined ? payload.backgroundImageUrl : currentLeague.backgroundImageUrl) || '',
    slogan: (payload.slogan !== undefined ? payload.slogan : currentLeague.slogan) || '',
  };
  await saveLeagueToMongo(nextLeague);
  response.json({ data: nextLeague });
});


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
    : null;

  const normalizedAwayLineup = parsed.data.awayLineup
    ? {
        starters: parsed.data.awayLineup.starters,
        substitutes: parsed.data.awayLineup.substitutes,
        ...(parsed.data.awayLineup.formationKey ? { formationKey: parsed.data.awayLineup.formationKey } : {}),
      }
    : null;

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
    highlightVideos: (parsed.data.highlightVideos || []).map((v: any) => ({ ...v, leagueId: parsed.data.leagueId })),
    playedAt: parsed.data.playedAt,
    status: 'finished' as const,
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
    leagueId: league.id,
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
    // El stub solo retorna el buffer original, mimetype estándar mp4
    const optimizedBuffer = await transcodeVideoIfPossible(file.buffer)
    const finalName = safeName.replace(/\.[^.]+$/, '').concat('.mp4')
    const uploadStream = bucket.openUploadStream(finalName, {
      metadata: {
        contentType: 'video/mp4',
        leagueId: league.id,
        categoryId: parsed.data.categoryId,
        matchId: match.matchId,
        uploadedBy: user.id,
      },
    })
    await new Promise<void>((resolve, reject) => {
      Readable.from(optimizedBuffer)
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
      leagueId: league.id,
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
}
)

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
      id: uuidv4(),
      name: category.name,
      minAge: category.minAge ?? 0,
      maxAge: category.maxAge ?? null,
      rules: category.rules,
    })),
  };

  await saveLeagueToMongo(league);
  response.json({ ok: true, data: league });
});

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
});

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

  // Si el partido está finalizado, persistir la alineación en el registro jugado
  const { liveMatchStore } = require('./live');
  const { savePlayedMatchToMongo } = require('./data');
  if (liveMatchStore.status === 'finished') {
    // Buscar el registro jugado correspondiente en MongoDB y actualizar la alineación
    // (Para simplificar, se guarda un nuevo registro jugado con la alineación actualizada)
    const matchRecord = {
      matchId: liveMatchStore.id,
      leagueId: liveMatchStore.leagueId || '',
      categoryId: liveMatchStore.categoryId || '',
      round: liveMatchStore.round || 0,
      finalMinute: liveMatchStore.timer ? Math.floor((liveMatchStore.timer.elapsedSeconds || 0) / 60) : 0,
      homeTeamName: liveMatchStore.homeTeam.name,
      awayTeamName: liveMatchStore.awayTeam.name,
      homeStats: liveMatchStore.homeTeam.stats,
      awayStats: liveMatchStore.awayTeam.stats,
      penaltyShootout: liveMatchStore.penaltyShootout,
      playerOfMatchId: liveMatchStore.playerOfMatchId,
      playerOfMatchName: liveMatchStore.playerOfMatchName,
      homeLineup: {
        starters: liveMatchStore.homeTeam.starters,
        substitutes: liveMatchStore.homeTeam.substitutes,
        formationKey: liveMatchStore.homeTeam.formationKey,
      },
      awayLineup: {
        starters: liveMatchStore.awayTeam.starters,
        substitutes: liveMatchStore.awayTeam.substitutes,
        formationKey: liveMatchStore.awayTeam.formationKey,
      },
      players: liveMatchStore.players || [],
      goals: liveMatchStore.goals || [],
      events: liveMatchStore.events || [],
      highlightVideos: liveMatchStore.highlightVideos || [],
      playedAt: liveMatchStore.playedAt || new Date().toISOString(),
    };
    savePlayedMatchToMongo(matchRecord).catch((err: any) => {
      console.error('Error guardando alineación en partido jugado:', err);
    });
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
});

// En producción, los eventos live:update se emiten por socket.io
// En desarrollo, se mantiene el stub/broadcastLive local


const startServer = async () => {
  await initializeDataStore();
  const migratedLineupsCount = await migratePlayedMatchesLineups();
  if (migratedLineupsCount > 0) {
    console.log(`Migración de lineups históricos completada: ${migratedLineupsCount} partidos actualizados.`);
  }
  httpServer.listen(port, () => {
    console.log(`FL Liga API corriendo en http://localhost:${port}`);
  });
};

startServer().catch((error) => {
    console.error('No se pudo iniciar FL Liga API:', error);
    process.exit(1);
});