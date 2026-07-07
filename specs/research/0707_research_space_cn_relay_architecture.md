# Team Space 中国大陆链路加速反代架构研究（2026-07-07）

> 研究对象：MyAgents Team Space / Cloud Space 当前部署在 `MyAgents_space`（Cloudflare Workers + D1 + R2 + KV）上的后端服务，桌面端通过 `src-tauri/src/space_cloud.rs` 访问 build-time origin。
> 背景问题：大陆用户到 Cloudflare 边缘网络的首跳和 TLS 建连可能慢且抖动；用户已有腾讯云新加坡服务器，实测大陆到该服务器可能更稳。目标是在客户端无感、URL 不变的前提下，引入腾讯云作为加速入口。
> 本文是研究报告，不是已执行 PRD。

---

## TL;DR

推荐方向：**腾讯云新加坡只做无状态 ingress relay，Cloudflare 仍是唯一业务后端与数据权威**。

```text
客户端仍访问:
  https://space.myagents.io

大陆线路 DNS:
  space.myagents.io -> 腾讯云新加坡 relay IP

默认/海外线路 DNS:
  space.myagents.io -> Cloudflare 入口

腾讯云 relay:
  https://space.myagents.io/*
    -> https://space-origin.myagents.io/*
    -> Cloudflare Worker
    -> D1 / R2 / KV
```

核心结论：

| 问题 | 结论 |
|---|---|
| URL 能不能不变 | 能。客户端只看 `space.myagents.io`；通过地理/线路 DNS 把大陆解析到腾讯云 relay，其它地区解析到 Cloudflare。 |
| relay 能不能无业务感知 | 能，但只能做到“业务盲转发”，不是“完全透明”。relay 不解析 token、不查数据库、不改 JSON，只透传 method/path/query/body/header/response，并加 infra header。 |
| 最不该做什么 | 不要把腾讯云做成第二套后端，不要双写数据库，不要让客户端自由切 URL。 |
| 最大坑 | 如果 `space.myagents.io` 仍是 Cloudflare 橙云 proxied 记录，大陆用户首跳仍先进 Cloudflare，无法解决首跳问题。要让大陆首跳到腾讯云，DNS 必须返回腾讯云 IP。 |

---

## 1. 当前约束

### 1.1 客户端约束

当前 Space 是 build-time capability：

- 客户端只认 `MYAGENTS_SPACE_BASE_URL` 烘焙出的 origin。
- Renderer 不提供自由 URL 输入。
- 本地 session/cache identity 包含服务 origin，production/staging 切换需要清缓存。

所以最稳的方案是：**客户端 origin 仍然是 `https://space.myagents.io`**。不要引入 `space-cn.myagents.io` 给客户端选择，否则会带来 session/cache/OAuth redirect 分裂。

### 1.2 服务端约束

`MyAgents_space` 当前权威状态在 Cloudflare：

- D1：用户、space、issue、claim、delivery、skill metadata。
- R2：头像、附件、skill 包。
- KV：桌面 OAuth 登录握手。
- Worker：鉴权、业务 API、D1 bookmark、poll policy、prune/rate limit。

因此腾讯云不应持有业务状态。它只应负责网络入口优化。

---

## 2. URL 不变的实现方式

### 2.1 必须引入 origin host

需要新增一个仅供 relay upstream 使用的 Cloudflare origin 域名：

```text
public host:  space.myagents.io
origin host:  space-origin.myagents.io
```

`space-origin.myagents.io` 指向 Cloudflare Worker，并由 Cloudflare 托管 TLS / route。客户端永远不直接使用它。

为什么需要它：

- 如果 relay upstream 继续请求 `https://space.myagents.io`，而大陆 DNS 已把 `space.myagents.io` 指向腾讯云，relay 会请求到自己，形成循环。
- `space-origin.myagents.io` 提供稳定的 Cloudflare upstream 入口，避免 DNS 回环。

Worker 的 public `BASE_URL` 仍应保持：

```text
BASE_URL=https://space.myagents.io
```

这样 OAuth redirect、绝对 URL、用户可见链接都仍指向公开域名，而不是 origin 域名。

### 2.2 DNS 路由

需要一个支持地理/线路调度和健康检查的权威 DNS 方案：

```text
CN / mainland line:
  space.myagents.io A/AAAA -> 腾讯云 relay IP

default / overseas:
  space.myagents.io CNAME/ALIAS -> Cloudflare Worker 入口
```

关键点：

- 如果使用 Cloudflare DNS 的橙云 proxied 记录，客户端首跳仍是 Cloudflare Anycast，不会先到腾讯云。
- 如果目标是大陆首跳改到腾讯云，`space.myagents.io` 对大陆解析必须是 DNS-only 的腾讯云 IP，或者由其它 Geo DNS 服务返回腾讯云 IP。
- 如果继续让 Cloudflare 做海外默认入口，需要把 Cloudflare Worker 暴露在 `space-origin.myagents.io` 或 default record。

可选 DNS 形态：

