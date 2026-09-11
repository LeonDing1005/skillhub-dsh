# @deepseek-ai/dsh-skill-installation

English | [中文](README.zh.md)

Host-side admission, lifecycle operations, immutable storage, and the managed `ctx.skills` provider for Community Skill releases. This package validates downloaded ZIP bytes against Registry Instance metadata, writes verified content and a receipt below one private staging directory, publishes both with a same-filesystem directory rename, and records lifecycle operation results for idempotent Host retry. `ManagedSkillProvider` contributes only enabled, verified packages and keeps storage paths and source-server metadata internal.

## API

```ts
import {
  ManagedInstallationService,
  ManagedSkillStore,
  registryInstanceId,
  type ManagedSkillRelease,
} from '@deepseek-ai/dsh-skill-installation'

declare const release: ManagedSkillRelease

const store = new ManagedSkillStore({
  root: '/var/lib/dsh/managed-skills',
  limits: {
    maxCompressedBytes: 8 * 1024 * 1024,
    maxExpandedBytes: 32 * 1024 * 1024,
    maxEntryCount: 256,
  },
})

const registry = registryInstanceId('community-primary')
void registry
const receipt = await store.admit(release)

const service = new ManagedInstallationService({
  root: '/var/lib/dsh/managed-skills',
  limits: {
    maxCompressedBytes: 8 * 1024 * 1024,
    maxExpandedBytes: 32 * 1024 * 1024,
    maxEntryCount: 256,
  },
  resolver: {
    async resolve(request, signal) {
      void request
      void signal
      return release
    },
  },
})

const result = await service.install({
  identity: release.identity,
  version: release.version,
  idempotencyKey: 'host-generated-operation-id',
})
void result
```

`ManagedSkillRelease` identifies one Registry Instance, namespace, slug, canonical skill name, and exact version. Its manifest contains the expected path, byte size, and lowercase SHA-256 for every file. `computeSkillHubFingerprint()` sorts those verified paths, hashes SkillHub's `path:sha256\n` sequence, and returns the prefixed release fingerprint.

## Admission and publication

Admission rejects absolute and parent-traversing paths, backslashes, Windows device and alternate-stream names, links and special files, duplicate portable paths, unsupported package roots, encrypted or unsupported entries, and configured archive limits. A package contains exactly one root `SKILL.md`, either directly or below one wrapper directory. The shared `dsh-skill-filesystem` parser validates that document, including its canonical name and invocation metadata.

Every extracted regular file must match the resolved manifest before publication. The store serializes admissions across processes, moves the staged package to a random private name beside committed packages, freezes its outer directory, and publishes `content/` and `receipt.json` together with one final directory rename. A pre-commit failure or cancellation removes the private package; the final rename is the commit point.

The receipt records the Registry Instance and remote identity, adapter and source server, canonical name, exact version, verified manifest, recomputed fingerprint, install time, enabled state, and managed content location. Before returning durable state, the store rejects linked or writable entries and verifies that the content file set, directory set, sizes, and hashes still match the receipt. Repeating the same identity and version with identical metadata returns that verified receipt without decoding replacement bytes. Metadata drift for an existing release and canonical-name ownership by another remote identity are typed conflicts. A writer-lock cleanup failure after commit emits a process warning while preserving the truthful successful result; the orphan lock requires operator removal before another admission can proceed.

`ManagedSkillAdmissionError.code` distinguishes invalid requests, archive and limit failures, manifest, fingerprint, skill, and identity failures, immutable-release and canonical-name conflicts, release unavailability, in-progress operations, corrupt durable state, and commit failures. Callers may translate these codes for their own Host or wire API; messages contain operator-readable context but no credentials or package content.

## Lifecycle operations

`ManagedInstallationService` wraps `ManagedSkillStore` for Host lifecycle operations on exact Community Skill releases. The caller supplies the immutable Registry Instance identity, exact version, and idempotency key; install and update ask the `ManagedSkillReleaseResolver` to reacquire that same release and reject any identity or version drift before archive admission. The resolver owns transport and authentication; this package owns local validation, durable receipt publication, receipt enablement state, package removal, and operation replay.

Operation records live beside the package store under `v1/operations/`, separately from package receipts. A running record reserves the caller's idempotency key before the mutation starts, and a per-target owner-pid lock under `v1/operations/targets/` rejects same-target operations from another service instance while the owner is still alive. A completed record stores the package target key and the replayable result after the mutation has reached its durable point. Reusing the same idempotency key for the same operation and target returns the completed result after restart; reusing that key for another operation or target is an idempotency conflict. A different idempotency key for the same target is rejected with `OPERATION_IN_PROGRESS` while another lifecycle operation is live.

Install admits one exact release and returns a safe receipt projection. Update requires the requested source version to be installed, admits the requested target version, disables the source version, and enables the new version only after both package receipts can be written. Enable and disable mutate only the receipt's `enabled` field; uninstall removes one exact package and its stale operation records so recovery does not replay a removed package. Uninstall is idempotent for an absent package and reports `removed: false`.

Startup recovery creates the private roots, removes abandoned staging directories and `.admitting-*` package directories, validates complete receipts and immutable content, removes stale running operation records and dead target locks, and keeps only completed operation records whose package receipts still verify. Completed uninstall records are replayable without a package receipt. Recovery never promotes partial package data. Corrupt durable packages or completed operation records fail as typed corruption so the Host can stop exposing unsafe state instead of guessing. Successful lifecycle results return safe receipt projections that omit the source server and managed content path; callers that need local package paths read verified store receipts inside the Host.

## Model Experience

Enabled managed packages appear in the existing `ctx.skills` catalog and are loaded through the same skill tool and invocation paths as other providers. Disabled or uninstalled packages are absent; project and scoped runtime precedence remains owned by `dsh-skill`.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Host library only** — this package does not expose Web controls or translate lifecycle operations onto RPC. Host composition registers `ManagedSkillProvider` with `apply(ctx, service)`.
- **Permission-based immutability** — committed files use read-only filesystem modes; Windows and filesystems that ignore POSIX mode bits provide weaker protection, and the owning operating-system account can deliberately restore write permission.
- **Atomic but not crash-durable** — publication uses a same-filesystem rename without `fsync`; a sudden system failure may require later reconciliation by the installation lifecycle owner.
