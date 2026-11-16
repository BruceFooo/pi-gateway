# pi-gateway

让手机（企业微信 + 浏览器）远程驱动本机 **pi** 编码代理：文字/图片进、文字+图片回、
危险操作前先确认、可排队、可定时、可切换/改名会话。

- 网关端口 `33336`，WebSocket 路径 `/pi/ws?token=<token>`，健康检查 `GET /healthz`。
- 前端页面在 distrisched 的 admin 子应用：`https://<UI域名>/admin/#/pi`（本地 `npm run dev` 后走 `/pi` 代理）。
- 当前状态：**已上线（2026-11-16）**。手机走 `https://<UI域名>/admin/#/pi` →
  阿里云 nginx → frp 隧道（remotePort 33336）→ 本机 Windows 服务 `pi-gateway`。
  文字/图片/确认卡/企业微信推送均已实测通过（见「上线与回滚」）。

## 目录

```
index.js            入口
src/gateway.mjs     WebSocket 协议、会话/队列/确认/图片/通知编排
src/scheduler.mjs   队列 + 定时任务（tick/minRunMs/hardTimeoutMs、cronPatch）
src/server.mjs      HTTP：/healthz、/pi/media、图片上传、企业微信通知推送
src/pi-rpc.mjs      本机 pi 子进程（--mode rpc）客户端，断线自动重启
src/session.mjs     会话列表/改名/绑定入口会话（读 pi 的 sessions/*.jsonl）
src/protocol.mjs    消息名与字段约定
src/paths.mjs       包根路径、state/、media/
config/config.json  端口、token、超时、通知等（见下）
state/queue.json    队列与定时任务持久化
media/              手机发来的图片（GET /pi/media/<file>）
logs/gateway.log    网关日志
scripts/            重启脚本 + 全部自测脚本
```

## 启动 / 重启

```powershell
# 生产常驻：Windows 服务（WinSW，配置 service/pi-gateway.xml，显示名 Pi Gateway）
# ⚠ 用这个，不要手打 sc.exe stop && sc.exe start：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-service.ps1
# 要等手机上这一轮回答发完再重启，就加 -DelaySec 75
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-service.ps1 -DelaySec 75
# 服务态日志：logs/service/pi-gateway.out.log / .err.log / .wrapper.log；重启动作日志 logs/restart-service.log

# 手动跑（开发调试用；同样会先杀掉 33336 监听者 + 残留的 pi --mode rpc 孤儿进程）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-gateway.ps1
```

**为什么必须用 `restart-service.ps1`（2026-11-16 踩坑实录）**：`sc.exe stop pi-gateway` 只结束 WinSW 包装进程，
它起的 `node index.js` 子进程**不会被杀**，变成孤儿继续占着 33336；接着 `sc.exe start` 起的新实例因
EADDRINUSE 崩掉，服务变 `STOPPED / WIN32_EXIT_CODE 1067（进程意外终止）`，而端口上跑的还是**旧代码**的旧进程。
当时的表象是：手机上点「页面」按钮报 `未知指令： page_list`，`/healthz` 的 `uptimeSec` 还是 4 小时。
脚本在 stop 之后按端口清理孤儿（连带它起的 `pi --mode rpc` 子进程），再 start，并在结尾自动验：
`sc query` 应为 RUNNING、`/healthz` 的 `uptimeSec` 应变小、`GET /pi/pages/__probe__.html` 不带令牌应返 **401**
（404 = 跑的还是旧代码）。**注意这会掐断当前 pi 会话**（会话是网关起的子进程），跑之前先跟手机上的人打招呼
或用 `-DelaySec`。

服务是 `service/pi-gateway.xml` 生成的（`scripts/make-service-xml.ps1`），**安装时把 PATH 快照写死在
xml 里**：node 或 pi 的路径变了，要重跑生成脚本并 `sc.exe delete pi-gateway` + 重新 install（需管理员）。
非管理员的远程会话里 `Restart-Service pi-gateway` 会因 `NonInteractive` 失败，用上面的 `sc.exe`。
装服务的提权一次性脚本是 `scripts/elevated-setup.ps1`（自带健康检查失败 → 自动卸载回滚）。

