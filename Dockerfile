FROM openresty/openresty:alpine

# 缓存目录只在运行时以命名卷挂载；这里故意不写 VOLUME，否则每次 docker run 会悄悄生成匿名卷，
# 换容器后旧数据找不到，"上游故障仍可用"就名存实亡。
RUN mkdir -p /var/cache/bv /usr/share/bv/web /etc/bv/lua \
    && chown nobody:nobody /var/cache/bv

COPY docker/nginx.conf.template /etc/bv/nginx.conf.template
COPY docker/lua/ /etc/bv/lua/
COPY docker/entrypoint.sh /usr/local/bin/bv-entrypoint.sh
COPY web/ /usr/share/bv/web/

# Windows 检出可能带 CRLF，会让 sh 脚本和 sed 渲染出的配置出现隐形的 \r。
RUN sed -i 's/\r$//' /usr/local/bin/bv-entrypoint.sh /etc/bv/nginx.conf.template /etc/bv/lua/*.lua \
    && chmod +x /usr/local/bin/bv-entrypoint.sh

EXPOSE 80

# 地址写 127.0.0.1：localhost 可能先解析成 ::1，而 nginx 只监听 IPv4。
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=2s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz

ENTRYPOINT ["/usr/local/bin/bv-entrypoint.sh"]
