/**
 * skills domain zod schemas (names derived from map keys: skillListRequestSchema /
 * skillListValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'
import type { CommunitySkillEntry, CommunitySkillLabelEntry, SkillEntry } from './skills.ts'

/** SkillEntry row of skill.list. */
export const skillEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  whenToUse: z.string().optional(),
  modelInvocable: z.boolean(),
}) satisfies z.ZodType<Wire<SkillEntry>>

/** skill.list request payload. */
export const skillListRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'skill.list'>>>

/** skill.list response value. */
export const skillListValueSchema = z.object({
  skills: z.array(skillEntrySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'skill.list'>>>

/** Stable Community Skill card; SkillHub-specific fields never enter this schema. */
export const skillCommunityEntrySchema = z.object({
  registryInstanceId: z.string().min(1),
  namespace: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
  title: z.string(),
  description: z.string(),
  publisher: z.string(),
  starCount: z.number().int().nonnegative(),
  downloadCount: z.number().int().nonnegative(),
  labels: z.array(z.string()),
  publishedAt: z.string().optional(),
  isNew: z.boolean(),
}) satisfies z.ZodType<Wire<CommunitySkillEntry>>

/** Community Skill filter label. */
export const skillCommunityLabelSchema = z.object({
  slug: z.string().min(1),
  title: z.string(),
}) satisfies z.ZodType<Wire<CommunitySkillLabelEntry>>

/** skill.communityList request payload. */
export const skillCommunityListRequestSchema = z.object({
  query: z.string().optional(),
  label: z.string().optional(),
  page: z.number().int().nonnegative().optional(),
  pageSize: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'skill.communityList'>>>

/** skill.communityList response value. */
export const skillCommunityListValueSchema = z.object({
  items: z.array(skillCommunityEntrySchema),
  labels: z.array(skillCommunityLabelSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
}) satisfies z.ZodType<Wire<ResponseValue<'skill.communityList'>>>
