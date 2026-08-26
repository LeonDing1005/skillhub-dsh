# Agent Note: Optional repository integrations

Status: implemented

English | [中文](2026-08-26-optional-repository-integrations.zh.md)

## Problem

Repository workflows combine checks that every checkout can run with integrations that require repository-owned credentials. Treating absent optional credentials as invalid code prevents a newly configured fork or mirror from merging the change that adapts those workflows to its own repository. Silently omitting the integration also hides which verification did not run.

Issue policy has a separate portability concern: trusted workflow code must query the repository named by the local issue-management configuration, rather than retaining the source repository's identity after a fork or transfer.

## Decision

The issue-management configuration names `LeonDing1005/skillhub-dsh`, and the Issue lifecycle token is scoped to that repository. Issue policy remains mandatory because it uses the event token and needs no optional application credential. When the repository does not expose the Issue field-values endpoint, policy emits a notice and treats Priority as unset; authentication failures and other API errors remain blocking.

Project lifecycle automation runs only when `DSH_ISSUE_APP_CLIENT_ID` is configured. An absent client ID emits a workflow notice and succeeds without creating a token or mutating ProjectV2. Once the client ID exists, token creation remains fail-loud: a missing or invalid private key, installation, repository grant, or Project permission fails the workflow.

The real-API E2E workflow treats `DEEPSEEK_API_KEY_EXTERNAL` as optional repository configuration. Trusted runs detect whether it is present before building the runnable artifacts. An absent key emits a workflow notice and skips both the build and live suite; a configured key runs the existing suite, whose API and assertion failures remain blocking. Fork and Dependabot pull requests remain excluded before any secret-bearing step.

## Verification

[Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the repository identity, credential conditions, explicit skip steps, and secret scope. [Issue policy tests](../../../../.github/issue-management/policy.test.mjs) continue to pin policy and lifecycle semantics independently of repository credentials.

## Alternatives considered

**Require every optional credential before any pull request can merge.** This makes the repository unusable until external application and API access are provisioned, and it blocks the workflow change needed to establish the repository's own configuration.

**Disable credential-dependent workflows entirely.** This avoids false failures but removes visible evidence that Project automation or live API coverage did not run, and makes later credential provisioning ineffective without another code change.

**Allow configured integrations to fail open.** Catching token, permission, or API failures would make a broken installation indistinguishable from an intentionally unconfigured repository. Only absence of the defining client ID or API key selects the skip path.

## Consequences

A checkout without repository secrets or Issue field values can merge through supported checks while GitHub records notices for omitted integrations and metadata. Maintainers must configure the GitHub App and DeepSeek secret to obtain ProjectV2 transitions and live-provider coverage. Once configured, bad credentials and real integration regressions remain visible failures.
