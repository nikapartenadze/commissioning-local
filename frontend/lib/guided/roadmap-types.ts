import { z } from 'zod'

export const RoadmapStepSchema = z.object({
  order: z.number().int().min(1),
  kind: z.enum(['device', 'io']),
  deviceName: z.string().min(1).max(120),
  ioName: z.string().min(1).max(120).optional(),
  instructionText: z.string().min(1).max(500),
  transitText: z.string().max(200).optional(),
}).refine(
  s => s.kind === 'device' || (s.kind === 'io' && !!s.ioName),
  { message: 'ioName is required when kind === "io"', path: ['ioName'] },
)

export type RoadmapStep = z.infer<typeof RoadmapStepSchema>

export const RoadmapPathSegmentSchema = z.object({
  fromStep: z.number().int().min(1).optional(),
  toStep: z.number().int().min(1).optional(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
  style: z.enum(['arrow', 'dashed']).optional(),
})

export const RoadmapPathSchema = z.object({
  segments: z.array(RoadmapPathSegmentSchema),
})

export type RoadmapPath = z.infer<typeof RoadmapPathSchema>

export const RoadmapSchema = z.object({
  id: z.number().int().positive(),
  projectId: z.number().int().positive(),
  mcm: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  stepsJson: z.array(RoadmapStepSchema),
  pathJson: RoadmapPathSchema.nullable().optional(),
  isPublished: z.boolean(),
  updatedAt: z.string().optional(),
})

export type Roadmap = z.infer<typeof RoadmapSchema>
