# Agent Note: Managed Skill Center Lifecycle UI

Status: implemented

English | [中文](2026-09-12-managed-skill-center-lifecycle-ui.zh.md)

## Problem

The Skill Center needs a browser lifecycle surface without allowing Host-only installation data or unverified Community metadata into the UI.

## Decision

The Skill Center enables My Skills when the Host provides managed-installation methods. It loads safe installation projections, renders enabled and disabled states, and routes enable, disable, uninstall, install, and update actions through the connection API. Community detail dialogs join an installation by immutable registry identity and exact version.

The browser sends only safe identity fields and generated idempotency keys. Host-only source URLs, credentials, package paths, and raw receipts remain outside the UI projection. My Skills currently covers managed installations; aggregation of local, bundled, and runtime sources remains a Host projection concern.

## Alternatives considered

**Expose complete receipts to the browser.** Rejected because receipts contain local paths and source metadata that are not part of the browser contract.

**Let the browser construct lifecycle requests from display names.** Rejected because display names are not immutable identities and could target the wrong release.

## Consequences

- Browser lifecycle actions remain available only when the Host exposes the corresponding methods.
- Exact registry identity and generated idempotency keys make retries addressable without exposing Host storage details.
- Broader Personal Skill Inventory aggregation remains a Host projection responsibility.
