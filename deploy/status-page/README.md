# winnowl 状态页(Cloudflare Worker)

公共 uptime / status 页。**刻意不在 winnowl 自己的集群里**:状态页的全部价值在集群出事的那几分钟,
跟被监控对象同生共死的探针恰好在最需要它的时候一起挂。这里由 CF 边缘每分钟探一次公网端点,
结果落 KV,页面也由 Worker 渲染 —— winnowl 整个 down 掉,这一页照样开得起来,并说得出从什么时候开始。

探的是**用户真正走的那条链路**(DNS → CF → nginx/Ingress → 后端),不是内网 Service:
链路上任何一环断了都算 down,这才是外部视角的可用性。

## 探测目标

| id | 说明 | 断了意味着 |
|---|---|---|
| `console` | Console SPA 外壳 | 打不开界面 |
| `api` | `/health`(control-api) | 界面在但没数据、登录不了 |
| `webhook` | `/webhooks/health`(webhook-ingress) | **review 全断且毫无动静** —— 2026-07 曾这样断了七天 |

`webhook` 这一条是有历史的:此前外部无法探它(`POST /webhooks/github` 对假 payload 返 404,
探针分不出「活着但拒绝了假 payload」和「死了」),所以 webhook-ingress 现在额外挂了一个
`GET /webhooks/health`(单端口部署下 `/webhooks/*` 整段分流到它,不改写路径)。

## 凭据

用 **scoped API token**,不用 `wrangler login`:后者把 OAuth token(含 refresh_token、全量 scope)
明文写进 `~/.config/.wrangler/config/default.toml`(0600,wrangler 4.118 里加密存储的代码存在但**没有接上**),
既不能设过期也没法单独吊销。

token 在本目录的 `.env` 里(`.gitignore` 已覆盖裸 `.env`,权限 600),**wrangler 会自动读**,
所以下面的命令不需要 export 任何东西:

```
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_API_TOKEN=…
```

建 token 时权限给两项就够:`Workers Scripts:Edit` + `Workers KV Storage:Edit`
(想用 `wrangler tail` 再加 `Workers Tail:Read`)。设个过期时间;要换人/换机器就在 dash 里吊销重发。

## 部署

```bash
cd deploy/status-page
npm install                       # 它刻意不在 pnpm workspace 里,自带 lockfile

# 首次:建 KV(探测历史),把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]].id
npx wrangler kv namespace create STATUS_KV

npx wrangler deploy
```

部署完先看一分钟后的第一次 cron:`npx wrangler tail`,或直接 `curl .../api/status`。
页面在 `https://winnowl-status.<account>.workers.dev/`,JSON 在 `/api/status`(可接外部告警)。

**`TARGETS` 配错是静默的**那一类问题的反面教材:它是 TOML 的 `'''` literal string,里面就是原样 JSON,
引号写 `\"` 一个反斜杠。写错时页面会直接说「状态页自己配错了」并给出解析错误 —— 早期版本会安静地
退成空目标列表,看着像还没配。

## 自定义域名

`wrangler.toml` 里放开 `[[routes]]`。**别挂在 winnowl 自己的域名下** —— 同一份 DNS / 证书 / 边缘配置
出问题时状态页会跟着打不开,而那正是要看它的时候。用另一个域名(或至少另一个 zone)。

## 数据与成本

KV 只存**按天计数**(`day:<id>:<YYYY-MM-DD>` → `{ok, fail}`)加每个目标的最近一次探测,
不存每次探测的明细:90 天 × 1440 次/天 × N 个目标写进 KV 又贵又没人看。
90 天窗口滑过去后计数键自动过期(TTL 97 天)。

三个目标 × 每分钟 = 每天 ~4300 次探测、~8600 次 KV 写,在 CF 免费额度内(10 万次/天)。
加目标前先算一下:每加一个目标每天多 ~2900 次写。

## 改探测目标

改 `wrangler.toml` 的 `TARGETS`(JSON 数组),重新 `wrangler deploy`。
`expect` 是响应体必须包含的子串 —— 只判 2xx 会把「返回了但功能坏了」算成健康。
