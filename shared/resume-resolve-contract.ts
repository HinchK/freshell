import { z } from 'zod'

export const ResumeResolveRequestSchema = z
  .object({
    input: z.string().min(1).max(20000),
  })
  .strict()

export const ResumeResolveMatchSchema = z.object({
  provider: z.string().min(1),
  sessionId: z.string().min(1),
  cwd: z.string().optional(),
  sessionType: z.string().optional(),
  title: z.string().optional(),
  firstUserMessage: z.string().optional(),
  lastActivityAt: z.number().int().nonnegative().optional(),
  matchKind: z.enum(['exact', 'prefix']),
})

export const ResumeResolveHintSchema = z.object({
  provider: z.string().min(1),
  source: z.enum(['command', 'word', 'id-shape']),
})

export const ResumeResolveResponseSchema = z.object({
  status: z.enum(['ready', 'warming']),
  matches: z.array(ResumeResolveMatchSchema),
  hint: ResumeResolveHintSchema.nullable(),
})

export type ResumeResolveRequest = z.infer<typeof ResumeResolveRequestSchema>
export type ResumeResolveMatch = z.infer<typeof ResumeResolveMatchSchema>
export type ResumeResolveResponse = z.infer<typeof ResumeResolveResponseSchema>
