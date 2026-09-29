# 实现计划 v2：Benchmark Viewer

规范：`spec.md`（权威）。术语：项目根目录 `CONTEXT.md`。项目根目录：`C:\PersonalFiles\benchmark-viewer`（新项目，非 git 仓库）。
测试夹具：`tests/fixtures/{leaderboard,models,pricing}.json`（真实上游样例的副本；实现与测试不得引用 `.scratch/research`）。

## 一、真实上游探针的发现（已验证）

用一次性 OpenResty 容器打了真实上游：

1. 官方榜单路径可用：容器内 DNS、TLS（需 `proxy_ssl_server_name on` 与 `proxy_ssl_name`）、Cloudflare 全部放行，固定请求体的 `POST` 返回 27 行；首次 MISS，第二次 HIT。
2. `proxy_pass_header Date` 后，命中缓存的 `Date` 是缓存写入时的上游时间，隔数秒不变；没有它 nginx 会用当前时间覆盖。
3. `proxy_hide_header Set-Cookie` 加 `proxy_ignore_headers Set-Cookie` 后，响应正常缓存且不下发 cookie。
4. BenchLM 静态文件返回 `Cache-Control: public, max-age=0, must-revalidate`，nginx 遵守而不缓存（实测连续 MISS）；必须 `proxy_ignore_headers Cache-Control Expires`。
5. 客户端 GET、上游 POST：`proxy_method POST` 加 `proxy_pass_request_body off` 加 `proxy_set_body`，缓存对客户端 GET 生效。
6. 镜像 `openresty/openresty:alpine`（1.31.1.1）：**没有 `envsubst`、没有 `curl`**；有 `sed`、`awk`、`sh`、`wget`。健康检查用 `wget`，地址写 `127.0.0.1`（避免 `localhost` 解析成 `::1`）。
7. Windows Docker Desktop：容器可通过 `host.docker.internal` 访问宿主机，模拟上游可以是宿主机上的 Node 脚本；本机有 Node 25 跑单元测试；8088 空闲。

## 二、对 spec 的两处修正（已同步进 spec.md）

- 官方接口没有任务数字段，顶部信息行显示"榜单行数 · 每行试验次数（`n_trials`）"，不显示任务数。
- 官方视图覆盖说明改为"未收录且有公开价格的（如 DeepSeek、Kimi、MiniMax）请看补充视图；无公开价格的开源或自托管模型（如 Qwen、GLM 的部分型号）两个视图都无法绘制"。

## 三、目录结构

```
Dockerfile
docker/
  nginx.conf.template      # 含 __占位符__，入口脚本用 sed 渲染
  entrypoint.sh
  lua/refresh.lua
web/
  index.html
  css/style.css
  js/{viewmodel,freshness,api,render,app}.js
  data/model-map.json
  vendor/                  # 只含需要的 D3 模块，随仓库分发
tests/
  fixtures/
  unit/                    # node:test
  integration/{mock-upstream.mjs, proxy.test.mjs}
  smoke/
README.md
```

## 四、模块接口约定

### 4.1 视图模型（`web/js/viewmodel.js`，ES 模块，纯函数，无 DOM、无 fetch）

数据路径：官方响应 `rows[].metadata.{model_display.label, agent_display.label, model_org.label, reasoning_effort, date}`、`rows[].metrics.{accuracy, accuracy_ci95_half_width, total_cost_usd, output_tokens, avg_trial_duration_sec}`、`rows[].n_trials`、`rows[].updated_at`、`pagination.{total,total_pages}`。BenchLM 模型文件与价格文件**顶层就是 `items[]`**（不是 `models.items`），模型项字段 `{slug, model, creator, releaseDate, benchmarks.agentic.aaTerminalBench4}`，价格项字段 `{slug, outputPrice}`，顶层 `generatedAt`（ISO）。

