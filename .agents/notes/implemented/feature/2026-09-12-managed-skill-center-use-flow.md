English | [中文](2026-09-12-managed-skill-center-use-flow.zh.md)

---
kind: feature
status: implemented
date: 2026-09-12
---

# Managed Skill Center use flow

The Skill Center now requires an explicit confirmation before installing or updating a managed release. Once an enabled installation is present, its detail dialog can return to the current conversation through the existing `conversation.insertSkillToken` seam. That operation preserves the input machine's whitespace-bounded token edit and composer-focus behavior; Skill Center only resolves the current session and restores the conversation page. A missing current session or unavailable scope fails loudly.

The browser route depends on the sessions service for current-session lookup. It reuses the most recently active ordinary Session, or creates and opens a blank ordinary Session when the selection is empty. It does not read Host paths, credentials, SkillHub URLs, or raw responses. Component coverage proves confirmation gating and the enabled-installation use action; route coverage proves current-scope insertion and blank-session fallback.
