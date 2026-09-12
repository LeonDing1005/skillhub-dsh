# Agent Note: 托管 Skill 精确安装生命周期

Status: implemented

[English](2026-08-27-managed-skill-exact-install-lifecycle.md) | 中文

## 问题

单独的准入只能证明一个已下载归档可以成为不可变包，但没有定义 Host 安装请求如何跨重试、进程重启或部分完成的传输存活。生命周期所有者需要把用户确认的精确 Community Skill 身份和版本绑定到一个持久结果，同时不让远程目录漂移、重复请求或遗留 staging 产生可调用或看似已安装的包。

## 决策

`ManagedInstallationService` 在 `ManagedSkillStore` 之上持有第一个托管生命周期操作：精确安装。Host 调用方提供 Registry Instance 身份、namespace、slug、精确版本和幂等键。Host 提供的 `ManagedSkillReleaseResolver` 为该精确目标重新获取发布版本产物和元数据，服务会在归档准入前拒绝身份或版本漂移。传输、认证和 Registry Instance 策略仍归 resolver；本地包验证、receipt 发布、操作记录和恢复仍归 `@deepseek-ai/dsh-skill-installation`。

操作记录位于 `v1/operations/`，与包 receipt 分开。running 记录会在 resolver 启动前写入，因此重启可以丢弃遗留进度。`v1/operations/targets/` 中的逐目标 owner-pid 锁会在所有者仍存活时拒绝另一服务实例的同目标安装。completed 记录只在 `ManagedSkillStore.admit()` 返回已验证的持久 receipt 后写入。幂等键命名操作；包目标键命名安装事实。对同一目标复用同一键时，重启后会重放已完成结果且不调用 resolver；把该键复用于另一目标会以 `IDEMPOTENCY_KEY_CONFLICT` 失败。对同一目标使用另一个 live 键会以 `OPERATION_IN_PROGRESS` 失败，从而为每个包身份和版本保留一个 writer。

恢复会创建私有根目录，移除遗留 staging 目录和 `.admitting-*` 包目录，验证完整包 receipt 与不可变内容，删除过期 running 操作记录和死亡目标锁，并只保留目标 receipt 仍能验证的 completed 操作记录。恢复绝不会提升部分内容、猜测远程状态，或从 staging 数据重建 completed 操作。损坏的 completed 操作记录或损坏包会作为类型化损坏失败，而不是被修复。

`ManagedSkillStore.recover()` 刻意保持独立可用：它只协调包存储，不解释操作幂等性。生命周期服务组合它，然后协调操作记录。这个拆分让启用、禁用、更新、回滚和卸载操作可以共享包验证器，而不会把每次 receipt 读取都当作一次安装操作重放。

成功安装结果只公开适合 Host/RPC 转换的安全 receipt 投影：源服务器和托管内容路径不会进入结果。需要本地路径的调用方只在 Host 内使用已验证的存储 receipt。resolver 失败会报告为 `RELEASE_UNAVAILABLE`；已完成包但无法持久化幂等记录时会以 `OPERATION_RECORD_CORRUPT` 失败，而不是返回一个重启后无法重放的成功。

## 曾考虑的替代方案

**把 receipt 当作幂等记录。** 不采用，因为 receipt 是安装事实，而幂等记录属于一次调用方操作。合并两者会让重试键无法与包状态区分，也无法记录“这次安装已完成”和“另一次操作已经让这个包存在”的差别。

**只通过 `ManagedSkillStore.admit()` 汇合并发安装。** 不采用，因为准入可以返回已有的相同 receipt，但无法告诉调用方另一个安装操作是否仍在解析、验证或提交。生命周期服务会在下载前拒绝重叠的同目标操作，并保持操作错误模型稳定。

**在启动恢复时提升 staging 数据。** 不采用，因为 staging 缺少 completed 操作记录，并且可能存在于 manifest、skill、receipt、mode 或最终内容验证完成之前。恢复只信任完整 receipt 和已验证包树。

## 后果

精确安装拥有持久重试点和重启恢复规则，而不扩大浏览器、RPC 或 `ctx.skills` 表面。更新、启用、禁用和卸载通过[生命周期变更决策](2026-08-28-managed-skill-lifecycle-mutations.md)复用同一生命周期记录设计；回滚、tombstone、provider 贡献和 Skill Center 变更 UI 仍是独立生命周期步骤。

单元覆盖固定了成功精确安装、安全结果投影、重启后的幂等重放、幂等键目标冲突、跨服务实例的 live 同目标操作拒绝、失败 resolver 后重试、远程发布版本漂移拒绝、安全操作记录错误，以及启动时清理 staging、`.admitting-*`、过期 running 操作记录和死亡目标锁。
