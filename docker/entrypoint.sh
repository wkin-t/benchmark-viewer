#!/bin/sh
# 镜像里没有 envsubst，所以用 sed 把环境变量渲染进 nginx 配置模板。
# 渲染结果就是 nginx 配置，环境变量里混进分号、引号、花括号、$ 就等于往配置里注入指令，
# 因此每个变量都先按白名单字符校验，不合格直接退出，不启动服务。
set -eu

TEMPLATE=/etc/bv/nginx.conf.template
CONF=/usr/local/openresty/nginx/conf/nginx.conf

UPSTREAM_LEADERBOARD_URL="${UPSTREAM_LEADERBOARD_URL:-https://api.harborframework.com/functions/v1/leaderboard-read}"
UPSTREAM_BENCHLM_BASE="${UPSTREAM_BENCHLM_BASE:-https://benchlm.ai/data}"
TTL_LEADERBOARD="${TTL_LEADERBOARD:-6h}"
TTL_BENCHLM="${TTL_BENCHLM:-24h}"
CACHE_INACTIVE="${CACHE_INACTIVE:-3650d}"
UPSTREAM_CONNECT_TIMEOUT="${UPSTREAM_CONNECT_TIMEOUT:-5s}"
UPSTREAM_READ_TIMEOUT="${UPSTREAM_READ_TIMEOUT:-30s}"
COOLDOWN_LEADERBOARD="${COOLDOWN_LEADERBOARD:-600}"
COOLDOWN_BENCHLM="${COOLDOWN_BENCHLM:-3600}"
COOLDOWN_FAILURE="${COOLDOWN_FAILURE:-60}"
WARM_INTERVAL="${WARM_INTERVAL:-3600}"

NEWLINE=$(printf '\nx')
NEWLINE=${NEWLINE%x}

# 用法：require_match 变量名 值 正则 期望格式说明。grep 按行匹配，所以先单独拒绝换行。
require_match() {
    case "$2" in
        *"$NEWLINE"*)
            echo "entrypoint: $1 不能包含换行" >&2
            exit 1
            ;;
    esac
    if ! printf '%s' "$2" | grep -Eq "$3"; then
        echo "entrypoint: $1 的值不合法（期望 $4）: $2" >&2
        exit 1
    fi
}

# URL 只允许字母数字与 . _ ~ : / ? & = % + , -；# 被 sed 用作分隔符，; 空白 引号 $ {} \ 一律不放行。
URL_PATTERN='^https?://[A-Za-z0-9._~:/?&=%+,-]+$'
BASE_PATTERN='^https?://[A-Za-z0-9._~:/%+,-]+$'
DURATION_PATTERN='^[0-9]+(ms|s|m|h|d|w)$'
SECONDS_PATTERN='^[0-9]+s$'
COUNT_PATTERN='^[0-9]+$'

require_match UPSTREAM_LEADERBOARD_URL "$UPSTREAM_LEADERBOARD_URL" "$URL_PATTERN" "http(s):// 开头且只含安全字符的完整 URL"
require_match UPSTREAM_BENCHLM_BASE "$UPSTREAM_BENCHLM_BASE" "$BASE_PATTERN" "http(s):// 开头、不含查询串的基址"
require_match TTL_LEADERBOARD "$TTL_LEADERBOARD" "$DURATION_PATTERN" "数字加 ms/s/m/h/d/w，如 6h"
require_match TTL_BENCHLM "$TTL_BENCHLM" "$DURATION_PATTERN" "数字加 ms/s/m/h/d/w，如 24h"
require_match CACHE_INACTIVE "$CACHE_INACTIVE" "$DURATION_PATTERN" "数字加 ms/s/m/h/d/w，如 3650d"
require_match UPSTREAM_CONNECT_TIMEOUT "$UPSTREAM_CONNECT_TIMEOUT" "$SECONDS_PATTERN" "整数秒，如 5s"
require_match UPSTREAM_READ_TIMEOUT "$UPSTREAM_READ_TIMEOUT" "$SECONDS_PATTERN" "整数秒，如 30s"
require_match COOLDOWN_LEADERBOARD "$COOLDOWN_LEADERBOARD" "$COUNT_PATTERN" "非负整数秒，0 表示无冷却"
require_match COOLDOWN_BENCHLM "$COOLDOWN_BENCHLM" "$COUNT_PATTERN" "非负整数秒，0 表示无冷却"
require_match COOLDOWN_FAILURE "$COOLDOWN_FAILURE" "$COUNT_PATTERN" "非负整数秒，0 表示无冷却"
# 心跳间隔限 9 位：busybox 的 [ -gt ] 对超长数字报 out of range 并判假，会让"校验通过"的值
# 反而静默关闭心跳；9 位秒（约 31 年）已超过任何合理间隔。
require_match WARM_INTERVAL "$WARM_INTERVAL" '^[0-9]{1,9}$' "1-9 位非负整数秒，0 表示不启用后台心跳"

# 基址后面要拼 /models.json，尾部斜杠去掉，否则会得到 //models.json。
UPSTREAM_BENCHLM_BASE=$(printf '%s' "$UPSTREAM_BENCHLM_BASE" | sed -e 's#/*$##')

# sed 替换串里 & 表示"整个匹配"，反斜杠是转义符，都要先转义。
sed_escape() {
    printf '%s' "$1" | sed -e 's/[\&]/\\&/g'
}

# URL 里取 host:port（用作 Host 头）与不含端口的 host（用作 TLS SNI 名）。
authority_of() {
    printf '%s' "$1" | sed -e 's#^[A-Za-z][A-Za-z0-9+.-]*://##' -e 's#[/?].*$##'
}
hostname_of() {
    printf '%s' "$1" | sed -e 's#:[0-9]*$##'
}

