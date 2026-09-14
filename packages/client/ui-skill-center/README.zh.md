# @deepseek-ai/dsh-client-ui-skill-center

[English](README.md) | 中文

面向标准化社区技能目录的原生技能中心页面。该插件注册侧边栏底部操作和一个 `shell.page` 中央界面，在目录打开时保留周围的 workspace 与 Session shell。选择或创建 Session 会返回会话。

“我的技能”视图通过 Host RPC 加载按会话寻址的 Personal Skill Inventory，展示托管、本地、随包和运行时候选（包括被遮蔽条目），并将解析胜出项与安装状态分开标记。非托管条目只读；只有带不可变 identity 的托管 receipt 才显示生命周期操作。

“社区技能”标签页可用，“我的技能”通过 Host 生命周期 RPC 加载已验证的托管安装。由 Host 执行的防抖搜索、分类标签、排序和增量分页共用一个请求键。改变搜索、分类或排序会重置分页。加载下一页时已有卡片保持原位，下一页失败后可在不清空卡片的情况下重试。已被新请求取代的迟到响应会被忽略。

确定性的加载、空、带重试的失败、陈旧、不可用和有数据状态共用稳定的宽、中、窄卡片轨道。陈旧响应会保留最近成功的卡片并提供明确的重试操作；过期结果会显示带类型的不可用状态。卡片展示命名空间/slug 标识、标题、描述、发布者、精确版本、标签、星标数、下载数以及 Host 派生的“新上架”标记；不展示浏览量或任何上游专用字段。

选择卡片会打开精确发布版本的模态框，包含“在 dsh 中使用”和“本地 / 第三方安装”两种模式。标题区展示规范名称、发布者、精确版本、星标数和下载数。只有 `metadata.examplePrompt` 到达 Host 投影时，dsh 模式才显示示例。本地模式严格显示 `skillhub install <slug> --namespace <namespace> --version <version>`，提供复制成功反馈，并支持经 Host 核验的精确版本下载。下载不会安装该技能。

详情模态框限制焦点范围，可通过 Escape、取消或遮罩关闭，并把焦点还给选中的卡片。其 `SKILL.md` 预览让原始 HTML 保持字面文本，省略远程图片，并通过滚动限制代码或无断点长文本。

页面通过标准 connection 服务调用 `skill.communityList`、`skill.communityGet` 和托管安装生命周期方法。精确字节使用 Host-only 的 `/api/skill.download` 路由。浏览器不会接收 SkillHub 凭据、基础 URL、上游响应类型、制品 URL 或 Host 路径。安装操作只发送安全的发布版本 identity 和生成的幂等键。

安装和更新需要显式确认。已启用的托管安装可以从详情对话框进入当前会话使用：路由解析当前 Session，经 `conversation.insertSkillToken` 插入规范的 `/name ` token，恢复会话页面，并把 composer 聚焦交给会话输入 seam 处理。

## 模型体验

无，因为该浏览器发现界面不注册任何面向模型的内容。

#### KV Cache 影响

无。

## 已知限制与延后工作

- 非托管 inventory 条目只读；只有带不可变 identity 的托管 receipt 才显示生命周期操作。
