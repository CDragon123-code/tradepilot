# 阿里云生产部署（轻量应用服务器 · 已备案域名）

适用：`server/` 这套 API + PostgreSQL + Caddy；采集仍由扩展在内网浏览器完成，云上只负责存储、校验与展示。

## 0. 前置条件

- 阿里云**轻量应用服务器**，Ubuntu 24.04 LTS，2C4G / 60GB 起（后续云端跑浏览器再升配）。
- 已在工信部完成备案的域名，准备一个子域，例如 `api.example.com`。
- 控制台「防火墙」放行：`22`（限制为你的办公 IP）、`80`、`443`。
- 服务器时区统一 `Asia/Shanghai`。

## 1. 安装 Docker

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # 重新登录后生效
```

> 若 `docker-compose-v2` 源不可用，改用官方脚本 `curl -fsSL https://get.docker.com | sudo sh`，或配置阿里云 Docker 镜像加速。

## 2. 上传代码

在本地项目根目录执行（把 `root@<服务器IP>` 换成实际地址）：

```bash
scp -r server src root@<服务器IP>:/opt/ali-cloud
```

> 构建上下文是仓库根目录：镜像会从 `src/` 拷入 6 个纯领域模块。不要把 `src/` 删掉，也不要单独 `docker build server/`。

服务器上确认目录：

```text
/opt/ali-cloud/
├── src/                # 扩展源码；只用到 data-core / identity / analyze / import-map / customer-profile / dify
└── server/
    ├── src/  migrations/  public/  Dockerfile  package.json
    └── deploy/
        ├── docker-compose.prod.yml
        ├── Caddyfile
        ├── backup.sh  restore-drill.sh
        └── .env.production.example
```

## 3. 配置环境变量

### 方式 A：一键脚本（推荐）

```bash
cd /opt/ali-cloud/server/deploy
chmod +x bootstrap.sh
sudo ./bootstrap.sh --domain api.example.com --seller seller-main --with-backup-cron
```

脚本会：安装 Docker → 生成 `.env`（随机数据库密码 + 采集/只读两个令牌）→ 构建并启动 → 健康检查 → 可选安装每日备份与巡检任务。结束时打印访问地址与两个令牌。

### 方式 B：手工配置

```bash
cd /opt/ali-cloud/server/deploy
cp .env.production.example .env
openssl rand -hex 24     # 用作 POSTGRES_PASSWORD
openssl rand -hex 32     # 用作 INGEST_TOKEN（采集器专用）
openssl rand -hex 32     # 用作 READ_TOKEN（员工端只读）
nano .env                # 填 DOMAIN / POSTGRES_PASSWORD / INGEST_TOKEN / READ_TOKEN / SELLER_ID
chmod 600 .env
chmod +x backup.sh restore-drill.sh
mkdir -p backups logs
```

注意：

- `POSTGRES_PASSWORD` 建议只用字母数字；如必须含 `@ : / #` 等字符，请直接设置完整 `DATABASE_URL`（Compose 会优先使用它）。
- `INGEST_TOKEN` 只给采集器（扩展）用，只能写导入接口；`READ_TOKEN` 只给工作台/员工端，只能读。两者都不该出现在前端源码里。
- 旧部署仍只有 `API_TOKEN` 也能启动（读写同权），但日志会提示 `token_not_separated`，建议尽快拆开。

## 4. 启动

> 已用方式 A 的 `bootstrap.sh`，本节可跳过。

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
curl -fsS http://127.0.0.1:8787/health || true   # 容器内端口不对外，正常会连接失败
docker compose -f docker-compose.prod.yml logs -f api
```

日志出现 `{"msg":"listening","port":8787,"store":"pg"}` 即正常；首次启动会自动执行 `migrations/`。

健康检查会同时探测数据库与磁盘，异常时返回 503：

```bash
docker compose -f docker-compose.prod.yml exec -T api node -e "fetch('http://127.0.0.1:8787/health').then(r=>r.text().then(t=>console.log(r.status,t)))"
```

导入性能基准（独立 `bench-test` 卖家，跑完自动清理，不影响真实数据）：

```bash
docker compose -f docker-compose.prod.yml exec -T api node src/bench-commit.js 50000
# 输出示例：{"rows":50000,"commit_ms":1200,"rows_per_sec_commit":41666,...}
```

## 5. 域名与 HTTPS

1. 在 DNS 里给 `api.example.com` 加 A 记录，指向轻量服务器公网 IP。
2. 等解析生效：`ping api.example.com`。
3. Caddy 会自动申请证书，确认：

```bash
curl -fsS https://api.example.com/health
docker compose -f docker-compose.prod.yml logs --tail=50 caddy
```

> 证书失败通常是：80 端口未放行、备案未完成、DNS 未生效。三者解决后执行 `docker compose -f docker-compose.prod.yml restart caddy`。

### 无域名临时访问（IP + 8443）

域名与备案未就绪时，可先用自签证书跑通全链路：

```bash
sudo ./bootstrap.sh --ip-mode --ip <公网IP> --with-backup-cron
```

- 访问 `https://<公网IP>:8443/`，浏览器提示证书不受信任属正常（Caddy 内部 CA）。
- 需在云防火墙放行 TCP 8443。
- 该模式使用 `docker-compose.ip.yml` + `Caddyfile.ip`；两个 `Caddyfile` 的 `roll_size` 必须写在 `output file {}` 内，否则 Caddy 启动报 `unrecognized subdirective`。
- 浏览器访问纯 IP 不发送 SNI，`Caddyfile.ip` 里的 `default_sni` 不能删，否则 TLS 握手返回 `internal error`。
- 备案完成后改回 `--domain` 模式即可，数据不受影响。

