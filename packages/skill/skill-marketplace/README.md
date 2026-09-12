# @deepseek-ai/dsh-skill-marketplace

English | [中文](README.zh.md)

Host-only Community Skills discovery service. One configured SkillHub endpoint is identified by an independent `registryInstanceId`; the adapter validates the deployed response fields and normalizes namespace, slug, title, description, publisher, exact version, stars, downloads, labels, and trustworthy publication time into `ctx.skillMarketplace`.

## Config

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | SkillHub Registry Instance HTTP origin. |
| `registryInstanceId` | required | Stable opaque identity attached to every normalized entry. |
| `pageSizeLimit` | `20` | Maximum accepted page size. |
| `freshTtlMs` | `300000` | Time that a successful query result is returned without contacting SkillHub. |
| `staleTtlMs` | `86400000` | Maximum age of a successful result that may be returned after an upstream failure. |
| `rateLimitRetries` | `3` | Maximum local retries after HTTP 429; accepts `0` through `10`. |
| `rateLimitBackoffMs` | `250` | Initial delay for exponential HTTP 429 retry backoff; the largest scheduled delay must fit the Host timer range. |
| `skillMarkdownMaxBytes` | `1048576` | Maximum UTF-8 bytes accepted from an exact release `SKILL.md`. |
| `versionCountLimit` | `1000` | Maximum published versions accepted while loading one exact release detail. |
| `zipDirectoryMaxBytes` | `4194304` | Maximum central-directory bytes retained while verifying an exact release ZIP. |

List calls support query, label, sort, zero-based page, and page size. Those fields form the cache key. The adapter enriches list rows with the exact version detail required by the deployed SkillHub API, rejects malformed or mismatched responses, preserves caller cancellation, and marks an entry New only when its valid `publishedAt` falls within the preceding seven days on the Host clock. Missing, invalid, future, or older times are not New.

A successful entry is fresh until `freshTtlMs`. After that point, an upstream availability failure returns the last successful value as stale until `staleTtlMs`; an older entry fails with `SKILL_MARKETPLACE_UNAVAILABLE`. Invalid Registry responses fail directly so cached data cannot hide an incompatible deployed API. HTTP 429 responses use bounded local exponential backoff and do not accept upstream `Retry-After` values as Host scheduling instructions.

`get(identity)` inspects one exact release by combining SkillHub detail, every version page up to `versionCountLimit`, exact-version metadata, files, byte-bounded raw `SKILL.md`, and `resolve` responses. Every returned value is dsh-owned, every response identity must match, CLI command tokens must be safe identifiers, and `examplePrompt` is present only for a string `metadata.examplePrompt`. `download(identity)` repeats exact-version metadata and resolve verification, then streams the exact archive while verifying every central entry and local-header reference plus each recorded file size and SHA-256. Central-directory retention is bounded by `zipDirectoryMaxBytes`. The Host names the response from the canonical skill name and version. Neither operation installs or registers the release.

This service never registers entries on `ctx.skills`. It provides discovery data only; no Community entry becomes model-invocable or user-invocable through this package. Upstream credentials, response types, and URLs remain on the Host. The browser receives only the normalized dsh wire projection.

## Model Experience

None, as Community discovery enters neither model requests nor the skill loader.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- One service instance represents one configured SkillHub Registry Instance; aggregation and installation are separate decisions. Local download does not create installation state.
- List enrichment issues one detail and one exact-version request per visible row because the deployed list response does not contain every normalized card field.