| 形态 | 优点 | 问题 |
|---|---|---|
| DNSPod / 腾讯云 DNS 做 `space.myagents.io` Geo/线路解析 | 大陆线路调度能力强，适合本目标 | 需要确认现有 zone 管理方式和自动证书流程 |
| Cloudflare Load Balancing DNS-only + Geo steering | 保留 Cloudflare 控制面 | 如果 proxied/orange-cloud，首跳仍到 Cloudflare；必须确认 DNS-only 行为 |
| 独立 `space-cn.myagents.io` | 实施最简单 | 客户端不无感，会产生 origin/cache/OAuth 分裂，不推荐作为正式形态 |

---

## 3. Relay 如何保持无业务感知

### 3.1 relay 的职责

relay 只做 L7 reverse proxy：

- 保留 HTTP method。
- 保留 path + query。
- streaming 转发 request body / response body。
- 透传业务 header：
  - `Authorization`
  - `Cookie`
  - `Set-Cookie`
  - `X-MyAgents-Space-Client-Id`
  - `x-d1-bookmark`
  - `Content-Disposition`
  - `Content-Type`
- 添加 infra header：
  - `X-Forwarded-For`
  - `X-Forwarded-Proto`
  - `X-Forwarded-Host`
  - `X-Request-Id`
  - 可选 `X-MyAgents-Relay-Secret`

### 3.2 relay 明确不做什么

- 不解析 Bearer token。
- 不校验用户身份。
- 不查数据库。
- 不改 JSON schema。
- 不缓存动态 API。
- 不对 `POST` / `PATCH` / `DELETE` 自动重试。
- 不把 Cloudflare error 映射成新的业务错误。
- 不记录 `Authorization` / `Cookie` / request body。

这保证腾讯云层坏掉时只影响网络入口，不影响业务语义。

### 3.3 GET retry 策略

可以考虑只对安全读请求做保守 retry：

| 请求类型 | relay retry |
|---|---|
| `GET` / `HEAD` | 连接失败或 upstream 502/503/504 时最多 1 次，短 timeout |
| `POST` / `PATCH` / `DELETE` | 不 retry |
| 上传/下载流 | 不 retry，避免半包和重复上传 |

当前 Space 写路径包括 issue/comment/claim/complete/profile/skill upload，重复写入风险高。重试应留在业务端具备幂等 key 的地方，而不是 relay。

---

## 4. 参考配置

### 4.1 Caddy 版本

```caddyfile
space.myagents.io {
  encode zstd gzip

  reverse_proxy https://space-origin.myagents.io {
    header_up Host space-origin.myagents.io
    header_up X-Forwarded-Host {host}
    header_up X-Forwarded-Proto https
    header_up X-Forwarded-For {remote_host}
    header_up X-Request-Id {http.request.uuid}
    header_up X-MyAgents-Relay-Secret {$MYAGENTS_SPACE_RELAY_SECRET}

    transport http {
      tls_server_name space-origin.myagents.io
      dial_timeout 5s
      response_header_timeout 30s
    }
  }

  log {
    output file /var/log/caddy/space-relay.log
    format json
  }
}
```

注意：

- relay 对客户端终止 `space.myagents.io` TLS。
- upstream TLS SNI 使用 `space-origin.myagents.io`。
- `Host` 发给 Cloudflare origin host，避免 Worker route 识别混乱。
- Worker 生成公开 URL 仍靠 `BASE_URL=https://space.myagents.io`。

### 4.2 Nginx 版本

```nginx
server {
    listen 443 ssl http2;
    server_name space.myagents.io;

    ssl_certificate     /etc/letsencrypt/live/space.myagents.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/space.myagents.io/privkey.pem;

    client_max_body_size 64m;
    proxy_request_buffering off;
    proxy_buffering off;

    location / {
        proxy_pass https://space-origin.myagents.io;

        proxy_ssl_server_name on;
        proxy_ssl_name space-origin.myagents.io;

        proxy_set_header Host space-origin.myagents.io;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Request-Id $request_id;
        proxy_set_header X-MyAgents-Relay-Secret $myagents_space_relay_secret;

        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

需要额外配置日志脱敏，避免写入 `Authorization`、`Cookie`、request body。

---

## 5. Worker 侧需要适配的点

### 5.1 public URL 与 origin host 分离

Worker 必须继续用 `BASE_URL=https://space.myagents.io` 生成用户可见 URL。

如果代码里存在 “从 request URL 推导 public base URL” 的逻辑，要改为信任配置，不要因为 upstream Host 是 `space-origin.myagents.io` 而生成 origin 链接。

### 5.2 真实 IP 与限流

Cloudflare Worker 看到的来源可能变成腾讯云 relay IP。

策略：

- relay 自己做基础 IP 限流，保护腾讯云入口。
- Worker 只有在 `X-MyAgents-Relay-Secret` 正确且来源 IP 属于 relay allowlist 时，才信任 `X-Forwarded-For`。
- 如果 secret 不正确，不要信任转发 IP，按 Cloudflare 看到的 IP 处理。

不要把 `X-Forwarded-For` 无条件当真实用户 IP，任何公网客户端都能伪造。

### 5.3 Cookie / OAuth

OAuth redirect URI 保持：

```text
https://space.myagents.io/api/auth/...
```

