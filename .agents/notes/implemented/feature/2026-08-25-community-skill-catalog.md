# Agent Note: Community Skill catalog foundation

Status: implemented

English | [中文](2026-08-25-community-skill-catalog.zh.md)

## Problem

The browser had an invocable local Skill menu but no native place to discover Community Skills from the fixed SkillHub deployment. Treating upstream rows as ordinary `ctx.skills` entries would make uninstalled remote content callable, expose upstream concepts to browser code, and leave identical namespace/slug/version tuples ambiguous when more than one registry instance exists.

## Decision

Community discovery is a separate Host capability. `@deepseek-ai/dsh-skill-marketplace` owns one configured SkillHub Registry Instance, validates fixed deployed OpenAPI and response fixtures, enriches list rows with exact-version details, and emits dsh-owned card values. Each identity includes the independently configured opaque `registryInstanceId` plus namespace, slug, and exact version. The adapter owns the seven-Host-clock-day New rule and treats missing, invalid, future, or older publication times as not new.

`skill.communityList` carries that normalized value through the existing API gateway and connection carrier. Its browser schema contains no base URL, credential, upstream type, Host path, or view count. The existing session-addressed `skill.list` remains the installed and invocable catalog; the marketplace never registers on `ctx.skills` and exposes no install or invoke operation.

`skill.communityGet` returns dsh-owned detail for one immutable identity. The adapter combines the upstream skill detail, complete paginated version list, exact-version metadata, file list, bounded raw `SKILL.md`, and exact `resolve` result, then rejects any namespace, slug, or version disagreement. An example prompt is present only when the parsed release metadata contains a string at `metadata.examplePrompt`. The official local command is the exact `skillhub install <slug> --namespace <namespace> --version <version>` form, and every interpolated token must match the CLI token grammar.

Exact artifact bytes use the Host-only `GET /api/skill.download` surface instead of JSON-RPC. The browser performs one GET, checks its attachment response, and hands the resulting bytes to its download manager. The Host resolves the requested version, verifies the ZIP signature before exposing the stream, and supplies a sanitized canonical-name/version attachment filename. Browsing and downloading never write an installation receipt or register the release.

The marketplace caches complete list pages by normalized query, label, sort, page, and page size. A successful page is fresh for five minutes and eligible as stale fallback for twenty-four hours by default; both windows are configurable. Availability failure after the stale window becomes the typed unavailable result, while an invalid Registry response fails directly so stale data cannot hide API incompatibility. Per-key generations prevent an older concurrent request from replacing a newer cache entry. HTTP 429 retries use a configured local exponential schedule with a fixed attempt and Host-timer bound and ignore upstream `Retry-After` scheduling.

The native `ui-skill-center` plugin contributes a sidebar action and a `shell.page` center surface. Community Skills is enabled, My Skills is visible but disabled, and the page owns deterministic loading, empty, failure/retry, stale, unavailable, and populated states. It debounces search, treats labels as categories, and resets pagination when search, category, or sort changes. Incremental pagination preserves existing cards while the next page is pending or retryable. Each request has a generation and abort signal so a superseded response cannot replace newer results. Cards show stable identity, title, description, publisher, labels, exact version, stars, downloads, and the Host-derived New marker. `AppFrame` hides the conversation and details elements while the page is visible but keeps both component trees mounted; selecting or creating a Session calls `showConversation()` and reveals the same session state.

Selecting a card opens an abortable exact-release dialog with `Use in dsh` and `Local / third-party installation` modes. The header shows only canonical name, publisher, exact version, stars, and downloads. The local mode shows the official command with copy feedback and offers the Host download; the dsh mode shows the example only when the Host supplied it. The shared Markdown renderer keeps raw HTML literal, suppresses remote images for this preview, and contains code and unbroken text inside a bounded scroll region. The modal traps focus, closes on Escape or Cancel, and restores focus to the selected card.

## Alternatives considered

**Register remote rows directly on `ctx.skills`.** This would erase the discovery/install distinction and make remote content callable before an installation policy, trust decision, local persistence format, or update lifecycle exists.

**Call SkillHub directly from the browser.** This would expose deployment identity, credentials, upstream response changes, and network policy to presentation code. Host normalization keeps the browser protocol stable and dsh-owned.

**Use namespace and slug as the complete identity.** Those fields collide across registry instances and versions. The stable registry instance id and exact version remain explicit even while the first composition uses one fixed upstream.

**Derive New in React.** Browser clocks and parsing would make the same entry render differently between clients. The Host that validates `publishedAt` owns the time decision and sends one boolean.

**Cache each browser control independently.** Search, category, sort, and pagination jointly identify one upstream result. A partial key could display a page produced for different controls, so the Host uses the complete normalized request.

**Honor `Retry-After` after HTTP 429.** An arbitrary upstream delay could retain Host requests and resources beyond the deployment's local policy. The adapter owns a bounded retry schedule instead.

**Carry artifacts through JSON-RPC.** Binary bodies do not belong in the JSON value schemas and would require buffering or base64 expansion. A Host-only GET surface preserves Host streaming and keeps the browser API free of upstream URLs.

**Infer examples from `SKILL.md`.** A heading or prose block is not authoritative metadata and different parsers could select different text. The optional section follows only `metadata.examplePrompt` and is absent otherwise.

## Consequences

The shipped Web composition can search, filter, sort, page through, and inspect a real Community catalog without granting invocation or leaking Host configuration. The catalog remains usable from its last successful Host result during a bounded upstream outage, while expired data fails explicitly. List enrichment adds one request pair per visible row to obtain the deployed API's missing exact-version fields, and opening a dialog issues the complete exact-release read set, so both operations remain bounded and cancellable. My Skills, installation, registry aggregation, and update policy remain absent rather than being implied by browsing or local download. Component tests pin catalog states, detail success and optional-example behavior, preview safety, keyboard behavior, and registration disposal. Fixed fixtures pin the upstream and dsh wire fields. The browser assembly test boots the shipped Loader tree, reaches a deterministic HTTP Registry Instance through the Host adapter, and covers combined controls, pagination retry, cancellation, rate limiting, offline stale data, typed expiry, responsive layouts, exact-release dialog visual states, and the real browser download path.
