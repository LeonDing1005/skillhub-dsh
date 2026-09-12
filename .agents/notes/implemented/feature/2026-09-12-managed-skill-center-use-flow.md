# Agent Note: Managed Skill Center use flow

Status: implemented

English | [中文](2026-09-12-managed-skill-center-use-flow.zh.md)

## Problem

The Skill Center needs a safe path from an installed Community Skill to the current conversation without bypassing installation confirmation or session scope rules.

## Decision

The Skill Center now requires an explicit confirmation before installing or updating a managed release. Once an enabled installation is present, its detail dialog can return to the current conversation through the existing `conversation.insertSkillToken` seam. That operation preserves the input machine's whitespace-bounded token edit and composer-focus behavior; Skill Center only resolves the current session and restores the conversation page. A missing current session or unavailable scope fails loudly.

The browser route depends on the sessions service for current-session lookup. It reuses the most recently active ordinary Session, or creates and opens a blank ordinary Session when the selection is empty. It does not read Host paths, credentials, SkillHub URLs, or raw responses. Component coverage proves confirmation gating and the enabled-installation use action; route coverage proves current-scope insertion and blank-session fallback.

## Alternatives considered

**Insert a skill token before installation completes.** Rejected because an uncommitted or disabled installation must not become model-visible.

**Require an already selected session.** Rejected because the existing shell supports a no-session view and the route can create a blank ordinary session through the sessions service.

## Consequences

- Installation and update actions remain confirmation-gated before the conversation can use a release.
- Session creation and scope resolution stay behind the sessions service; the Skill Center does not handle Host paths or credentials.
- The existing conversation token editor remains the owner of whitespace and focus behavior.