relay 透传回调即可。`Set-Cookie` 如果不带 Domain，浏览器会按客户端访问 host `space.myagents.io` 存储，符合目标。不要让 Worker 把 cookie domain 写成 `space-origin.myagents.io`。

### 5.4 R2 public asset

当前头像公开域名是 `files.myagents.io`。API relay 不能自动改善这个域名的大陆访问速度。

如果头像/附件直链也成为瓶颈，需要单独研究：

- `files.myagents.io` 是否也做相同 relay/CDN。
- 或把公开资产改为由 `space.myagents.io` 下的 Worker/relay 路径输出。

当前优先级建议先只处理 API，因为用户反馈卡在团队/Skills loading。

---

## 6. 验证计划

### 6.1 不切 DNS 的验证

先不要改正式 DNS，用本地解析强制命中腾讯云 relay：

```bash
curl --resolve space.myagents.io:443:<TENCENT_RELAY_IP> \
  -w 'http=%{http_code} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' \
  https://space.myagents.io/health
```

带登录态测实际 API：

```bash
curl --resolve space.myagents.io:443:<TENCENT_RELAY_IP> \
  -H "Authorization: Bearer <SESSION_TOKEN>" \
  -H "X-MyAgents-Space-Client-Id: <PUBLIC_CLIENT_ID>" \
  -w 'http=%{http_code} ttfb=%{time_starttransfer} total=%{time_total}\n' \
  https://space.myagents.io/api/spaces/official/skills
```

对比三条链路：

| 链路 | 目标 |
|---|---|
| 大陆 -> Cloudflare 直连 | 当前基线 |
| 大陆 -> 腾讯云 relay -> Cloudflare | 目标方案 |
| 大陆 -> 用户代理 -> Cloudflare | 用户自备代理基线 |

至少记录 p50/p95/p99、错误率、TLS timeout 次数。

### 6.2 功能 smoke

必须覆盖：

- `/health`
- `/api/me`
- `/api/spaces/official/skills`
- `/api/spaces/official/events`
- Issue list/detail/comment
- claim / complete / cancel-claim
- skill zip download
- attachment upload/download
- OAuth desktop login callback
- `x-d1-bookmark` request/response header 透传

### 6.3 上线后观测

relay 日志只记录：

- request id
- method/path template（不带 query 里的敏感内容）
- status
- upstream status
- upstream connect / TLS / TTFB / total
- body bytes
- country/ASN（如果可得）

不要记录：

- Authorization
- Cookie
- request body
- response body

---

## 7. 故障与回滚

### 7.1 relay 挂了

需要 DNS health check/failover：

```text
腾讯云 relay unhealthy
  -> 大陆线路 DNS 回退到 Cloudflare 入口
```

TTL 建议 60s 起步。若 DNS 提供商健康检查不稳定，先不要做自动切流，改为手动开关。

### 7.2 Cloudflare origin 挂了

relay 不应伪装成功。直接返回 Cloudflare status/body，最多加 request id 方便排查。

### 7.3 腾讯云被攻击

relay 层需要基础限流和连接数限制。Worker 仍保留 Cloudflare 侧 rate limit，避免攻击绕过 relay 时直接打 origin。

---

## 8. 推荐落地顺序

1. 新增 `space-origin.myagents.io`，绑定到 Cloudflare Worker。
2. Worker 确认 `BASE_URL` 仍是 `https://space.myagents.io`。
3. 腾讯云新加坡部署 Caddy/Nginx relay，证书覆盖 `space.myagents.io`。
4. 用 `curl --resolve` 做不切 DNS 的性能和功能 smoke。
5. 增加 relay 日志脱敏、基础限流、健康检查。
6. 小流量或单地区 DNS 切到腾讯云 relay。
7. 对比 p50/p95/p99 和 timeout，再决定是否扩大到全大陆线路。

---

## 9. 暂不建议的方案

| 方案 | 不建议原因 |
|---|---|
| 客户端增加 `space-cn.myagents.io` 选项 | 破坏无感 URL；引入 session/cache/OAuth 分裂。 |
| 腾讯云部署第二套业务后端 | D1/R2/KV 数据一致性和双写复杂度远高于收益。 |
| relay 缓存动态 API | issue/claim/delivery/skill 权限都与用户/session 有关，缓存很容易越权或陈旧。 |
| relay 对所有请求自动 retry | 写请求重复执行风险高。 |
| 让 Cloudflare orange-cloud 继续作为大陆首跳 | 无法解决大陆用户到 Cloudflare 的首跳慢，只能优化 Cloudflare 内部或 origin 部分。 |

---

## 参考资料

- Cloudflare Workers Smart Placement: https://developers.cloudflare.com/workers/configuration/smart-placement/
- Cloudflare D1 read replication / Sessions API: https://developers.cloudflare.com/d1/best-practices/read-replication/
- Cloudflare Load Balancing traffic steering: https://developers.cloudflare.com/load-balancing/additional-options/traffic-steering/
- Caddy `reverse_proxy`: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- NGINX `ngx_http_proxy_module`: https://nginx.org/en/docs/http/ngx_http_proxy_module.html
