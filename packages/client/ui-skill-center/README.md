# @deepseek-ai/dsh-client-ui-skill-center

English | [中文](README.zh.md)

Native Skill Center page for the normalized Community Skills catalog. The plugin registers a sidebar footer action and a `shell.page` center surface, preserving the surrounding workspace and Session shell while the catalog is open. Selecting or creating a Session returns to the conversation.

The Community Skills tab is enabled and My Skills remains visibly disabled. Host-executed debounced search, category labels, sorting, and incremental pagination share one request key. Changing search, category, or sort resets pagination. Loading the next page keeps existing cards in place, and a failed next page can be retried without clearing them. Late responses from superseded requests are ignored.

Deterministic loading, empty, failure with retry, stale, unavailable, and populated states share stable wide, medium, and narrow card tracks. A stale response keeps the last successful cards visible with an explicit retry action; an expired result shows the typed unavailable state. Cards show namespace/slug identity, title, description, publisher, exact version, labels, stars, downloads, and the Host-derived New marker; no view count or upstream-only field is rendered.

Selecting a card opens an exact-release modal with `Use in dsh` and `Local / third-party installation` modes. Its header shows the canonical name, publisher, exact version, stars, and downloads. The dsh mode shows an example only when `metadata.examplePrompt` reached the Host projection. The local mode shows exactly `skillhub install <slug> --namespace <namespace> --version <version>`, reports copy success, and offers a Host-verified exact-version download. Downloading does not install the skill.

The detail modal traps focus, closes with Escape, Cancel, or the mask, and restores focus to the selected card. Its `SKILL.md` preview keeps raw HTML literal, omits remote images, and bounds code or unbroken text with scrolling.

The page calls `skill.communityList` and `skill.communityGet` through the standard connection service. Exact bytes use the Host-only `/api/skill.download` route. The browser receives no SkillHub credentials, base URL, upstream response types, artifact URL, or Host path, and it exposes no installation or invocation action.

## Model Experience

None, as this browser discovery surface registers nothing model-facing.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- My Skills and installation are not enabled by this catalog.