#### 域名已解析但未备案（不建议作为主入口）

域名审核通过、备案还没下来时，`Caddyfile.ip` 里可以同时挂两个站点块（均 `tls internal`）：

```text
https://api.example.com:8443          # 实际可用：境内直连正常
https://api.example.com:8443    # 域名：境内直连会被重置，见下
```

在云解析给子域加 `A` 记录指向服务器公网 IP 后，重建 caddy 生效：

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.ip.yml up -d --force-recreate caddy
curl -kfsS https://api.example.com:8443/health
```

> **未备案域名会被按 SNI 阻断**：实测境内直连 `https://api.example.com:8443` 在 TLS 握手阶段即被 `Connection was reset`，而同一 IP 不带 SNI 访问正常；用其他 SNI 指向同一 IP 也能拿到 Caddy 响应 → 说明拦截按域名（SNI）生效，不是端口或 Caddy 问题。因此备案完成前请用 IP 地址访问，域名留给备案通过后的 443 正式模式。
>
> 另外 8443 这类非标准端口在部分公司代理/VPN 下也会被拦（本机 Clash 开代理时即失败，`curl --noproxy "*"` 直连可验证）。

### Docker Hub 拉取超时（大陆服务器）

在 `/etc/docker/daemon.json` 配置镜像加速并重启 Docker（可参考 `setup-docker-mirror.sh`）：

```json
{ "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run", "https://docker.xuanyuan.me"] }
```

## 6. 扩展接入（登录即用，无需手填地址）

员工装好扩展后，首次会自动打开设置页，只需输入邮箱和密码：

1. 扩展设置页 → 云端同步 → 填「员工邮箱 / 密码」→ 点「登录并启用云端」。
2. 登录成功后扩展会：自动探测云端地址（域名不通时回落公网 IP）→ 写入会话令牌 → 绑定店铺 → 开启自动上传 → 自动补传现有资料库并清空队列。
3. 会话 30 天有效，期间重启浏览器不用再登录；过期后设置页会提示「登录已过期，请在设置页重新登录」。

创建/重置员工账号（服务器上执行，密码至少 8 位）：

```bash
docker exec ali-cloud-api-1 node src/user-cli.js add alice@company.com 'StrongPass123' \
  --name 爱丽丝 --role operator --seller seller-main
docker exec ali-cloud-api-1 node src/user-cli.js list
```

角色：`admin`（管理） / `operator`（可读可采） / `viewer`（只读）。

工作台网页 `https://<地址>/` 仍支持直接输入 `READ_TOKEN`，但推荐用员工账号登录后的会话。

### 管理后台（/admin）

管理员打开 `https://<地址>/admin`（自签证书需先点「继续前往」），用管理员邮箱密码登录后可：

- 创建员工账号：邮箱、姓名、初始密码、角色（admin / operator / viewer）、店铺 ID；
- 重置任意员工密码；
- 停用 / 启用账号（停用后立即无法登录）；
- 删除账号（会连带清除会话，不可恢复；不能删自己，也不会删掉最后一个启用的管理员）。

接口：`GET/POST /api/employees`、`PATCH/DELETE /api/employees/:id`，全部要求管理员会话。

### 智能业务员 / AI 运营台（/agents）

管理员打开 `https://<地址>/agents`，用同一个管理员账号登录。**全平台共用一套 Dify 知识库**（`.env` 里的 `DIFY_API_KEY`），业务员只决定人设、每日上限和负责的客户范围。

