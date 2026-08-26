# Agent Note: 托管 skill 包准入

Status: implemented

[English](2026-08-26-managed-skill-package-admission.md) | 中文

## 问题

在用户明确安装确切版本之前，Community 目录数据只是未受信任的发现元数据。后续安装工作流需要一个由 Host 持有的操作，用于拒绝恶意 ZIP 结构、依据 Registry Instance 元数据证明每个解压字节，并且只暴露完整的不可变包与 receipt，或者完全不暴露包。复用普通用户 skill 目录会丢失远程身份、确切版本来源和可靠的提交点。

## 决策

`@deepseek-ai/dsh-skill-installation` 持有准入操作，但不注册 Cordis 服务或 skill provider。`ManagedSkillStore.admit()` 接收已经解析的 `ManagedSkillRelease`，应用由部署控制的压缩字节、解压字节和条目数量限制，并在版本化私有 staging 根目录内的唯一目录下解压。

归档读取器在拼接 Host 路径前拒绝路径穿越、不可移植的 Windows 名称、链接和特殊文件，只接受根包或唯一包装目录，并要求恰好存在一个根 `SKILL.md`。它在写入时计算字节哈希，将按路径排序的文件记录与 Registry Instance manifest 比较，并重新计算 SkillHub 的路径排序指纹。`dsh-skill-filesystem` 导出 `parseSkillDocument()`，使准入与本地发现共用同一套 frontmatter、名称和调用策略解析器。

存储使用既有的跨进程文件锁串行化准入。SHA-256 存储键由 Registry Instance、namespace、slug 和确切版本派生，不会把这些值直接暴露为文件系统名称。staging 目录同时包含 `content/` 和 `receipt.json`；它先以随机私有名称移到已提交包旁，随后内容、receipt 与包目录变为只读，再由最后一次同父目录重命名提交发布。在该重命名前失败时，会删除私有包。归档读取期间以及两次移动之前都会检查取消。

receipt 保存远程身份、adapter、规范化源服务器、规范名称、确切版本、已验证文件记录、指纹、安装时间、enabled 状态和托管内容位置。持久读取会验证这些字段、排序后的 manifest 与指纹、存储键、只读真实条目，以及完整内容文件与目录集合、大小和哈希。对相同身份和版本的请求会直接返回该已验证 receipt，而不解码所提供的产物；版本元数据发生变化会产生不可变版本冲突，另一个远程身份使用相同规范名称则产生规范名称冲突。准入操作完成后的锁释放错误会发出进程警告，而不会把已提交结果报告为失败。

## 曾考虑的替代方案

**直接安装到普通 skill 根目录。** 不采用，因为文件系统 provider 持有用户创作内容的发现，而不负责远程来源、不可变版本、receipt 或原子包发布。更广泛的产品依据保留在 [SkillHub 支持的 Skill Center 提案](../../proposed/feature/2026-08-24-skillhub-backed-skill-center.md)中。

**在仓库代码中自行实现 ZIP 解析。** 不采用，因为 `yauzl` 提供维护中的中央目录解析、大小验证、惰性条目读取、加密与压缩元数据和流式解压。此包在其外围增加由 dsh 持有的路径、文件类型、包根、manifest 和身份策略。

**先冻结 staging，再直接跨存储父目录移动。** 不采用，因为 macOS 会拒绝把只读目录从 `staging/` 移到 `packages/`。可写的私有移动先以随机的非发布名称进入 `packages/`；冻结和最后一次同父目录重命名都发生在发布 key 出现之前。

## 后果

后续 Host 安装代码可以通过一个类型化模块准入确切版本，并区分策略拒绝、完整性失败、身份冲突、存储损坏和提交失败。测试覆盖根包与包装包、可移植路径攻击、精确与超限归档限制、manifest 与指纹漂移、共享 skill 解析、取消、原子失败、持久 receipt 与内容损坏、幂等重试和规范名称归属。

此包刻意止于准入。产物传输、Web 控件、callable provider 贡献、更新、禁用、卸载、启动协调和崩溃持久的 `fsync` 策略仍由后续安装生命周期工作负责。文件系统 mode 在 POSIX 系统上提供防止意外写入的实用保护，但不是抵御操作系统账户所有者的安全屏障。
