# @deepseek-ai/dsh-skill-marketplace

[English](README.md) | 中文

仅在 Host 运行的社区技能发现服务。一个已配置的 SkillHub 端点由独立的 `registryInstanceId` 标识；适配器验证已部署响应字段，并把命名空间、slug、标题、描述、发布者、精确版本、星标数、下载数、标签和可信发布时间标准化到 `ctx.skillMarketplace`。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 必填 | SkillHub Registry Instance 的 HTTP 源。 |
| `registryInstanceId` | 必填 | 附加到每个标准化条目的稳定不透明标识。 |
| `pageSizeLimit` | `20` | 可接受的最大分页大小。 |
| `freshTtlMs` | `300000` | 成功查询结果无需访问 SkillHub 即可返回的时长。 |
| `staleTtlMs` | `86400000` | 上游失败后仍可返回最近成功结果的最大时长。 |
| `rateLimitRetries` | `3` | HTTP 429 的最大本地重试次数；接受 `0` 至 `10`。 |
| `rateLimitBackoffMs` | `250` | HTTP 429 指数退避的初始延迟；最大计划延迟必须处于 Host 计时器范围内。 |
| `skillMarkdownMaxBytes` | `1048576` | 精确发布版本 `SKILL.md` 可接受的最大 UTF-8 字节数。 |

列表调用支持查询、标签、排序、从零开始的页码和分页大小，这些字段共同组成缓存键。适配器会使用已部署 SkillHub API 所需的精确版本详情补全列表行，拒绝格式错误或标识不一致的响应，并保留调用方取消。只有有效 `publishedAt` 位于 Host 时钟此前七天内的条目才标记为“新上架”；缺失、无效、未来或更早的时间都不会标记。

成功条目在 `freshTtlMs` 内保持新鲜。超过该时间后，上游可用性故障会在 `staleTtlMs` 内返回最近成功值并标记为陈旧；更旧的条目以 `SKILL_MARKETPLACE_UNAVAILABLE` 失败。无效 Registry 响应会直接失败，避免缓存掩盖已部署 API 不兼容。HTTP 429 使用有界的本地指数退避，不把上游 `Retry-After` 值当作 Host 调度指令。

`get(identity)` 通过组合 SkillHub 的详情、全部版本分页、精确版本元数据、文件、有字节上限的原始 `SKILL.md` 和 `resolve` 响应来检查一个精确发布版本。全部返回值均由 dsh 所有，每个响应的标识都必须一致，CLI 命令 token 必须是安全标识，并且只有字符串类型的 `metadata.examplePrompt` 才会成为 `examplePrompt`。`download(identity)` 再次核验精确版本元数据和 resolve 结果，核验 ZIP 签名，然后以规范技能名称和版本命名，流式返回精确制品。两种操作都不会安装或注册该发布版本。

该服务绝不把条目注册到 `ctx.skills`。它只提供发现数据；任何社区条目都不会因本包而变成模型可调用或用户可调用。上游凭据、响应类型和 URL 留在 Host，浏览器只接收标准化后的 dsh wire 投影。

## 模型体验

无，因为社区发现既不进入模型请求，也不进入 skill loader。

#### KV Cache 影响

无。

## 已知限制与延后工作

- 一个服务实例代表一个已配置的 SkillHub Registry Instance；聚合和安装属于独立决策。本地下载不会创建安装状态。
- 已部署列表响应不含全部标准化卡片字段，因此列表补全会为每个可见条目发送一次详情请求和一次精确版本请求。