1. **运营总览**：待人工、已出草稿、已通过、业务员数、进行中任务、未回复询盘。
2. **新建业务员**：名称、人设（前置到提示词）、每日上限。
3. **分配客户**：按国家 / 买家等级 / 来源 / 回复状态筛选；免打扰客户自动排除。
4. **建任务**：按已分配客户生成任务项（幂等键 = 任务 + 客户 + 剧本版本）。
5. **生成草稿**：服务端调 Dify，返回草稿 + 知识引用，并写入 `ai_run`。
6. **守门规则（7 条）**：价格/报价、交期/发货、付款条件、认证/资质、保证/承诺、站外联系方式、独家代理。命中 `block` 级直接转 `review_required`，进「待人工介入」队列；`warn` 级保留草稿但标记。
7. **待人工介入**：草稿按守门命中优先排序，人工「通过 / 驳回」后出队。

接口：`/api/agents`、`/api/agents/:id/assign|assignments|unassign`、`/api/tasks`、`/api/tasks/:id/items`、`/api/task-items/:id`、`POST /api/task-items/:id/draft`、`GET /api/review-queue`、`GET /api/ops/overview`、`GET /api/platform/ai`。

`.env` 需要：`DIFY_API_KEY`（平台共用）、`DIFY_BASE_URL`（默认 `https://api.dify.ai/v1`）、`SECRET_KEY`（其他第三方密钥加密用）。

> **云端优先数据**：登录后扩展的看板/分析直接读 `GET /api/dataset`（同一套云端数据库），采集入库自动增量上传；本机 IndexedDB 仅作离线缓存。单轮最多上传 8 个队列项，未传完会自动 1 分钟后续传，无需手动点同步。

> **时效与互通**：扩展每 5 分钟上报心跳（版本、待传行数、本机各类型条数）；`GET /api/freshness` 返回每个数据源的新鲜度（≤30 分钟 fresh / ≤120 分钟 delayed / 超时 stale）以及「本机比云端多出的条数」，可直接发现漏传。设置页会显示一行汇总。断更告警阈值默认 2 小时（`STALE_HOURS` 可调）。

### 云端采集器（可选，关机也能采）

只读采集询盘，不发送消息。用专用工作号更安全。

```bash
cd /opt/ali-cloud/server/deploy
# 首次启动（会拉取 Playwright 镜像，约 2GB）
docker compose -f docker-compose.prod.yml -f docker-compose.ip.yml -f docker-compose.collector.yml --profile collector up -d --build collector

# 单次试跑
docker exec -e RUN_ONCE=1 ali-cloud-collector-1 node src/index.js
docker logs --tail=30 ali-cloud-collector-1
```

首次使用：

1. 在浏览器登录**专用工作号**并打开阿里后台；
2. 扩展设置页 →「同步登录态到云端」（需管理员账号）；
3. 采集器下一轮自动使用；也可用上面的单次试跑立即验证。

> **登录态自动续期**（扩展 v0.35.3+）：首次手动同步即视为授权，之后扩展每 12 小时比对登录相关 cookie（`cookie2`/`_m_h5_tk`/`xlly_s` 等），有变化才重新上传，无变化跳过。设置页会显示「登录态云端托管：X 小时前同步」以及云端采集器的最近结论（`login_expired` 时标红并提示重新登录）。关闭自动续期后需手动点按钮。

> 登录态失效只能人工重新登录（阿里要求账号密码/验证码），无法自动绕过；自动续期只是把「已登录浏览器里的新 cookie」及时同步到云端，避免因遗忘点击而导致长期断更。

可调参数（`.env`）：`INQUIRY_URL`（默认 `https://i.alibaba.com/hub/alicrm/inquiryList.htm`）、`COLLECTOR_INTERVAL`（默认 60 分钟）、`COLLECTOR_RUN_ONCE`。

> 内存：2C2G 下单次运行实测可用（used 638MB / available 974MB），但**不要与其它重任务并发**；建议长期使用升到 4G。登录失效会写 `login_expired` 并上报心跳，不会反复重试轰炸平台。

> **注意**：目前只到「草稿 + 人工确认 + 白名单自动发送」；自动发送默认关闭，仅白名单客户生效。

### 智能体工作台（/console）

`https://<地址>/console`：以会话为单位与智能体实时对话。

- 新建会话：选业务员 + 客户询盘 ID；同一 `业务员 × 客户 × 渠道` 复用同一会话。
- **流式对话**：`POST /api/threads/:id/turn` 返回 SSE（`delta` 增量 / `guard` 守门 / `done` 收尾）。
- **卡点转人工**：守门命中时自动生成升级单，会话转 `waiting_human`；在工作台填写人工结论 → 写入会话 → **自动续跑一个回合**。
- **客户分配建议**：点「让智能体评估」，对未分配询盘按待回复/时效/买家等级/资料完整度打分并给出理由，人工「采纳 / 忽略」；采纳即写入客户归属。

