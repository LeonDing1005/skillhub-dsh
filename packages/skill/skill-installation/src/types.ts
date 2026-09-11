import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable deployment-owned identity for one configured Registry Instance. */
export type RegistryInstanceId = Branded<'RegistryInstanceId'>

/** Immutable remote identity independent from its release version and display name. */
export interface CommunitySkillIdentity {
  readonly registryInstanceId: RegistryInstanceId
  readonly namespace: string
  readonly slug: string
}

/** One Registry Instance manifest entry expected in the downloaded package. */
export interface ExpectedSkillFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

/** Exact Community Skill release and downloaded ZIP bytes presented for admission. */
export interface ManagedSkillRelease {
  readonly identity: CommunitySkillIdentity
  readonly adapter: string
  readonly sourceServer: string
  readonly canonicalName: string
  readonly version: string
  readonly manifest: readonly ExpectedSkillFile[]
  readonly fingerprint: string
  readonly artifact: Uint8Array
}

/** Deployment-owned limits applied before a package can consume managed storage. */
export interface ManagedSkillAdmissionLimits {
  readonly maxCompressedBytes: number
  readonly maxExpandedBytes: number
  readonly maxEntryCount: number
}

/** Construction options for one managed-package storage root. */
export interface ManagedSkillStoreOptions {
  readonly root: string
  readonly limits: ManagedSkillAdmissionLimits
  readonly now?: () => Date
}

/** Exact install request supplied by a Host caller after user confirmation. */
export interface ManagedSkillInstallRequest {
  readonly identity: CommunitySkillIdentity
  readonly version: string
  readonly idempotencyKey: string
}

/** Host adapter that reacquires exact Community Skill releases for installation. */
export interface ManagedSkillReleaseResolver {
  /**
   * Resolve one exact Community Skill release and artifact.
   * @param request - exact remote identity and version requested by the caller.
   * @param signal - cancellation forwarded from the installation operation.
   * @returns exact release bytes and metadata for admission.
   */
  resolve(request: Pick<ManagedSkillInstallRequest, 'identity' | 'version'>, signal?: AbortSignal): Promise<ManagedSkillRelease>
}

/** Construction options for the Host-owned Managed Installation service. */
export interface ManagedInstallationServiceOptions extends ManagedSkillStoreOptions {
  readonly resolver: ManagedSkillReleaseResolver
}

/** Successful durable result for one managed install operation. */
export interface ManagedSkillInstallResult {
  readonly operation: 'install'
  readonly receipt: ManagedSkillInstallReceipt
}

/** Install-result receipt fields safe for Host/RPC projection. */
export type ManagedSkillInstallReceipt = Omit<ManagedSkillReceipt, 'sourceServer' | 'managedLocation'>

/** Verified file record persisted in a managed package receipt. */
export interface VerifiedSkillFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

/** Versioned receipt published atomically with one immutable package. */
export interface ManagedSkillReceipt {
  readonly formatVersion: 1
  readonly identity: CommunitySkillIdentity
  readonly adapter: string
  readonly sourceServer: string
  readonly canonicalName: string
  readonly version: string
  readonly manifest: readonly VerifiedSkillFile[]
  readonly fingerprint: string
  readonly installedAt: string
  readonly enabled: true
  readonly managedLocation: string
}

/** Typed managed-package admission failures suitable for later Host translation. */
export type ManagedSkillAdmissionErrorCode =
  | 'INVALID_REQUEST'
  | 'ARTIFACT_TOO_LARGE'
  | 'INVALID_ARCHIVE'
  | 'UNSAFE_ARCHIVE_PATH'
  | 'UNSAFE_ARCHIVE_ENTRY'
  | 'DUPLICATE_ARCHIVE_PATH'
  | 'UNSUPPORTED_PACKAGE_ROOT'
  | 'TOO_MANY_FILES'
  | 'EXPANDED_SIZE_EXCEEDED'
  | 'MANIFEST_MISMATCH'
  | 'FINGERPRINT_MISMATCH'
  | 'INVALID_SKILL'
  | 'IDENTITY_MISMATCH'
  | 'CANONICAL_NAME_CONFLICT'
  | 'IMMUTABLE_RELEASE_CONFLICT'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'RELEASE_UNAVAILABLE'
  | 'OPERATION_IN_PROGRESS'
  | 'OPERATION_RECORD_CORRUPT'
  | 'STORE_CORRUPT'
  | 'COMMIT_FAILED'
