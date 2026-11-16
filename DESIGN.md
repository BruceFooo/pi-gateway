# 手机端 pi 控制台（pi-mobile-console）设计方案

> 状态：设计稿，未实施。目标：用手机浏览器在已部署的 distrisched 前端里控制本机（Windows PC）上的 pi。
> 参考范式：OpenClaw（gateway 拥有 agent 会话 + 手机 Web Control UI + WS 事件流 + 审批一等公民）。

---

## 0. 一句话架构

```
手机浏览器
  └─ https://<UI域名>/admin/  →「更多 → Pi 控制台」→ /admin/...#/pi
       │  同源 /pi/  (HTTPS + WSS, *.<域名> 泛域名证书)
       ▼
阿里云 nginx 127.0.0.1:443 ── location ^~ /pi/ ──▶ 127.0.0.1:33336   (frps 本机监听)
                                                        ▲
                                            frpc (本机, 已跑, serverAddr=<服务器IP>:<frps 端口>)
                                                        │
本机 Windows ── pi-gateway (Node, 监听 127.0.0.1:33336) ◀┘
                   └─ 每个会话一个子进程：pi --mode rpc   (JSONL stdin/stdout)

反向通知：pi-gateway ──HTTPS──▶ task_center /ui/api/pi/notify ──▶ 企业微信 textcard → touser=opsUser
```

要点：**手机只碰 443**（安全组已放行），frp 只碰已存在的 <frps 端口>，本机 33336 只在回环上，公网摸不到。

---

## 1. 为什么是这个形态（方案对比）

| 方案 | 做法 | 手机能干什么 | 代价 | 结论 |
|---|---|---|---|---|
| A. pi 扩展内嵌 HTTP 桥（照搬 pi Browser Assistant 的 47860 桥） | 在正在跑的桌面 pi 里装扩展，扩展开 HTTP/WS | 只能镜像「桌面上那个正在开的会话」；桌面 pi 必须开着 | 最小（~200 行） | 不做主体，**留作二期「桌面会话投射」** |
| **B. 独立 pi-gateway 服务（pi SDK / RpcClient）** | 本机常驻 Node 服务，自己 `new RpcClient({cliPath})` 起 `pi --mode rpc` 子进程，HTTP+WS 对外 | 新建/切换/续跑任意会话、发文本与图片、停止、审批、收通知；会话文件与桌面共用可交接 | ~600–800 行 TS + 1 个 Windows 服务 + 1 条 frp + 1 个 nginx location | **采用** |
| C. 把 TUI 直接搬到手机（ttyd / noVNC / SSH+tmux） | 转发终端画面 | 能跑，但移动端选不了文本、看不清、没法点按钮 | 极小 | 不采用 |
| D. 直接换用 OpenClaw（它有现成 Control UI） | 装 OpenClaw 网关 | 功能最全 | 现有资产（skills / extensions / pi Browser Assistant / 学习模式记忆 / 阿里云 skill）全在 pi 上，换宿主成本远大于写 800 行 gateway | 不采用，只**抄它的客户端契约与 UI 交互** |

选 B 的关键理由：pi 已提供完整程序化接口（RPC 命令面 + 事件流 + 扩展 UI 转发），不需要给 pi 打补丁；会话文件是磁盘 JSONL，手机 ↔ 桌面天然可交接。

---

## 2. 组件与落点（改哪里，改多少）

