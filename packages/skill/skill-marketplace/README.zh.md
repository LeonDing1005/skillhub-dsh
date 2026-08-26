# @deepseek-ai/dsh-skill-marketplace

[English](README.md) | 中文

仅在 Host 运行的社区技能发现服务。一个已配置的 SkillHub 端点由独立的 `registryInstanceId` 标识；适配器验证已部署响应字段，并把命名空间、slug、标题、描述、发布者、精确版本、星标数、下载数、标签和可信发布时间标准化到 `ctx.skillMarketplace`。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 必填 | SkillHub Registry Instance 的 HTTP 源。 |
| `registryInstanceId` | 必填 | 附加到每个标准化条目的稳定不透明标识。 |
| `pageSizeLimit` | `20` | 可接受的最大分页大小。 |

列表调用支持查询、标签、从零开始的页码和分页大小。适配器会使用已部署 SkillHub API 所需的精确版本详情补全列表行，拒绝格式错误或标识不一致的响应，并保留调用方取消。只有有效 `publishedAt` 位于 Host 时钟此前七天内的条目才标记为“新上架”；缺失、无效、未来或更早的时间都不会标记。

该服务绝不把条目注册到 `ctx.skills`。它只提供发现数据；任何社区条目都不会因本包而变成模型可调用或用户可调用。上游凭据、响应类型和 URL 留在 Host，浏览器只接收标准化后的 dsh wire 投影。

## 模型体验

无，因为社区发现既不进入模型请求，也不进入 skill loader。

#### KV Cache 影响

无。

## 已知限制与延后工作

- 一个服务实例代表一个已配置的 SkillHub Registry Instance；聚合和安装属于独立决策。
- 已部署列表响应不含全部标准化卡片字段，因此列表补全会为每个可见条目发送一次详情请求和一次精确版本请求。
