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
  readonly sort?: string
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
  readonly freshness: 'fresh' | 'stale'
  readonly lastSuccessfulAt?: string
}

/** Exact Community Skill release identity accepted by detail and download surfaces. */
export interface CommunitySkillIdentityPayload {
  readonly registryInstanceId: string
  readonly namespace: string
  readonly slug: string
  readonly version: string
}

/** One exact release version available from the configured Registry Instance. */
export interface CommunitySkillVersionEntry {
  readonly version: string
  readonly publishedAt?: string
  readonly downloadAvailable: boolean
}

/** One file recorded in an exact Community Skill release. */
export interface CommunitySkillFileEntry {
  readonly path: string
  readonly size: number
  readonly contentType: string
  readonly sha256: string
}

/** Exact Community Skill release detail projected onto the dsh wire. */
export interface CommunitySkillDetailValue extends CommunitySkillIdentityPayload {
  readonly canonicalName: string
  readonly title: string
  readonly description: string
  readonly publisher: string
  readonly starCount: number
  readonly downloadCount: number
  readonly publishedAt?: string
  readonly examplePrompt?: string
  readonly skillMarkdown: string
  readonly versions: readonly CommunitySkillVersionEntry[]
  readonly files: readonly CommunitySkillFileEntry[]
  readonly installCommand: string
}

/** Safe projection of one managed installation; storage paths and source URLs stay Host-only. */
export interface ManagedSkillInstallationEntry extends CommunitySkillIdentityPayload {
  readonly canonicalName: string
  readonly enabled: boolean
  readonly installedAt: string
  readonly fingerprint: string
}
/** Safe list projection for managed installations. */
export interface ManagedSkillInstallationListValue { readonly items: readonly ManagedSkillInstallationEntry[] }
/** Identity and caller-owned retry key for a lifecycle mutation. */
export interface ManagedSkillInstallationMutationPayload extends CommunitySkillIdentityPayload { readonly idempotencyKey: string }

/** Browser-safe projection of one Host-resolved or installed Skill source. */
export interface SkillInventoryEntry {
  /** Managed identity fields; absent for unmanaged local/runtime rows. */
  readonly registryInstanceId?: string
  readonly namespace?: string
  readonly slug?: string
  readonly version?: string
  /** Stable invocation name. */
  readonly name: string
  /** Canonical package/skill name used for stable identity across sources. */
  readonly canonicalName: string
  /** Display title; local providers use the canonical name. */
  readonly title: string
  /** Human-readable description. */
  readonly description: string
  /** Publisher label when the source provides one. */
  readonly publisher: string
  /** Source bucket such as project, user, custom, bundled, runtime, or managed. */
  readonly source: string
  /** Provider identity that owns the candidate. */
  readonly provider: string
  /** Invocation policy at the candidate boundary. */
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  /** Whether this row belongs to the managed installation store. */
  readonly managed: boolean
  /** Whether the managed installation is enabled; unmanaged rows are always true. */
  readonly enabled: boolean
  /** Whether a durable managed installation owns this row. */
  readonly installed: boolean
  /** Whether this exact row currently wins resolution for the selected context. */
  readonly resolved: boolean
  /** Winning source/provider label when the name is currently resolved. */
  readonly resolvedSource?: string
  /** Relative, user-facing path for unmanaged local skills only. */
  readonly resolvedPath?: string
  /** Whether lifecycle mutation controls are unavailable for this row. */
  readonly readOnly: boolean
}

/** Session-addressed request for the complete Skill Inventory projection. */
export interface SkillInventoryListPayload { readonly sessionId: SessionId }
/** Complete Host projection of every source visible to the selected context. */
export interface SkillInventoryListValue { readonly items: readonly SkillInventoryEntry[] }

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
  /** Loads one exact Community Skill release from the configured Registry Instance. */
  communityGet(request: RpcRequest<CommunitySkillIdentityPayload>, signal?: AbortSignal): Promise<RpcResponse<CommunitySkillDetailValue>>
  installationList?(request: RpcRequest<Record<string, never>>, signal?: AbortSignal):
  Promise<RpcResponse<ManagedSkillInstallationListValue>>
  installationInstall?(request: RpcRequest<ManagedSkillInstallationMutationPayload>, signal?: AbortSignal):
  Promise<RpcResponse<ManagedSkillInstallationEntry>>
  installationUpdate?(request: RpcRequest<ManagedSkillInstallationMutationPayload & { fromVersion: string }>, signal?: AbortSignal):
  Promise<RpcResponse<ManagedSkillInstallationEntry>>
  installationSetEnabled?(request: RpcRequest<ManagedSkillInstallationMutationPayload & { enabled: boolean }>, signal?: AbortSignal):
  Promise<RpcResponse<ManagedSkillInstallationEntry>>
  installationUninstall?(request: RpcRequest<ManagedSkillInstallationMutationPayload>, signal?: AbortSignal):
  Promise<RpcResponse<{ removed: boolean }>>
  /** Lists all source candidates and the selected-context winner without exposing Host paths. */
  inventoryList?(request: RpcRequest<SkillInventoryListPayload>, signal?: AbortSignal):
  Promise<RpcResponse<SkillInventoryListValue>>
}