相关接口：`/api/threads`、`/api/threads/:id`、`/api/threads/:id/turn`、`/api/escalations`、`/api/escalations/:id/resolve`、`/api/agents/:id/suggestions`、`/api/suggestions`、`/api/suggestions/:id/accept|reject`。

### 执行台（扩展内，/executor.html）

云端「待人工介入」通过后的草稿会进入执行队列，员工在扩展里执行并回写结果：

1. 扩展设置页 →「打开执行台」，或直接访问 `chrome-extension://<扩展ID>/executor.html`。
2. 列表显示客户、国家、主题与完整话术；点「打开阿里聊天」在新标签打开 `message.alibaba.com`。
3. 复制话术 → 在阿里聊天窗口粘贴发送 → 回来点「标记已发送」（失败则填原因）。
4. 云端 `/console` 也有执行台卡片与「打开阿里国际站」按钮，便于随时核对。

> **同窗并排**：扩展已把执行台注册为 Chrome 侧边栏（`chrome.sidePanel`）。在设置页点「侧边栏工作台」，或右键工具栏图标选择侧边栏，即可「左侧阿里页面 + 右侧智能体」同一窗口使用。阿里禁止 iframe 嵌入，因此不再提供网页内嵌方案。

接口：`GET /api/executions`、`POST /api/executions/:id/claim`、`POST /api/executions/:id/result`。

### 发送闸门（M2.3）

`GET /api/executions` 现在返回每条草稿的 `gate` 与整页的 `allowed_count / blocked_count`：

```json
{ "allowed": false,
  "reasons": [{ "code": "quiet_hours", "label": "静默时段 23:00–07:00" }],
  "daily_used": 3, "daily_limit": 20, "tz_offset_minutes": 480,
  "local_time": "23:30", "next_allowed_at": "2026-11-13T23:00:00.000Z" }
```

- **每日上限**：按店铺本地时区统计当天 `sent_confirmed` 条数，触顶即阻断，次日零点恢复。
- **同客户冷却**：`ai_agent.cooldown_hours`（默认 24）内同一客户不重复发送。
- **静默时段**：`ai_agent.quiet_start / quiet_end`（默认 23:00–07:00），支持跨零点。
- **业务员暂停**：`status != active` 直接阻断。
- 时区用 `ai_agent.tz_offset_minutes`（默认 480，东八区），不依赖服务器本地时区。

`POST /api/executions/:id/claim` 会**再算一次闸门**，命中则返回 `409 gate_blocked` 与 `reasons`。

### 执行租约与自动发送（M2.4）

- **领取租约**：`POST /api/executions/:id/claim` 原子把 `approved → sending`，返回 `claim_token` 与 `expires_at`（默认 300 秒）。租约未过期时第二个客户端得到 `409 claimed_by_other`；过期可抢占，避免崩溃后任务永久卡住。
- **结果三态**：`POST /api/executions/:id/result` 接受 `sent / failed / uncertain`。`uncertain` 表示页面未回执，交人工核实，不计入当日上限、也不会被自动重发。同状态重复回写返回 `idempotent: true`；把已成功的改判为失败返回 `409 status_conflict`。
- **扩展自动发送**：设置页 →「自动发送」，**默认关闭**。开启后每 5 分钟检查一次队列，只处理白名单（客户名 / 询盘 ID）内的条目，单轮最多 N 条（默认 2），条间随机间隔（默认 25–60 秒）。每条先 claim 再打开对应会话发送，90 秒内无回执标记 `uncertain`。
- 页面发送复用工作台已验证的 `aliSmartReply` 链路（搜索定位会话 → 填入 → 点击发送 → 校验消息区），不发任何未经批准的内容。

> 当前为「人工执行台 + 白名单自动发送」双通道；自动发送只对白名单客户生效，其余仍需人工粘贴发送。

## 7. 每日备份 + 巡检 + 询盘提醒

本机备份（默认保留 7 天）：

```bash
cd /opt/ali-cloud/server/deploy && ./backup.sh
```

配置定时任务（03:00 备份、09:00 巡检、每 10 分钟询盘提醒）：

```bash
crontab -e
# 追加：
0 3 * * * cd /opt/ali-cloud/server/deploy && ./backup.sh >> ./logs/backup.log 2>&1
0 9 * * * docker exec ali-cloud-api-1 node src/alert-cli.js >> /opt/ali-cloud/server/deploy/logs/alert.log 2>&1
*/10 * * * * docker exec ali-cloud-api-1 node src/reminder-cli.js >> /opt/ali-cloud/server/deploy/logs/reminder.log 2>&1
```