```
EFFORT_ORDER = ['none','low','medium','high','xhigh','max']
METRICS = { cost, outTokens, duration }   // 每个含 { key, label, unit, axisTitle, tooltipHtml, legendText }
  cost:      axisTitle '平均每任务成本（美元，实测）'，带 ⓘ 文案（spec A2）
  outTokens: axisTitle '平均每任务输出 token'，说明 '每次试验平均输出 token 数'
  duration:  axisTitle '平均单次耗时（秒）'，说明 '官方公布的平均单次试验耗时'
  legendText 统一为 '最优前沿：没有“<X 标签>更低且分数更高”的行'

normalizeLeaderboard(raw) -> { rows: Row[], truncated: boolean, notes: { ciMin, ciMax, nTrialsSet } }
  Row = { id, model, framework, org, effort, score, ciHalf, nTrials,
          cost, outTokens, durationSec, releaseDate, updatedAt }
  id = `${model}|${framework}|${effort}`；cost = total_cost_usd/n_trials；outTokens = output_tokens/n_trials；
  durationSec = avg_trial_duration_sec；releaseDate = metadata.date。
  output_tokens 与 avg_trial_duration_sec 是可选字段：缺失或非有限数时对应指标为 null（不得出现 NaN）。
  truncated = pagination.total_pages > 1 或 rows.length < pagination.total。
  notes.ciMin/ciMax 取全部行的 ciHalf 最小/最大，不受筛选影响。

FilterState = { models: { [model]: { selected: boolean, efforts: { [effort]: boolean } } } }
defaultFilter(rows) -> FilterState                      // 全部选中
toggleModel(filter, model) / toggleEffort(filter, model, effort) / selectAll(filter) / clearAll(filter) -> FilterState（不可变更新）

buildOfficialView({ rows, filter, metric, bestOnly }) -> OfficialView
  处理顺序：筛选 -> 指标缺失的行剔除（计入 missing）-> bestOnly -> 最优前沿与预算档。
  OfficialView = {
    metric: METRICS[metric],
    points:   [{ ...Row, x, y, onFrontier }],          // x 为所选指标值，y = score
    lines:    [{ key, model, framework, org, pointIds }],   // 同模型同框架，按档位顺序；可见点不足 2 个不出线
    frontier: { pointIds },                             // 按 x 升序
    budgetTable: null | [{ limit, best: Point[] }],     // 仅 metric==='cost'；limit = 5,10,15（累计阈值）
    filterTree: [{ model, org, total, selected, state:'all'|'some'|'none',
                   efforts:[{ effort, available, selected }] }],   // efforts 只列数据里任何模型出现过的档位
    counts: { selected, total },
    missing: number,                                    // 因缺少所选指标而未上图的行数
    truncated: boolean, notes: { ciMin, ciMax }
  }

computeFrontier(points) -> id[]
  x 越小越好、y 越大越好；q 压制 p 当且仅当 q.x<=p.x 且 q.y>=p.y 且至少一项严格；完全相同的点都保留。并列次序按 id 字典序。
pickBestPerModel(points) -> points   // 每个"模型+框架"取 y 最大者；并列取 x 更小；再并列按 id
budgetBest(points, limits) -> [{ limit, best }]   // 每档：x<=limit 的点里 y 最大者；并列全部返回，x 小者靠前；无点则 []

buildSupplementView({ models, pricing, modelMap, vendorFilter }) -> SupplementView
  modelMap: { [官方 model label]: string[] /* BenchLM slug 列表 */ }；alsoOfficial = 该 slug 出现在 modelMap 的任一值里。
  有 AA 分数 = aaTerminalBench4 != null（0 分有效，必须显示，Y 轴需留下边距）。
  price = pricing 中同 slug 的 outputPrice；slug 为 null 的价格项忽略；price 缺失、null 或 <=0 -> excluded（含无对应价格条目）。
  SupplementView = {
    points: [{ slug, model, creator, score, price, releaseDate, alsoOfficial, onFrontier }],
    frontier: { pointIds }, excluded: [{ slug, model }],
    vendors: [{ creator, total, selected }], snapshotAt: Date|null   // 取两文件 generatedAt 中较旧的
  }
  vendorFilter = { [creator]: boolean }，缺省视为全选；前沿在可见点上计算。
```

