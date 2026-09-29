# Benchmark Viewer

Terminal-Bench 4.0 成本与分数散点图。一个 OpenResty 容器同时提供静态页面和带缓存的上游代理。源码公开，整份作品仅限非商业使用。

- 官方视图：官方榜单（Harbor Hub 公开接口）的分数与每任务实测成本。
- 补充视图：BenchLM 数据集里 Artificial Analysis 的分数与输出单价。
- 数据由容器缓存并定时更新，上游故障时继续显示旧数据；页面上的"立即同步"按钮由服务端强制冷却。

术语见 `CONTEXT.md`，行为规范见 `.scratch/benchmark-viewer/spec.md`。

## 运行

构建镜像并启动（默认对外端口 8088，可改 `-p` 左边的数字）：

```bash
docker build -t benchmark-viewer .
docker run -d --name benchmark-viewer \
  -p 8088:80 \
  -v benchmark-viewer-cache:/var/cache/bv \
  --restart unless-stopped \
  benchmark-viewer
```

然后在局域网内用浏览器打开 `http://<本机地址>:8088/`。

三个要点：

- `-v benchmark-viewer-cache:/var/cache/bv` 是**命名卷**，缓存目录固定为 `/var/cache/bv`。没有它，容器一旦被删除重建，缓存就丢了，"上游故障仍可用"在重建后失效。镜像故意不声明 `VOLUME`，避免 `docker run` 悄悄生成匿名卷。
- `--restart unless-stopped` 让容器随 Docker 自启。
- 镜像自带健康检查：`wget -q -O /dev/null http://127.0.0.1/healthz`。`docker ps` 的状态栏会显示 `healthy`。

升级镜像时先 `docker rm -f benchmark-viewer` 再用同一条命令启动，命名卷里的缓存会保留。

## 对外接口

| 路径 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 静态页面 |
| `/healthz` | GET | 健康检查，返回 `ok` |
| `/api/leaderboard` | GET | 官方榜单。容器向官方接口发写死的 `POST`（请求体不接受客户端传入） |
| `/api/benchlm/models.json` | GET | BenchLM 模型文件 |
| `/api/benchlm/pricing.json` | GET | BenchLM 价格文件 |
| `/api/refresh` | POST | 立即同步，见下 |

白名单外的路径一律 404；白名单路径上 GET 以外的方法（含 HEAD、OPTIONS）返回 405 且带 `Allow: GET`，HEAD 不放行是因为 nginx 会把 HEAD 转成发往上游的 GET，与写死的 `POST` 冲突，`GET /api/refresh` 也是 405。客户端的查询串、请求头（含 Cookie、Authorization）都不会转发给上游，`?x=1` 之类的查询串命中同一个缓存条目。

代理响应带 `X-Cache-Status`：`HIT`（新鲜缓存）、`MISS`（无缓存，刚从上游取到）、`STALE`（缓存已过 TTL，先返回旧数据并触发后台更新；后台更新失败后，条目仍是过期的，之后的请求在 `STALE` 与 `UPDATING` 之间交替，数据与 `Date` 始终不变，不会回到 `HIT`）、`UPDATING`（已有后台更新在进行，返回旧数据）。后台更新成功后回到 `HIT`。缓存条目按整秒计时，实际过期时刻在 TTL 到 TTL+1 秒之间。响应头只保留 `Date`、`Content-Type`、`X-Cache-Status`、`Cache-Control: no-cache` 等本服务自己需要的头，`Server` 不带版本号，上游的 `CF-*`、`Access-Control-*` 等一律不下发。`Date` 头是缓存条目写入时**上游**给出的时间，命中缓存时保持不变，页面据此显示"上次同步"。

### POST /api/refresh

依次处理官方榜单和 BenchLM 两个上游，各自独立判断冷却。返回 200 与 JSON：

```json
{
  "leaderboard": { "status": "refreshed", "fetchedAt": "Tue, 29 Sep 2026 05:23:36 GMT", "retryAfterSeconds": 600, "finishedAt": "..." },
  "benchlm":     { "status": "cooldown", "retryAfterSeconds": 3120, "finishedAt": "..." }
}
```

- `status` 为 `refreshed`、`cooldown` 或 `failed`。`failed` 带 `error`；`cooldown` 带 `retryAfterSeconds`（还需等待的秒数）；`refreshed` 在该上游的冷却值大于 0 时同样带 `retryAfterSeconds`（此刻起还需冷却的秒数，向上取整），冷却值为 0 时不带。
- `fetchedAt` 是缓存条目的上游 `Date`；BenchLM 取两个文件中较旧的一个。`finishedAt` 是本次处理结束的时间。
- BenchLM 的两个文件都成功才算 `refreshed`，任一失败整体算 `failed`。
- 并发的第二个刷新请求得到 `cooldown`，不会再打上游。
- 失败（含超时、403、429、5xx、200 但内容不是 JSON 或没有 Content-Type）不会覆盖旧缓存。
- 冷却状态放在容器内存里，容器重启后清零。

## 环境变量

都有默认值，默认值就是生产值。入口脚本会校验每个值只含安全字符，不合格时容器直接退出并在日志里指明变量名。

