# @deepseek-ai/dsh-skill-installation

English | [中文](README.zh.md)

Host-only admission and immutable storage for exact Community Skill releases. This package validates downloaded ZIP bytes against Registry Instance metadata, writes verified content and a receipt below one private staging directory, and publishes both with a same-filesystem directory rename. It registers no Cordis service and does not contribute installed content to `ctx.skills`.

## API

```ts
import {
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
```

`ManagedSkillRelease` identifies one Registry Instance, namespace, slug, canonical skill name, and exact version. Its manifest contains the expected path, byte size, and lowercase SHA-256 for every file. `computeSkillHubFingerprint()` sorts those verified paths, hashes SkillHub's `path:sha256\n` sequence, and returns the prefixed release fingerprint.

## Admission and publication

Admission rejects absolute and parent-traversing paths, backslashes, Windows device and alternate-stream names, links and special files, duplicate portable paths, unsupported package roots, encrypted or unsupported entries, and configured archive limits. A package contains exactly one root `SKILL.md`, either directly or below one wrapper directory. The shared `dsh-skill-filesystem` parser validates that document, including its canonical name and invocation metadata.

Every extracted regular file must match the resolved manifest before publication. The store serializes admissions across processes, moves the staged package to a random private name beside committed packages, freezes its outer directory, and publishes `content/` and `receipt.json` together with one final directory rename. A pre-commit failure or cancellation removes the private package; the final rename is the commit point.

The receipt records the Registry Instance and remote identity, adapter and source server, canonical name, exact version, verified manifest, recomputed fingerprint, install time, enabled state, and managed content location. Before returning durable state, the store rejects linked or writable entries and verifies that the content file set, directory set, sizes, and hashes still match the receipt. Repeating the same identity and version with identical metadata returns that verified receipt without decoding replacement bytes. Metadata drift for an existing release and canonical-name ownership by another remote identity are typed conflicts. A writer-lock cleanup failure after commit emits a process warning while preserving the truthful successful result; the orphan lock requires operator removal before another admission can proceed.

`ManagedSkillAdmissionError.code` distinguishes invalid requests, archive and limit failures, manifest, fingerprint, skill, and identity failures, immutable-release and canonical-name conflicts, corrupt durable state, and commit failures. Callers may translate these codes for their own Host or wire API; messages contain operator-readable context but no credentials or package content.

## Model Experience

None, as this Host-only package admission module registers no provider, tool, prompt, or session event.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Admission only** — this package does not download artifacts, expose Web controls, register a callable skill provider, update or uninstall releases, or reconcile abandoned state after process failure.
- **Permission-based immutability** — committed files use read-only filesystem modes; Windows and filesystems that ignore POSIX mode bits provide weaker protection, and the owning operating-system account can deliberately restore write permission.
- **Atomic but not crash-durable** — publication uses a same-filesystem rename without `fsync`; a sudden system failure may require later reconciliation by the installation lifecycle owner.