### 4.2 新鲜度（`web/js/freshness.js`）

```
evaluateFreshness({ upstreamUpdatedAtList, fetchedAt, now }) -> { upstreamUpdatedAt, fetchedAt, agoMs, warn }
  upstreamUpdatedAt = 各行 updated_at 最大值；warn 当且仅当 now - fetchedAt > 48h；fetchedAt 为空时 warn=false 且 fetchedAt=null。
formatAgo(ms) -> '刚刚'|'N 分钟前'|'N 小时前'|'N 天前'
summarizeRefresh({ beforeUpstreamUpdatedAt, afterUpstreamUpdatedAt, result }) -> { kind, text }
  kind: 'updated'|'unchanged'|'cooldown'|'failed'|'partial'；文案见 spec。
```

### 4.3 容器与代理（必须逐条满足）

**对外路径**：`GET /api/leaderboard`、`GET /api/benchlm/{models,pricing}.json`、`POST /api/refresh`、静态页面 `/`、`GET /healthz`。白名单外一律 404；白名单路径上 GET/HEAD 以外的方法返回 405；`/api/refresh` 用 GET 返回 405。

**每个代理 location**：
- 缓存键为**每个文件一个字面量**（例如 `leaderboard`、`benchlm:models`、`benchlm:pricing`）；刷新用的内部 location 必须使用**完全相同的键**。
- 上游请求**不带客户端查询串**（`GET /api/leaderboard?x=1` 命中同一缓存条目，上游收到的请求无查询串）。
- 请求头固定：`Accept-Encoding: ""`（上游总回 identity）、`User-Agent: benchmark-viewer/1.0 (internal LAN tool)`、正确的 `Host` 与 `proxy_ssl_name`；`proxy_ignore_headers Vary Cache-Control Expires Set-Cookie`；`proxy_hide_header Set-Cookie`；`proxy_pass_header Date`。
- 只缓存 200；上游 `Content-Type` 不含 `json` 的响应不得写入缓存（`proxy_no_cache`）。
- `proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504 http_403 http_429`；`proxy_cache_background_update on`；`proxy_cache_lock on`，`proxy_cache_lock_timeout` 与 `proxy_cache_lock_age` 不小于读取超时加连接超时之和（35 秒以上）。不做错误响应的负缓存（会覆盖好数据）。
- `proxy_cache_path` 的 `inactive` 取一个远大于任何 TTL 的值（默认 3650d），且不设 `max_size`；缓存目录为命名卷。
- 响应头：`X-Cache-Status`；对浏览器加 `Cache-Control: no-cache`；下游 `gzip on`（含 `application/json`）。

**上游域名解析**：`proxy_pass` 用变量，并配置 `resolver`（入口脚本从 `/etc/resolv.conf` 读取容器的 DNS，`valid=30s`，关闭 IPv6），使断网时重启也能起来、IP 变化能跟上；变量方式下 URI 要自己拼完整。

**环境变量（默认 = 生产值，入口脚本用 sed 渲染，分隔符用 `#`，值先校验只含安全字符并规整尾部斜杠）**：
`UPSTREAM_LEADERBOARD_URL`、`UPSTREAM_BENCHLM_BASE`、`TTL_LEADERBOARD`（6h）、`TTL_BENCHLM`（24h）、`CACHE_INACTIVE`（3650d）、`UPSTREAM_CONNECT_TIMEOUT`（5s）、`UPSTREAM_READ_TIMEOUT`（30s）、`COOLDOWN_LEADERBOARD`（600）、`COOLDOWN_BENCHLM`（3600）、`COOLDOWN_FAILURE`（60）。冷却值渲染进 `init_by_lua_block` 常量，Lua 不直接读环境。冷却值为 0 表示无冷却。

