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
  | 'STORE_CORRUPT'
  | 'COMMIT_FAILED'
