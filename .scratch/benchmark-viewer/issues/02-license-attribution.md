Type: research
Status: resolved
Blocked by:

# BenchLM 数据许可与署名要求怎么落地？

## Question

数据集为 CC BY-NC 4.0。请核实并记录：

1. 署名的精确要求（文案、链接、放置位置），以及 `/data`、`/methodology`、服务条款、`robots.txt` 里对 API 调用频率或缓存的任何限制。
2. 每日一次同步是否在允许范围内；是否需要设置 User-Agent 或联系方式。
3. 把数据镜像进 Docker 镜像并分发（例如推到公开仓库）是否被允许；只在自己机器上运行呢？
4. 若个人自用、不对外发布，是否需要满足署名要求。

产出：可直接写进页脚的署名文案 + 同步与分发的红线清单。

## Answer

完整报告：`../research/02-license-attribution.md`（子代理转述，非法律意见，未逐字核对原文）。

- 署名：站方要求 "Data from BenchLM.ai" 加链接；CC BY-NC 4.0 另需许可链接并注明是否修改。位置未规定。
- 条款页未见 API 频率/缓存/User-Agent 限制。
- 冲突：`robots.txt` 有 `Disallow: /api/`，但 `/data` 公布的官方端点就是 `/api/data/*`。每日一次同步未被明文禁止，建议先邮件 benchlm.ai/contact 确认。
- 分发：数据打进公开镜像风险高；镜像只放代码、运行时拉数据风险最低；仅本机运行风险低。
- 页面他人可访问时应署名，一律加页脚。
- 设计影响：数据运行时拉取，不烘进镜像；优先用 `/data/*.json` 静态文件而非 `/api/`。
