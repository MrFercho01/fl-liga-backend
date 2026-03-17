import { z } from 'zod';

export const createTeamSchema = z.object({
  name: z.string().min(2),
  leagueId: z.string().uuid(),
  categoryId: z.string().uuid(),
  logoUrl: z.string().url().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  technicalStaff: z.object({
    director: z.object({ name: z.string(), photoUrl: z.string().optional() }).optional(),
    assistant: z.object({ name: z.string(), photoUrl: z.string().optional() }).optional(),
  }).optional(),
  players: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    nickname: z.string().optional(),
    age: z.number().int().min(10),
    number: z.number().int().min(1),
    position: z.string(),
    photoUrl: z.string().optional(),
    registrationStatus: z.enum(['pending', 'registered']).optional(),
  })),
});