# 单次上游尝试的最长耗时 = 连接超时 + 读取超时。
ATTEMPT_SECONDS=$(( ${UPSTREAM_CONNECT_TIMEOUT%s} + ${UPSTREAM_READ_TIMEOUT%s} ))
# 缓存锁的等待时间不小于单次尝试，再留 5 秒余量。
LOCK_TIMEOUT="$(( ATTEMPT_SECONDS + 5 ))s"
# 刷新"进行中"标记要盖住 BenchLM 依次取两个文件的最坏耗时。
LOCK_TTL=$(( ATTEMPT_SECONDS * 2 + 5 ))

RESOLVER=$(awk '/^nameserver[ \t]/ { if ($2 ~ /:/) printf "[%s] ", $2; else printf "%s ", $2 }' /etc/resolv.conf)
if [ -z "$RESOLVER" ]; then
    echo "entrypoint: /etc/resolv.conf 里没有 nameserver，无法解析上游域名" >&2
    exit 1
fi

LB_HOST=$(authority_of "$UPSTREAM_LEADERBOARD_URL")
BL_HOST=$(authority_of "$UPSTREAM_BENCHLM_BASE")

sed \
    -e "s#__RESOLVER__#$(sed_escape "$RESOLVER")#g" \
    -e "s#__LB_URL__#$(sed_escape "$UPSTREAM_LEADERBOARD_URL")#g" \
    -e "s#__LB_HOST__#$(sed_escape "$LB_HOST")#g" \
    -e "s#__LB_SSL_NAME__#$(sed_escape "$(hostname_of "$LB_HOST")")#g" \
    -e "s#__BL_BASE__#$(sed_escape "$UPSTREAM_BENCHLM_BASE")#g" \
    -e "s#__BL_HOST__#$(sed_escape "$BL_HOST")#g" \
    -e "s#__BL_SSL_NAME__#$(sed_escape "$(hostname_of "$BL_HOST")")#g" \
    -e "s#__TTL_LEADERBOARD__#$TTL_LEADERBOARD#g" \
    -e "s#__TTL_BENCHLM__#$TTL_BENCHLM#g" \
    -e "s#__CACHE_INACTIVE__#$CACHE_INACTIVE#g" \
    -e "s#__LOCK_TIMEOUT__#$LOCK_TIMEOUT#g" \
    -e "s#__LOCK_TTL__#$LOCK_TTL#g" \
    -e "s#__COOLDOWN_LEADERBOARD__#$COOLDOWN_LEADERBOARD#g" \
    -e "s#__COOLDOWN_BENCHLM__#$COOLDOWN_BENCHLM#g" \
    -e "s#__COOLDOWN_FAILURE__#$COOLDOWN_FAILURE#g" \
    -e "s#__CONNECT_TIMEOUT__#$UPSTREAM_CONNECT_TIMEOUT#g" \
    -e "s#__READ_TIMEOUT__#$UPSTREAM_READ_TIMEOUT#g" \
    "$TEMPLATE" > "$CONF"

# 后台心跳：nginx 的缓存只在有请求的时候才会更新——缓存过期后要等下一个访问者来触发后台刷新，
# 没有访客数据就会一直停在旧快照。这个循环周期性触碰三个读接口，制造"有人访问"。
# 不打 /api/refresh：那是绕过缓存强制拉取；心跳只负责让 TTL 机制按时运转，更新节奏仍由 TTL 决定。
if [ "$WARM_INTERVAL" -gt 0 ]; then
    (
        # 目标是本机回环，任何代理都不该介入：容器若被注入了 http_proxy 一类变量，busybox wget
        # 会把 127.0.0.1 也交给代理，心跳永远打不通；nginx 自己不读这些变量，不受此影响。
        unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
        # nginx 要等下面 exec 之后才起来，先等它就绪，否则首轮触碰会落空。
        # 就绪前的 Connection refused 是预期内的重试，屏蔽到 stderr 之外；持续失败在 60 秒后补一行诊断。
        tries=0
        until wget -q -O /dev/null http://127.0.0.1/healthz 2>/dev/null; do
            tries=$((tries + 1))
            if [ "$tries" -eq 60 ]; then
                echo "bv-heartbeat: healthz 探测持续失败 60 秒，心跳暂时无法工作（若容器注入了代理变量，请确认回环地址未被代理拦截）" >&2
            fi
            sleep 1
        done
        while :; do
            start=$(date +%s)
            # 路径清单与 nginx.conf 的白名单一致；新增白名单文件时这里要同步（warm.test.mjs 覆盖三个路径的行为）。
            failed=0
            for path in /api/leaderboard /api/benchlm/models.json /api/benchlm/pricing.json; do
                wget -q -T 60 -O /dev/null "http://127.0.0.1$path" 2>/dev/null || failed=$((failed + 1))
            done
            # 只在意"冷缓存撞上上游故障"（本地有旧数据时触碰总是 200 成功）：此时给一行语义化诊断，
            # 而不是让 wget 的原生错误刷屏。
            if [ "$failed" -gt 0 ]; then
                echo "bv-heartbeat: 本轮有 $failed/3 个接口触碰失败（无可用旧缓存且上游不可达时会如此）" >&2
            fi
            # 周期以触碰开始时刻计时：触碰耗时超过间隔时至少歇 1 秒，不退化成连续重试。
            elapsed=$(( $(date +%s) - start ))
            remain=$(( WARM_INTERVAL - elapsed ))
            if [ "$remain" -lt 1 ]; then
                remain=1
            fi
            sleep "$remain"
        done
    ) &
fi

exec /usr/local/openresty/bin/openresty -g 'daemon off;'
