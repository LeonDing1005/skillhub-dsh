# Domain Docs

English | [中文](domain.zh.md)

This repository uses a single domain context.

## Before exploring

- Read the root [CONTEXT.md](../../CONTEXT.md).
- Read relevant active Agent Notes under [`.agents/notes/`](../../.agents/notes/README.md).
- Treat implemented Agent Notes as shipped decisions, proposed notes as unshipped plans, and rejected notes as rejected alternatives.
- Do not treat archived Agent Notes as current authority.
- If a file is absent, proceed silently.

## Vocabulary

Use terms exactly as defined by [CONTEXT.md](../../CONTEXT.md) in issues, specs, interfaces, tests, and implementation notes. Resolve real terminology gaps through the domain-modeling workflow instead of inventing synonyms.

## Decisions

Agent Notes are this repository's decision-record system; do not create a parallel ADR hierarchy. Surface conflicts with an existing implemented Agent Note explicitly rather than silently overriding it.
