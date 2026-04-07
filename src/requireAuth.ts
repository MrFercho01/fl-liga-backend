import { Request, Response } from 'express';
import { SUPER_ADMIN_USER_ID, AppUser } from './data';
import { Collection } from 'mongodb';
import { getAllUsersFromMongo } from './data';

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
  if (!userId) {
    response.status(401).json({ error: 'No autenticado: falta token o X-User-Id' });
    throw new Error('No autenticado');
  }
  // Buscar usuario en MongoDB
  const users = await getAllUsersFromMongo();
  const user = users.find(u => u.id === userId && u.active);
  if (!user) {
    response.status(401).json({ error: 'Usuario no encontrado o inactivo' });
    throw new Error('No autenticado');
  }
  return user;
}