**`POST /api/refresh`**（Lua）：
- 响应：`{ "leaderboard": { "status": "refreshed"|"cooldown"|"failed", "retryAfterSeconds": n?, "error": "..."?, "fetchedAt": "<HTTP-date>"? }, "benchlm": { 同上 } }`。
- 冷却用 `lua_shared_dict`：用原子的 `add(key, ts, ttl)` 抢占冷却位；另设"进行中"锁（TTL 大于两次超时之和），并发的第二个请求得到 `cooldown`；冷却值 0 时跳过冷却；成功后按对应冷却时长、失败后按 `COOLDOWN_FAILURE` 改写 TTL。
- 刷新通过内部子请求，绕过缓存读取但成功（200 且 JSON）才写入同一缓存条目；失败不覆盖旧缓存。**T2 第一步先实测**"子请求绕过缓存后，另一个客户端读到更新的 `Date`"；若 `ngx.location.capture` 不成立，备选是让 Lua 通过本机回环发一个真实的主请求到内部 location。
- BenchLM 两个文件**都成功**才算 `refreshed`，任一失败算 `failed` 且不覆盖；"上次同步"取两个文件中较旧的 `Date`。
- 官方与 BenchLM 依次处理，最坏耗时约 2 倍读取超时；前端刷新请求设 90 秒超时并显示"同步中…"。

**其他**：Dockerfile 不声明匿名 `VOLUME`；README 写明 `docker run -p 8088:80 -v benchmark-viewer-cache:<缓存目录> --restart unless-stopped`；健康检查用 `wget -q -O /dev/null http://127.0.0.1/healthz`。

## 五、任务、顺序与测试

| # | 任务 | 依赖 | 说明 |
|---|---|---|---|
| T1 | 视图模型与新鲜度纯函数 + 单元测试 | 无 | TDD，夹具用真实样例；期望值独立于实现（可手算：例如官方前沿为 GPT-5.6 Luna max、GPT-6 Astra low/medium/high/max；≤$5 档为 GPT-6 Astra low，≤$10 与 ≤$15 档均为 GPT-6 Astra max） |
| T2 | 容器：Dockerfile、模板、入口脚本、Lua、模拟上游、集成测试 | 无 | TDD：先写集成测试 |
| T3 | 前端页面：D3 渲染、筛选、切换、主题、按钮、说明文字 | T1 | 可运行页面 + 烟雾测试 |
| T4 | 联调：容器 + 页面 + 真实上游；README | T1–T3 | 浏览器实测，如实报告验证范围 |

**集成测试必须覆盖**（缓存、冷却、超时用环境变量缩短）：
1. 两个代理接口返回预期数据；白名单外路径 404；非 GET 方法 405；`GET /api/refresh` 405；请求体不能由客户端指定。
2. 缓存命中：TTL 内上游只收到一次请求；命中时 `X-Cache-Status: HIT` 且 `Date` 不变；带查询串（如 `?x=1`）的请求同样命中，且上游收到的请求不带查询串。
3. 上游返回 `Set-Cookie`、`Vary`、`Cache-Control: max-age=0` 时仍被缓存，且不向客户端下发 cookie。
4. 上游 403、429、500、超时、返回非 JSON 的 200 时：返回旧数据，不覆盖缓存；无缓存时返回错误。
5. 不同 `Accept-Encoding` 的客户端命中同一缓存条目；刷新后所有客户端读到新数据。
6. 刷新：官方成功后进入冷却、冷却期内返回 `cooldown` 与剩余秒数；失败后按失败冷却；失败不覆盖旧缓存；并发两个刷新只有一个到达上游；冷却值 0 表示无冷却；BenchLM 两文件任一失败整体算失败；BenchLM 冷却内只刷新官方部分。
7. 容器重启（同一命名卷）后，上游故障仍能返回旧数据；`CACHE_INACTIVE` 默认值足够大（检查渲染出的配置）。
8. 环境变量注入：URL 含 `&` 与查询串的模拟上游可用。
9. 健康检查通过；gzip 生效。
10. 对**真实上游**的一次烟雾（可选、单独命令）：`/api/leaderboard` 连续两次，第二次 HIT 且 `Date` 不变；BenchLM 两个文件同样；刷新绕过缓存后 `Date` 更新（用于确认 `Date` 反映拉取时间而非 CDN 当前时间）。