| # | 位置 | 改动 | 规模 |
|---|---|---|---|
| 1 | `<本机工具根>\pi-gateway\`（新建） | Node 22+ 服务：HTTP/WS API、会话 supervisor（`RpcClient`）、通知客户端、鉴权、配置 `gateway.json`；用 `<本机工具根>\gofrpc\WinSW-x64.exe` 同款方式注册 Windows 服务 | 新增 ~600–800 行 |
| 2 | `<本机工具根>\gofrpc\frpc.toml` | 追加一条 proxy：`name="pi-gateway" type="tcp" localIP="127.0.0.1" localPort=33336 remotePort=33336` | +5 行 |
| 3 | 服务器 `<服务器根>/runtime/nginx/sites-enabled/<UI域名>.conf` | 追加 **`location ^~ /pi/ { proxy_pass http://127.0.0.1:33336/; ... }`**（`^~` 是必须的：现有正则 `location ~ .*\.(js|css)?$` 会盖掉普通前缀 location）+ WS `Upgrade` + `client_max_body_size 20M` + `proxy_read_timeout 300s` + 独立 `limit_req_zone` | +25 行 |
| 4 | `task_center` | `UIApiController` 加 `POST /ui/api/pi/notify`（`X-Pi-Token` 校验，走 `SecurityConfig` 白名单）；`WechatSendService` 加 `sendWechatTo(String toUser, title, body)`（`TextCard` 第 1 参 `touser` 参数化），**保留现有 `send2Wechat` 的 `@all` 语义不动** | +40 行 Java |
| 5 | `ui/task_manage/admin/` | 新页面 `components/PiConsole.vue`；`main.ts` 加路由 `{path:'/pi'}`；`App.vue` 「更多」grid 加一个 `van-grid-item text="Pi 控制台" @click="go('/pi')"`（现有 7 项在 `:35-42`） | 新增 ~400 行 Vue |

**不动的东西**：不改 pi 本体、不改 pi 的 TUI、不新增企业微信应用、不引入 whisper（手机输入法自带语音转文字，见 §6）。

---

## 3. 手机端页面（越简单越好：1 页 3 屏）

用 Vant（admin 已是 Vant），不做新登录页——沿用 admin 已登录态 + gateway token。

```
┌ 顶部状态条 ────────────────────────────────┐
│ ● 空闲   <本机工具根>/.../distrisched   [模型 ▾] [思考 ▾]   ⚡3 个 run │
├────────────────────────────────────────────┤
│  ① 会话（主屏，90% 时间在这）              │
│     用户气泡 / agent 流式文本              │
│     ▸ read  src/App.vue            ✓ 1.2s  │  ← 工具行默认折叠，点开看参数+输出
│     ▸ bash  mvn clean package      … 运行中│
│     [输入框 多行]              [📎][发送]  │  ← 📎 = 拍照/相册；运行中显示「停止 / 打断 / 排队」
├────────────────────────────────────────────┤
│  ② 待确认（只在有事项时带红点）            │
│     「要执行 mvn deploy 吗？」[允许][拒绝]  │
├────────────────────────────────────────────┤
│  ③ 任务/历史                               │
│     ▸ 运行中：distrisched 发布 (2m)        │
│     ▸ 最近会话：学习模式调研 (1h) → 点开续跑│
│     [+ 新建会话]（选项目目录 + 任务模板）   │
└────────────────────────────────────────────┘
```

对标 OpenClaw 的移动端交互（都已在它的 Control UI 里验证过，值得照抄）：
- **历史以服务端为准**：重连后先全量拉历史，再接增量（见 §5 断线恢复）。
- **run 状态不靠猜**：gateway 明确给出 `activeRunIds`（空数组＝确定空闲），别用「最后一条消息」推断。
- **agent 的提问显示在输入框上方**，用户仍可继续打字；提交 ≠ 回答（可以跳过）。
- **失败/中断的消息可「编辑重发」**（把该条退回输入框）。
- **拍照直连相机**（HTTPS 下才有预览；本方案全程 https，没问题）。
- 会话命名、侧栏会话列表、点开历史即续跑。

pi 原生语义要在 UI 上显式区分（OpenClaw 没这么直接，别糊掉）：
- **打断（steer）**：当前 run 在下一个工具边界被改道 → 「它做错方向了，立刻纠正」。
- **排队（follow_up）**：当前 run 结束后再跑 → 「等它做完再做下一件事」。
- **停止（abort）**：直接中断。
所以运行中的 composer 给三个动作：`打断 / 排队 / 停止`。

---

## 4. 通知设计（主动通知 + 任务完成通知）

**为什么必须经 task_center 转发**：企业微信应用消息要求「可信企业 IP」，实测服务器 `gettoken` 成功（本机直连会被拒），所以通知从服务器发。

**通知对象已确认**：企业微信通讯录里 userid 恰好就是 `opsUser`（`{"name":"Bruce Foo","userid":"opsUser","department":[1]}`；另有其它成员）。所以「指定 opsUser」= `TextCard` 的 `touser="opsUser"`。

通道：
```
POST https://<CENTER域名>/ui/api/pi/notify
Header: X-Pi-Token: <随机 32B，配置在 gateway 与 task_center 各一份>
Body:   { "to":"opsUser", "title":"[pi] 任务完成", "body":"…摘要…", "session":"<会话id>", "kind":"settled|approval|error" }
```
task_center 校验 token → `WechatSendService.sendWechatTo("<touser>", title, body)` → textcard `url=https://<UI域名>/admin/#/pi?session=<id>`（点开直达该会话，body 超长按 4000B 截断）。

触发点（按 pi 事件精确挂钩）：
| 事件 | 通知 |
|---|---|
| `agent_settled`（**不是** `agent_end`：重试/压缩/steering/排队都会在其后触发，`agent_settled` 才是最终空闲） | 任务完成；摘要取 `get_last_assistant_text` 首行 |
| 工具 gating 挂起（gateway 在 `tool_call` 上拦 → 推手机 `confirm`） | 「等待确认」，附命令/改动摘要 |
| `pi` 子进程退出 / 心跳丢失 / 会话异常 | 错误通知 |
| frpc 断链（本机侧自测） | 「本机离线」通知（手机端也会显示灰色状态） |

节流与配额：同会话同类 60s 内只发 1 次；完成通知带「会话名 + 首行摘要」一行即可；企业微信应用消息配额有限，**必须合并**（多个 run 同时完成 → 1 条汇总）。
`@all` 的老语义（301 挂号告警）保持不变——新增方法，不改默认，避免影响现有告警链。

---

## 5. pi 侧接口与事件映射（实现要点，全是已验证事实）

启动与帧协议：
- 每会话一个子进程：`RpcClient({ cliPath: <pi dist/cli.js>, args:["--mode rpc", ...] })`（`pi --mode rpc --no-session` 是文档给的形态；gateway 用会话文件即可，不必 `--no-session`）。
- JSONL 严格成帧：**按 LF 分帧，不要用 Node `readline`**（它还按 U+2028/U+2029 断行，会撕裂记录）；`id` 关联请求与响应；**gateway 自己的日志只写 stderr**。
- `prompt` 的 `response.data.disposition`（`started`/`handled`）决定 UI 立刻显示什么；`steer`/`follow_up` 返回 `queueUpdated`，`queue_cleared` 要清掉本地队列显示。

RPC 命令面（够用，无需自造）：
`prompt steer follow_up abort clear_queue new_session get_state get_messages set_model cycle_model get_available_models set_thinking_level set_steering_mode set_follow_up_mode compact set_auto_compaction set_auto_retry abort_retry bash abort_bash get_session_stats export_html switch_session fork clone get_fork_messages get_entries get_tree get_last_assistant_text set_session_name get_commands`

事件 → UI 映射：
| pi 事件 | 手机端 |
|---|---|
| `message_update` 且 `assistantMessageEvent.type==="text_delta"` | 流式追加 |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `tool_result` | 工具行（折叠），每个最终调用必有 `tool_execution_end` |
| `turn_end` / `agent_end` | 回合结束（**不要**当完成） |
| `agent_settled` | 完成 → 状态点变空闲 + 发企业微信 |
| compaction / retry / queue 事件 | 顶部状态提示（「正在压缩上下文」「正在重试」） |
| RPC-only `extension_ui_request`（`select/confirm/input/editor/notify/setStatus/setWidget/setTitle`） | 「待确认」屏的卡片，回 value / confirmation / cancellation |

图片输入：SDK `prompt()` 选项里有 **`images?: ImageContent[]`** ⇒ 手机拍照直传 base64 即可，不需要 OCR。

会话交接（这个设计里最实用的一条）：
- 会话默认存 `~/.pi/agent/sessions/`（按 cwd 分组），可用 `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` / `sessionDir` 改。
- gateway 与桌面 pi **共用同一目录** ⇒ 手机新建的会话，回到桌面 `pi --session <id>` 或 `/resume` 直接接着跑；反过来手机也能列出并续跑桌面会话。
- 手机侧「新建会话」= 选项目目录（cwd 决定 pi 的上下文与 AGENTS/CLAUDE 加载）+ 可选任务模板。

断线恢复（照抄 OpenClaw 的 active-run cache 思路，简化版）：
1. WS 重连 → 先 `history`（gateway 从会话 JSONL 读全量，直接替换本地消息列表）。
2. 同时带回 `activeRunIds`；若本机有在跑的 run，gateway 保留该 run 的 `runId` + 已生成文本环形缓冲 + 最近 N 条事件（带 `seq`）。
3. 客户端按 `runId`+`seq` 调增量；正向缺口（seq 跳号）就再拉一次权威历史。
4. 启动/重连后立刻「回填待审批/待确认」列表（避免连接窗口里的竞态丢单）。

---

## 6. 安全模型（手机 → 公网 → 家里/公司的 agent）

| 层 | 措施 | 备注 |
|---|---|---|
| 传输 | 全链路 HTTPS/WSS（泛域名证书 `*.<域名>` 已在 `<服务器根>/cert/<域名>/`） | 手机只访问 443 |
| 暴露面 | gateway 只监听 `127.0.0.1:33336`；frpc `localIP=127.0.0.1`；nginx 从 `127.0.0.1:33336` 反代 | 不需要在阿里云安全组开新端口 |
| frp | 沿用现有 token（`frps.toml` `auth.token`，`bindPort=<frps 端口>`，无端口白名单，客户端自选 remotePort） | **可选加固（二期）**：frps 加 `transport.bindAddr="127.0.0.1"`，四个 remotePort 就只绑回环，公网彻底摸不到。⚠️ 改了要验证现有 4 条隧道（openwebui/comfyui/dify/RDP）都是走 nginx→127.0.0.1，若有人在外网直连 `:33334` 会被打断；改前 `ss -lntp` 看 `*:33334`，改后应变成 `127.0.0.1:33334` |
| 鉴权 | gateway 用独立 `PI_CONSOLE_TOKEN`（32B 随机，长期 bearer；配在 gateway 与前端构建期注入的常量里） | 不复用 distrisched JWT（跨语言校验麻烦，二期可做：JWT 密钥在 `task_common`，gateway 可验签）。手机端「配对」流程参考 OpenClaw：二维码/短码一次性下发设备 token，可在 admin 里吊销 |
| 授权（最关键） | **pi 没有内建权限系统**：工具能不能跑，只能由 gateway 在 `tool_call` 事件上拦。建议默认：手机发起的会话只开放只读工具（read/grep/…），`bash/edit/write` 一律挂起推手机 confirm；桌面发起的会话保持 pi 现状 | 这是最需要你拍板的一条（§8-2） |
| nginx | `location ^~ /pi/` + `limit_req zone=pi rate=5r/s burst=20` + `client_max_body_size 20M`（照片）+ `proxy_read_timeout 300s`（WS 长连）+ 不进静态缓存 location | ⚠️ `cron 30 3,9,14 * * * systemctl restart runtime-nginx` 会切断 12 台执行器 wss（实测 5~7s 自动重连）→ 改配置手动 reload 并避开 03:30/09:30/14:30 |
| 审计 | gateway 记录 `设备 → prompt → sessionId`（会话 JSONL 本身即完整审计） | 提醒：会话文件里含命令输出/文件内容，转发或导出前先看一眼（pi 文档也是这么提醒的） |

---

## 7. 分阶段落地（每期都能独立验收）

| 期 | 内容 | 验收标准 | 风险 |
|---|---|---|---|
| **P0 只读观察** | gateway + frp + nginx + 手机「会话/任务」两屏只读 + 完成通知 | 手机能看到桌面/手机会话实时滚动；跑完收到企业微信 | 最低，全链路（frp/token/nginx/事件流）一次打通 |
| **P1 文本控制** | 新建会话、发 prompt、打断/排队/停止、模型与思考等级 | 手机上发一句，桌面 `pi --session <id>` 能看到同一条 | 中（要处理并发 run） |
| **P2 图片 + 待确认 + 编辑重发** | 拍照上传（`prompt({images})`）、RPC 扩展 UI 卡片、失败消息编辑 | 手机拍照问「这是什么错」；agent 提问能在手机上答 | 中 |
| **P3 工具 gating + 配对吊销 + 多设备** | 默认只读工具集、`tool_call` 审批、二维码配对/吊销 | 未经确认的 `bash` 不会跑 | 中高（误拦会烦人，先白名单 `mvn`/`git` 之类） |

P0 的改动面已经覆盖 100% 的基础设施风险，后面每期只加交互层。

---

## 8. 需要你拍板的 5 件事

1. **入口形态**：同域 `<UI域名>/pi/`（推荐，前端同源最省事）还是新建 `pi.<域名>` 子站（隔离更干净，但要新 vhost）。
2. **工具权限默认**（最重要）：手机发起的会话是否默认禁 `bash/edit/write`，点开审批才允许？（强烈建议默认禁）
3. **gateway 部署位置与进程模型**：建议 `<本机工具根>\pi-gateway\` + WinSW 服务；每会话一子进程、上限 2–3 并发 run，超出排队。可接受？
4. **通知文案与直达**：textcard 点开直接进该会话（`#/pi?session=<id>`）；完成通知只发「会话名 + 首行摘要」一行，够吗？
5. **二期要不要「桌面 pi 会话投射」**（方案 A 的扩展桥）：桌面上正开着的 pi 会话，手机能看到并接管输入。P0 之后再加。

---

## 9. 备选/放弃项（记录理由，免得以后重新讨论）

- **语音**：手机输入法自带语音转文字（微信/iOS/搜狗都行）→ 直接转成文本进 composer，**不需要 whisper**；若要 agent 听语音条，再加本地 whisper.cpp，属 P4。
- **直接用 OpenClaw 的 Control UI**：功能最全（配对/scope/approvals/PiP/命令面板都有），但你的 skills、扩展、pi Browser Assistant、学习模式记忆、阿里云发布 skill 全在 pi 上，换宿主 = 重建全部资产。已把它文档里的客户端契约（scope 分层、activeRunIds、审批回填、Ed25519 设备配对）当作本设计的蓝本。
- **Tailscale / frp 的 direct 模式暴露 pi 端口**：多一层客户端安装与运维；本方案手机只用 443，够用。
- **在 task_center 里直接跑 agent**：task_center 是 Java/Spring，pi 是 Node 生态，混在一个进程只会互相拖累。

---

## 10. 关键事实清单（复核用）

- frps：`<服务器根>/frps/frps.toml` = `bindPort=<frps 端口>` + `auth.method="token"`（无端口白名单）；`frps.service` active；`ss -lntp` 现有 `<frps 端口> 33389 33333 33334 33335`。
- frpc：`<本机工具根>\gofrpc\frpc.toml` 已 4 条隧道（RDP 3389→33389、openwebui 3000→33333、comfyui 8188→33334、dify 8717→33335），WinSW 服务模板同目录。
- nginx：`<服务器根>/runtime/nginx/sites-enabled/`（<站点短名>/comfyui/dify/openwebui/ai/anki/blog/cert），443 由 `runtime-nginx.service` 一个 master 承载全部 vhost；`<UI域名>.conf` 里 `/api/ → 127.0.0.1:8888/`；证书 SAN = `<域名>, *.<域名>`。
- 服务器公网 IP = frpc `serverAddr`（在 `<本机工具根>/gofrpc/frpc.toml` 第 1 行；公开仓库里不写死），SSH 免密 `root@<域名>`。
- 企业微信：`corpId` / `agentId` 见 `task_center/config/QyWeixin.java`（公开仓库不写死），通讯录 userid 见企业微信后台；`TextCard(touser,...)` 第 1 参即通知对象。
- 前端：`ui/task_manage/admin/App.vue` 「更多」popup grid（7 项，`/jobPolicy` 在 `:42`）、路由在 `admin/main.ts:35`、页面样例 `admin/components/JobPolicy.vue`。
- pi：`docs/rpc.md`、`docs/rpc-commands.md`、`docs/json.md`、`docs/rpc-extension-ui.md`、`docs/sdk.md`；`RpcClient`/`createAgentSession` 均从 `@earendil-works/pi-coding-agent` 导出；会话目录 `~/.pi/agent/sessions/`（按 cwd 分组）。

## 11. 实测修正（2026-11-16 本地回归后补记）

- **第 5/8 节的旧假设作废**：pi 1.5.2 没有原生危险命令审批（实测 `rm -f` 直接执行）。
  确认改由「模型末行标记 `[[PI_CONFIRM:问题|选项A|选项B]]`」驱动，网关 `agent_settled` 后扫描生成确认卡。
- 模型确认不进 `approvals`、不参与 `isBusy()`（否则已结束的 run 会把队列卡到 `approvalTimeoutMs`）。
- 客户端消息的**目标 id 不能用 `msg.id`**（`msg.id` 是请求配对 id）：已改为
  `entryId` / `cronId` / `approvalId`，`msg.id` 仅作回退。
- `Queue.markIdle()` 的 `minRunMs` 守卫会让比它更短的一轮（定时任务快答约 3s）永远占住 `running`，
  整条队列饿死到 `hardTimeoutMs`（2 小时）——已改为延后同样时长重判（`this.idleRetry`）。
- `#cronUpdate` 必须委托 `Queue.cronPatch`：自己拷字段会既不认 `patch.remove`、也不解析 `at`。

## 12. 上线实录（2026-11-16 白天，公网已跑通）

链路：手机浏览器 → `https://<UI域名>/admin/#/pi` → runtime nginx `location ^~ /pi/`
→ frps(<frps 端口>) / remotePort **33336** → 本机 `127.0.0.1:33336`（WinSW 服务 `pi-gateway`）。
实测：连接即 `ready`、文字往返、图片往返（历史里 `[图片 #1..#4]`）、确认卡（公网点「要」后
网关收到 `approval_resolve`）、企业微信真发（`[notify] 已发送 -> opsUser: 任务需要你确认`）。

- **nginx 正则 location 优先于前缀 location**：该站有 `location ~\.(png|ico|js|css)$`（防盗链）挡在
  `location /` 前 ⇒ 普通 `location /pi/` 会被它抢走静态请求，只能用 `location ^~ /pi/`。
  `map $http_upgrade $connection_upgrade` 已存在（`nginx.conf:42`），跟现网风格复用。
- center 旧 jar 没有 `/ui/api/pi/notify` 路由 → 网关侧看到 403，看着像 token 错；**先确认 jar 版本**再查 token。
  token 比对用 `MessageDigest.isEqual`（`UIApiController` 约 :511，`@Value("${pi.notify.token:}")` 约 :92，
  `SecurityConfig.java:40` 放行）。
- WinSW 服务装时把 **PATH 快照写死**（`scripts/make-service-xml.ps1` 生成 `service/pi-gateway.xml`）：
  fnm 的 node 路径会变 ⇒ xml 里用 `C:\node\aliases\default\node.exe`，并显式 `USERPROFILE=<用户主目录>`
  （pi 凭据与 `~/.pi/agent/sessions/` 靠它）；环境变了就重跑生成脚本 + reinstall。
  非交互会话里 `Restart-Service` 不可用 ⇒ `sc.exe stop/start`。
- 发布走技能 `aliyun-<中性名>`（**必须 pwsh7**）。发现脚本 bug：`tar` 命中 Git for Windows 的
  GNU tar 1.35，报 `tar (child): Cannot connect to C: resolve failed` ⇒ 已改成 `$env:SystemRoot\System32\tar.exe`（bsdtar）。
- **未做（可选项）**：`#maybeLongRunNotify()` 只在 `tool_execution_end` 计数时触发 ⇒ 一轮纯文本/模型空停顿
  （实测见过 6 分钟只有 `thinking_start/end`，无 `agent_settled`，`isStreaming=true`）不会推提醒；
  若要补，就加「N 分钟无任何事件」的 `notice`。这不是队列 bug：当时 `queueRunning:null`、`runState:idle`，
  卡顿在上游模型，不是 `markIdle()` 饿死。
