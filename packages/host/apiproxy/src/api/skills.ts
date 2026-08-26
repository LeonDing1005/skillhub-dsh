/**
 * skills domain contract: read-only skill catalog lookup addressed by session.
 * The session's header cwd resolves to the canonical project root host-side —
 * the client never submits a raw path, and skill lookup never creates or
 * resumes an Agent.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Skill catalog row (wire projection of the host SkillSummary; provider/source vocabulary stays host-side). */
export interface SkillEntry {
  /** Kebab-case identifier the user references as `/name` in the composer. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** False marks a user-only skill (`disable-model-invocation`): invocable here, absent from the model catalog. */
  readonly modelInvocable: boolean
}

/** Stable Community Skill identity and card fields owned by the dsh wire. */
export interface CommunitySkillEntry {
  readonly registryInstanceId: string
  readonly namespace: string
  readonly slug: string
  readonly version: string
  readonly title: string
  readonly description: string
  readonly publisher: string
  readonly starCount: number
  readonly downloadCount: number
  readonly labels: readonly string[]
  readonly publishedAt?: string
  readonly isNew: boolean
}

/** One Community Skills filter label. */
export interface CommunitySkillLabelEntry {
  readonly slug: string
  readonly title: string
}

/** Browser-owned filters and pagination for the public catalog. */
export interface CommunitySkillListPayload {
  readonly query?: string
  readonly label?: string
  readonly page?: number
  readonly pageSize?: number
}

/** One page of Community Skills projected for native clients. */
export interface CommunitySkillListValue {
  readonly items: readonly CommunitySkillEntry[]
  readonly labels: readonly CommunitySkillLabelEntry[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

/**
 * Skill-domain unary methods (the map key skill.* of RpcMethodMap). Listing
 * is the domain's only RPC: invocation itself is a plain `session.prompt`
 * whose leading `/name` token the host recognizes at the pre-step boundary
 * (`dsh-tool-skill` injects the rendered body there), so every client shares
 * one deterministic path with no dedicated invocation wire.
 */
export interface SkillsApi {
  /** Lists the user-invocable skill catalog for the session's project. */
  list(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ skills: readonly SkillEntry[] }>>
  /** Lists normalized discovery-only entries from the configured Community Registry Instance. */
  communityList(request: RpcRequest<CommunitySkillListPayload>, signal?: AbortSignal): Promise<RpcResponse<CommunitySkillListValue>>
}
