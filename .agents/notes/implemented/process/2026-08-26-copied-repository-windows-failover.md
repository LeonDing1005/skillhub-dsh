# Agent Note: Copied-repository Windows failover

Status: implemented

English | [中文](2026-08-26-copied-repository-windows-failover.zh.md)

## Problem

The [copied-repository CI fallback](2026-08-26-copied-repository-ci-fallback.md) selects `windows-latest` before evaluating `DSH_CI_FAILOVER_WINDOWS`. A copied repository that provisions the documented `[self-hosted, dsh-win-ci, windows]` runner cannot select it, so the repository variable has no effect and native Windows checks continue on GitHub-hosted capacity.

## Decision

The `windows-native` runner expression evaluates `DSH_CI_FAILOVER_WINDOWS=selfhosted` before the repository-name fallback. For non-Dependabot pull requests, that value selects `[self-hosted, dsh-win-ci, windows]` in both the canonical and copied repositories. Without the value, copied repositories use `windows-latest` and the canonical repository uses `dsh-windows-2025-16core`.

Dependabot remains on hosted Windows because untrusted dependency pull requests do not run on the self-hosted pool. Workflow tests pin both selector presence and ordering so a repository-name fallback cannot shadow the explicit failover choice.

## Alternatives considered

**Keep copied repositories fixed to `windows-latest`.** Rejected because it makes a configured failover variable ineffective even after the repository provisions the documented runner labels.

**Default every copied repository to the self-hosted labels.** Rejected because copied repositories do not inherit runner registrations and would queue indefinitely before provisioning.

**Add a copied-repository-specific variable.** Rejected because the existing Windows switch already names the deployment choice and the runner labels are identical.

## Consequences

Copied repositories retain a zero-configuration hosted fallback and can opt into their own Windows pool through the same switch as the canonical repository. Repository owners must register all three labels before setting the variable. The selection rule remains independent of `DSH_CI_FAILOVER_LINUX`.
