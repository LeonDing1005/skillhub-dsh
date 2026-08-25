# SkillHub 后端接口与部署能力研究

> 研究目的：为 dsh 的 SkillHub-backed Skill Center 确认上游真实能力与集成边界。
> 研究日期：2026-08-24（Asia/Shanghai）。
> 证据范围：仅使用 `iflytek/skillhub` 官方仓库、该仓库源码/文档/部署清单/迁移、GitHub 官方 Repository 与 Release API。所有仓库链接固定到本次检查的 commit。

## 结论摘要

SkillHub 可以作为 dsh 社区 Skills 的**注册表、治理和分发后端**。它已经具备公开/按身份可见的检索、命名空间、版本、文件清单、单文件读取、ZIP 下载、标签、指标、上传、审核、隐藏/撤回和 CLI API。服务端数据模型也明确分离 skill、version、file、tag、search document 与治理记录。[源码：核心表](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/db/migration/V2__phase2_skill_tables.sql#L4-L103) [源码：审核与社会化表](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/db/migration/V3__phase3_review_social_tables.sql#L4-L79)

但 dsh 提案中有两个必须修正的假设：

1. SkillHub 暴露每个文件的 SHA-256 和由文件路径/摘要构造的版本 `fingerprint`，却没有经源码验证的**下载 ZIP 整包摘要或签名字段**。现有 CLI 下载后直接解压，并未把 `fingerprint` 或文件摘要用于安装校验。[源码：文件字段与 resolve 字段](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/SkillController.java#L212-L235) [源码：CLI 安装流程](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/cli/src/services/install-service.ts#L55-L83)
2. SkillHub 的 `label` 是当前可用于社区分类筛选的服务端模型；`tag` 是把 `stable`、`beta` 等名称移动到某个版本的版本别名，不是 UI 分类。dsh 不应把两者混为一谈。[源码：搜索 label 参数](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/SkillSearchController.java#L37-L60) [源码：版本 tag 操作](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/SkillTagController.java#L37-L86)

一期建议采用 Host 侧适配器，使用 `/api/web` 的只读发现端点和显式版本下载，匿名只读优先；dsh 自己维护安装记录、启停和原子提交。发布、审核和身份界面留到二期。

## 1. 检查版本与成熟度

| 项目 | 检查结果 | 判读 |
|---|---|---|
| commit | `f846da230cc0e06e4ab18c05911bb9b2cbd85ff1` | `main` 在 2026-08-24 16:37:34 +08:00 的提交；本报告所有源码链接固定到此 commit。 |
| 最近稳定 release | `v0.2.17`，2026-08-21 发布 | 非 prerelease；release 声明数据库 schema 为 V43，并说明没有已知 breaking change。[官方 Release API](https://api.github.com/repos/iflytek/skillhub/releases/latest) |
| 仓库创建时间 | 2026-03-11 | 项目历史很短，版本仍是 `0.2.x`；不能按长期稳定公共 API 对待。[官方 Repository API](https://api.github.com/repos/iflytek/skillhub) |
| 契约状态 | 有 SpringDoc/OpenAPI 生成类型和 drift 检查 | 仓库要求后端契约变化时重生成 Web SDK，可作为适配器开发时的契约基线。[README](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/README.md#L215-L232) |
| 部署成熟度 | Compose/runtime script、Kustomize、Helm 均存在 | 已达到可自托管状态，但升级、备份和外部依赖仍需部署方运维。 |

成熟度结论：**可用于受控的一期集成，但必须锁定镜像/commit，并在 dsh 适配器里隔离字段与路径变化。** `v0.2.x`、快速迁移演进（V43）和同一能力同时存在 `/api/v1`、`/api/web`、`/api/cli/v1`、ClawHub compatibility 四套入口，意味着不能让 dsh Web 客户端直接依赖上游响应。

## 2. 部署能力

### 2.1 可部署组件与拓扑

| 组件 | 角色 | 默认/示例端口 | 持久状态 |
|---|---|---:|---|
| `skillhub-server` | Java 21 / Spring Boot API、认证、治理、Flyway | `8080` | PostgreSQL；skill 文件在 local PVC 或 S3；会话和限流在 Redis |
| `skillhub-web` | Nginx 承载 React，并反代 API | `80`（开发 UI `3000`） | 无 |
| `skillhub-scanner` | 上传安全扫描服务 | `8000` | 任务流使用 Redis；扫描结果进入后端数据 |
| PostgreSQL 16 | 权威业务数据、搜索文档、审计和迁移 | `5432` | volume/PVC/外部托管数据库 |
| Redis 7 | Spring Session、滑动窗口限流、扫描任务流 | `6379` | 生产拓扑可为 standalone、Sentinel 或 Cluster |
| MinIO/S3 | skill 文件或 bundle 对象 | `9000`，MinIO console `9001` | volume/PVC 或外部对象存储 |

开发 Compose 明确启动 scanner、PostgreSQL、Redis 和 MinIO，并公开上述端口；staging overlay 再增加 server `8080` 与 web `80`。[Compose](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/docker-compose.yml#L1-L58) [Staging Compose](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/docker-compose.staging.yml#L12-L86)

Kubernetes 清单拆成 Web、Server、Scanner 三个 Deployment，并提供“内置 PostgreSQL/Redis”与“外部基础设施”两种 overlay。Helm 还支持本地 PVC 或 S3；本地 RWO PVC 会约束 Server 升级/副本策略，生产高可用更适合 S3/RWX。[K8s README](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/deploy/k8s/README.md#L1-L98) [Helm 存储说明](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/charts/skillhub/README.md#L387-L425)

### 2.2 启动方式与前置条件

- 官方最短路径是 Docker + Compose，通过官方 `runtime.sh ... up` 拉取 `latest` 稳定镜像；`--version edge` 才跟随 `main`。生产必须传 `--public-url`，否则 CLI 安装命令、OAuth callback、device auth 和 `skill.md` URL 可能指向错误地址。[README](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/README.md#L99-L127)
- 本地开发使用 `make dev-all`，UI `3000`、API `8080`，需要 Java 21、Node 前端工具链以及 Compose 基础服务；官方 ready-to-use 路径是发布的 GHCR 镜像。[README](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/README.md#L153-L183) [README：镜像架构](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/README.md#L234-L241)
- 单机文档给出的最低规格为 Docker Engine 20.10+、Compose Plugin 2.0+、4 GB RAM、20 GB 磁盘；该文档引用的 `compose.release.yml` 在本次 commit 的仓库根目录并不存在，因此应优先使用 README 的 runtime script 或 Helm，而不是照抄该旧命令。[单机文档](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/document/docs/02-administration/deployment/single-machine.md#L8-L38)

### 2.3 关键环境变量

下表只列 dsh 部署决策直接相关的变量；完整默认值由 `application.yml` 拥有。

| 范畴 | 变量 |
|---|---|
| 公开地址/会话 | `SKILLHUB_PUBLIC_BASE_URL`、`SESSION_COOKIE_SECURE`、`SERVER_SERVLET_SESSION_TIMEOUT` |
| PostgreSQL | `SPRING_DATASOURCE_URL`、`SPRING_DATASOURCE_USERNAME`、`SPRING_DATASOURCE_PASSWORD`、`DB_POOL_MAX_SIZE` |
| Redis | `REDIS_HOST`、`REDIS_PORT`、`REDIS_PASSWORD`；另有 Sentinel/Cluster/TLS 配置 |
| 文件存储 | `SKILLHUB_STORAGE_PROVIDER=local|s3`、`STORAGE_BASE_PATH`、`SKILLHUB_STORAGE_S3_ENDPOINT`、`...PUBLIC_ENDPOINT`、`...BUCKET`、`...ACCESS_KEY`、`...SECRET_KEY`、`...PRESIGN_EXPIRY` |
| 认证 | GitHub/GitLab OAuth 变量；local/direct/session-bootstrap 开关；bootstrap admin 变量 |
| 发布限制 | `SKILLHUB_PUBLISH_ALLOWED_FILE_EXTENSIONS`；默认 100 个文件、单文件 10 MiB、包 100 MiB（注意 domain 常量为 500 个文件，但应用配置默认覆盖为 100） |
| Scanner | `SKILLHUB_SECURITY_SCANNER_ENABLED`、URL、mode、超时/重试和 analyzer/policy 变量 |
| 可观测性 | `SKILLHUB_TRACING_MODE`、`SKILLHUB_LOG_FORMAT`、service version/environment、OTLP endpoint/timeout/compression、采样率 |

权威默认值见 [application.yml：基础、数据库、Redis、认证](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/application.yml#L1-L120)、[存储与发布](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/application.yml#L123-L200)、[bootstrap 与观测](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/application.yml#L208-L244)。

### 2.4 Bootstrap、可观测性、备份和升级

- 普通 profile 默认 `BOOTSTRAP_ADMIN_ENABLED=false`，local profile 默认开启；README 给出默认 `admin / ChangeMe!2026`，生产必须更换且首次登录后轮换。[配置](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/application.yml#L208-L215) [README](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/README.md#L170-L183)
- 健康端点为 `/actuator/health`；默认只暴露 `health,info`，Prometheus exporter 默认关闭。支持结构化/异步日志、W3C trace propagation 和可选 OTLP tracing。[配置](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/application.yml#L217-L244)
- Flyway 是 schema 变更入口，Hibernate 只做 `validate`。升级镜像会运行迁移，因此数据库备份必须在升级前完成，且应用与 DB schema 应按同一 release 推进。[配置](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/application.yml#L20-L39)
- 必须同时备份 PostgreSQL 与 skill object storage/local PVC；Redis 主要承载会话、限流和流，不应替代权威备份。Helm 明确把备份、恢复、PVC 复用和其他迁移方案留给运维方，release 卸载时 skill PVC 使用 keep policy。[Helm README](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/charts/skillhub/README.md#L285-L295) [Helm README：PVC 保留](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/charts/skillhub/README.md#L489-L513)

### 2.5 用户当前部署的实测结果

以下结果来自 2026-08-24 对用户本机运行实例的只读检查，不用于替代上述固定 commit 的源码证据：

| 检查项 | 实测结果 | 对 dsh 的影响 |
|---|---|---|
| 镜像身份 | Web、Server 与 Scanner 的 OCI label 均为产品版本 `0.2.17`、revision `15ce199e1a951fed05139e4c984150ddfc45def3`；Compose 当前引用私有镜像仓库的 `latest` tag | 该 revision 与本报告检查的 `main` commit `f846da2...` 不同。生产应固定 image digest 或不可变版本 tag，并针对实际镜像跑契约测试。 |
| 运行拓扑 | `skillhub-runtime-web-1`、`server-1`、`skill-scanner-1`、`postgres-1`、`redis-1` 全部健康；Web 映射 `127.0.0.1:3000 -> 80`，Server 映射 `8080`，Scanner 只在 Compose 网络暴露 `8000` | 与官方 Server/Web/Scanner/PostgreSQL/Redis 拆分一致；当前实例没有单独 MinIO 容器。 |
| 持久化 | PostgreSQL、Redis 和 Server 的 `/var/lib/skillhub/storage` 各有 Docker volume；五个服务均使用 `unless-stopped` | 当前实例采用本地 skill storage，备份至少覆盖数据库与 Server storage volume；Redis volume 不替代前两者。 |
| 健康与文档 | Server `/actuator/health` 返回 `UP`；`/v3/api-docs` 可直接匿名读取并自报 `SkillHub API 0.1.0-beta.7`，Swagger UI 存在 | 产品版本、镜像 revision 与 API 自报版本是三个不同标识。适配器启动和 CI 都应记录并验证实际 OpenAPI，不从 `0.2.17` 推断 API 兼容性。 |
| 匿名目录 | `GET /api/web/skills`、详情、版本、版本文件列表、单文件内容、resolve 和 ZIP 下载均成功；下载为 `application/zip`，文件名为 `<slug>-<version>.zip` | dsh 一期公开目录与分发可以不配置用户身份；私有 namespace 再增加 Host token。 |
| 搜索与字段 | 实例接受 `q,namespace,label,sort,page,size`；列表和详情实际返回 namespace、owner、发布版本、download/star/rating、labels 与 compliance snapshot，没有 view count | 报告中的分类、指标和浏览量结论在目标实例上得到确认。 |
| 完整性 | 版本文件列表逐项返回 `filePath,fileSize,contentType,sha256`；resolve 返回精确版本、`sha256:` fingerprint 与 download URL | dsh 可以实现逐文件校验和 fingerprint 重算；实例仍未提供 ZIP 整包摘要或签名。 |
| 认证 | `/api/v1/auth/methods` 只返回 `local-password`，OAuth provider 列表为空，匿名访问 `/api/v1/auth/me` 返回 401 | 二期发布 UI 在当前部署上使用本地账号；不能假设 GitHub OAuth 已配置。 |
| 分类数据 | `/api/web/labels` 端点公开但当前返回空数组；实例已有 17 个 built-in public skills | 前端必须支持“无分类定义”并保留 `全部`，不能用硬编码金融分类填充。 |
| 安全响应 | 响应设置 CSP、frame deny、nosniff、strict-origin referrer policy、CSRF 与 session cookie；下载 GET 匿名成功，但 HEAD 返回 401 | 健康探针与能力检查必须使用契约声明的方法，不能用 HEAD 的状态推断 GET 是否需要认证。 |

容器环境变量只检查了名称，没有读取或记录值。目标实例暴露 local/S3 storage、scanner、bootstrap admin、local/direct/GitHub auth、mail/password reset、public base URL、匿名下载 cookie secret、日志与 OTLP tracing 等配置面，与源码研究的配置项相符。

## 3. 与 dsh 相关的后端 API

### 3.1 API 家族选择

SkillHub 同时提供：

- `/api/web/**`：Portal/Web 客户端原生契约，字段最完整，适合 dsh Host 适配器；
- `/api/v1/**`：多数 Portal 端点的别名，同时也承载 ClawHub compatibility，存在路径语义重叠；
- `/api/cli/v1/**`：CLI 优先的简化 search/resolve/download/publish 契约；
- `/.well-known/clawhub.json` 与兼容路由：面向已有 ClawHub client，README 明确说兼容仍在扩展，不应作为 dsh 首选。[README](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/README.md#L89-L96)

因此一期固定使用 `/api/web` 发现/详情/版本/文件/下载，必要时使用 `/api/cli/v1` 的 resolve；不要混用 canonical slug compatibility 语义。

### 3.2 发现、详情和分发

| 能力 | 已验证端点与参数 | 已验证返回数据/行为 | 状态 |
|---|---|---|---|
| 搜索/列表 | `GET /api/web/skills?q=&namespace=&label=&sort=&page=&size=`；`page` 从 0 开始，默认 0/20；多 `label` 可组合 | envelope 内 `items,total,page,size`；item 有 id、slug、displayName、summary、namespace、下载/收藏/评分、更新时间和 lifecycle version | Confirmed |
| 详情 | `GET /api/web/skills/{namespace}/{slug}` | owner、visibility/status、download/star/subscription/rating、labels、权限布尔值、headline/published/preview version | Confirmed |
| 版本列表 | `GET .../versions?page=0&size=20` | id、version、status、changelog、fileCount、totalSize、publishedAt、downloadAvailable | Confirmed |
| 版本详情 | `GET .../versions/{version}` | 上述字段加 `parsedMetadataJson`、`manifestJson` | Confirmed |
| resolve | `GET .../resolve?version=&tag=&hash=` | skillId、namespace、slug、精确 version/versionId、fingerprint、matched、downloadUrl | Confirmed |
| 文件清单 | `GET .../versions/{version}/files` | 每个文件的 id、filePath、fileSize、contentType、sha256 | Confirmed |
| 单文件内容 | `GET .../versions/{version}/file?path=SKILL.md` | `application/octet-stream` 内容流；可用于详情预览 | Confirmed |
| ZIP 下载 | `GET .../download`、`GET .../versions/{version}/download`、`GET .../tags/{tag}/download` | S3 可 302 到 presigned URL，否则 API 流式返回；下载限流 | Confirmed |
| labels（分类） | `GET /api/web/labels`；skill labels `GET/PUT/DELETE .../{namespace}/{slug}/labels/{labelSlug}` | label definition 有 slug、type、翻译、`visibleInFilter`、sortOrder | Confirmed |
| tags（版本别名） | `GET/PUT/DELETE .../{namespace}/{slug}/tags/{tagName}` | tag 指向 target version；另有按 tag 的 files/file/download | Confirmed |
| 我的发布 | `GET /api/web/me/skills?page=&size=&filter=&q=&namespace=` | 认证用户拥有的 skill 分页 | Confirmed |
| 指标 | detail/summary 内 downloadCount、starCount、ratingAvg/ratingCount；无 view count | Gangtise 截图的“浏览量”不能从已验证 API 获得 | Partially confirmed |

搜索与分页的精确参数、默认值及限流见 [SkillSearchController](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/SkillSearchController.java#L20-L63)，item 字段见 [Web 类型](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/web/src/api/types.ts#L198-L217)，详情和版本字段见 [Web 类型](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/web/src/api/types.ts#L276-L340)。文件、resolve 与下载行为见 [SkillController](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/SkillController.java#L212-L420)。

排序值由搜索实现而非 controller enum 校验。README 声称支持 downloads、ratings、recency；dsh 应在联调时从目标版本 OpenAPI/实际实例确认允许的 `sort` 字符串，不在客户端硬编码未经验证的全集。[README](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/README.md#L73-L78)

### 3.3 身份、发布、更新、删除与治理

| 能力 | 端点/机制 | 权限与备注 |
|---|---|---|
| 当前身份 | `GET /api/v1/auth/me`、CLI `whoami`；API token 管理在 `/api/v1/tokens` | session、OAuth、local credential、Bearer API token 并存；token 带 scopes |
| 创建/上传新版本 | `POST /api/web/skills/{namespace}/publish` multipart：`file`、`visibility`、`confirmWarnings` | 认证且有命名空间发布权限；同一 slug + 新 version 即版本更新；返回 skillId、slug、version、status、fileCount、totalSize |
| 发布预检 | `POST /api/cli/v1/skills/{namespace}/publish/validate` multipart | 认证；返回 dry-run errors/warnings，适合二期上传 UI |
| 生命周期 | archive/unarchive、delete version、withdraw review、rerelease、submit review、confirm publish | 具体操作由 namespace role/平台角色校验；不是普通 CRUD update |
| 删除 skill | `DELETE /api/web/skills/{namespace}/{slug}` 或 `/id/{skillId}` | 管理者操作；存储删除带补偿迁移，需把失败作为非原子外部资源问题处理 |
| 审核 | `/api/web/reviews` submit/list/detail/approve/reject/withdraw/download | Namespace admin/owner 审核；平台全局提升另有 promotions |
| 平台审核/下架 | `/api/v1/admin/skills/{id}/hide|unhide`、`/versions/{id}/yank` | `SUPER_ADMIN` 或 `SKILL_ADMIN`；动作进入 audit log |
| 命名空间 | list/detail/create/update/delete、members、roles、freeze/archive/restore/transfer | Owner/Admin/Member + 平台角色模型 |
| 举报/社会化 | reports、star、rating、subscription | 已存在但不是 dsh 一期所需 |

上传字段和响应由 [SkillPublishController](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/SkillPublishController.java#L46-L98) 定义；CLI 预检/发布见 [CliSkillController](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/cli/CliSkillController.java#L98-L139)；生命周期见 [SkillLifecycleController](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/SkillLifecycleController.java#L41-L156)；审核见 [ReviewController](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/ReviewController.java#L47-L153)；平台 hide/yank 角色见 [AdminSkillController](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/admin/AdminSkillController.java#L35-L78)。

SkillHub 没有单独“编辑现有版本内容”的 API。已发布版本按版本身份读取；更新是上传新的 semver 版本，再经过所需审核/确认。dsh 不应设计“直接覆盖社区版本”。

## 4. Skill 包、存储和 CLI 行为

### 4.1 包格式与 Agent Skills 兼容性

- 包是 ZIP 或 multipart 文件集合，要求归一化后的包根目录存在 `SKILL.md`；允许单一外层目录并在上传时剥离。`SKILL.md` 是 YAML frontmatter + Markdown body，必填 `name`、`description`，version 可在顶层或 `metadata.version`。[协议](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/docs/07-skill-protocol.md#L1-L47) [解析器](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-domain/src/main/java/com/iflytek/skillhub/domain/skill/metadata/SkillMetadataParser.java#L35-L57)
- 官方协议明确目标是与 OpenSkills/Claude Agent Skills 互操作，约定 `SKILL.md + references/ + scripts/ + assets/`，安装目录名等于 skill slug；服务端不生成 AGENTS.md。[协议](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/docs/07-skill-protocol.md#L3-L25)
- CLI 原生命令是 `skillhub install <name> [--namespace] [--version] [--agent] [--scope user|project] [--dir] [--force]`。Codex profile 的项目和用户根均为 `.codex/skills`；无明确 agent 时的通用回退为项目 `.agents/skills`。[安装命令](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/cli/src/commands/install.ts#L10-L120) [Codex profile](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/cli/src/agents/profiles/codex.ts#L1-L2) [目标解析](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/cli/src/agents/resolver.ts#L19-L52)

### 4.2 服务端存储模型与完整性

PostgreSQL 保存 skill 元数据、不可同名版本、manifest/parsed metadata、文件路径/大小/content type/SHA-256/storage key 和 tag 指针；实际文件字节在 local filesystem 或 S3。[迁移](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/db/migration/V2__phase2_skill_tables.sql#L29-L74)

`resolve.fingerprint` 是服务端对已排序文件路径与文件 SHA-256 计算出的版本指纹（`sha256:` 前缀），不是已验证的 ZIP 字节摘要。文件清单 API 可让 dsh 下载后逐文件核验并重算同一指纹，但服务端没有暴露签名、公钥、证书链或 detached signature。[源码：fingerprint 计算](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-domain/src/main/java/com/iflytek/skillhub/domain/skill/service/SkillQueryService.java#L779-L803) [源码：resolve response](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/dto/ResolveVersionResponse.java#L3-L12)

结论：**checksums 为文件级；signatures 不存在；bundle checksum 未验证存在。** dsh 一期若要求“服务器提供的摘要”，应以文件清单逐项 SHA-256 + 重算 fingerprint 实现，而不是依赖响应头或 ZIP 摘要。

### 4.3 上传与解压安全

服务端：

- 默认应用限制为 100 文件、单文件 10 MiB、总包 100 MiB；归档读取同时检查压缩前请求大小和实际解压大小。[配置](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/application.yml#L80-L83) [归档提取](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/support/SkillPackageArchiveExtractor.java#L27-L83)
- 路径必须是相对、无 drive/scheme `:`、已规范化且不能逃逸根目录；重复路径报错。允许扩展名和轻量 magic/UTF-8 检查的“不匹配”多数记为 warning，需要 `confirmWarnings=true` 才继续，不是绝对拒绝。[路径策略](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-domain/src/main/java/com/iflytek/skillhub/domain/skill/validation/SkillPackagePolicy.java#L39-L67) [校验器](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-domain/src/main/java/com/iflytek/skillhub/domain/skill/validation/SkillPackageValidator.java#L71-L137)
- Java `ZipInputStream` 路径没有显式读取 Unix symlink mode；由于服务端只把 entry bytes 存为普通对象，不会在上传阶段落地成 symlink，但 dsh 仍必须独立拒绝 symlink/device 等归档类型。

官方 CLI：

- 先 resolve、下载有界响应、在目标根创建临时目录、解压、写 `.skillhub/metadata.json`，最后 `rename` 到目标；失败清理 temp。`--force` 会先递归删除旧目录，因此更新不是保留旧版本的事务式回滚。[CLI 安装](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/cli/src/services/install-service.ts#L55-L125)
- CLI ZIP 解析拒绝 Zip64、多磁盘、超过 500 entries、单文件 10 MiB、总解压 100 MiB和绝对/根逃逸路径；使用纯 JS 解压。[CLI archive](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/cli/src/platform/archive.ts#L13-L97) [safeJoin](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/cli/src/platform/archive.ts#L147-L159)
- CLI 没有核对文件 SHA-256/fingerprint、包签名或 `SKILL.md.name == requested slug` 的安装后验证。dsh 不能把 CLI 当前实现当作其更严格安装安全要求的充分证据。

## 5. 认证与运行安全

### 5.1 AuthN/AuthZ

SkillHub 支持浏览器 session + OAuth2/OIDC、local password、device flow 与 Bearer API token。API token 只存 prefix 与 hash，并有 scope、expiry、revocation；命名空间成员为 Owner/Admin/Member，平台角色包括 SUPER_ADMIN、SKILL_ADMIN、USER_ADMIN、AUDITOR。[迁移：身份/token/RBAC](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/db/migration/V1__init_schema.sql#L1-L111)

公开搜索、详情、公开版本和下载允许匿名，但结果仍经过 visibility scope；私有 namespace/skill 需要 session 或 Bearer token。dsh Host 应优先使用 scoped API token，不把 cookie/session 或 token 发给浏览器。

浏览器 session 请求使用 cookie CSRF token；Bearer 且无 session cookie 的 API 路由可按 route policy 忽略 CSRF。安全链还设置 CSP、`X-Content-Type-Options`、frame deny、HSTS 和 strict-origin referrer policy，默认其他路由需认证。[SecurityConfig](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-auth/src/main/java/com/iflytek/skillhub/auth/config/SecurityConfig.java#L94-L165)

### 5.2 CORS、重定向、TLS 与限流

- **CORS：Unknown/不应依赖。** 本次检查未发现全局 `CorsConfiguration` 或 `.cors()` 配置。官方 Web 通过 Nginx 同源反代 API；dsh Host-to-Host 调用不受浏览器 CORS 影响，这也支持“浏览器不直连 SkillHub”的提案。
- **下载重定向：Confirmed。** S3 存储可能返回 HTTP 302 presigned URL，local/fallback 则流式下载。Host 适配器必须限制重定向目标为配置的 S3/public endpoint，避免把 Authorization 转发给任意 origin。[下载响应](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/SkillController.java#L405-L420)
- **TLS：部署层负责。** 应用支持 secure session cookie 和 HSTS，但默认 cookie secure 为 false；生产需 Ingress/反向代理终止 TLS、设 `SESSION_COOKIE_SECURE=true` 并正确处理 forwarded headers。[配置](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/application.yml#L1-L11)
- **限流：Confirmed。** search 为认证 60/匿名 20，download 为认证 120/匿名 30，publish 为认证 10/匿名 0；默认窗口来自 annotation（60 秒）。生产使用 Redis 原子滑动窗口。429 返回 JSON，但 interceptor 未设置 `Retry-After`，所以 dsh 不能假设该 header 存在。[Controller limits](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/cli/CliSkillController.java#L42-L123) [RateLimitInterceptor](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/ratelimit/RateLimitInterceptor.java#L46-L83) [Redis limiter](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/java/com/iflytek/skillhub/ratelimit/RedisSlidingWindowRateLimiter.java#L13-L48)
- **Scanner：Confirmed but policy-dependent。** 默认 scanner enabled，支持 upload/local 模式和多 analyzer；真正阻断阈值由 policy preset 和 `fail-on-severity` 决定。它提高发布准入，不构成 dsh 运行时信任或签名验证。[配置](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/server/skillhub-app/src/main/resources/application.yml#L177-L207)

## 6. dsh 提案假设核对

状态含义：Confirmed = 一手资料直接支持；Partially confirmed = 能力存在但字段/语义不同或需 dsh 补齐；Unsupported = 与当前实现冲突；Unknown = 一手资料不能回答。

| dsh 提案中的假设 | 状态 | 证据与具体影响 |
|---|---|---|
| SkillHub 是社区目录、版本、发布者和下载产物的真源 | Confirmed | 核心表和 API 完整覆盖；dsh 可只保存远程 identity/version 引用，不复制社区索引。 |
| dsh 通过 Host 适配器集成而非嵌入上游前端 | Confirmed | API 原生且官方 Web 也只消费 API；CORS 未配置更强化 Host-to-Host 方案。 |
| 匿名可执行只读发现 | Confirmed | search/detail/download 接受可选 userId，并有 anonymous 限流；私有可见性仍需 token。 |
| 社区支持搜索、namespace、分类、分页和排序 | Partially confirmed | q/namespace/label/page/size/sort 均存在；“分类”应映射 label；允许的 sort 值需目标版本联调。 |
| 卡片可展示发布者、版本、浏览量、下载量 | Partially confirmed | owner、headline/published version、downloadCount 有；没有 view count，必须隐藏或改用 star/rating。 |
| 详情可展示完整 `SKILL.md` | Confirmed | 通过 version file API 读取 `path=SKILL.md`；detail 本身不直接返回 Markdown body。 |
| SkillHub 提供输入示例 | Unknown | SKILL.md 可自定义 frontmatter，但已验证 summary/detail 类型没有标准 `example prompt` 字段；只能从约定扩展或正文提取，不能假设。 |
| SkillHub 提供“本地/第三方安装命令” | Partially confirmed | README/CLI 可生成命令所需 registry+namespace+slug+version；未发现详情 API 的 installCommand 字段，dsh 应自行格式化。 |
| 详情可列版本、文件和下载精确版本 | Confirmed | versions/files/resolve/version download 均有。 |
| 下载端点提供可验证的整包摘要 | Unsupported | 只有逐文件 sha256 + version fingerprint；无 ZIP digest 字段，CLI 也不校验。dsh 必须逐文件核验并重算 fingerprint，或推动上游新增 bundle digest。 |
| SkillHub 产物有签名 | Unsupported | 未发现签名、公钥或验证契约；一期只能做来源 allowlist + TLS + hash，不得宣称 supply-chain signature。 |
| SkillHub 的 package 校验足以保护 dsh 安装 | Partially confirmed | 上游拒绝路径逃逸/大小异常并扫描，但 dsh 下载后仍必须独立校验 archive 类型、路径、内容和 name/version 一致性。 |
| 只有安装后才进入 dsh `ctx.skills` | Unknown（dsh-owned） | SkillHub 不管理 dsh runtime；这是正确的 dsh 本地信任边界，不依赖上游。 |
| dsh 可独立启用/停用/卸载 | Unknown（dsh-owned） | SkillHub 无“客户端安装状态”；必须由 dsh 本地安装记录实现。 |
| dsh 可以原子更新且保留旧版本回滚 | Unsupported by upstream CLI | 官方 CLI `--force` 先删旧目录；dsh 必须实现自己的 staging、验证、记录切换和 rollback。 |
| SkillHub 提供不可变 marketplace identity | Partially confirmed | `skill.id` 稳定、namespace+slug 唯一、version 唯一；但没有跨实例全局 ID。dsh identity 必须包含 server ID/base URL + namespace + slug。 |
| 包 slug/name/catalog metadata 可一致校验 | Partially confirmed | 服务端从 SKILL.md 解析 slug/version；dsh 仍应在安装后校验 requested identity 与内容，API 没有直接提供签名绑定。 |
| “我的 Skills”可从 SkillHub 查询我创建/上传的内容 | Confirmed | `/api/web/me/skills` 有 filter/q/namespace；本地安装、项目和 bundled skills 仍由 dsh 联合投影。 |
| 创建/上传/发布能在二期实现 | Confirmed | publish、validate、review、confirm、promotion、roles 均存在；UI 需适配目标 namespace policy。 |
| 已发布版本可直接编辑覆盖 | Unsupported | 当前模型用新版本发布和 lifecycle；dsh UI 应是“发布新版本”，不是 edit-in-place。 |
| 审核、权限、下架和审计由 SkillHub 负责 | Confirmed | namespace roles、platform roles、reviews、hide/yank、audit_log 均存在。 |
| SkillHub 限流会提供重试时间 | Unsupported | 429 已验证，但 interceptor 不发 `Retry-After`；dsh 采用本地指数退避并允许用户重试。 |
| dsh 可保留最近社区缓存并离线使用本地 skills | Unknown（dsh-owned） | SkillHub 不提供离线目录快照契约；缓存和 stale 标识应由 dsh Host 实现。 |
| 浏览器不收到 SkillHub 凭据或直接路径 | Confirmed as architecture, not upstream | Host 代理调用可以满足；S3 302 可能暴露短期 presigned URL，因此 dsh 对浏览器下载应由 Host 转流。 |
| SkillHub 支持 local filesystem 与 S3/MinIO | Confirmed | 配置与 Helm 均明确；生产建议外部 S3/RWX。 |
| SkillHub 可水平扩展为 HA | Partially confirmed | Server 无本地 session，Redis/Postgres/S3 可外置；local RWO PVC 会迫使 Recreate/单副本，scanner 架构支持独立扩展。 |
| 升级和备份由项目完整自动化 | Unsupported | Flyway 自动迁移存在，但备份/恢复和对象存储一致性由运维方负责。 |

## 7. 推荐的一期最小集成

### 7.1 上游部署

1. 部署固定 `v0.2.17` 镜像，不使用 `latest` 或 `edge`；生产配置 `SKILLHUB_PUBLIC_BASE_URL`、TLS、secure cookie、强 bootstrap password，并在首次配置后关闭 bootstrap。
2. 使用外部 PostgreSQL、Redis 和 S3 兼容对象存储；小规模 PoC 可用 runtime script/Compose，但数据库与对象存储必须进入备份计划。
3. 默认开启 scanner，但把它当发布治理，不当安装完整性证明。
4. 为 dsh 创建最小 scope 的 API token；若一期目录全部 public，可先匿名读取，只有私有 namespace 再增加 token。

### 7.2 dsh SkillHub adapter 的一期端点

只实现以下六类调用：

1. `GET /api/web/labels`：构建分类筛选。
2. `GET /api/web/skills`：`q,namespace,label,sort,page,size`，规范化到 dsh 自有 `MarketplaceSkill`。
3. `GET /api/web/skills/{namespace}/{slug}`：详情和指标。
4. `GET .../versions` 与 `GET .../versions/{version}`：选择并固定版本。
5. `GET .../versions/{version}/files` 与 `GET .../versions/{version}/file?path=SKILL.md`：预览和安装前 manifest。
6. `GET .../versions/{version}/download`：Host 跟随受限 302 或直接流式下载。

不要在一期接入 `/api/v1` ClawHub compatibility、发布、review、rating/star 或管理员 API。不要让浏览器直接拿 presigned URL；dsh Host 转流并保留认证。

### 7.3 dsh 安装验证最小闭环

1. 以 `(registryInstanceId, namespace, slug, exactVersion)` 作为远程版本 identity；`registryInstanceId` 由配置产生，不能只用可变 base URL。
2. 在下载前读取文件清单和 `resolve.fingerprint`；下载到 staging，限制压缩包字节数、解压总量、文件数、单文件大小。
3. 拒绝绝对路径、`..`、drive/scheme、重复/大小写冲突路径、symlink/hardlink/device、Zip64/多磁盘及不支持的根布局。
4. 解压后逐文件 SHA-256 对照上游清单，拒绝缺失、额外或摘要不匹配；按上游算法重算 version fingerprint。
5. 解析根 `SKILL.md`，校验 name/slug、version 与请求版本，使用 dsh 自有 skill validator；预览不进入模型上下文。
6. 原子提交不可变包目录与安装记录，随后刷新 registry；启用/停用、更新和卸载全部由 dsh 本地状态机负责。

这比调用官方 CLI 更符合现有提案，因为 CLI 不提供启停，且 `--force` 更新不保留旧版本回滚。[CLI 安装行为](https://github.com/iflytek/skillhub/blob/f846da230cc0e06e4ab18c05911bb9b2cbd85ff1/cli/src/services/install-service.ts#L65-L119)

## 8. 一手资料仍无法回答的问题

1. 生产实例实际启用了哪些 auth provider、access policy、namespace 可见性与 token scopes；这些是部署配置，不是仓库固定事实。
2. 目标实例允许的 `sort` 字符串全集、分页最大 size，以及是否会在未来版本稳定保持 `/api/web` 契约。
3. 是否会为下载 ZIP 增加稳定的 `Digest`/ETag/bundle SHA-256 或签名；当前代码不能证明。
4. `resolve.fingerprint` 是否被官方承诺为公共长期契约；当前可由代码确认算法，但文档没有稳定性承诺。
5. `SKILL.md` 中“输入示例”“调用策略”等 dsh UI 字段采用什么标准扩展；核心 parser 只强制 `name` 和 `description`。
6. SkillHub instance 是否有不可变 instance UUID API；若无，dsh 必须自行配置 registry identity。
7. 对私有 S3 302 下载，presigned host allowlist 与 Authorization stripping 的官方运维约定；dsh 应自行实施严格策略。
8. Scanner 对脚本/提示注入的真实 false-positive/false-negative、是否 fail-open，以及组织最终准入 policy；仓库只有配置能力，无法替代部署决策。
9. PostgreSQL 与对象存储的事务一致备份/恢复 runbook、RPO/RTO 和灾备拓扑；官方 Helm 明确留给运维。
10. dsh 与 SkillHub 的版本兼容矩阵。建议 dsh adapter 启动时记录上游 version，并用固定 fixture 做 contract tests。

## 9. 实施决策

基于本次研究，原提案总体架构成立，但一期 spec 应明确加入以下变更：

- “分类”绑定 SkillHub labels，“版本通道”绑定 tags；
- 隐藏浏览量，除非部署实例新增经验证字段；
- 安装命令由 dsh 根据 registry/namespace/slug/version 生成，不等待上游字段；
- 完整性策略改为“文件清单 SHA-256 + version fingerprint”，并明确当前无签名；
- dsh 的下载代理默认不把 S3 presigned URL 暴露给浏览器；
- 上游 429 不依赖 `Retry-After`；
- 发布与治理二期使用 native publish/validate/review API；
- 所有 SkillHub API 与字段只存在于 Host adapter 内，并锁定/测试一个上游版本。

这组约束足以开始 dsh 一期的 adapter contract 和安装服务设计；尚不需要修改或 fork SkillHub。
