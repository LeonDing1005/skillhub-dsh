# Agent Note: Copied-repository CI fallback

Status: implemented

English | [中文](2026-08-26-copied-repository-ci-fallback.zh.md)

## Problem

The canonical repository's pull-request workflows use organization-owned Linux and Windows runners, a GitHub App for issue lifecycle automation, and an external DeepSeek API secret. A repository created from the same source tree does not inherit those resources. Its pull requests therefore remain queued or fail before testing the submitted code, even when the repository's ordinary GitHub-hosted Actions capacity is available.

## Decision

[CI](../../../../.github/workflows/ci.yml) selects `ubuntu-latest` and `windows-latest` for pull requests when `github.repository` is not `deepseek-harness/deepseek-harness`. The copied-repository Linux jobs use lower worker limits appropriate for standard GitHub-hosted runners. The canonical repository retains its organization-owned runners, repository variables, and self-hosted failover behavior.

[Issue policy](../../../../.github/workflows/issue-policy.yml), [Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml), and [real DeepSeek API e2e](../../../../.github/workflows/e2e.yml) retain their triggers but run their jobs only in the canonical repository. A copied repository receives successful skipped checks instead of failures caused by an absent GitHub App, canonical issue-management configuration, or `DEEPSEEK_API_KEY_EXTERNAL`. The fallback does not treat an arbitrary OpenAI-compatible endpoint as the external DeepSeek API covered by the canonical e2e workflow.

[Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the repository-identity conditions, standard runner fallbacks, canonical runner selectors, issue automation restriction, and external-API restriction.

## Alternatives considered

**Duplicate every organization resource in each copied repository.** Rejected because runner labels, GitHub App credentials, repository variables, and secrets are deployment-owned configuration. Requiring an exact copy makes the source tree unusable before each repository completes unrelated organization provisioning.

**Use the repository's personal access token or custom model gateway for missing workflow credentials.** Rejected because a GitHub token cannot provide runner capacity or a GitHub App private key, and a custom OpenAI-compatible gateway does not prove compatibility with the external DeepSeek API.

**Remove the canonical jobs.** Rejected because the organization-owned runners, issue automation, and real external-API checks remain required signals in the canonical repository.

## Consequences

Copied repositories can execute the complete keyless pull-request suite on standard GitHub-hosted runners without reproducing canonical infrastructure. Their CI does not claim coverage from canonical issue automation or external DeepSeek API tests; those jobs are visibly skipped. The repository-name condition becomes part of CI deployment behavior, so a canonical repository rename requires updating the condition and its workflow tests.
