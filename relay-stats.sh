#!/bin/bash
# 从中转站（sub2api）的数据库读取最近 24 小时的用量汇总，写成一个 JSON 文件给调度台读。
# 由 dispatch-relay.timer 每分钟以 root 运行一次。只做一条只读的汇总查询，不读取任何用户、密钥或对话内容。
# 用量是"最近 24 小时"滚动统计（不是按自然日），所以和中转站后台的"今日"数字不会完全一样。
set -e
CONTAINER=migration-sub2api-postgres-standby
OUT=/run/dispatch-relay/stats.json

json=$(docker exec -i "$CONTAINER" psql -U sub2api -d sub2api -X -A -t -q <<'SQL'
set default_transaction_read_only = on;
set statement_timeout = 5000;
-- 口径：
--   请求 / Token / 平均响应：最近 24 小时内的请求明细（usage_logs）汇总，滚动计算；
--   总计：后台自己的日汇总表 usage_dashboard_daily 全部历史相加；全部历史的平均响应也来自它；
--   性能指标：最近 5 分钟的请求数和 Token 数，各除以 5。
with d as (select count(*) as total_requests,
                  coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens), 0) as output_tokens,
                  coalesce(sum(cache_creation_tokens), 0) as cache_creation_tokens, coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
                  coalesce(sum(duration_ms), 0) as total_duration_ms
           from usage_logs where created_at >= now() - interval '24 hours'),
     a as (select sum(total_requests) as req, sum(total_duration_ms) as dur,
                  sum(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) as tok
           from usage_dashboard_daily),
     m as (select count(*) as req,
                  coalesce(sum(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) as tok
           from usage_logs where created_at >= now() - interval '5 minutes')
select json_build_object(
  'collectedAt', (extract(epoch from now()) * 1000)::bigint,
  'day', to_char(current_date, 'YYYY-MM-DD'),
  'windowHours', 24,
  'tz', current_setting('TimeZone'),
  'requests', coalesce((select total_requests from d), 0),
  'tokens', coalesce((select input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens from d), 0),
  'inputTokens', coalesce((select input_tokens from d), 0),
  'outputTokens', coalesce((select output_tokens from d), 0),
  'cacheTokens', coalesce((select cache_creation_tokens + cache_read_tokens from d), 0),
  'todayAvgMs', (select round(total_duration_ms::numeric / nullif(total_requests, 0)) from d),
  'avgMs', (select round(dur::numeric / nullif(req, 0)) from a),
  'totalRequests', coalesce((select req from a), 0),
  'totalTokens', coalesce((select tok from a), 0),
  'req5m', (select req from m),
  'tok5m', (select tok from m)
);
SQL
)

case "$json" in
  \{*\}) ;;
  *) echo "unexpected query output" >&2; exit 1 ;;
esac
printf '%s\n' "$json" > "$OUT.tmp"
chmod 644 "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