仓库里 **不含** `service/pi-gateway.exe`（WinSW 启动器，18MB 官方二进制，已 gitignore）：新机器上从
WinSW 的 releases 下 `WinSW-x64.exe` 改名成 `service/pi-gateway.exe` 即可，xml 由 `scripts/make-service-xml.ps1` 生成。
同样不含 `config/config.json`（真实令牌）——从 `config/config.example.json` 拷一份再填。

不要从 bash 里 `nohup node index.js &`：那样起的进程继承控制台，shell 一退就 SIGTERM。
脚本的 stdout 也不要接管道（PowerShell 会挂）。启动后 6 秒内 `healthz` 应返回
`{"ok":true,"protocol":1,...,"pi":{"connected":true,...},"notify":{...}}`。

## 配置（config/config.json 中真实生效的键）

| 键 | 值 | 作用 |
|---|---|---|
| `port` | 33336 | WS/HTTP 端口 |
| `token` | （见文件） | 连接与图片上传的鉴权 token |
| `autoRestart` | true | pi 子进程退出后自动重启 |
| `approvalTimeoutMs` | 900000 | 确认卡 15 分钟无回答自动过期 |
| `longRunNotifyMs` | 600000 | 单轮超过 10 分钟推一次「还在跑」 |
| `retentionHours` | 48 | state/media 里旧条目的保留时长 |
| `maxImagesPerMessage` / `maxImageBytes` | 4 / 8388608 | 单条消息图片限制 |
| `notify.centerUrl` | `https://<CENTER域名>` | 企业微信通知经 distrisched center 的 `/ui/api/pi/notify` |

本地自测通知链路：起 `node scripts/notify-stub.mjs`（监听 127.0.0.1:33399），
用环境变量 `PI_NOTIFY_CENTER_URL` 指过去，`GET /hits` 看收到的 payload。

## 协议要点（改客户端前必读）

- 事件信封是 `{type:'event', event:'<名字>', ...payload}`，**payload 展平在顶层**，
  不是 `event:<名字>` 那种字段；连接后网关主动推 `ready{boundSessionId,activeSessionId,state,lastSeq,pi}`。
- 响应按请求 `id` 配对，因此**目标 id 一律用专用字段**，不能占用 `msg.id`：
  `queue_remove{entryId}`、`cron_update{cronId,patch}`、`cron_run{cronId}`、
  `approval_resolve{approvalId,value}`（旧字段 `msg.id` 仍作为回退，但前端已不再用）。
- `chat_send` 的入队回执 id 在 `data.queued`；`agent_settled` 载荷只有 `{aborted,state}`，**没有 runId**，
  所以「一轮结束」只能靠时序判定。
- 图片：`POST /pi/media`（multipart，带 token）→ `chat_send{images:[...]}`；
  回程 `user_message` 带附件 url，可在 `/pi/media/<file>` 取回。

## 危险操作确认（标记协议）

pi 1.5.2 没有原生「危险命令审批」，所以约定由模型在回复末行输出：

```
[[PI_CONFIRM:要执行 rm -rf ./dist 吗|继续|取消]]
```

网关在每轮 `agent_settled` 后扫描并剥掉标记（`#titleOf`/前端 `cleanText()` 同样剥离），
生成确认卡推给手机 + 企业微信（`kind:'approval'`，正文里带「可选：A / B / C」）；回答会排一轮**新任务**送回模型。
模型确认**不进** `approvals`、不参与 `isBusy()`——否则一个已结束的 run 会把队列卡到 15 分钟超时。
标记是否出现取决于模型，脚本失败先重跑一次再判定。

**匹配规则（`src/markers.mjs`，两个标记都一样）**：标记必须**独占一行**（允许 markdown 列表/引用前缀与首尾空白），
并且**不在代码块 / 行内代码里**；命中不了时只写一行日志（`[confirm] 检测到 PI_CONFIRM，但标记没有独占一行…已忽略`）。

