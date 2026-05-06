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

export const categoryRuleSchema = z.object({
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
  seriesCount: z.union([z.literal(3), z.literal(5)]).optional(),
  walkoversGoalDiff: z.number().int().min(0).max(99).optional(),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(2),
  minAge: z.number().int().min(5),
  maxAge: z.number().int().min(5).nullable().default(null),
  rules: categoryRuleSchema.optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().trim().min(2).optional(),
  minAge: z.number().int().min(5).optional(),
  maxAge: z.number().int().min(5).nullable().optional(),
  rules: categoryRuleSchema.optional(),
}).refine((payload) => Object.keys(payload).length > 0, {
  message: 'Debes enviar al menos un campo para actualizar',
});

// ─── Knockout schemas ───────────────────────────────────────────────────────

export const knockoutTeamEntrySchema = z.object({
  teamId: z.string().uuid(),
  teamName: z.string().min(1),
  position: z.number().int().min(1),
})

export const createKnockoutSchema = z.object({
  format: z.enum(['final_2', 'semi_4', 'quarter_8', 'r16_16', 'r32_32']),
  seedingMethod: z.enum(['intelligent', 'random']),
  qualifiedTeams: z.array(knockoutTeamEntrySchema).min(2).max(32),
})

export const knockoutResultSchema = z.object({
  knockoutMatchId: z.string().uuid(),
  /** 1 = ida (primera pierna), 2 = vuelta (segunda pierna). Para partidos de una sola pierna omitir o pasar 1. */
  leg: z.union([z.literal(1), z.literal(2)]).optional().default(1),
  /** Requerido solo en pierna única o segunda pierna (vuelta). */
  winnerId: z.string().uuid().optional(),
  winnerName: z.string().min(1).optional(),
  homeGoals: z.number().int().min(0),
  awayGoals: z.number().int().min(0),
  penaltyHome: z.number().int().min(0).nullable().optional(),
  penaltyAway: z.number().int().min(0).nullable().optional(),
})
