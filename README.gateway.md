# New API 统一模型网关 · 首版部署

此目录基于 QuantumNous/new-api，保留原项目的账户、令牌、钱包、计费、渠道和管理界面。上游基线提交为 `669d774976369e986f03b6e24fff1042f6f94832`（2026-11-17）。本地扩展服务于 `llm-auto` 模型池；网关、PostgreSQL、Redis 通过同一套 Compose 管理。

YeShell 只需要网关地址、网关签发的 API Key 和模型名 `llm-auto`。上游可以是现成的直连 LLM 接口，也可以是 FRP 暴露的接口；网关不负责部署或启动 GPU 模型。

## 1. 在测试服务器启动

准备 Linux 服务器、Git、Docker Engine 和 `docker compose` 插件（v2 或更新版本）。建议测试机有 4 核 CPU、8 GB 内存和 20 GB 可用磁盘；首次在服务器构建 Go 和前端会占用额外内存和时间，不需要 GPU。直接克隆源码即可，Docker 会完成前后端编译，不需要 tar 包或在宿主机安装 Go、Bun。

```bash
git clone https://github.com/yesifu/yeper-llm-proxy.git
cd yeper-llm-proxy
./deploy/gateway.sh config --quiet
./deploy/gateway.sh up -d --build
./deploy/gateway.sh ps
./deploy/gateway.sh logs --tail=100 gateway
```

不需要执行 init，也不需要创建 `.env`。测试账号、密码、固定应用密钥直接写在 `compose.gateway.yml`：

| 用途 | 用户名 | 密码 |
| --- | --- | --- |
| 网关管理员 | `admin` | `Ab123456!@#` |
| PostgreSQL | `newapi` | `Ab123456!@#` |
| Redis | `default` | `Ab123456!@#` |

修改文件顶部的 `x-test-password`，即可统一设置**首次安装**的三个密码；修改 `gateway.environment.INITIAL_ADMIN_USERNAME` 可换管理员用户名。`SESSION_SECRET`、`CRYPTO_SECRET` 也已固定在 `gateway.environment` 中，不需要生成或记忆。连接串由容器启动脚本自动拼接并编码，`@`、`#` 等特殊字符不用手工转义。

空数据库首次启动自动创建管理员。已有管理员或已完成初始化的数据库不会被重置，之后修改后台登录密码请使用个人资料中的改密功能；PostgreSQL 已有数据卷时，修改 Compose 密码还需要同步修改数据库角色密码。应用密钥与登录密码分别配置，已有数据时保持 `CRYPTO_SECRET` 稳定。

这里要使用 `deploy/gateway.sh` 或显式指定 `-f compose.gateway.yml`。根目录原版 `docker-compose.yml` 仍是 New API 上游配置，直接运行裸 `docker compose up` 会选择原版配置。

默认仅监听服务器 `127.0.0.1:3000`，数据库和 Redis 没有宿主机端口映射。可在自己电脑建立 SSH 隧道，再浏览 `http://127.0.0.1:3000`，直接使用上述管理员账号登录：

```bash
ssh -L 3000:127.0.0.1:3000 用户名@服务器地址
```

如需在受控测试网络直连，可将 Compose 的 `gateway.ports` 改成 `"0.0.0.0:3000:3000"`，限制服务器防火墙允许访问的来源，再执行 `./deploy/gateway.sh up -d`。公网客户访问时，在网关前配置 HTTPS 反向代理；在 `gateway.environment` 设置 `SESSION_COOKIE_SECURE: "true"`、`SESSION_COOKIE_TRUSTED_URL: "https://你的域名"` 和 `TRUSTED_PROXIES: "实际反向代理的IP或网段"`，再重建网关容器。代理需要关闭 SSE 响应缓冲并允许较长读取超时。

## 2. 配置渠道和自动池

