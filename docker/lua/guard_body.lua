-- 与 guard_header.lua 配对：把被改成 502 的响应体整体换成一段固定的错误 JSON。
local body = ngx.ctx.bv_reject_body
if not body then
    return
end

if ngx.ctx.bv_reject_sent then
    ngx.arg[1] = ""
else
    ngx.ctx.bv_reject_sent = true
    ngx.arg[1] = body
end
