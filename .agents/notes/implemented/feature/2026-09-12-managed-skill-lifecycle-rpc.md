# Agent Note: Managed Skill Lifecycle RPC

English | [中文](2026-09-12-managed-skill-lifecycle-rpc.zh.md)

The Host API now exposes safe managed-installation list, install, update, enablement, and uninstall methods through the typed RPC map and browser connection client. Payloads carry immutable identity, exact versions, and caller idempotency keys. Responses contain only canonical name, enabled state, install time, and fingerprint; source URLs, credentials, and local package paths remain Host-only.

When the managed installation service is absent, lifecycle calls return a typed internal-unavailable result. The browser-facing contract remains usable for deployments that mount the service later.