1. 在 New API **渠道**中添加已有的模型服务，填写渠道类型、Base URL、上游 Key、模型列表和用户分组。自有兼容接口优先使用 OpenAI 兼容渠道，URL 的填写方式沿用 New API 相应渠道类型要求。
2. 在原有模型定价页面为**实际底层模型名**配置价格。`llm-auto` 是对外路由入口；不同底层模型按各自的定价结算。自有模型没有系统内置价时，应先补齐定价再放入池。
3. 在**自动模型池**页面（`/auto-pool`）点击**从渠道添加**，按名称选择已有渠道，再选择该渠道已配置的模型。单模型渠道自动选中，多模型渠道支持一次添加多个；已入池的相同渠道／渠道模型不会重复添加。不同别名即使映射到同一实际模型，也可以分别加入，保留各自的路由匹配规则；卡片显示“渠道模型 → 实际模型”。地址、Key 和模型映射复用渠道配置，不需要手输渠道 ID、模型名或节点标识。禁用或不兼容的渠道会说明原因。
4. 添加后卡片显示渠道名称和实际模型，可直接调整权重、并发上限和调度状态。新节点默认权重 `100`、并发上限 `1`、状态为“接收请求”；权重 `0` 暂时不接收新请求。同一渠道的模型默认共享资源和并发上限。若不同渠道指向同一套推理服务，在**高级设置**中设置相同的共享资源标识；同一资源的并发上限同步调整。原有节点的资源分组会保留，上下文限制可在高级设置中调整。工具调用、视觉开关直接显示在节点卡片上；新节点默认关闭，按实际部署能力开启。YeShell 发起工具请求时，只有开启工具调用的节点会参与分配。
5. 点击**保存更改**，开启健康检测并启用自动池，再点击各节点的**立即探测**，或等待定时检查；要求健康时，首次探测成功前不会分配该成员。回收算力时将成员设为“排空”，等活动请求归零，再停止底层模型；“暂停”也停止接收新请求，自动健康检查不会把人工暂停改回接收状态。客户端始终发送 `llm-auto`。
6. 给客户创建普通平台 Key，设置相应分组和额度。Key 的**名称**只是备注，可以任意填写；要限制它只用自动池，在 **API 密钥 → 编辑 → 高级设置 → 模型限制**中选择 `llm-auto` 并保存。自动池启用且存在用户有权访问的有效渠道成员后，下拉列表会显示这个模型；模型限制留空表示允许所有模型，也可以调用自动池。实际调用时仍须在 YeShell 的**模型**字段填写 `llm-auto`。钱包、充值和消费记录继续使用 New API 原有功能。

渠道的分组访问权限仍生效。模型池成员声明的工具调用、视觉和上下文长度能力应与实际部署一致；把无工具能力的模型加入普通文本池并不意味着它能够处理 YeShell 的工具调用。高级自定义渠道支持已有 Chat / Responses 路由、自定义上游路径、认证和协议转换；按渠道模型名匹配路由，再转发实际模型并按实际模型计费。只配置 Chat 路由的成员不会接收 Responses 请求，探测会选择可用端点。仍禁止可能绕过模型改写的全局／渠道请求体透传、所选路由的请求体透传和渠道参数覆盖。

需要请求失败后切换到其他成员时，在 New API 的系统设置／请求处理策略中将全局重试次数 `RetryTimes` 设为 `1` 或 `2`，并保留相应的可重试状态码。上游默认 `0` 表示不重试。自动池沿用这套重试策略，每次重试排除已尝试成员；已向客户输出响应后不会再换模型。更贵的重试必须先补足预扣，最终仅按完成请求的模型结算。

**并发、健康与排空控制仅作用于 `llm-auto` 请求及池内探测。** 客户直接调用真实模型名会走 New API 原有路由，绕过自动池的容量和排空控制；同一 GPU 上通过网关以外入口发起的任务也不在统计内。首版应为池使用专用渠道和分组，并将客户 Key 的模型权限限制为 `llm-auto`。回收资源前同时确认没有其他入口仍在使用它。

健康检查会通过渠道适配器发送短推理请求，默认间隔 60 秒，最多 16 路并发，可能产生上游费用，但不扣客户钱包。暂停或排空的成员不做自动探测。首版自动池支持 HTTP `/v1/chat/completions` 和 `/v1/responses` 的文本、工具调用及声明了视觉能力的图片输入；音频、视频、文件、Realtime 和异步任务继续使用明确模型名的原有渠道。Responses 要求每次携带完整上下文，不支持 `previous_response_id` / `conversation` 跨请求状态。Redis 不可用时停止分配，避免并发额度失效。

配置有限上下文窗口时，纯文本按网关估算进行筛选。首版无法可靠估算媒体输入的完整上下文占用，有有限窗口的成员不会接收媒体请求；需要测试视觉时可用 `context_window=0` 关闭网关这一项筛选，实际长度仍由上游校验。

直连和 FRP 的区别仅在渠道 URL。FRP 可独立部署，已有公网 API 直接填写原始地址。Docker 内的 `127.0.0.1` 指容器自身；访问同机 FRP 服务可用 `host.docker.internal:端口`，但 FRP 端口须监听 Docker 可达的接口，并受防火墙限制。

Codex、Gemini 等来源继续复用 New API 对应渠道适配器与凭据机制；有已部署的 CLIProxy 等兼容接口时也可作为普通上游接入。本版不额外实现账户登录代理服务。每种上游应先用真实账户单独测试，再加入客户自动池。

## 3. YeShell 和请求验证

填写以下内容：

- 地址：`https://你的域名/v1`（本地隧道测试为 `http://127.0.0.1:3000/v1`）
- API Key：在此网关创建的客户 Key
- 模型：`llm-auto`

