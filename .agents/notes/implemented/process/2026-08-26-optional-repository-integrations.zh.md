# Agent Note: 可选仓库集成

Status: implemented

[English](2026-08-26-optional-repository-integrations.md) | 中文

## 问题

仓库工作流同时包含每个 checkout 都能运行的检查，以及依赖仓库自有凭据的集成。若把缺少可选凭据视为代码无效，新配置的 fork 或镜像将无法合并用于使工作流适配自身仓库的改动。若静默省略集成，又会隐藏哪些验证没有运行。

Issue Policy 还有独立的可移植性问题：可信工作流代码必须查询本地 Issue 管理配置所命名的仓库，而不能在 fork 或转移后继续保留源仓库标识。

## 决策

Issue 管理配置命名 `LeonDing1005/skillhub-dsh`，Issue Lifecycle token 也限定到该仓库。Issue Policy 使用事件 token，不需要可选应用凭据，因此仍为必需检查。当仓库不提供 Issue field-values 接口时，policy 发出 notice 并将 Priority 视为未设置；认证失败和其他 API 错误仍会阻塞。

Project Lifecycle 自动化只在已配置 `DSH_ISSUE_APP_CLIENT_ID` 时运行。缺少 client ID 时，工作流发出 notice 并成功结束，不创建 token，也不修改 ProjectV2。一旦 client ID 存在，token 创建仍会明确失败：private key、安装、仓库授权或 Project 权限缺失或无效都会使工作流失败。

真实 API E2E 工作流把 `DEEPSEEK_API_KEY_EXTERNAL` 视为可选仓库配置。可信运行在构建可运行产物之前检测密钥是否存在。缺少密钥时，工作流发出 notice，并跳过构建与真实测试；配置密钥后则运行既有测试套件，其中 API 和断言失败仍会阻塞。Fork 和 Dependabot PR 在任何携带 secret 的步骤之前仍被排除。

## 验证

[工作流测试](../../../../scripts/ci-workflow.spec.ts)固定仓库标识、凭据条件、显式跳过步骤和 secret 作用域。[Issue Policy 测试](../../../../.github/issue-management/policy.test.mjs)继续独立于仓库凭据固定 policy 与 lifecycle 语义。

## 曾考虑的替代方案

**要求所有可选凭据就绪后才能合并任何 PR。** 这会使仓库在外部应用和 API 访问完成配置前不可用，也会阻止用于建立仓库自身配置的工作流改动。

**完全禁用依赖凭据的工作流。** 这能避免错误失败，但会移除 Project 自动化或真实 API 覆盖未运行的可见证据，而且后续配置凭据后仍需再次改动代码才能生效。

**让已配置的集成失败后继续通过。** 捕获 token、权限或 API 失败，会使损坏的安装与有意未配置的仓库无法区分。只有缺少起决定作用的 client ID 或 API key 才选择跳过路径。

## 后果

没有仓库 secret 或 Issue field values 的 checkout 可以通过受支持的检查完成合并，同时 GitHub 会记录被省略集成和元数据的 notice。维护者必须配置 GitHub App 与 DeepSeek secret，才能获得 ProjectV2 状态转换和真实 provider 覆盖。配置完成后，错误凭据和真实集成回归仍然是可见的失败。
