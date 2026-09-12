# Agent Note: 托管 Skill 生命周期变更

Status: implemented

[English](2026-08-28-managed-skill-lifecycle-mutations.md) | 中文

## 问题

精确安装提供了持久包和重试记录，但托管 Skill 在安全进入 Skill Center 和 provider 流程之前，还需要由 Host 控制的更新、启用、禁用和卸载操作。这些操作必须跨调用方重试和重启存活，同时不把 Registry Instance URL、凭据、源响应、Host 路径或本地包路径暴露到浏览器侧结果。

## 决策

`ManagedInstallationService` 把精确安装的操作日志扩展到每个生命周期变更。running 记录在变更开始前保留一个调用方幂等键和一个确切包目标。completed 记录携带操作种类、包目标、完成时间和安全的可重放结果。可重放结果只包含投影后的 receipt 字段或卸载事实；源服务器和托管内容位置保留在 Host 内读取的已验证存储 receipt 中。

安装和更新是仅有的会解析远程发布版本字节的生命周期操作。它们使用调用方提供的 Registry Instance 身份和确切版本，并在准入前拒绝 resolver 身份或版本漂移。启用和禁用只修改已验证 receipt 的 `enabled` 字段。卸载会删除一个确切包目录以及同目标的过期操作记录，同时保留自身 completed 卸载记录，使重启后的重试无需包 receipt 就能报告同一结果。

更新要求 `fromVersion` 包已经安装，然后通过 `ManagedSkillStore` 准入目标版本，先把目标写为禁用状态、禁用源版本，再启用目标版本。如果启用在修改源 receipt 后失败，服务会恢复源 receipt 的 enabled 状态，并让目标保持禁用。操作目标键是目标版本，因为持久结果是新安装的活动版本；调用方提供 `fromVersion`，从而可以有意禁用源确切包。

启动恢复继续以包验证器作为已安装内容的事实来源。它删除过期 running 记录和死亡目标锁，只在目标 receipt 仍可验证时保留 completed install、update、enable 和 disable 记录，并在没有 receipt 时保留 completed uninstall 记录。恢复绝不会从部分包数据重建生命周期结果。

## 曾考虑的替代方案

**在 receipt 之外表示启用状态。** 不采用，因为包 receipt 已经是恢复时会验证的持久包状态。第二个状态文件会增加另一个提交点，并迫使 provider 启动时合并两个权威来源，而当前没有足够收益。

**卸载后保留过期 completed 记录并在恢复时忽略它们。** 不采用，因为每个旧的 install、update、enable 或 disable 记录都需要 tombstone 或特殊查询来证明缺失 receipt 是有效状态。卸载时移除同目标过期记录，可以为不存在的包留下一个可重放的操作事实。

**把更新视为卸载加安装。** 不采用，因为调用方需要一个表示“把这个身份移到这个确切版本”的幂等操作结果，并且只有在目标包可准入时才应禁用旧版本。拆成两个操作会暴露中间状态，并让重试归属变得模糊。

## 后果

Host 库现在可以安装、更新、启用、禁用、卸载、重放和恢复确切托管包，而不增加浏览器、RPC 或 `ctx.skills` 贡献表面。操作日志格式会存储可重放结果，因此旧的预发布操作记录按照本仓库的无兼容承诺刻意不兼容。

回滚仍是独立操作，因为选择前一个目标是策略，而不是包准入机制。tombstone 推迟到后续调用方需要超过幂等卸载重放的已删除包审计轨迹时再引入。托管 provider、Host/RPC 方法、Skill Center 控件和无 key 组装 Web flow 仍是后续生命周期步骤。

单元覆盖固定了启用/禁用幂等重放、重启后的卸载重放、已删除包的过期操作清理、更新到确切目标版本、旧版本禁用，以及跨版本 enabled 状态的启动恢复。
