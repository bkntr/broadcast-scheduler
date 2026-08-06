import { z } from 'zod'

export const scheduleInputSchema = z.object({
  cadence: z.enum(['daily', 'weekly', 'weekdays']),
  periods: z.number().int().min(1).max(366),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(24),
  weekdays: z.array(z.number().int().min(1).max(7)),
  timeZone: z.string().min(1).max(100),
  locale: z.enum(['en', 'fr']),
  dateStyle: z.enum(['short', 'medium', 'long']),
  timeStyle: z.enum(['24h', '12h']),
  titleTemplate: z.string().min(1).max(200),
  descriptionTemplate: z.string().max(10000),
  startingSession: z.number().int().min(0).max(999999),
  privacy: z.enum(['private', 'unlisted', 'public', 'public-at-start']),
  playlistId: z.string().max(200).optional(),
  customPlaylistId: z.string().max(200).optional(),
  thumbnailPath: z.string().max(4096).optional(),
  sharedStreamKey: z.boolean(),
  rotateStreamKey: z.boolean(),
  autoStart: z.boolean(),
  autoStop: z.boolean(),
  madeForKids: z.boolean()
})

export const settingsSchema = z.object({
  locale: z.enum(['en', 'fr']),
  theme: z.enum(['system', 'light', 'dark']),
  selectedChannelId: z.string().optional(),
  lastSchedule: scheduleInputSchema.partial().optional()
})

export const batchStartSchema = z.object({
  input: scheduleInputSchema,
  excludedIds: z.array(z.string()).max(10000)
})