| 变量 | 默认值 | 格式 | 说明 |
|---|---|---|---|
| `UPSTREAM_LEADERBOARD_URL` | `https://api.harborframework.com/functions/v1/leaderboard-read` | 完整 URL，可含 `&` 与查询串 | 官方榜单接口 |
| `UPSTREAM_BENCHLM_BASE` | `https://benchlm.ai/data` | 不含查询串的基址，尾部斜杠会被去掉 | 其下取 `models.json` 与 `pricing.json` |
| `TTL_LEADERBOARD` | `6h` | 数字加 `ms`/`s`/`m`/`h`/`d`/`w` | 官方榜单缓存时长 |
| `TTL_BENCHLM` | `24h` | 同上 | BenchLM 缓存时长 |
| `CACHE_INACTIVE` | `3650d` | 同上 | nginx 缓存条目多久没被访问才淘汰。取极大值，旧数据只会被新数据替换 |
| `UPSTREAM_CONNECT_TIMEOUT` | `5s` | 整数加 `s` | 上游连接超时 |
| `UPSTREAM_READ_TIMEOUT` | `30s` | 整数加 `s` | 上游读取超时 |
| `COOLDOWN_LEADERBOARD` | `600` | 非负整数秒 | 官方榜单刷新成功后的冷却，`0` 表示无冷却 |
| `COOLDOWN_BENCHLM` | `3600` | 非负整数秒 | BenchLM 刷新成功后的冷却 |
| `COOLDOWN_FAILURE` | `60` | 非负整数秒 | 任一上游刷新失败后的冷却 |

用环境变量传入，例如 `docker run -e TTL_LEADERBOARD=1h -e COOLDOWN_BENCHLM=1800 ...`。

## 测试

需要 Docker 和 Node（测试脚本用 `node:test`，不依赖第三方包）。集成测试会构建镜像 `bv-test-image`，在宿主机起一个模拟上游（`tests/integration/mock-upstream.mjs`，数据取自 `tests/fixtures/`），再让容器经 `host.docker.internal` 访问它。测试容器名都以 `bv-test-` 开头，用随机高位端口（18100 以上），每个用例结束后清理，不占用 8088。

```bash
npm run test:integration          # 全部集成测试（不访问真实上游）
REAL_UPSTREAM=1 node --test tests/integration/real-upstream.test.mjs   # 可选：真实上游烟雾
```

真实上游烟雾会访问官方榜单与 BenchLM 各三次（两次读取加一次刷新），请克制使用。PowerShell 下写作 `$env:REAL_UPSTREAM=1; node --test tests/integration/real-upstream.test.mjs`。

脚本用通配符 `tests/integration/*.test.mjs` 选文件：Node 25 的 `node --test <目录>` 会把目录当模块解析而失败，所以不能直接传目录。

## 许可

程序以 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) 授权，全文见 `LICENSE`。可以阅读、修改和再分发源码，但只限非商业目的。这不是 OSI 意义上的开源许可证。

`package.json` 里的 `"private": true` 只是为了防止被发布到 npm。

补充视图用的 BenchLM 数据（含 `tests/fixtures/models.json` 与 `pricing.json`）是 **CC BY-NC 4.0**，署名 “Data from BenchLM.ai”。商业使用须另行联系 BenchLM。官方榜单样例来自 Harbor Hub，服务条款不由本仓库改写。第三方清单见 `NOTICE`。

## 已知限制

- **故障期没有失败退避。** 缓存过期且上游持续故障时，每次访问都会触发一次后台更新去打上游（旧数据照常返回）。局域网内访问量小，这个代价可接受；需要时可以把 `TTL_*` 调大。
- **BenchLM 两个文件的刷新不是原子的。** 依次拉取，第一个成功、第二个失败时，第一个的缓存已经被更新，整体只报告 `failed`。第一个失败则不会请求第二个。页面的"上次同步"取两个文件中较旧的 `Date`，所以不会高估新鲜度。
- **旧数据没有硬性保留上限。** 直到被成功拉取的新数据替换为止，数据是否陈旧只靠页面上"上次同步超过 48 小时"的警告提示。
- **非 JSON 的 200 在没有旧缓存时返回 502。** 上游偶尔返回 200 的维护页或挑战页，容器不会缓存它，也不会把它当数据交给页面。
- **上游 403、429、5xx 在没有旧缓存时原样透传给页面**，页面按状态码显示错误。
- **刷新最坏耗时约两倍读取超时**（官方与 BenchLM 依次处理，BenchLM 内两个文件也依次拉取）。页面刷新请求应设足够长的超时。
- **冷却状态在内存里**，容器重启后清零；缓存不受影响。
- **只校验了 IPv4 的上游解析**：resolver 配置了 `ipv6=off`。
- 镜像构建上下文没有 `.dockerignore`，`docker build` 会把整个目录（含 `.scratch`）发给守护进程，但 `COPY` 只取 `docker/` 与 `web/`，不会进入镜像。

## 目录

```
Dockerfile
docker/
  nginx.conf.template   # 含 __占位符__，入口脚本用 sed 渲染
  entrypoint.sh         # 校验环境变量、渲染配置、启动 OpenResty
  lua/refresh.lua       # POST /api/refresh
  lua/guard_*.lua       # 把上游"200 但非 JSON"变成 502
web/                    # 静态前端
tests/
  fixtures/             # 真实上游样例，模拟上游的响应体
  integration/          # 容器集成测试与模拟上游
```
