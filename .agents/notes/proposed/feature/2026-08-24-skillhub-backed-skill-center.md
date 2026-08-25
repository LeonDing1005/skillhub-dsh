# Agent Note: SkillHub-backed Skill Center

Status: proposed

English | [中文](2026-08-24-skillhub-backed-skill-center.zh.md)

## Problem

dsh can already discover local and bundled skills, expose the user-invocable catalog through `skill.list`, insert `/name` references from the composer, and load a selected skill through the existing skill registry. It does not provide a product surface for discovering remote skills, inspecting their contents, installing or disabling them, or managing the user's installed collection.

The requested experience is the Gangtise Skills panel shown in the six reference screenshots supplied on 2026-08-24: a community catalog and a personal catalog, card-based discovery, search and category filters, a two-mode detail dialog, installation state, enablement controls, local download, and a direct path from an installed skill into a conversation.

A visual copy alone would leave the important lifecycle undefined. Remote catalog entries are not callable dsh skills, installation must not expose partially written content, disabling must affect both model and user invocation, and a project-local skill may override an installed skill with the same name. The product needs one explicit contract connecting the marketplace, the managed package store, the existing skill registry, and the Web client.

## Proposal

Add a native dsh **Skill Center** backed by a separately deployed [SkillHub](https://github.com/iflytek/skillhub) instance. SkillHub owns remote catalog, search, package versions, publisher identity, download artifacts, and publishing workflows. dsh owns the Web experience, installation records, package validation, enablement, workspace resolution, and invocation.

SkillHub remains the source of truth for the community: maintainers create and update community skills there, and dsh obtains metadata and versioned artifacts through its distribution APIs. dsh does not mirror publisher records, edit community releases, or maintain an independent community index.

SkillHub is integrated through a Host-side adapter instead of embedding or modifying its frontend. Community entries do not enter `ctx.skills`; only enabled packages installed into dsh's managed skill store are contributed to the existing registry. This preserves the current [skill registry and invocation behavior](../../../../docs/subsystems/skills.md), including workspace-sensitive precedence and the `/name` user gesture.

Phase one connects exactly one configured SkillHub Registry Instance and delivers the complete public path: community discovery, detail, exact-version installation, enable, disable, update, uninstall, download, and use in conversation. It does not require SkillHub authentication or expose private namespaces. Remote identities nevertheless include a dsh-configured `registryInstanceId` with namespace, slug, and version so a later multi-registry feature does not require installation-record migration.

The product owner confirmed this amended phase-one scope as the implementation baseline on 2026-08-25. The note remains `proposed` until the behavior ships and its verification passes.

The Skill Center content area and detail dialog reproduce the supplied Gangtise screenshots pixel for pixel, including dimensions, spacing, typography, colors, borders, shadows, card density, control placement, and interaction states. This requirement overrides ordinary dsh component styling where the two differ. The surrounding dsh application shell remains dsh-owned; Gangtise's product logo, finance navigation, market ticker, and unrelated global controls are outside the copied surface.

## Goals and scope

The complete target includes the following outcomes:

- browse, search, filter, paginate, and refresh a remote community catalog;
- inspect identity, publisher, version, usage metrics, example prompt, install command, and rendered `SKILL.md` before installation;
- install, update, enable, disable, uninstall, and download a skill without restarting dsh;
- browse all dsh-visible personal skills and distinguish managed installations from project, user, custom, bundled, and runtime sources;
- insert an enabled, user-invocable skill into a conversation through the existing `/name` path;
- create and upload a skill to SkillHub when the configured server and user identity permit publishing; and
- preserve usable last-known data and clear recovery actions when SkillHub is unavailable.

The first release does not include authentication, private namespaces, creation, upload, publishing, SkillHub administration, moderation queues, organization and billing management, registry federation, automatic background updates, skill execution inside the detail dialog, ratings, comments, recommendations, or analytics dashboards.

## Information architecture

Skill Center is a first-class Web route reachable from dsh's primary navigation. The route has two stable top-level tabs:

| Tab | Purpose | Default state |
|---|---|---|
| Community Skills | Discover the configured SkillHub catalog | All categories, relevance order |
| My Skills | Manage skills visible to the current dsh installation | All sources |

Tab selection, search text, category, personal filter, sort, and scroll position are view state. They may survive route changes in the current browser, but they do not enter a Session log or model context.

### Community Skills

The header contains the title, a short subtitle, and a search input. A category row begins with `All` and then renders SkillHub labels as categories; when the registry returns no labels, `All` is the only category and dsh does not invent domain-specific categories. The row is horizontally scrollable on narrow screens. Search is debounced, submitted server-side, and combined with the selected category. Changing search or category resets pagination.

The catalog uses a responsive grid with three columns at the wide desktop reference size, two at medium widths, and one on narrow screens. Every card has a stable height and presents:

- display title and a `NEW` badge only when the latest release has a trustworthy `publishedAt` no more than seven days before the Host clock;
- a clamped description with an accessible full-text label;
- publisher, semantic version, star count, and download count, preserving the two metric positions in the reference without fabricating an unavailable view count; and
- an installed indicator when the exact skill identity is present locally, regardless of whether the installed version is enabled.

Selecting any non-control area opens the detail dialog. Installed state is never inferred from card counters or title; it comes from the Host installation service and is joined by immutable marketplace skill identity.

The grid defines skeleton loading, empty search, empty category, initial-load failure, stale cached result, next-page loading, and next-page failure states. A stale cached result remains browsable with a visible retry action. Pagination must not reorder already rendered cards while a request is pending.

### My Skills

The header contains the title, subtitle, search input, and `Upload Skill` command. The filter row contains `All`, `Installed`, `Created by me`, and `Uploaded by me`. The latter two require an authenticated SkillHub identity; when identity is unavailable, their empty state explains the requirement and offers the configured sign-in action rather than failing the whole page.

The first card in `All` and `Created by me` is `Create my Skill`. It starts the publishing editor described below. Other cards use the community card information density and add source, resolved status, enablement, and an overflow action menu.

A managed installation exposes an enable switch and actions for details, update when available, download, and uninstall. A discovered but unmanaged local skill is listed with its source and resolved path; dsh does not delete, overwrite, or publish that skill through the marketplace menu. Bundled and runtime skills are read-only. When another source wins the same name for the selected workspace, the card says which source is active instead of presenting the managed installation as the resolved skill.

Search is local over the last authoritative personal catalog and matches display title, skill name, description, and publisher. Personal filters and search compose. A registry invalidation or completed installation refreshes the catalog without a route reload.

## Skill detail dialog

The detail dialog is opened from either catalog and matches the supplied detail reference crops at desktop width, uses a full-height sheet on narrow screens, has a focus trap, Escape handling, focus restoration, and no nested modal. Its header presents display title, canonical kebab-case name, publisher, version, star count, and download count.

A two-option segmented control changes the body between `Use in dsh` and `Local / third-party installation`. Changing mode does not close the dialog or discard loaded detail data.

### Use in dsh

Before installation, this mode shows a copyable example prompt only when the release explicitly supplies `metadata.examplePrompt`; the entire block is omitted when that field is absent. It is followed by a sanitized Markdown preview of the complete `SKILL.md`. The footer offers `Install to my Skills` and `Cancel`.

During installation, the primary action reports the discrete Host phase `Downloading`, `Validating`, or `Committing` with indeterminate motion inside that phase; it does not fabricate a byte percentage. Duplicate clicks are ignored, and dialog dismissal requires confirmation only after filesystem mutation has begun. On success, the same dialog transitions in place to the installed state.

After installation, the footer offers `Uninstall`, `Use in conversation`, and `Cancel`. A disabled skill instead offers `Enable and use in conversation`. Install always pins the exact displayed version. An available newer version adds an update affordance that names the target version and requires explicit user confirmation; dsh performs no automatic or background updates and does not remove the installed version until the replacement commits successfully.

`Use in conversation` never invokes the skill from the dialog and never submits a prompt. It returns to the most recently active ordinary Session, or creates a blank ordinary Session when none exists, inserts a whitespace-bounded `/name ` token at the saved composer cursor through the existing input-trigger behavior, and focuses the composer. Existing draft text and selection are preserved around the insertion. The Host remains the authority that resolves and injects the skill when the user submits.

If the skill is not user-invocable, the dialog does not show `Use in conversation`; it explains that the skill can only be selected by the model. If another source currently wins the same name, the action identifies the winning source and does not imply that this installed package will run.

### Local / third-party installation

This mode shows the copyable official CLI form `skillhub install <slug> --namespace <namespace> --version <version>`, formatted by dsh from adapter data, followed by the same `SKILL.md` preview. SkillHub does not provide an install-command field. The command never adds `--force`, an agent, or a destination scope on the user's behalf. The footer offers `Download locally` and `Cancel`; when the skill is also installed in dsh it additionally offers `Uninstall` at the opposite side of the footer, matching the supplied reference behavior.

`Download locally` downloads the exact displayed version through a Host endpoint that preserves authentication and verifies the upstream artifact before streaming it. It does not alter dsh installation state. The filename contains the canonical name and version.

## Create and upload

`Create my Skill` opens a dsh-native editor for display title, canonical name, description, categories, example prompt, invocation policy, and `SKILL.md`, with optional resource files. The editor validates the same package rules as installation and can save a local draft without publishing.

`Upload Skill` accepts a directory bundle or supported archive, validates it locally, shows the parsed metadata and file inventory, and requires explicit confirmation before upload. Publishing requires an authenticated SkillHub identity and the permissions reported by the server. Version conflicts, rejected policy checks, and server validation errors remain attached to the relevant field or file.

Publishing is never an implicit side effect of local creation or installation. A successful upload refreshes `Uploaded by me`; a successful publish refreshes `Created by me` and the community catalog only when the server reports that the release is publicly visible.

Create and upload are phase-two deliverables because the screenshots establish their entry points but not their complete editor or server policy. Phase one ships the entry points only when they lead to a clearly labeled unavailable state; it must not present inert buttons.

## Domain model

The marketplace catalog and the callable skill catalog are separate models:

| Model | Owner | Meaning |
|---|---|---|
| MarketplaceSkill | SkillHub adapter | One remote product identity with latest release summary and discovery metadata |
| MarketplaceSkillVersion | SkillHub adapter | One immutable version, preview, artifact locator, integrity data, and install hints |
| SkillInstallation | dsh Host | One locally installed marketplace identity, pinned version, enabled state, receipt, and update status |
| SkillSummary / SkillDefinition | Existing `ctx.skills` registry | One currently discoverable and loadable skill after provider precedence |
| PersonalSkillRow | dsh Host projection | A joined management row over installation, local discovery source, ownership, and current workspace resolution |

Remote identity is not the display title or kebab-case invocation name. Installation and update operations use the immutable SkillHub identity plus version; invocation continues to use the validated skill name from `SKILL.md`. A release whose package name disagrees with its catalog metadata is rejected.

Installing the same registry identity and exact version is idempotent. A different community identity with the same canonical skill name is rejected while a managed installation of that name exists, and the conflict identifies the installed source. A project, user-authored, bundled, or runtime skill with the same name does not block installation because existing provider precedence remains authoritative; the UI must show which source currently resolves.

The installation state machine is `absent -> downloading -> validating -> committing -> installed-enabled`, with `installed-disabled`, `updating`, `uninstalling`, and `failed` operational states. Only the two installed states are durable. A process restart discards transient progress and reconstructs durable state from receipts and package directories.

## SkillHub adapter

The Host defines a provider-neutral marketplace service and a SkillHub adapter. Configuration includes `registryInstanceId`, base URL, optional public Web URL, credential reference, request timeout, cache ages, page size ceiling, artifact limits, and publishing enablement. The default list cache is fresh for 5 minutes and may be browsed as explicitly stale for up to 24 hours; deployments may override both bounds. Secrets stay in the Host credential service and are never returned to the browser.

The adapter normalizes SkillHub responses into dsh-owned types and owns endpoint paths, authentication headers, pagination tokens, category vocabulary, metric availability, artifact URLs, and upstream error translation. The Web client never calls SkillHub directly and never depends on SkillHub response fields.

Read-only discovery may operate anonymously when the server allows it. Authenticated operations fail with a typed `authentication-required` or `permission-denied` result. Rate limits preserve the last successful page, use bounded dsh-local exponential backoff, and expose a manual retry action; the adapter does not invent a retry time when upstream omits `Retry-After`. Unsupported optional metadata is omitted rather than fabricated.

Phase one requires adapter support for catalog listing, detail, version artifact download, and install hints. The deployed SkillHub container is pinned by image digest, and contract tests run against the actual pinned OpenAPI rather than its self-reported version string. An incompatible schema makes Community Skills unavailable with a typed configuration error while leaving My Skills and installed-skill invocation operational. Phase two adds identity, ownership queries, upload, create, and publish. The adapter contract allows another registry implementation without changing the Web package or installation service.

## Installation and registry behavior

Marketplace packages live in a dsh-managed store outside the ordinary `.dsh/skills` and `.agents/skills` roots. A managed-skill provider contributes only enabled, fully committed packages to `ctx.skills`. Uninstalled community entries and disabled installations are therefore absent from both model-facing and user-facing catalogs.

Installation downloads into a unique staging directory, verifies transport status, enforces configured compressed and expanded size limits, rejects absolute paths, parent traversal, device files, unsafe links, duplicate paths, excessive file counts, and unsupported package roots, then checks every extracted file against SkillHub's per-file SHA-256 list and recomputes the sorted-path fingerprint returned by `resolve`. It independently parses `SKILL.md` through the same rules as the filesystem provider and verifies that package identity agrees with catalog metadata. Commit writes the package and receipt atomically before invalidating `skills/change`. Failure removes staging data and leaves the previously installed version untouched.

The receipt records `registryInstanceId`, immutable marketplace identity, adapter name, source server, canonical skill name, exact version, the verified per-file hash manifest, recomputed fingerprint, install time, enabled state, and package location. It does not claim a ZIP digest that SkillHub does not supply. The package directory is immutable after commit. An update stages a complete replacement and atomically changes the receipt; rollback therefore retains the previous version.

Disable changes the receipt and invalidates the managed provider without deleting package files. Uninstall removes the provider contribution first, then removes the receipt and managed package. An uninstall failure reports whether the skill is already unavailable or still active; the UI must not guess from a failed request.

Update keeps the prior immutable package and receipt until the replacement commit is durable. Uninstall uses a recoverable tombstone so restart reconciliation can finish removal or restore the last truthful active state. On startup, the installation service removes abandoned staging directories, reconciles receipts, package directories, and tombstones, and emits invalidations only after durable state is known. Recovery never promotes an unverified package.

Existing precedence remains authoritative. Project skills may override a managed installation; scoped runtime or preset providers may resolve differently by Session. Install, enable, or update success means the managed package is available to the registry, not necessarily that it wins every workspace lookup.

## Host API and events

Extend the typed ApiProxy skill domain with operations equivalent to the following groups:

- `skill.marketplace.list`, `skill.marketplace.get`, and `skill.marketplace.download` for remote discovery;
- `skill.installation.list`, `skill.installation.install`, `skill.installation.update`, `skill.installation.setEnabled`, and `skill.installation.uninstall` for local management;
- `skill.publish.identity`, `skill.publish.validate`, `skill.publish.upload`, and `skill.publish.release` for phase-two publishing; and
- the existing `skill.list` for the Session-resolved, user-invocable composer catalog.

Every mutating request carries a caller-minted idempotency key. Results identify the requested marketplace identity, version, resulting durable state, and typed failure reason. Browser cancellation stops network work where possible but does not claim that a commit was rolled back after the Host has crossed its atomic commit point.

The Host forwards coarse marketplace-cache and installation-change invalidations. Clients refetch their current query or personal catalog rather than applying server diffs. Existing `skills/change` remains the only invalidation for callable catalog consumers such as `ui-skill`.

## Web client ownership

Implement the route as a new client plugin package using the existing slot system. The package owns route view state, dialog state, query coordination, and presentation. Host services own remote data, installation mutations, validation, and workspace resolution. Business components receive JSON-compatible data and callbacks; they do not receive a Cordis context or call SkillHub.

The package preserves the surrounding dsh shell and reuses its route composition, icon library, locale service, and focus behavior. Inside the Skill Center content area and detail dialog, it owns a small set of literal visual tokens calibrated to the supplied Gangtise desktop screenshots so dsh theme changes cannot move the pixel baseline. It does not add a component library, Tailwind, Gangtise branding, finance navigation, ticker, unrelated global controls, or a second global shell. Product copy is Chinese with an English locale counterpart. Mobile behavior is a responsive derivation rather than a second pixel reference.

Markdown preview uses the existing safe renderer with raw HTML and executable embeds disabled. Code and long unbroken text scroll within a bounded preview instead of widening the dialog. Copy buttons expose an accessible label and a short success state without changing layout.

## Loading, failure, and concurrency

List and detail reads use abortable, query-keyed single flight and bounded last-successful caches. A later query result cannot overwrite a newer query. Stale catalog data displays its last-successful timestamp and a manual retry action; after the configured 24-hour default stale bound, it is replaced by a typed unavailable state. Installation state comes from Host responses and invalidations, not optimistic card toggles.

Only one mutation for a marketplace identity runs at a time. Install, update, enable, disable, and uninstall controls are disabled while that identity is mutating, but unrelated cards remain usable. Repeated requests with the same idempotency key return the original result; a different concurrent key receives `operation-in-progress`.

Offline or unavailable SkillHub does not break `My Skills`, current skill invocation, or local source discovery. Community cached data is explicitly marked stale. Managed installation operations that do not require upstream data, including disable and uninstall, remain available.

## Security and trust

Skill packages are trusted instructions only after explicit installation; browsing and previewing never make their content model-visible or executable. The detail preview does not resolve remote images or execute package scripts. Installing a skill does not run setup commands.

Artifact fetches follow the configured credential-bearing redirect policy, enforce TLS according to Host configuration, and log origin, identity, version, and verified fingerprint without logging credentials. Publishing validates filenames and content before sending and never uploads files outside the selected package root.

The install confirmation displays publisher, source server, version, invocation policy, and whether executable resource files are present. SkillHub currently supplies neither a package signature nor a ZIP digest, so phase one makes no authenticity claim: it verifies each advertised file SHA-256 and the recomputed `resolve.fingerprint`. A future registry signature policy may strengthen admission.

## Delivery phases

Phase one is delivered as seven ordered, independently reviewable work packages. A package does not expose its controls until its Host behavior and failure states are complete.

1. **Pin contracts and fixtures.** Pin the deployed SkillHub image digest; capture contract fixtures from its actual list, detail, versions, files, resolve, and download responses; import the six supplied image crops as test fixtures; and freeze browser, fonts, clock, labels, metrics, and catalog data for deterministic comparison. Exit gate: the SkillHub contract suite and empty visual harness run without network access.
2. **Add the marketplace module.** Add a Host-side skill marketplace module whose small dsh-owned interface provides catalog listing, detail, exact-version resolution, and artifact acquisition. Keep SkillHub paths, pagination, labels, field translation, anonymous limits, cache behavior, and OpenAPI compatibility inside its SkillHub adapter. Exit gate: normalization, stale-cache, cancellation, 429, malformed-response, and incompatible-contract tests pass through the same interface callers use.
3. **Add managed installation and registry contribution.** Add a local managed-skill module that owns staging, archive admission, per-file hashes, fingerprint recomputation, receipts, immutable package directories, tombstones, startup reconciliation, idempotency, and one `ctx.skills` provider for enabled committed packages. Exit gate: install, conflict, update rollback, enable/disable, uninstall, crash-point recovery, precedence, and `skills/change` tests pass without ApiProxy or Web code.
4. **Expose Host transport.** Extend `packages/host/apiproxy/src/api/skills.ts`, its schemas and fetch dispatch with dsh-owned marketplace and installation operations; add the authenticated Host download surface and coarse cache/installation invalidations. The wire never exposes SkillHub response types, credentials, or package paths. Exit gate: contract, dispatch, cancellation, idempotency, download, and event tests pass with fake marketplace and installation implementations.
5. **Build the read-only Skill Center surface.** Add a dedicated `@deepseek-ai/dsh-client-ui-skill-center` package and mount it in `packages/bundle/web-app/cordis.patch.yml`. Implement navigation, Community Skills, all-source My Skills projection, search, labels, pagination, stale/error states, and the two-mode detail dialog before mutation controls are enabled. Exit gate: all six supplied screenshot crops meet the pixel threshold and keyboard, focus, long-content, locale, and responsive component tests pass.
6. **Wire lifecycle actions and conversation handoff.** Connect exact-version install, update confirmation, enable/disable, uninstall, local download, mutation progress, and recovery UI. Reuse the existing `ui-input-trigger` `/name` insertion path through a narrow programmatic composer interface; do not add a second invocation wire. Exit gate: component and assembled tests cover every durable state, duplicate action, source conflict, preserved draft/selection, and user-invocation policy.
7. **Prove the assembled release.** Run the keyless browse-to-uninstall Web flow against deterministic fixtures and a separate smoke run against the pinned local SkillHub; exercise restart at every update/uninstall transition; verify outage isolation, archive limits, accessibility, both locales, and production bundle composition; then update this Agent Note from proposed behavior to the facts that shipped.

Phase two is a separate proposal-sized increment: SkillHub identity, Created by me and Uploaded by me queries, local editor, package upload, publishing validation, and release workflow do not enter these seven work packages.

Each phase must leave no inert visible controls. A later-phase control is either omitted or leads to an explicit capability-required state.

## Alternatives considered

**Embed the SkillHub frontend in dsh.** Rejected because it would duplicate navigation and authentication, bypass dsh's theme and slot composition, expose upstream routing assumptions, and still require a separate bridge for local installation and Session-aware invocation.

**Fork and restyle SkillHub's frontend.** Rejected because dsh would inherit an unrelated frontend release lifecycle while the local package store, provider precedence, and composer behavior still belong to dsh. The adapter keeps upstream API change in one Host package.

**Register every remote SkillHub entry directly in `ctx.skills`.** Rejected because merely browsing a community catalog would make uninstalled third-party instructions visible to models and `/name` users. The marketplace is discovery data; installation is the explicit trust and availability transition.

**Install directly into `~/.dsh/skills`.** Rejected for marketplace-managed packages because ordinary filesystem entries have no durable origin, pinned version, digest, disabled state, or atomic update receipt. Existing user-authored skills remain supported there and appear as unmanaged personal rows.

**Reimplement the skill runtime for marketplace packages.** Rejected because the current registry, provider precedence, invocation policy, `skills/change`, `skill.list`, `/name` gesture, and `skill` tool already own runtime behavior. The new work adds management and one provider.

## Acceptance criteria

- Deterministic Playwright component fixtures with pinned Chromium and font files reproduce the two supplied `1077 x 638` catalog crops, three `802 x 638` detail crops, and one `807 x 638` detail crop with `maxDiffPixelRatio <= 0.002`. The comparison covers hierarchy, spacing, typography, colors, search, label categories, card grid, metrics, installed indicator, pagination, and the observed dialog states. Dynamic timestamps and counters are fixture-controlled rather than masked. These dimensions are content crops, not a claimed browser viewport; the surrounding dsh shell is excluded. Separate assembled tests verify loading, empty, failure, stale, retry, and usable responsive mobile states without treating them as supplied pixel references.
- The detail dialog reproduces the two display modes and all four observed lifecycle combinations: uninstalled dsh use, uninstalled local download, installed dsh use, and installed local download. Copy, preview, install, uninstall, download, cancel, and conversation actions have keyboard and screen-reader behavior.
- Installing a valid SkillHub package makes it visible through the existing registry and composer catalog without restarting dsh. Disabling removes it from both model and user invocation while retaining its files; enabling restores it; uninstall removes its managed contribution and receipt.
- Interrupted, invalid, oversized, traversal-containing, integrity-mismatched, and conflicting installs never expose a partial package and never destroy the previous installed version. Retried mutations are idempotent. Restart tests at every update and uninstall state transition prove that reconciliation returns to one truthful durable state without promoting unverified content.
- My Skills joins managed and unmanaged sources, reports enabled and resolved state separately, refreshes after invalidation, and correctly explains project or scoped overrides of the same skill name.
- `Use in conversation` preserves an existing draft, inserts a whitespace-bounded `/name ` through the established input path, focuses the composer, and does not submit or invoke anything until the user sends the prompt.
- SkillHub outage leaves installed skills, local discovery, My Skills, disable, uninstall, and invocation functional. Community discovery shows either a typed failure or clearly stale cached data.
- The browser never receives SkillHub credentials or artifact filesystem paths, never calls SkillHub directly, and never executes or makes previewed package content model-visible before explicit installation and invocation.
- Component tests cover cards, filters, dialog focus, copy state, narrow layouts, long names, long descriptions, installation transitions, source conflicts, and both locales. Host tests cover adapter normalization, archive validation, atomic commit, rollback, receipts, provider invalidation, precedence, idempotency, and cancellation.
- A keyless assembled Web test covers browse -> detail -> install -> use in conversation -> disable -> enable -> uninstall, and a replay fixture proves existing conversations remain stable when marketplace metadata or installed files later change.
- Phase-two acceptance additionally covers authenticated creation, upload validation, permission failures, version conflicts, publish confirmation, and refresh of Created by me and Uploaded by me without making publishing a side effect of local save.

## Risks

SkillHub's public APIs and package metadata do not expose every field visible in the reference screenshots. The adapter maps labels to categories and star count to the reference's first metric slot, shows an example only from `metadata.examplePrompt`, and omits other unavailable optional data rather than fabricating it. The pinned deployment's actual OpenAPI contract must be covered by contract tests before phase-one estimates are committed.

Remote packages are executable in the broad sense that their instructions can direct tools after invocation. Archive validation prevents filesystem attacks during installation but does not establish publisher trust or instruction safety. Deployment owners need a source allowlist, digest policy, and clear install confirmation.

The same skill name can resolve differently across workspaces and agent presets. A global My Skills page can therefore report installation and enabled state globally, but resolved state must always name the selected Session or workspace context.

Create and upload depend on authentication, authorization, moderation, and version policy that are not visible in the supplied screenshots. Those workflows remain phase two until the deployed SkillHub contract is verified.

Large catalogs and large `SKILL.md` files can make grids and previews expensive. The Host and client need bounded pages, artifact limits, clamped card content, lazy detail fetches, and bounded preview rendering.
