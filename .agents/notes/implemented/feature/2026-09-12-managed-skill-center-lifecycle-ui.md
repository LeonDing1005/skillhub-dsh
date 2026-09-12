# Agent Note: Managed Skill Center Lifecycle UI

English | [中文](2026-09-12-managed-skill-center-lifecycle-ui.zh.md)

The Skill Center now enables My Skills when the Host provides managed-installation methods. It loads safe installation projections, renders enabled and disabled states, and routes enable, disable, uninstall, install, and update actions through the connection API. Community detail dialogs join an installation by immutable registry identity and exact version.

The browser sends only safe identity fields and generated idempotency keys. Host-only source URLs, credentials, package paths, and raw receipts remain outside the UI projection. My Skills currently covers managed installations; aggregation of local, bundled, and runtime sources remains a Host projection concern.
