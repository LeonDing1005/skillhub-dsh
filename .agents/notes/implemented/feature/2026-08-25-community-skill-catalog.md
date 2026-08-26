# Agent Note: Community Skill catalog foundation

Status: implemented

English | [中文](2026-08-25-community-skill-catalog.zh.md)

## Problem

The browser had an invocable local Skill menu but no native place to discover Community Skills from the fixed SkillHub deployment. Treating upstream rows as ordinary `ctx.skills` entries would make uninstalled remote content callable, expose upstream concepts to browser code, and leave identical namespace/slug/version tuples ambiguous when more than one registry instance exists.

## Decision

Community discovery is a separate Host capability. `@deepseek-ai/dsh-skill-marketplace` owns one configured SkillHub Registry Instance, validates fixed deployed OpenAPI and response fixtures, enriches list rows with exact-version details, and emits dsh-owned card values. Each identity includes the independently configured opaque `registryInstanceId` plus namespace, slug, and exact version. The adapter owns the seven-Host-clock-day New rule and treats missing, invalid, future, or older publication times as not new.

`skill.communityList` carries that normalized value through the existing API gateway and connection carrier. Its browser schema contains no base URL, credential, upstream type, Host path, or view count. The existing session-addressed `skill.list` remains the installed and invocable catalog; the marketplace never registers on `ctx.skills` and exposes no install or invoke operation.

The native `ui-skill-center` plugin contributes a sidebar action and a `shell.page` center surface. Community Skills is enabled, My Skills is visible but disabled, and the page owns deterministic loading, empty, failure/retry, and populated states. Cards show stable identity, title, description, publisher, labels, exact version, stars, downloads, and the Host-derived New marker. `AppFrame` hides the conversation and details elements while the page is visible but keeps both component trees mounted; selecting or creating a Session calls `showConversation()` and reveals the same session state.

## Alternatives considered

**Register remote rows directly on `ctx.skills`.** This would erase the discovery/install distinction and make remote content callable before an installation policy, trust decision, local persistence format, or update lifecycle exists.

**Call SkillHub directly from the browser.** This would expose deployment identity, credentials, upstream response changes, and network policy to presentation code. Host normalization keeps the browser protocol stable and dsh-owned.

**Use namespace and slug as the complete identity.** Those fields collide across registry instances and versions. The stable registry instance id and exact version remain explicit even while the first composition uses one fixed upstream.

**Derive New in React.** Browser clocks and parsing would make the same entry render differently between clients. The Host that validates `publishedAt` owns the time decision and sends one boolean.

## Consequences

The shipped Web composition can show a real Community catalog without granting invocation or leaking Host configuration. The foundation adds one request pair per visible row to obtain the deployed API's missing exact-version fields, so the first page is intentionally bounded. Filtering, detail pages, My Skills, installation, registry aggregation, and update policy remain absent rather than being implied by discovery. Component tests pin all page states and registration disposal. Fixed fixtures pin the upstream and dsh wire fields. The browser assembly test boots the shipped Loader tree, reaches a deterministic HTTP Registry Instance through the Host adapter and `skill.communityList`, and compares the English and Chinese 1077×638 PNGs byte for byte.