## 六、验证门槛

- 单元测试与集成测试全过（给出实际命令输出）。
- 真实上游烟雾一次。
- 浏览器中实际看到两个视图、筛选、切换、按钮反馈；如实报告验证到哪一步。
- `docker run -p 8088:80` 启动，`/healthz` 通过。

## 七、红军审查处置记录

审查者：全新上下文的只读子代理，verdict：needs-attention。用户决定修订后不再重新提交审查，直接实现。

| 发现 | 严重度/置信度 | 处置 |
|---|---|---|
| `inactive` 默认 10 分钟会清掉旧数据 | high 0.85 | 采纳：`CACHE_INACTIVE=3650d`；测试 7 |
| `Vary: Accept-Encoding` 使缓存分变体，刷新只更新一个变体 | high 0.7 | 采纳：固定上游 `Accept-Encoding`、忽略 `Vary`、下游 gzip；测试 5、9 |
| 查询串被追加到上游、污染或绕过缓存 | high 0.75 | 采纳：字面量缓存键、不带查询串；测试 2 |
| 非 GET 方法直通上游 | high 0.75 | 采纳：405；测试 1 |
| 启动时解析上游域名、IP 固定 | high 0.75 | 采纳：变量加 resolver；实测在无网络时能启动列为手动验证 |
| 故障期访问者各自碰上游 | high 0.6 | 部分采纳：后台更新、加锁超时不小于 35 秒；不做失败退避（复杂度不匹配，作为已知限制记入 README） |
| 冷却竞态、`exptime=0`、进行中锁 | medium 0.75 | 采纳；测试 6 |
| `capture` 与 bypass 组合不确定 | medium 0.35 | 采纳：T2 第一步实测，备选回环主请求 |
| 200 但非 JSON 也被缓存 | medium 0.4 | 采纳：非 JSON 不写缓存；测试 4 |
| sed 转义、URL 形态、Lua 取环境变量 | medium 0.6 | 采纳：分隔符 `#`、校验、渲染进 `init_by_lua_block`；测试 8 |
| BenchLM 两文件刷新语义 | medium 0.5 | 采纳：都成功才算刷新，取较旧的 `Date` |
| 补充视图排除 Qwen、GLM，与"请看补充视图"文案矛盾 | high 0.9 | 采纳：修改 spec 与工单 07 文案 |
| 价格文件空值（slug 为 null、`outputPrice` 为 null）、AA 分数 0 | medium 0.9 | 采纳：`!= null`，0 分有效，忽略 null slug |
| `output_tokens`、`avg_trial_duration_sec` 可选 | medium 0.85 | 采纳：缺失为 null，记入 `missing` |
| 契约空洞（FilterState、supplement 入参、时间来源） | medium 0.9 | 采纳：4.1、4.2 已补全 |
| 最佳档、并列、预算档的次序 | low 0.6 | 采纳：先筛选再最佳档再前沿；次序按 id；期望值写入 T1 |
| `none` 档位恒被划掉 | low 0.5 | 采纳：只列数据里出现过的档位 |
| token 或耗时下的轴标题与图例 | low 0.5 | 采纳：`METRICS` 元数据 |
| `page_size` 100 静默丢行 | low 0.5 | 采纳：`truncated` 标志与提示 |
| 计划漏 gzip、超时、锁超时、命名卷写法 | medium 0.85 | 采纳：4.3 |
| 测试覆盖不到超时、重启、`inactive`、Vary、查询串 | medium 0.85 | 采纳：新增超时环境变量与测试 1–10 |
| 健康检查 `localhost` 可能解析 `::1`；`VOLUME` 匿名卷；前端 `no-store` | low 0.5 | 采纳 |
| `Date` 是否反映 BenchLM 的拉取时间 | low 0.5 | 测试 10 联调时确认 |
