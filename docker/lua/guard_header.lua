-- 剔除上游按前缀成组出现、无法用 proxy_hide_header 通配的响应头（Cloudflare 的 CF-*、跨域的 Access-Control-*）。
-- 放在最前面：后面的 502 改写也需要一份干净的头。
local HIDDEN_PREFIXES = { "cf-", "access-control-" }

if not ngx.is_subrequest then
    for name in pairs(ngx.resp.get_headers(0)) do
        local lower = name:lower()
        for _, prefix in ipairs(HIDDEN_PREFIXES) do
            if lower:sub(1, #prefix) == prefix then
                ngx.header[name] = nil
                break
            end
        end
    end
end

-- 上游返回 200 但内容不是 JSON（例如维护页、WAF 挑战页），或干脆没有 Content-Type 时，
-- nginx 已按 proxy_no_cache 不写缓存；这里再把它变成 502，否则前端会把一段 HTML 当数据去解析。
-- 缺失 Content-Type 与 refresh.lua 的 classify 一致，一律按无效处理。
-- 命中或使用旧缓存的响应不来自本次上游请求，不能改。
if ngx.is_subrequest or ngx.status ~= 200 then
    return
end

local cache_status = ngx.var.upstream_cache_status
if cache_status ~= "MISS" and cache_status ~= "EXPIRED" and cache_status ~= "BYPASS" then
    return
end

local ctype = ngx.var.upstream_http_content_type
if ctype and ctype:lower():find("json", 1, true) then
    return
end

ngx.status = 502
ngx.header["Content-Type"] = "application/json"
ngx.header["Content-Length"] = nil
ngx.ctx.bv_reject_body = '{"error":"upstream returned non-JSON content"}'
