# Agent Note: Managed Skill Provider

English | [中文](2026-08-29-managed-skill-provider.zh.md)

The managed installation package now exports `ManagedSkillProvider` and `apply(ctx, service)`. The provider lists only receipts whose `enabled` flag is true and loads the verified `content/SKILL.md` through the shared filesystem parser. Candidates use a managed rank below bundled skills and an opaque resource base; source-server metadata and host paths never enter `SkillCandidate` or `SkillDefinition`.

`ManagedInstallationService.onChange()` is the invalidation seam. Lifecycle operations notify listeners only after their completed operation record is durable, allowing `ctx.skills` to invalidate its catalog without exposing lifecycle internals to consumers. Host composition remains responsible for constructing the service and registering the provider; RPC and Web wiring are deferred to later tickets.

## Consequences

- Disabled and uninstalled packages disappear from both model-facing and user-facing skill catalogs after `skills/change` invalidation.
- Existing registry precedence remains authoritative; managed rank is 550, so project and user roots retain their documented ordering while bundled skills remain stronger.
- Provider failures are handled by the existing registry discovery policy and do not expose private receipt fields.
