# @deepseek-ai/dsh-skill-marketplace

English | [中文](README.zh.md)

Host-only Community Skills discovery service. One configured SkillHub endpoint is identified by an independent `registryInstanceId`; the adapter validates the deployed response fields and normalizes namespace, slug, title, description, publisher, exact version, stars, downloads, labels, and trustworthy publication time into `ctx.skillMarketplace`.

## Config

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | SkillHub Registry Instance HTTP origin. |
| `registryInstanceId` | required | Stable opaque identity attached to every normalized entry. |
| `pageSizeLimit` | `20` | Maximum accepted page size. |

List calls support query, label, zero-based page, and page size. The adapter enriches list rows with the exact version detail required by the deployed SkillHub API, rejects malformed or mismatched responses, preserves caller cancellation, and marks an entry New only when its valid `publishedAt` falls within the preceding seven days on the Host clock. Missing, invalid, future, or older times are not New.

This service never registers entries on `ctx.skills`. It provides discovery data only; no Community entry becomes model-invocable or user-invocable through this package. Upstream credentials, response types, and URLs remain on the Host. The browser receives only the normalized dsh wire projection.

## Model Experience

None, as Community discovery enters neither model requests nor the skill loader.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- One service instance represents one configured SkillHub Registry Instance; aggregation and installation are separate decisions.
- List enrichment issues one detail and one exact-version request per visible row because the deployed list response does not contain every normalized card field.
