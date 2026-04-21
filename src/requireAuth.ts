import { Request, Response } from 'express';
import { SUPER_ADMIN_USER_ID, AppUser } from './data';
import { getUsersCollection } from './data';

/**
 * Middleware/Helper para autenticar usuario por header simple (X-User-Id).
 * Devuelve el usuario autenticado o responde 401 si no es válido.
 */
export async function requireAuth(request: Request, response: Response): Promise<AppUser> {
  // Permitir autenticación por Authorization: Bearer <id> o X-User-Id
  let userId = '';
  const authHeader = request.header('authorization') || request.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    userId = authHeader.replace('Bearer ', '').trim();
  } else {
    userId = request.header('x-user-id') || request.header('X-User-Id') || '';
  }
  console.log('[requireAuth] userId extraído:', userId);
  if (!userId) {
    response.status(401).json({ code: 'NO_AUTH', error: 'No autenticado: falta token o X-User-Id' });
    throw new Error('No autenticado');
  }
  // Buscar usuario en MongoDB de forma eficiente
  const usersCollection = await getUsersCollection();
  const user = await usersCollection.findOne({ id: userId });
  // Validar usuario activo y posible expiración de sesión
  if (!user) {
    response.status(401).json({ code: 'NO_USER', error: 'Usuario no encontrado' });
    throw new Error('No autenticado');
  }
  if (!user.active) {
    response.status(401).json({ code: 'INACTIVE', error: 'Usuario inactivo' });
    throw new Error('Usuario inactivo');
  }
  // Si existe lastActiveAt y quieres forzar expiración de sesión, valida aquí:
  if (user.lastActiveAt) {
    const now = Date.now();
    const lastActive = new Date(user.lastActiveAt).getTime();
    const maxInactivity = 1000 * 60 * 60 * 8; // 8 horas de inactividad
    if (now - lastActive > maxInactivity) {
      response.status(401).json({ code: 'SESSION_EXPIRED', error: 'Sesión expirada por inactividad' });
      throw new Error('Sesión expirada');
    }
  }
  // Si todo OK, actualizar lastActiveAt (opcional, si quieres mantener la sesión viva)
  try {
    await usersCollection.updateOne({ id: userId }, { $set: { lastActiveAt: new Date().toISOString() } });
  } catch (e) {
    console.warn('[requireAuth] No se pudo actualizar lastActiveAt:', e);
  }
  console.log('[requireAuth] Resultado búsqueda usuario:', user ? 'OK' : 'NO ENCONTRADO');
  return user;
}
