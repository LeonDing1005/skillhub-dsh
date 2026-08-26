# @deepseek-ai/dsh-client-ui-skill-center

English | [中文](README.zh.md)

Native Skill Center page for the normalized Community Skills catalog. The plugin registers a sidebar footer action and a `shell.page` center surface, preserving the surrounding workspace and Session shell while the catalog is open. Selecting or creating a Session returns to the conversation.

The Community Skills tab is enabled and My Skills remains visibly disabled. Deterministic loading, empty, failure with retry, and populated states share one stable card grid. Cards show namespace/slug identity, title, description, publisher, exact version, labels, stars, downloads, and the Host-derived New marker; no view count or upstream-only field is rendered.

The page calls only `skill.communityList` through the standard connection service. It receives no SkillHub credentials, base URL, upstream response types, or Host paths, and it exposes no installation or invocation action.

## Model Experience

None, as this browser discovery surface registers nothing model-facing.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- My Skills, filtering, pagination controls, detail pages, and installation are not enabled by this foundation.
