# Agent Note: Managed Skill Provider

Status: implemented

English | [中文](2026-08-29-managed-skill-provider.zh.md)

## Problem

Managed Community Skill packages need to participate in the model-facing skill registry without exposing receipts, source-server metadata, or Host storage paths to consumers.

## Decision

The managed installation package exports `ManagedSkillProvider` and `apply(ctx, service)`. The provider lists only receipts whose `enabled` flag is true, parses each committed `content/SKILL.md` through the shared filesystem parser, and carries its description, optional `whenToUse`, invocation policy, metadata, and opaque resource base into the registry candidate. Loading rechecks the current enabled receipt before reading the candidate, so a stale candidate cannot load a disabled or removed package. Candidates use a managed rank below bundled skills; source-server metadata and Host paths never enter `SkillCandidate` or `SkillDefinition`.

`ManagedInstallationService.onChange()` is the invalidation seam. Lifecycle operations notify listeners only after their completed operation record is durable, allowing `ctx.skills` to invalidate its catalog without exposing lifecycle internals to consumers. Host composition remains responsible for constructing the service and registering the provider; RPC and Web wiring remain outside this package.

## Alternatives considered

**Expose managed receipts directly to the registry.** Rejected because registry consumers would depend on Host-only storage and remote metadata instead of the verified skill document.

**Let the provider poll the installation store.** Rejected because polling can expose stale catalogs; durable-change notifications give the registry an explicit invalidation point.

## Consequences

- Disabled and uninstalled packages disappear from both model-facing and user-facing skill catalogs after `skills/change` invalidation, and stale candidates fail at the provider load step.
- Existing registry precedence remains authoritative; managed rank is 550, so project and user roots retain their documented ordering while bundled skills remain stronger.
- Provider failures are handled by the existing registry discovery policy and do not expose private receipt fields.
- A receipt or document read failure returns an incomplete provider observation, so `ctx.skills.snapshot().complete` makes a partial catalog explicit and keeps the next request eligible for retry.