> 2026-11-16 事故：一条「手机 pi 使用指南」回复把两个标记当文档示例写在行内代码里，旧的正则在整段正文全文匹配，
> 结果示例被真的执行了——弹出问题为「问题」、选项为「选项A/选项B」的确认卡（微信里看不到选项，用户只能照抄），
> 同时 `[[PI_SESSION:new]]` 示例真的新开了一个会话（上下文全丢）。回归见 `scripts/verify-markers.mjs`。
> 所以模型侧的护栏也写进了入口简报（`ENTRY_BRIEF` 第 6 条）：讲解协议时不要原样输出标记，改成 `PI_CONFIRM(…)` 这种非触发写法或放进代码块。

## 本机 HTML 页面发布（`[[PI_PAGE:…]]`，2026-11-16 新增）

模型（例如 `answer-me-with-html` 技能）写完一个本机 HTML 解释页后，在回复末行单独输出：

```
[[PI_PAGE:C:\path\to\explain.html|调度原理]]
```

网关在 `agent_settled` 后扫描（`#scanPageMarker()`，匹配规则与其它标记一样：独占一行、不在代码里），
把文件**复制**进 `pages/` 并发 `page_ready` 事件（`{name,url,title,bytes,at}`）；
手机 `PiConsole` 会在对话里插一张「📄 打开」卡片，「页面(N)」面板列出已发布页面，点了在新标签打开。
这样不需要给技能加「起 HTTP 服务」的提示词，也不会让解释页的 `fetch` 跨域打网关。

- **URL**：`/pi/pages/<slug>-<sha8>.html?token=<网关令牌>`。哈希取**源路径**的 sha1 前 8 位 ⇒ 同一个文件重发覆盖同一个 URL（页面只反映最新状态），不同目录同名文件不会互相顶掉，URL 也不泄露本机目录。
- **访问控制**：走 `/pi/` 那条 nginx 规则（不用改 nginx）；要令牌（`?token=` 或 `x-pi-token`）；响应头 `cache-control: no-store`、`x-content-type-options: nosniff`、`referrer-policy: no-referrer` + CSP（页内脚本/内联样式可用，外联资源与 `fetch` 被 `default-src 'none'` 拦掉）。
- **安全边界（重要）**：页面与本控制台**同源**，能读 localStorage 里的令牌、能调同站接口。所以 `pages.mjs` **只接受本机自己生成/修改的 `.html`**（拒绝远程抓来的 HTML），单文件默认上限 2MB（`maxPageBytes` 可配），保留 `pageRetentionHours`（默认 14 天）后自动清；`pages/` 已进 `.gitignore`（生成的解释页不是源码）。
- 标题优先级：标记里写的 > 页面自己的 `<title>` > 文件名。
- 发布失败只写日志 + 一条 `notice`（`[pages] 发布失败：文件不存在：…`），不影响本轮回答。

## 会话

入口会话（标题「手机控制台」）与网关绑定，重启后按标题补绑。
改名有两条路径，两处都要读：pi RPC `set_session_name` 追加带 `timestamp` 的 `session_info`（通常在文件末尾），
网关 `#renameInFile` 改首行 `header.name` + `header.renamedAt`；`#readMeta` 按时间戳取最新的一次。

## 自测脚本