两类推送都走 `FEISHU_WEBHOOK`（或 `FEISHU_APP_ID/APP_SECRET/CHAT_ID` 自建应用），全部在服务器执行，本地不需要开任何程序：

- **询盘提醒**（每 10 分钟）：扫 `current_record` 里未回复的询盘，24 小时内为 P0、72 小时内为 P1；同一询盘同一优先级 12 小时内不重复推送。
- **异常巡检**（每天 09:00）：数据源断更、从未成功同步、采集器登录态、磁盘 ≥90%、数据库不可用。

巡检降噪规则（避免夜间误报刷屏）：

- **仅在业务时段报数据断更**：默认 08:00–20:00（`ACTIVE_START_HOUR` / `ACTIVE_END_HOUR`），夜间不采集属正常。
- **全部停更合并成一条**：如「全部 6 个数据源停更 19.7 小时（最近更新 11-13 17:21）」，不再逐条列出 6 行。
- **阈值** `STALE_HOURS` 默认 3 小时。
- **采集器提示**：区分「登录态未托管」「登录态已失效」「容器未上报」三种情况，并直接给出下一步动作（如：重新登录阿里 → 扩展设置页点「同步登录态到云端」）。
- 磁盘与数据库属硬故障，任何时段都推送。

手动验证：

```bash
docker exec -e REMINDER_WINDOW_HOURS=720 ali-cloud-api-1 node src/reminder-cli.js --dry-run
docker exec ali-cloud-api-1 node src/alert-cli.js --dry-run   # 只打印不推送
docker exec ali-cloud-api-1 node src/alert-cli.js             # 立即推送一次
```

上传阿里云 OSS（可选，异地容灾）：

```bash
# 安装 ossutil 后配置 endpoint / AccessKey（RAM 子账号，仅授权该 Bucket）
ossutil config
# 在 .env 里设置 OSS_BUCKET=your-bucket，之后 backup.sh 会自动上传
```

每月至少做一次恢复演练（恢复到临时库、核对行数后自动删除）：

```bash
cd /opt/ali-cloud/server/deploy && ./restore-drill.sh
```

验收目标：RPO ≤ 15 分钟（按当前日备为 24 小时，后续可加 WAL 归档），RTO ≤ 4 小时；先把「最近一次恢复用时」记录在案。

## 8. 升级与回滚

```bash
cd /opt/ali-cloud
git pull          # 或重新 scp 覆盖
cd server/deploy && docker compose -f docker-compose.prod.yml up -d --build api
```

- 迁移是增量的，启动时自动执行；不要手工改 `schema_migrations`。
- 回滚：`git checkout <上一个可用提交>` 后重新 `up -d --build api`；数据库结构保持向前兼容。
- 升级前先跑一次 `./backup.sh`。

## 9. 排错清单

| 现象 | 排查 |
|---|---|
| 证书申请失败 | 80 未放行 / 备案未完成 / DNS 未生效；看 `logs/caddy` 与 `docker compose logs caddy` |
| API 起不来 | `docker compose logs api`；多为 `DATABASE_URL` 密码含特殊字符或两个令牌都为空 |
| 扩展上传 401 | 扩展里填的是 `INGEST_TOKEN`，不是 `READ_TOKEN`；改完点保存 |
| 工作台 401 | 工作台登录要 `READ_TOKEN`；采集令牌不能读 |
| 扩展上传超时 | 服务器出网/入网带宽、Caddy 日志；确认 `https://域名/health` 可达 |
| 磁盘增长快 | `docker system df`；日志已按 10MB×3 轮转，备份保留 7 天 |
| 数据源显示「延迟」 | 采集器/浏览器没在运行，或平台登录态失效；工作台会按 24 小时阈值提示 |

## 10. 安全基线

- SSH 只用密钥登录，禁用密码；22 端口只允许固定 IP。
- 不把 `8787`、`5432` 映射到公网（生产 Compose 已不映射）。
- `.env` 权限 600，不进 Git；`INGEST_TOKEN` / `READ_TOKEN` 定期轮换（轮换后同步改扩展设置与工作台登录）。
- 日志为单行 JSON（含 `request_id`），可用 `docker compose logs api | grep '"level":"warn"'` 快速定位鉴权失败与 5xx。
- 系统每月 `apt upgrade`，Docker 镜像随版本升级。
- 客户数据只存在本店服务器与你的 OSS Bucket；OSS 使用私有读写 + 生命周期规则。

