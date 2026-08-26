# Agent Note: 复制仓库的 CI 回退

Status: implemented

[English](2026-08-26-copied-repository-ci-fallback.md) | 中文

## 问题

规范仓库的 PR（Pull Request）工作流使用组织自有的 Linux 和 Windows runner、用于 Issue 生命周期自动化的 GitHub App，以及外部 DeepSeek API secret。由同一源码树创建的仓库不会继承这些资源。即使该仓库可以使用普通 GitHub 托管的 Actions 容量，其 PR 也会持续排队或在测试提交代码之前失败。

## 决策

当 `github.repository` 不是 `deepseek-harness/deepseek-harness` 时，[CI](../../../../.github/workflows/ci.yml)为 PR 选择 `ubuntu-latest` 和 `windows-latest`。复制仓库的 Linux job 使用适合标准 GitHub 托管 runner 的较低 worker 上限。规范仓库保留其组织自有 runner、仓库变量和自托管故障切换行为。

[Issue policy](../../../../.github/workflows/issue-policy.yml)、[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml)和[真实 DeepSeek API e2e](../../../../.github/workflows/e2e.yml)保留其触发器，但 job 仅在规范仓库中运行。复制仓库获得成功跳过的检查，而不会因为缺少 GitHub App、规范 Issue 管理配置或 `DEEPSEEK_API_KEY_EXTERNAL` 而失败。该回退不会把任意 OpenAI 兼容端点视为规范 e2e 工作流所覆盖的外部 DeepSeek API。

[工作流测试](../../../../scripts/ci-workflow.spec.ts)锁定仓库身份条件、标准 runner 回退、规范 runner 选择器、Issue 自动化限制和外部 API 限制。

## 曾考虑的替代方案

**在每个复制仓库中复刻所有组织资源。** 否决，因为 runner 标签、GitHub App 凭证、仓库变量和 secret 属于部署配置。要求完全复刻会使源码树在每个仓库完成无关的组织配置之前不可用。

**使用仓库的 personal access token 或自定义模型网关来补充缺失的工作流凭证。** 否决，因为 GitHub token 无法提供 runner 容量或 GitHub App 私钥，而自定义 OpenAI 兼容网关无法证明与外部 DeepSeek API 的兼容性。

**删除规范 job。** 否决，因为组织自有 runner、Issue 自动化和真实外部 API 检查仍然是规范仓库的必需信号。

## 后果

复制仓库可以在标准 GitHub 托管 runner 上执行完整的无密钥 PR 套件，而无需复刻规范基础设施。其 CI 不会声称获得了规范 Issue 自动化或外部 DeepSeek API 测试的覆盖；这些 job 会明确显示为跳过。仓库名称条件成为 CI 部署行为的一部分，因此规范仓库重命名时必须更新该条件及其工作流测试。
