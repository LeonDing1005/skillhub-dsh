# Agent Note: Managed Skill Lifecycle RPC

Status: implemented

English | [中文](2026-09-12-managed-skill-lifecycle-rpc.zh.md)

## Problem

The browser needs managed-installation lifecycle operations while Host-only source data, credentials, and package paths remain private and deployments may omit the installation service.

## Decision

The Host API exposes safe managed-installation list, install, update, enablement, and uninstall methods through the typed RPC map and browser connection client. Payloads carry immutable identity, exact versions, and caller idempotency keys. Responses contain only canonical name, enabled state, install time, and fingerprint; source URLs, credentials, and local package paths remain Host-only.

When the managed installation service is absent, lifecycle calls return a typed internal-unavailable result. The browser-facing contract remains usable for deployments that mount the service later.

## Alternatives considered

**Send raw installation receipts over RPC.** Rejected because receipts contain Host-local paths and source-server metadata.

**Make the installation service mandatory for every Host composition.** Rejected because Community Skill lifecycle support is optional and existing deployments must keep serving other API methods.

## Consequences

- Browser clients can retry exact lifecycle operations with caller-owned idempotency keys.
- Missing Host capability is represented as a typed result instead of an undefined RPC method.
- The wire projection remains smaller than the Host receipt and cannot expose local installation details.
