# Agent Note：Managed Skill Provider

[English](2026-08-29-managed-skill-provider.md) | 中文

托管安装包现在导出 `ManagedSkillProvider` 与 `apply(ctx, service)`。Provider 只列出 `enabled` 为 true 的 receipt，并使用共享文件系统解析器加载已验证的 `content/SKILL.md`。候选项使用低于 bundled skill 的 managed rank 和 opaque resource base；源服务器元数据与 Host 路径不会进入 `SkillCandidate` 或 `SkillDefinition`。

`ManagedInstallationService.onChange()` 是失效通知 seam。生命周期操作仅在 completed 操作记录持久化后通知监听者，使 `ctx.skills` 可以失效 catalog，同时不向 consumer 暴露生命周期内部。Host 负责构造 service 并注册 provider；RPC 与 Web 接线留给后续 ticket。

## 影响

- 禁用和卸载的包会在 `skills/change` 失效后从面向模型和用户的 skill catalog 中消失。
- 现有 registry 优先级仍然有效；managed rank 为 550，项目和用户目录保持既有顺序，bundled skill 仍更高。
- Provider 错误由现有 registry 发现策略处理，不会泄露私有 receipt 字段。
