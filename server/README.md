# 云端最小数据平台（P1 骨架）

边缘采集器把数据分批上传到这里；这里负责鉴权、幂等入库、当前态与变更查询。扩展仍然只做界面与采集，不直接连数据库。

## 组成

- `src/app.js`：HTTP 路由与校验（零框架依赖，Node 内置 `http`）
- `src/store-memory.js`：内存实现，供契约测试
- `src/store-pg.js`：PostgreSQL 实现（`pg`）
- `src/domain.js`：复用扩展里已验证的纯领域模块（`data-core/identity/analyze/import-map/customer-profile`）
- `migrations/001_init.sql`：`source_batch` / `source_part` / `source_record` / `current_record`

> 领域模块不在 `server/` 内复制，构建时从 `src/` 拷进镜像的 `domain-src/`；本地开发直接读 `../src`。因此 Docker 构建上下文是**仓库根目录**（compose 已配置好），单独 `docker build server/` 会失败。

## 本地跑测试（不需要数据库）

```powershell
node --test server/test/imports.test.js
```

## 启动（Docker Compose）

```powershell
cd server
Copy-Item .env.example .env
# 修改 .env 里的 POSTGRES_PASSWORD 与 API_TOKEN
docker compose up -d --build
Invoke-WebRequest http://127.0.0.1:8787/health -UseBasicParsing
```

`api` 只绑定 `127.0.0.1:8787`，公网访问请在前面加 Caddy/Nginx 做 HTTPS 与限流。

生产部署（阿里云轻量应用服务器 + 已备案域名 + Caddy 自动证书 + 每日备份/恢复演练）见 [deploy/README.md](./deploy/README.md)。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 免鉴权健康检查 |
| POST | `/imports` | 建导入批次：`{kind, meta?}`，返回 `import_id` |
| PUT | `/imports/{id}/parts/{n}` | 上传第 n 个分片：`{rows:[{platform_id,payload,business_at?,observed_at?}], checksum?}` |
| POST | `/imports/{id}/commit` | 提交并入库，返回 `{received,inserted,updated,skipped,part_count}` |
| GET | `/sync/status` | 逐数据类型：最后成功时间、最新业务时间、行数 |
| GET | `/changes?since=&limit=` | 增量拉取当前态（游标为响应里的 `cursor`） |
| GET | `/dashboard/summary` | 工作台摘要：逐源健康、缺口清单、最近 5 个批次 |
| GET | `/api/overview` | 业务概览：摘要 + 复用 `analyze.home` 计算的 KPI 与待办 |
| GET | `/api/inquiries` | 询盘列表：`page/pageSize/q/country/source/added/grade` |
| GET | `/api/employees` | 员工列表（含店铺、角色、状态） |
| POST | `/api/employees` | 创建员工：`{email, name, password, role, seller_id}` |
| PATCH | `/api/employees/{id}` | 编辑员工：`{email?, name?, role?, seller_id?, status?, password?}` |
| GET | `/api/send-control` | 店铺级发送停机开关 |
| PUT | `/api/send-control` | 设置停机：`{paused, reason?}`（仅 admin） |
| GET | `/api/dnc` | 不联系名单：默认只返回生效中，`active=0` 含过期 |
| POST | `/api/dnc` | 加入/更新名单：`{customer_key, reason?, until?}`（仅 admin） |
| DELETE | `/api/dnc?customer_key=` | 从名单移除（仅 admin） |
| GET | `/` | 只读工作台页面（免鉴权，页面内登录） |

鉴权：除 `/health`、`/` 与静态资源外都需要 `Authorization: Bearer $API_TOKEN`。

### 发送复核（DNC / 店铺停机）

- `/api/executions` 与 `/api/executions/{id}/claim` 都会重新检查店铺停机开关和 `do_not_contact`，并在 `gate.reasons` 返回 `store_paused` / `dnc`。
- 领取动作在存储层还有原子条件：列表返回后即使立刻加入 DNC 或停机，也不会被领取。
- 过期 DNC（`until` 已过）自动失效；客户键兼容 `123` 与 `inquiry:123` 两种写法。
- 停机开关与 DNC 管理仅 admin 可用；执行台页面可直接切换停机并查看阻断原因。
- 所有数据类型（询盘/客户/公海/订单/聊天/访客）都按“非空覆盖”合并：主账号与子账号共用同一 `seller_id` 时，子账号的局部快照不会用空值冲掉主账号已有字段。

## 只读工作台

打开 `http://127.0.0.1:8787/`，输入服务端 `API_TOKEN`（只存在当前标签页的 `sessionStorage`），页面每 60 秒自动刷新。

- **KPI**：数据源数量、当前态总行数、最近成功时间、缺口数。
- **数据源健康**：每种类型的行数、批次数、最后成功时间、最新业务时间、状态（正常 / 超过 24 小时延迟 / 空）。
- **缺口清单**：按阈值生成，P0 优先：
  - 询盘缺客户名称 ≥20% → P0（无法识别身份、补等级、匹配聊天与成交）
  - 广告商机缺买家资料 ≥30% → P0
  - 买家等级缺失 ≥50% → P1
  - 订单缺询盘 ID ≥50% → P1
  - 数据源超过 24 小时未更新 → P1；预期数据源为空 → P2
- **最近导入批次**：最近 5 个已提交批次的类型、行数与提交时间。

## 幂等与覆盖规则

- 同一批次、同一分片号：内容相同（校验和一致）返回 `duplicate: true`；内容不同返回 `409 part_conflict`。
- 已提交批次不能再传分片（`409 import_committed`）；重复 commit 返回同一结果。
- 同一 `platform_id`：`business_at` 更旧的行计入 `skipped`，不覆盖当前态；业务时间未知时按可更新处理。
- 所有数据都带 `tenant_id + seller_id`，服务端只接受 `.env` 里配置的 `SELLER_ID`。

## 已知边界（下一版再补）

- v1 用 `current_record.payload` 存整行 JSON，先保证契约与幂等；后续再拆 `inquiry/customer/message/order` 等强类型表。
- 聊天没有稳定平台消息 ID，`platform_id` 只能用低置信度临时键（会话+时间+内容摘要），不能作为发送幂等依据。
- 未做 OAuth/多用户登录，仅单店铺 + 单服务令牌；接第二个店铺前必须补身份与权限。
- 工作台只读：不能在前端修改阶段、分配任务或触发补采；这些动作要等员工身份与权限模型落地。
- 图片/原始报表未接入对象存储，当前只存结构化行。