服务器具备 Python 3 时，可以运行验证脚本。脚本交互读取 Key，不把它写入文件或命令输出；默认会产生**两次实际计费请求**，分别测试普通响应和 SSE。`--tools` 额外发送一次工具调用请求。

```bash
python3 deploy/smoke.py --url http://127.0.0.1:3000
python3 deploy/smoke.py --url http://127.0.0.1:3000 --tools
```

也可通过环境变量 `GATEWAY_API_KEY` 注入 Key。完成后检查消费日志中的实际模型、渠道、用量和费用，确认使用的是实际模型价格。再逐个暂停、恢复成员，检查是否停止选入；对一个资源发起超过上限的并发请求，观察流式请求结束前额度是否仍被占用。

## 4. 镜像和构建源

默认采用 [DaoCloud 国内镜像代理](https://github.com/DaoCloud/public-image-mirror)，应用镜像始终从**本目录修改后的源码**构建，名字为 `new-api-gateway:local`。所有基础镜像固定 digest，避免可变标签带来意外升级：

| 用途 | 标签 | 可选环境覆盖 |
| --- | --- | --- |
| 数据库 | PostgreSQL `17.12-bookworm` | `POSTGRES_IMAGE` |
| Redis | Redis `7.4.12-bookworm` | `REDIS_IMAGE` |
| 前端构建 | Bun `1.4.4` | `BUN_IMAGE` |
| Go 构建 | Go `1.26.10-alpine` | `GO_IMAGE` |
| 运行环境 | Debian `bookworm-slim` | `RUNTIME_IMAGE` |

Go 模块默认 `goproxy.cn`，前端依赖默认 `registry.npmmirror.com`，Debian 软件包默认清华镜像。2026-11-18 已读取上述镜像 digest 的 registry manifest，均返回 HTTP 200 且包含 Linux amd64/arm64；同时检查了 Go/npm/Debian 镜像端点。**这不等于已经完成 Docker 拉取或容器运行测试**，你的服务器可能仍受镜像限流或网络影响。

切换官方源时，直接修改 Compose 中的五个镜像地址，将 `docker.m.daocloud.io/` 改为 `docker.io/`，保留标签和 digest；在 `gateway.build.args` 中设置 `GOPROXY: https://proxy.golang.org,direct`、`NPM_REGISTRY: https://registry.npmjs.org`、`APT_MIRROR: ""`，再构建。也可自行添加可选 `.env`，使用表中的变量覆盖镜像源；账号和密码以 Compose 中的配置为准。

## 5. 日常操作和数据

```bash
# 查看状态和滚动日志
./deploy/gateway.sh ps
./deploy/gateway.sh logs -f --tail=100 gateway

# 修改代码后重建网关，数据库和 Redis 数据卷保留
./deploy/gateway.sh up -d --build gateway

# 停止服务，保留命名卷
./deploy/gateway.sh down

# 备份业务数据库（先确保服务运行）
mkdir -p deploy/backups
./deploy/gateway.sh exec -T postgres pg_dump -U newapi -d newapi -Fc > deploy/backups/newapi.dump
```

PostgreSQL 数据保存在 `new-api-gateway_postgres_data`，Redis AOF 在 `new-api-gateway_redis_data`，网关工作数据在 `new-api-gateway_gateway_data`。账务持久化仍在数据库，Redis 服务于缓存和调度。备份当前 Compose 配置和业务数据库；`down -v` 会删除数据卷，不能用于普通重启。

本版按单网关服务部署。当前开发机器没有 Docker Engine；部署部分已使用 Compose v5.8.0 验证配置解析、变量替换、私有数据库端口、数据卷及就绪依赖；已检查启动脚本语法、密码特殊字符编码，并用临时模拟接口验证 smoke 脚本的普通响应、SSE 和工具调用检查。真正的镜像构建、容器首次启动、已有数据库升级以及真实模型端到端测试需要在测试服务器继续验证。

## 6. 已完成的开发验证

2026-11-18 验证结果：

- Go 后端编译及 Linux amd64 交叉编译通过；前端类型检查、修改文件 lint、17 项目标测试和生产构建通过。
- `controller`、`relay`、`relay/helper`、`middleware`、`service`、`i18n` 包测试通过。
- 自动池测试在真实 Redis 7.4.7 上通过，包括 `-race`；覆盖共享容量、租约过期、重试排除、工具历史、权限、暂停/排空、探测并发及 Redis 故障拒绝分配。
- SQLite 3.50.4、MySQL 8.4.11、PostgreSQL 17.11 的配置保存、重复加载、失败回滚和管理 API 授权测试通过。自动池复用现有 Option 表，没有新增表或迁移。
- 初始管理员在上述三种真实数据库上的测试通过：空库初始化、并发首次启动、无效配置回滚、重复启动，以及已有账号（含禁用或软删除账号）不被覆盖。`model`、`controller`、`middleware` 包测试通过。
- 使用当前容器入口脚本启动本机网关，连接 PostgreSQL 和启用密码认证的 Redis，验证固定密码中的 `@`、`#` 能正确传入；空库自动完成初始化，HTTP 登录成功、错误密码被拒绝。带有无效替换密码的第二次启动仍保留原账号、密码哈希与初始化记录。
- 模拟上游端到端验证通过：OpenAI 兼容/vLLM/SGLang 的实际模型映射和 token 价格；SSE 工具调用整个响应期间占用容量；故障切换补足预扣、价格快照、一次结算；余额不足时禁止更贵的重试并退款。
- 已将本机编译的网关连接真实 PostgreSQL、Redis 启动，完成浏览器登录、自动池成员编辑、保存和刷新回读验证。这些本机检查不替代 Docker 和真实 GPU 服务验收。
- 渠道选择改版：14 项前端交互测试、类型检查、lint、格式检查和生产构建通过；渠道目录在 SQLite 3.50.4、MySQL 8.4.11、PostgreSQL 17.11 的读取、模型映射、错误处理和权限测试通过。浏览器在实际非安全 HTTP 来源验证单模型自动选择、多模型批量添加、自动编号、共享并发、保存回读、重复过滤、不兼容提示和移动端弹窗。新增目录接口不返回上游 Key、地址或原始配置。
- 自定义渠道入池修复：15 项前端交互测试、类型检查、lint、格式检查、生产构建及 Linux amd64 后端构建通过；`go test -p 1 ./controller ./service -run '^TestAutoPool' -count=1 -race -v` 使用 SQLite 3.50.4、MySQL 8.4.11、PostgreSQL 17.11 和 Redis 7.4.7 通过。覆盖原生／转换路由、模型别名、Header／Query 认证、健康探测、实际模型扣费、SSE 容量、游乐场、保存回读和入池后开启透传的服务端拒绝；普通指定模型请求保留原渠道路由及定价。`go test ./relay/channel/advancedcustom ./middleware ./relay -count=1` 通过。测试使用本机模拟上游，尚未连接用户的真实 GPU 服务。

2026-11-19 补充验证：修复 API Key 编辑器和其他使用 `/api/user/models` 的模型选择列表缺少 `llm-auto`。`go test ./controller -run '^TestAutoPoolUserModelDiscoveryDatabaseMatrix' -count=1 -v` 在 SQLite 3.50.4、MySQL 8.4.11、PostgreSQL 17.11 上通过，使用下方相同的测试 DSN 环境变量；覆盖可访问分组、自动分组、重复成员、禁用／失效渠道和自定义路由。`go test ./controller -count=1`、本机构建和 Linux amd64 构建通过。列表沿用服务端分组授权，公开模型 API 保留 Key 模型权限和实际模型定价检查；参考 [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) 的逐请求权限检查原则，不以模型下拉列表替代请求鉴权。

复跑核心验证（Redis 必须使用专用的本地测试数据库；MySQL/PostgreSQL 测试会创建独立临时数据库）：

```bash
AUTO_POOL_TEST_REDIS=redis://127.0.0.1:6379/13 \
TEST_POSTGRES_DSN='postgresql://测试用户:密码@127.0.0.1:5432/postgres?sslmode=disable' \
TEST_MYSQL_DSN='测试用户:密码@tcp(127.0.0.1:3306)/mysql?parseTime=true' \
go test ./controller ./service -run '^TestAutoPool' -count=1 -race

go test ./controller ./relay ./relay/helper ./middleware ./service ./i18n

TEST_POSTGRES_DSN='postgresql://测试用户:密码@127.0.0.1:5432/postgres?sslmode=disable' \
TEST_MYSQL_DSN='测试用户:密码@tcp(127.0.0.1:3306)/mysql?parseTime=true' \
go test ./model -run '^TestBootstrapAdminDatabaseMatrix$' -count=1 -v
```

管理员测试会在所指定的 MySQL/PostgreSQL 数据库中创建随机前缀的临时表，并在完成后清理；请使用测试数据库。本机使用 PostgreSQL `127.0.0.1:15439/postgres`、MySQL `127.0.0.1:13369/mysql` 执行该命令，三个引擎均通过。

管理 API 沿用 New API 的管理员认证、ChannelRead/Write/Operate 权限及 PAT 范围校验；未替换登录或会话流程。环境变量只用于空库首次创建账号，密码使用原有校验和 Argon2id 哈希，初始化事务不创建会话或令牌，也不输出明文密码。相关回归参考了项目要求的 [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) 和 [ASVS 5.0.0](https://asvs.owasp.org/) 的输入校验、原子操作和密码处理要求（2.2.2、2.3.3、6.2.1、6.2.8）；这里记录的是本次变更的验证范围。
