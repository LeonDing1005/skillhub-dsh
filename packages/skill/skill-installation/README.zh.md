# @deepseek-ai/dsh-skill-installation

[English](README.md) | 中文

面向 Host 的 Community Skill 版本准入、生命周期操作与不可变存储。此包依据 Registry Instance 元数据验证下载的 ZIP 字节，在唯一的私有 staging 目录下写入已验证内容和 receipt，通过同一文件系统内的目录重命名同时发布两者，并记录生命周期操作结果以支持 Host 幂等重试。它不注册 Cordis 服务，也不会向 `ctx.skills` 贡献已安装内容。

## API

```ts
import {
  ManagedInstallationService,
  ManagedSkillStore,
  registryInstanceId,
  type ManagedSkillRelease,
} from '@deepseek-ai/dsh-skill-installation'

declare const release: ManagedSkillRelease

const store = new ManagedSkillStore({
  root: '/var/lib/dsh/managed-skills',
  limits: {
    maxCompressedBytes: 8 * 1024 * 1024,
    maxExpandedBytes: 32 * 1024 * 1024,
    maxEntryCount: 256,
  },
})

const registry = registryInstanceId('community-primary')
void registry
const receipt = await store.admit(release)

const service = new ManagedInstallationService({
  root: '/var/lib/dsh/managed-skills',
  limits: {
    maxCompressedBytes: 8 * 1024 * 1024,
    maxExpandedBytes: 32 * 1024 * 1024,
    maxEntryCount: 256,
  },
  resolver: {
    async resolve(request, signal) {
      void request
      void signal
      return release
    },
  },
})

const result = await service.install({
  identity: release.identity,
  version: release.version,
  idempotencyKey: 'host-generated-operation-id',
})
void result
```

`ManagedSkillRelease` 标识一个 Registry Instance、namespace、slug、规范 skill 名称和确切版本。它的 manifest 包含每个文件的预期路径、字节大小和小写 SHA-256。`computeSkillHubFingerprint()` 对这些已验证路径排序，对 SkillHub 的 `path:sha256\n` 序列求哈希，并返回带前缀的版本指纹。

## 准入与发布

准入拒绝绝对路径和父目录穿越、反斜杠、Windows 设备名与备用数据流名称、链接与特殊文件、重复的可移植路径、不支持的包根、加密或不受支持的条目，以及超过配置的归档限制。一个包必须恰好包含一个根 `SKILL.md`，它可以直接位于根目录，也可以位于唯一的包装目录下。共享的 `dsh-skill-filesystem` 解析器验证该文档，包括规范名称和调用元数据。

发布前，每个解压出的普通文件都必须与解析所得 manifest 一致。存储在进程间串行化准入，把暂存包以随机私有名称移到已提交包旁，冻结其外层目录，并通过最后一次目录重命名一起发布 `content/` 与 `receipt.json`。提交前失败或取消会删除该私有包；最后一次重命名是提交点。

receipt 记录 Registry Instance 与远程身份、adapter 与源服务器、规范名称、确切版本、已验证 manifest、重新计算的指纹、安装时间、enabled 状态和托管内容位置。返回持久状态之前，存储会拒绝链接或可写条目，并验证内容文件集合、目录集合、大小和哈希仍与 receipt 一致。以相同元数据重复请求同一身份和版本时，会直接返回该已验证 receipt，而不解码替换字节。既有版本的元数据漂移，以及另一个远程身份占用同一规范名称，都会返回类型化冲突。提交后的 writer lock 清理失败会发出进程警告，同时保留真实的成功结果；后续准入前需要由运维人员移除遗留 lock。

`ManagedSkillAdmissionError.code` 区分无效请求、归档与限额失败、manifest、指纹、skill 与身份失败、不可变版本与规范名称冲突、发布版本不可用、正在进行的操作、持久状态损坏和提交失败。调用方可以为自己的 Host 或 wire API 转换这些代码；错误消息包含便于运维人员理解的上下文，但不包含凭据或包内容。

## 生命周期操作

`ManagedInstallationService` 在 `ManagedSkillStore` 之上实现面向确切 Community Skill 发布版本的 Host 生命周期操作。调用方提供不可变 Registry Instance 身份、确切版本和幂等键；安装和更新会要求 `ManagedSkillReleaseResolver` 重新取得同一发布版本，并在归档准入前拒绝任何身份或版本漂移。resolver 持有传输和认证；此包持有本地验证、持久 receipt 发布、receipt 启用状态、包删除和操作重放。

操作记录位于包存储旁的 `v1/operations/`，与包 receipt 分开。running 记录会在变更开始前保留调用方的幂等键，`v1/operations/targets/` 下的逐目标 owner-pid 锁会在所有者仍存活时拒绝另一服务实例的同目标操作。completed 记录会在变更抵达持久点后保存包目标键和可重放结果。对同一操作和目标复用同一幂等键时，重启后会直接返回已完成结果；把该键复用于另一操作或目标会作为幂等冲突失败。另一生命周期操作仍在运行时，对同一目标使用不同幂等键会以 `OPERATION_IN_PROGRESS` 拒绝。

安装会准入一个确切发布版本并返回安全 receipt 投影。更新要求请求的源版本已经安装，然后准入请求的目标版本、禁用源版本，并且只有在两个包 receipt 都可写入后才启用新版本。启用和禁用只修改 receipt 的 `enabled` 字段；卸载会删除一个确切包及其过期操作记录，使恢复不会重放已经删除的包。卸载对不存在的包保持幂等，并报告 `removed: false`。

启动恢复会创建私有根目录，移除遗留 staging 目录和 `.admitting-*` 包目录，验证完整 receipt 与不可变内容，删除过期 running 操作记录和死亡目标锁，并只保留包 receipt 仍能验证的 completed 操作记录。completed 卸载记录可以在没有包 receipt 的情况下重放。恢复绝不会提升部分包数据。损坏的持久包或 completed 操作记录会作为类型化损坏失败，使 Host 可以停止暴露不安全状态，而不是猜测。成功生命周期结果返回安全 receipt 投影，省略源服务器和托管内容路径；需要本地包路径的调用方只在 Host 内读取已验证的存储 receipt。

## 模型体验

无，因为这个仅限 Host 的包准入模块不注册 provider、工具、提示词或会话事件。

#### KV Cache 影响

无；此包不会组装模型输入。

## 已知限制与推迟的工作

- **仅 Host 库** — 此包不会暴露 Web 控件、注册 callable skill provider，或把生命周期操作转换到 RPC。
- **基于权限的不可变性** — 已提交文件使用只读文件系统 mode；Windows 和忽略 POSIX mode bit 的文件系统提供的保护较弱，拥有操作系统账户仍可主动恢复写权限。
- **原子但并非崩溃持久** — 发布使用同一文件系统内的重命名而不调用 `fsync`；系统突然故障后可能需要由安装生命周期所有者执行协调。
