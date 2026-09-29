-- POST /api/refresh：官方榜单与 BenchLM 依次处理，各自独立判断冷却。
-- 刷新通过内部子请求（proxy_cache_bypass 1 + 与公开接口相同的缓存键）完成：
-- 绕过缓存读取，但只有 200 且为 JSON 的响应才会写入同一个缓存条目，失败不会覆盖旧数据。
local cjson = require "cjson.safe"
local cfg = require "bv_config"

local dict = ngx.shared.bv_refresh

local GROUPS = {
    { name = "leaderboard", uris = { "/_refresh/leaderboard" } },
    { name = "benchlm", uris = { "/_refresh/benchlm/models", "/_refresh/benchlm/pricing" } },
}

local function remaining_seconds(key)
    local ttl = dict:ttl(key)
    if not ttl or ttl <= 0 then
        return 1
    end
    return math.max(1, math.ceil(ttl))
end

local function cooldown_result(key)
    return {
        status = "cooldown",
        retryAfterSeconds = remaining_seconds(key),
        finishedAt = ngx.http_time(ngx.time()),
    }
end

-- 返回 nil 表示成功，否则是失败原因。
local function classify(res)
    if res.status ~= 200 then
        if res.status == 504 or res.status == 502 then
            return "upstream unreachable or timed out (status " .. res.status .. ")"
        end
        return "upstream status " .. res.status
    end
    local ctype = res.header["Content-Type"]
    if type(ctype) == "table" then
        ctype = ctype[1]
    end
    if not ctype or not ctype:lower():find("json", 1, true) then
        return "upstream returned non-JSON content"
    end
    return nil
end

local function refresh_group(group)
    local name = group.name
    local busy_key = "busy:" .. name
    local cd_key = "cd:" .. name
    local cooldown = cfg.cooldown[name]

    -- 先抢"进行中"标记：并发的第二个请求在这里被挡下，不会再打上游。
    if not dict:add(busy_key, 1, cfg.lock_ttl) then
        return cooldown_result(busy_key)
    end

    -- 再用原子的 add 抢占冷却位；冷却值为 0 时不占位，但失败冷却可能仍在生效，所以要先看有没有。
    local claimed
    if cooldown > 0 then
        claimed = dict:add(cd_key, 1, cooldown)
    else
        claimed = dict:get(cd_key) == nil
    end
    if not claimed then
        local result = cooldown_result(cd_key)
        dict:delete(busy_key)
        return result
    end

    local oldest
    local failure
    for _, uri in ipairs(group.uris) do
        local res = ngx.location.capture(uri)
        failure = classify(res)
        if failure then
            break
        end
        local date = res.header["Date"]
        local ts = date and ngx.parse_http_time(date) or ngx.time()
        if not oldest or ts < oldest then
            oldest = ts
        end
    end

    local next_cooldown = failure and cfg.cooldown.failure or cooldown
    if next_cooldown > 0 then
        dict:set(cd_key, 1, next_cooldown)
    else
        dict:delete(cd_key)
    end
    dict:delete(busy_key)

    if failure then
        return { status = "failed", error = failure, finishedAt = ngx.http_time(ngx.time()) }
    end
    local result = { status = "refreshed", fetchedAt = ngx.http_time(oldest), finishedAt = ngx.http_time(ngx.time()) }
    -- 成功后立刻告知还要冷却多久，前端据此当场禁用按钮，不必等下一次被拒。
    if next_cooldown > 0 then
        result.retryAfterSeconds = remaining_seconds(cd_key)
    end
    return result
end

ngx.req.discard_body()

local out = {}
for _, group in ipairs(GROUPS) do
    out[group.name] = refresh_group(group)
end

ngx.header["Content-Type"] = "application/json"
ngx.say(cjson.encode(out))