| 脚本 | 覆盖 | 最近结果 |
|---|---|---|
| `smoke.mjs` | 连接→入队→串行→读回（会往绑定会话写测试聊天） | PASS 12 项 |
| `verify-contract.mjs` | 协议字段形状 | OK 10/10 |
| `verify-features.mjs` | 图片往返 + 定时任务增删跑 | OK 13/13 |
| `verify-switch.mjs` | 列表/改名/切换/绑定不被破坏 | PASS 11/11 |
| `probe-confirm.mjs` | 标记确认全链路（真发企业微信时去掉 `PI_NOTIFY_CENTER_URL`） | **PASS 9/9**（服务态实测） |
| `verify-rename.mjs` | `session_rename` → 列表里读到新名（pi 追加 `session_info`，按时间戳取最新） | PASS（改名→改回，往返通过） |
| `verify-notify.mjs` | 通知器真发一次（会真发企业微信，慎用） | sent=1 → `opsUser` |
| `probe-longrun.mjs` | 长任务告警 | 见 logs/probe.out |
| `verify-markers.mjs` | 标记匹配规则：文档示例（行内代码/围栏）不触发、真标记独占一行才触发（纯离线，不连活体网关） | PASS 19/19（含 `PI_PAGE` 7 条） |
| `verify-pages.mjs` | 页面发布：同名重发不堆 URL、不同目录不互顶、`..`/非 `.html` 拒绝、索引跨重启保留标题、只删过期页、大小上限报错文案（纯离线） | PASS 26/26 |

跑之前记得 `PI_NOTIFY_CENTER_URL=http://127.0.0.1:33399` + 起 stub，否则会打到生产 center。

## 上线与回滚（2026-11-16 已实施）

四处改动，各自都有备份：

| 改动 | 位置 | 备份 / 回滚 |
|---|---|---|
| 本机常驻服务 | `service/pi-gateway.xml` + `pi-gateway.exe`（WinSW） | `sc.exe stop pi-gateway` + `service\pi-gateway.exe uninstall`，再跑 `scripts/restart-gateway.ps1` 回手动模式 |
| frp 隧道 | `<本机工具根>/gofrpc/frpc.toml` 里 `name="pi-gateway"`（localPort 33336 → remotePort 33336） | 备份 `frpc.toml.bak-20261116-115034`；删掉那段 + `Restart-Service remote-desktop`（会瞬断 RDP） |
| nginx 反代 | 服务器 `<服务器根>/runtime/nginx/sites-available/<UI域名>.conf` 新增 `location ^~ /pi/` | 备份 `<UI域名>.conf.bak-20261116-115000`；装块用的脚本 `scripts/server-apply-pi-nginx.sh`（`nginx -t` 失败即自动还原） |
| center 通知 token | 服务器 `<服务器根>/java/task_center/application.properties` 第 34 行 `pi.notify.token=...` | 备份 `application.properties.bak-20261116-114113`；脚本 `scripts/server-apply-pi-token.sh` |

一条命令按层回滚（默认 `all`，不加 `-Yes` 只打印将要做什么）：

```powershell
pwsh -NoProfile -File scripts/rollback-pi-gateway.ps1 -Level nginx   # 或 service|frpc|center|all
pwsh -NoProfile -File scripts/rollback-pi-gateway.ps1 -SelfTest     # 只验证 frpc 删段逻辑（副本上跑，无副作用）
```

jar / 前端 dist 的版本回滚仍由发布技能自己的 `backup/<时间戳>/` 负责（`-NoRollback` 才跳过），这个脚本不碰。

踩过的坑（下次改服务器前先看）：

- 该站点的正则 `location ~\.(png|ico|js|css)$` 在 `location /` 之前且带防盗链，**普通 `location /pi/`
  会被它截走 `pi-gateway` 页面的 js/css** ⇒ 必须用 `location ^~ /pi/`。
- `map $http_upgrade $connection_upgrade` 已在 `nginx.conf:42`，写 WS 头要跟现网风格用
  `proxy_set_header Connection $connection_upgrade;`。
- center 老 jar 里没有 `/ui/api/pi/notify` → 网关打过去 403；**改了 controller 必须重新发布 center**
  （本次发布的是 jobVersion `26.11.11.272`）。
- nginx 用 `-t` 校验的是 `<服务器根>/runtime/nginx/conf/nginx.conf`（不是 `/etc/nginx/`）。
- 公网入口只走 TLS + token，`location ^~ /pi/` 里已 `access_log off`，避免 token 进访问日志。
