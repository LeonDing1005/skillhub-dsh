/**
 * skills domain zod schemas (names derived from map keys: skillListRequestSchema /
 * skillListValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'
import type {
  CommunitySkillDetailValue, CommunitySkillEntry, CommunitySkillFileEntry,
  CommunitySkillIdentityPayload, CommunitySkillLabelEntry, CommunitySkillVersionEntry, SkillEntry,
  SkillInventoryEntry,
} from './skills.ts'

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

const skillCommunityIdentityShape = {
  registryInstanceId: z.string().min(1),
  namespace: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
}

/** Stable Community Skill card; SkillHub-specific fields never enter this schema. */
export const skillCommunityEntrySchema = z.object({
  ...skillCommunityIdentityShape,
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
  sort: z.string().optional(),
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
  freshness: z.union([z.literal('fresh'), z.literal('stale')]),
  lastSuccessfulAt: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'skill.communityList'>>>

/** Exact Community Skill release identity. */
export const skillCommunityIdentitySchema = z.object({
  ...skillCommunityIdentityShape,
}) satisfies z.ZodType<Wire<CommunitySkillIdentityPayload>>

const skillCommunityVersionSchema = z.object({
  version: z.string().min(1),
  publishedAt: z.string().optional(),
  downloadAvailable: z.boolean(),
}) satisfies z.ZodType<Wire<CommunitySkillVersionEntry>>

const skillCommunityFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  sha256: z.string(),
}) satisfies z.ZodType<Wire<CommunitySkillFileEntry>>

/** skill.communityGet request payload. */
export const skillCommunityGetRequestSchema = skillCommunityIdentitySchema satisfies z.ZodType<Wire<RequestPayload<'skill.communityGet'>>>

/** skill.communityGet response value. */
export const skillCommunityGetValueSchema = skillCommunityIdentitySchema.extend({
  canonicalName: z.string().min(1),
  title: z.string(),
  description: z.string(),
  publisher: z.string(),
  starCount: z.number().int().nonnegative(),
  downloadCount: z.number().int().nonnegative(),
  publishedAt: z.string().optional(),
  examplePrompt: z.string().optional(),
  skillMarkdown: z.string(),
  versions: z.array(skillCommunityVersionSchema),
  files: z.array(skillCommunityFileSchema),
  installCommand: z.string(),
}) satisfies z.ZodType<Wire<CommunitySkillDetailValue>>

const managedInstallationEntrySchema = skillCommunityIdentitySchema.extend({
  canonicalName: z.string().min(1),
  enabled: z.boolean(),
  installedAt: z.string(),
  fingerprint: z.string(),
})
/** skill.installationList request payload. */
export const skillInstallationListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'skill.installationList'>>>
/** skill.installationList response value. */
export const skillInstallationListValueSchema = z.object({ items: z.array(managedInstallationEntrySchema) }) satisfies z.ZodType<Wire<ResponseValue<'skill.installationList'>>>
const skillInstallationMutationSchema = skillCommunityIdentitySchema.extend({ idempotencyKey: z.string().min(1) })
/** skill.installationInstall request payload. */
export const skillInstallationInstallRequestSchema = skillInstallationMutationSchema satisfies z.ZodType<Wire<RequestPayload<'skill.installationInstall'>>>
/** skill.installationInstall response value. */
export const skillInstallationInstallValueSchema = managedInstallationEntrySchema satisfies z.ZodType<Wire<ResponseValue<'skill.installationInstall'>>>
/** skill.installationUpdate request payload. */
export const skillInstallationUpdateRequestSchema = skillInstallationMutationSchema.extend({ fromVersion: z.string().min(1) }) satisfies z.ZodType<Wire<RequestPayload<'skill.installationUpdate'>>>
/** skill.installationUpdate response value. */
export const skillInstallationUpdateValueSchema = managedInstallationEntrySchema satisfies z.ZodType<Wire<ResponseValue<'skill.installationUpdate'>>>
/** skill.installationSetEnabled request payload. */
export const skillInstallationSetEnabledRequestSchema = skillInstallationMutationSchema.extend({ enabled: z.boolean() }) satisfies z.ZodType<Wire<RequestPayload<'skill.installationSetEnabled'>>>
/** skill.installationSetEnabled response value. */
export const skillInstallationSetEnabledValueSchema = managedInstallationEntrySchema satisfies z.ZodType<Wire<ResponseValue<'skill.installationSetEnabled'>>>
/** skill.installationUninstall request payload. */
export const skillInstallationUninstallRequestSchema = skillInstallationMutationSchema satisfies z.ZodType<Wire<RequestPayload<'skill.installationUninstall'>>>
/** skill.installationUninstall response value. */
export const skillInstallationUninstallValueSchema = z.object({ removed: z.boolean() }) satisfies z.ZodType<Wire<ResponseValue<'skill.installationUninstall'>>>

const skillInventoryEntrySchema = z.object({
  registryInstanceId: z.string().optional(),
  namespace: z.string().optional(),
  slug: z.string().optional(),
  version: z.string().optional(),
  name: z.string().min(1),
  canonicalName: z.string().min(1),
  title: z.string(),
  description: z.string(),
  publisher: z.string(),
  source: z.string().min(1),
  provider: z.string().min(1),
  invocation: z.object({ modelInvocable: z.boolean(), userInvocable: z.boolean() }),
  managed: z.boolean(),
  enabled: z.boolean(),
  installed: z.boolean(),
  resolved: z.boolean(),
  resolvedSource: z.string().optional(),
  resolvedPath: z.string().optional(),
  readOnly: z.boolean(),
}) satisfies z.ZodType<Wire<SkillInventoryEntry>>
/** skill.inventoryList request payload. */
export const skillInventoryListRequestSchema = z.object({ sessionId: sessionIdSchema }) satisfies z.ZodType<Wire<RequestPayload<'skill.inventoryList'>>>
/** skill.inventoryList response value. */
export const skillInventoryListValueSchema = z.object({ items: z.array(skillInventoryEntrySchema) }) satisfies z.ZodType<Wire<ResponseValue<'skill.inventoryList'>>>
