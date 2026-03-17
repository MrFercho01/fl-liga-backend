import { Request, Response } from 'express';
import { usersStore, SUPER_ADMIN_USER_ID, AppUser } from './data';

/**
 * Middleware/Helper para autenticar usuario por header simple (X-User-Id).
 * Devuelve el usuario autenticado o responde 401 si no es válido.
 */
export function requireAuth(request: Request, response: Response): AppUser {
  const userId = request.header('x-user-id') || request.header('X-User-Id');
  if (typeof userId !== 'string' || !userId.trim()) {
    response.status(401).json({ error: 'No autenticado: falta X-User-Id' });
    throw new Error('No autenticado');
  }
  const user = usersStore.find(u => u.id === userId && u.active);
  if (!user) {
    response.status(401).json({ error: 'Usuario no encontrado o inactivo' });
    throw new Error('No autenticado');
  }
  return user;
}
