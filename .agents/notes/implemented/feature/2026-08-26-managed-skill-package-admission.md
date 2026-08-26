# Agent Note: Managed Skill package admission

Status: implemented

English | [中文](2026-08-26-managed-skill-package-admission.zh.md)

## Problem

Community catalog data is untrusted discovery metadata until a user explicitly installs an exact release. Later installation workflows need one Host-owned operation that can reject hostile ZIP structure, prove every extracted byte against Registry Instance metadata, and expose either a complete immutable package plus receipt or no package at all. Reusing an ordinary user skill directory would lose remote identity, exact-version provenance, and a reliable commit point.

## Decision

`@deepseek-ai/dsh-skill-installation` owns the admission operation without registering a Cordis service or skill provider. `ManagedSkillStore.admit()` accepts an already-resolved `ManagedSkillRelease`, applies deployment-owned compressed byte, expanded byte, and entry limits, and extracts below a unique directory inside the store's versioned private staging root.

The archive reader rejects traversal, non-portable Windows names, links, and special files before joining a host path, admits either a root package or one wrapper directory, and requires exactly one root `SKILL.md`. It hashes bytes while writing, compares the path-sorted file records with the Registry Instance manifest, and recomputes SkillHub's path-sorted fingerprint. `dsh-skill-filesystem` exports `parseSkillDocument()` so admission and local discovery use one frontmatter, name, and invocation-policy parser.

The store serializes admission with the existing cross-process file lock. A SHA-256 storage key derives from Registry Instance, namespace, slug, and exact version without exposing those values as filesystem names. The staged directory contains both `content/` and `receipt.json`; it first moves under a random private name beside committed packages, then content, receipt, and the package directory become read-only before a final same-parent rename commits publication. A failure before that rename removes the private package. Cancellation is checked during archive reads and immediately before both moves.

Receipts preserve remote identity, adapter, normalized source server, canonical name, exact version, verified file records, fingerprint, install time, enabled state, and managed content location. Durable reads validate those fields, their sorted manifest and fingerprint, the storage key, read-only real entries, and the complete content file and directory sets, sizes, and hashes. An identical identity/version request returns that verified receipt without decoding the supplied artifact; changed release metadata is an immutable-release conflict, while another remote identity using the same canonical name is a canonical-name conflict. A lock-release error after the admission operation completes emits a process warning without turning the committed result into a reported failure.

## Alternatives considered

**Install directly into an ordinary skill root.** Rejected because the filesystem provider owns user-authored discovery, not remote provenance, immutable versions, receipts, or atomic package publication. The broader product rationale remains in the [SkillHub-backed Skill Center proposal](../../proposed/feature/2026-08-24-skillhub-backed-skill-center.md).

**Implement ZIP parsing in repository code.** Rejected because `yauzl` provides maintained central-directory parsing, size validation, lazy entry reads, encryption and compression metadata, and stream extraction. The package adds the dsh-owned path, file-type, package-root, manifest, and identity policies around it.

**Freeze staging before moving it directly between storage parents.** Rejected because macOS denies moving a read-only directory from `staging/` into `packages/`. The private writable move enters `packages/` under a random non-release name; freezing and the final same-parent rename occur before the release key exists.

## Consequences

Later Host installation code can admit exact releases through one typed module and can distinguish policy rejection, integrity failure, identity conflict, corrupt storage, and commit failure. Tests cover root and wrapped packages, portable path attacks, exact and excessive archive limits, manifest and fingerprint drift, shared skill parsing, cancellation, atomic failure, durable receipt and content corruption, idempotent retry, and canonical-name ownership.

This package intentionally stops at admission. Artifact transport, Web controls, callable provider contribution, update, disable, uninstall, startup reconciliation, and crash-durable `fsync` policy remain with later installation lifecycle work. Filesystem modes provide practical accidental-write protection on POSIX systems, not a security barrier against the owning operating-system account.
