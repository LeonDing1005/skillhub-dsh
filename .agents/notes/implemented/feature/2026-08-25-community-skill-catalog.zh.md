# Agent Note: 社区技能目录基础

Status: implemented

[English](2026-08-25-community-skill-catalog.md) | 中文

## 问题

浏览器已有可调用的本地 Skill 菜单，但没有原生界面用于发现固定 SkillHub 部署中的社区技能。若把上游条目当作普通 `ctx.skills` 条目，尚未安装的远程内容会变得可调用，上游概念会进入浏览器代码，而且存在多个注册表实例时，相同的命名空间/slug/版本元组将无法区分。

## 决定

社区发现是独立的 Host 能力。`@deepseek-ai/dsh-skill-marketplace` 拥有一个已配置的 SkillHub Registry Instance，验证固定的已部署 OpenAPI 与响应 fixture，用精确版本详情补全列表行，并输出 dsh 自有的卡片值。每个标识由独立配置的不透明 `registryInstanceId`、命名空间、slug 和精确版本组成。适配器拥有基于 Host 时钟七天的“新上架”规则；缺失、无效、未来或更早的发布时间都不会标记为新。

`skill.communityList` 通过现有 API gateway 和 connection 载体传递该标准化值。其浏览器 schema 不含基础 URL、凭据、上游类型、Host 路径或浏览量。现有按 Session 寻址的 `skill.list` 仍是已安装且可调用的目录；marketplace 绝不注册到 `ctx.skills`，也不公开安装或调用操作。

原生 `ui-skill-center` 插件贡献一个侧边栏操作和一个 `shell.page` 中央界面。“社区技能”可用，“我的技能”可见但禁用，页面拥有确定性的加载、空、失败/重试和有数据状态。卡片展示稳定标识、标题、描述、发布者、标签、精确版本、星标数、下载数和 Host 派生的“新上架”标记。页面可见时，`AppFrame` 会隐藏会话与详情元素，但保持两个组件树挂载；选择或创建 Session 会调用 `showConversation()`，并重新显示同一份 Session 状态。

## 考虑过的替代方案

**把远程条目直接注册到 `ctx.skills`。** 这会抹去发现与安装的区别，并在安装策略、信任决策、本地持久化格式或更新生命周期尚不存在时，使远程内容可以调用。

**让浏览器直接调用 SkillHub。** 这会把部署标识、凭据、上游响应变化和网络策略暴露给呈现代码。Host 标准化使浏览器协议保持稳定且由 dsh 拥有。

**只用命名空间和 slug 作为完整标识。** 这些字段会在不同注册表实例和版本之间冲突。即使首个组合只使用一个固定上游，稳定的注册表实例 id 和精确版本仍保持显式。

**在 React 中派生“新上架”。** 浏览器时钟和解析会使同一条目在不同客户端呈现不同结果。验证 `publishedAt` 的 Host 拥有时间判断，并只发送一个布尔值。

## 后果

已发布 Web 组合可以展示真实社区目录，而不授予调用能力，也不泄露 Host 配置。为了取得已部署 API 缺失的精确版本字段，该基础功能会为每个可见行增加一对请求，因此首屏大小被有意限制。筛选、详情页、“我的技能”、安装、注册表聚合和更新策略保持缺席，不会被发现功能暗示为已存在。组件测试固定页面全部状态与注册释放，固定 fixture 固定上游与 dsh wire 字段。浏览器组合测试启动已发布 Loader 树，通过 Host 适配器和 `skill.communityList` 访问确定性的 HTTP Registry Instance，并逐字节比较英文与中文的 1077×638 PNG。
