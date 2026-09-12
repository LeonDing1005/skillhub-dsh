# Agent Note：Managed Skill Provider

Status: implemented

[English](2026-08-29-managed-skill-provider.md) | 中文

## Problem

托管 Community Skill 包需要进入面向模型的 skill registry，同时不能把 receipt、源服务器元数据或 Host 存储路径暴露给 consumer。

## Decision

托管安装包导出 `ManagedSkillProvider` 与 `apply(ctx, service)`。Provider 只列出 `enabled` 为 true 的 receipt，使用共享文件系统解析器解析每份已提交的 `content/SKILL.md`，并把 description、可选 `whenToUse`、调用策略、metadata 和 opaque resource base 带入 registry candidate。加载前会重新核对当前 enabled receipt，因此旧候选不能加载已禁用或已删除的包。候选项使用低于 bundled skill 的 managed rank；源服务器元数据与 Host 路径不会进入 `SkillCandidate` 或 `SkillDefinition`。

`ManagedInstallationService.onChange()` 是失效通知 seam。生命周期操作仅在 completed 操作记录持久化后通知监听者，使 `ctx.skills` 可以失效 catalog，同时不向 consumer 暴露生命周期内部。Host 负责构造 service 并注册 provider；RPC 与 Web 接线留给包外职责。

## Alternatives considered

**直接向 registry 暴露托管 receipt。** 否决，因为 registry consumer 会依赖 Host 专属存储和远程元数据，而不是已验证的 skill 文档。

**让 provider 轮询安装存储。** 否决，因为轮询可能产生过期 catalog；持久化变更通知为 registry 提供明确的失效点。

## 影响

- 禁用和卸载的包会在 `skills/change` 失效后从面向模型和用户的 skill catalog 中消失，旧候选也会在 provider 加载步骤失败。
- 现有 registry 优先级仍然有效；managed rank 为 550，项目和用户目录保持既有顺序，bundled skill 仍更高。
- Provider 错误由现有 registry 发现策略处理，不会泄露私有 receipt 字段。
- receipt 或文档读取失败时会返回不完整 provider observation，因此 `ctx.skills.snapshot().complete` 会明确标出部分 catalog，并让下一次请求继续重试。
