import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable deployment-owned identity for one configured Registry Instance. */
export type RegistryInstanceId = Branded<'RegistryInstanceId'>

/**
 * Construct a Registry Instance id after configuration validation.
 * @param value - validated deployment-owned identifier.
 * @returns branded Registry Instance id.
 */
export const registryInstanceId = (value: string): RegistryInstanceId => value as RegistryInstanceId

/** Immutable identity of one Community Skill release. */
export interface CommunitySkillIdentity {
  readonly registryInstanceId: RegistryInstanceId
  readonly namespace: string
  readonly slug: string
  readonly version: string
}

/** One normalized Community Skill card returned to dsh consumers. */
export interface CommunitySkillSummary {
  readonly identity: CommunitySkillIdentity
  readonly title: string
  readonly description: string
  readonly publisher: string
  readonly starCount: number
  readonly downloadCount: number
  readonly labels: readonly string[]
  readonly publishedAt?: string
  readonly isNew: boolean
}

/** One Registry Instance category visible in Community Skills. */
export interface CommunitySkillLabel {
  readonly slug: string
  readonly title: string
}

/** Inputs for one Community Skills page. */
export interface CommunitySkillListRequest {
  readonly query?: string
  readonly label?: string
  readonly page?: number
  readonly pageSize?: number
}

/** A normalized Community Skills page. */
export interface CommunitySkillPage {
  readonly items: readonly CommunitySkillSummary[]
  readonly labels: readonly CommunitySkillLabel[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}
