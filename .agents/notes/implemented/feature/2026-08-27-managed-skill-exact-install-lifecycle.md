# Agent Note: Managed Skill exact install lifecycle

Status: implemented

English | [中文](2026-08-27-managed-skill-exact-install-lifecycle.zh.md)

## Problem

Admission alone proves that one downloaded archive can become an immutable package, but it does not define how a Host install request survives retries, process restart, or a partially completed transfer. The lifecycle owner needs to bind a user-confirmed exact Community Skill identity and version to one durable result without letting remote catalog drift, duplicate requests, or abandoned staging produce a callable or apparently installed package.

## Decision

`ManagedInstallationService` owns the first managed lifecycle operation above `ManagedSkillStore`: exact install. The Host caller supplies a Registry Instance identity, namespace, slug, exact version, and idempotency key. A Host-provided `ManagedSkillReleaseResolver` reacquires the release artifact and metadata for that exact target, and the service rejects identity or version drift before archive admission. Transport, authentication, and Registry Instance policy remain with the resolver; local package validation, receipt publication, operation recording, and recovery remain with `@deepseek-ai/dsh-skill-installation`.

Operation records live in `v1/operations/`, separate from package receipts. A running record is written before the resolver starts, so a restart can discard abandoned progress. A per-target owner-pid lock in `v1/operations/targets/` rejects same-target installs from another service instance while the owner is alive. A completed record is written only after `ManagedSkillStore.admit()` returns a verified durable receipt. The idempotency key names the operation; the package target key names the install fact. Reusing the same key for the same target replays a completed result across restart without calling the resolver, while reusing that key for another target fails as `IDEMPOTENCY_KEY_CONFLICT`. A different live key for the same target fails as `OPERATION_IN_PROGRESS`, preserving one writer per package identity/version.

Recovery creates the private roots, removes abandoned staging directories and `.admitting-*` package directories, validates complete package receipts and immutable content, deletes stale running operation records and dead target locks, and keeps only completed operation records whose target receipt still verifies. Recovery never promotes partial content, guesses at remote state, or reconstructs a completed operation from staging data. A corrupt completed operation record or corrupt package fails as typed corruption instead of being repaired.

`ManagedSkillStore.recover()` is intentionally useful on its own: it reconciles package storage without interpreting operation idempotency. The lifecycle service composes it and then reconciles operation records. This split lets enable, disable, update, rollback, and uninstall operations share the package verifier without treating every receipt read as an install operation replay.

Successful install results expose only a receipt projection safe for Host/RPC translation: source server and managed content path stay out of the result. Callers that need local paths use verified store receipts inside the Host. Resolver failures are reported as `RELEASE_UNAVAILABLE`, while a completed package whose idempotency record cannot be persisted fails as `OPERATION_RECORD_CORRUPT` instead of returning a success that cannot replay after restart.

## Alternatives considered

**Use receipts as idempotency records.** Rejected because a receipt is the installation fact, while an idempotency record belongs to one caller operation. Combining them would make a retry key indistinguishable from package state and would not record the difference between "this install completed" and "this package exists for another operation."

**Let concurrent installs converge through `ManagedSkillStore.admit()` alone.** Rejected because admission can return an existing identical receipt, but it cannot tell the caller whether another install operation is still resolving, validating, or committing. The lifecycle service rejects overlapping same-target operations before download and keeps the operation error model stable.

**Promote staged data during startup recovery.** Rejected because staging lacks a completed operation record and may exist before manifest, skill, receipt, mode, or final content verification. Recovery trusts only complete receipts and verified package trees.

## Consequences

Exact install has a durable retry point and a restart recovery rule without expanding the browser, RPC, or `ctx.skills` surfaces. Update, enable, disable, and uninstall reuse the same lifecycle record design in [the lifecycle mutation decision](2026-08-28-managed-skill-lifecycle-mutations.md); rollback, tombstones, provider contribution, and Skill Center mutation UI remain separate lifecycle steps.

Unit coverage pins successful exact install, safe result projection, post-restart idempotent replay, idempotency-key target conflict, live same-target operation rejection across service instances, failed resolver retry, remote release drift rejection, safe operation-record errors, and startup cleanup of staging, `.admitting-*`, stale running operation records, and dead target locks.
