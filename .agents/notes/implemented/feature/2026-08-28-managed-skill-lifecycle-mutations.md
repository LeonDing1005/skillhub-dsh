# Agent Note: Managed Skill lifecycle mutations

Status: implemented

English | [中文](2026-08-28-managed-skill-lifecycle-mutations.zh.md)

## Problem

Exact install gives a durable package and retry record, but a managed Skill also needs Host-controlled update, enable, disable, and uninstall operations before it can safely participate in Skill Center and provider flows. Those operations must survive caller retries and restarts without exposing Registry Instance URLs, credentials, source responses, Host paths, or local package paths to browser-bound results.

## Decision

`ManagedInstallationService` extends the exact-install operation log to every lifecycle mutation. Running records reserve one caller idempotency key and one exact package target before mutation starts. Completed records carry the operation kind, package target, completion time, and a safe replay result. A replay result contains only projected receipt fields or uninstall facts; source server and managed content location stay in verified store receipts read inside the Host.

Install and update are the only lifecycle operations that resolve remote release bytes. They use the caller-supplied Registry Instance identity and exact version, and reject resolver identity or version drift before admission. Enable and disable mutate only the verified receipt's `enabled` field. Uninstall deletes one exact package directory and stale operation records for the same target, while preserving its own completed uninstall record so retry after restart reports the same outcome without requiring a package receipt.

Update requires the `fromVersion` package to be installed, admits the target version through `ManagedSkillStore`, writes that target disabled first, disables the source version, then enables the target version. If enablement fails after changing the source receipt, the service restores the source enabled state and leaves the target disabled. The operation target key is the target version because the durable result is the newly installed active version; the caller supplies `fromVersion` so the source exact package can be disabled deliberately.

Startup recovery keeps the package verifier as the source of truth for installed content. It removes stale running records and dead target locks, keeps completed install, update, enable, and disable records only when their target receipt still verifies, and keeps completed uninstall records without a receipt. Recovery never reconstructs a lifecycle result from partial package data.

## Alternatives considered

**Represent enablement outside the receipt.** Rejected because the package receipt is the durable package state already verified during recovery. A second state file would add another commit point and make provider startup merge two authorities before any benefit exists.

**Keep stale completed records after uninstall and ignore them during recovery.** Rejected because each old install, update, enable, or disable record would need a tombstone or special lookup to prove why a missing receipt is valid. Removing same-target stale records during uninstall leaves one replayable operation fact for the absent package.

**Treat update as uninstall plus install.** Rejected because callers need one idempotent operation result for "move this identity to this exact version" and the previous version must be disabled only if the target package can be admitted. Separate operations would expose an intermediate state and make retry attribution ambiguous.

## Consequences

The Host library can now install, update, enable, disable, uninstall, replay, and recover exact managed packages without adding a browser, RPC, or `ctx.skills` contribution surface. The operation log format stores replay results, so old pre-release operation records are intentionally not compatible with this repository's no-compatibility pre-release stance.

Rollback remains a separate operation because choosing the previous target is policy, not package admission mechanics. Tombstones are deferred until a later caller needs an audit trail for removed packages beyond idempotent uninstall replay. The managed provider, Host/RPC methods, Skill Center controls, and assembled keyless Web flow remain later lifecycle steps.

Unit coverage pins enable/disable idempotent replay, uninstall replay after restart, stale operation cleanup for removed packages, update to an exact target version, previous-version disablement, and startup recovery of enabled state across versions.
