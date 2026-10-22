# ofm-server 设计与实现

面向使用者的说明见 [`../README.md`](../README.md)。本文只记录实现层面的决定，以及
“为什么是这样而不是那样”。

```
任意 agent (pi / Claude Code / curl / OpenAI SDK / Anthropic SDK)
        │  POST /v1/chat/completions  或  POST /v1/messages   Bearer <本地 key>
        ▼
   ofm-server  ── ① 鉴权  ② 会话粘滞  ③ 指纹中间层  ④ 请求头  ⑤ 响应侧修复  ⑥ 流判定
        ▼
OpenCode Zen 网关 (Bearer public) / Kilo 公有网关 (无凭据)
```

## 接口清单

| 路由 | 说明 |
|---|---|
| `GET /health` | 存活探针（免鉴权，只回答在线） |
| `GET /v1/models` | 两车道合并清单 |
| `POST /v1/chat/completions` | OpenAI Chat Completions，流式 / 非流式 |
| `POST /v1/messages` | Anthropic Messages，流式 / 非流式 |
| `POST /v1/messages/count_tokens` | 本地 token 估算（不调上游） |
| `POST /messages`、`/messages/count_tokens` | 同上，无 `/v1` 前缀的兼容入口 |
| `GET /api/models` | 清单 + 元数据 + 上次拉取结果（控制台用） |
| `POST /api/models/test` | 一次真实最小调用（`max_tokens=64`），返回 TTFT / 用量 / 错误 |
| `POST /api/models/test-all` | 后台全量扫描，202 立即返回 |
| `GET /api/requests`、`/api/requests/:id` | 请求透视（仅开启时返回记录） |
| `GET /api/settings` | 端口 / Key / 代理 / 路由 / 开关状态 |
| `POST /api/settings/inspector` | 开关请求透视（默认关） |
| `POST /api/settings/proxy` | 代理配置 / 连通性测试（`{ test: {...} }` 为 dry run） |

模型 id：OpenCode 车道用原名；Kilo 车道加 `kilo/` 前缀，请求时前缀剥掉再发上游。

## 中间层做了什么（六件事）

1. **会话粘滞**：免费额度按 upstream session 统计，每请求新 session 会立刻 429 且
   Retry-After 递增。seed = `模型 + 首条 user 消息`，映射持久化在 `data/sessions.json`。
2. **工具指纹注入**：v2 闸门要求请求体声明 `read` 与 `shell`，且 description 与参数
   schema 与官方 v2.0.26 CLI **逐字一致**。缺失即注入（见 `lib/fingerprint.js`，勿改字符串）。
3. **同名别名**：调用方恰好也有定义不同的 `read`/`shell` 时，改名为 `read_client[N]`，
   历史 `tool_calls` 与 `tool_choice` 同步改写，响应侧再还原成调用方拼写。
4. **tool_choice 卫生**：绝不发 `none`（v2 见到即 403），缺省补 `auto`。
5. **响应侧修复**：模型若真去调用注入的 `read`/`shell` 诱饵 → 整段抑制（调用方没注册
   这个工具）；`tool_calls[].index` 从 0 重编号（上游块索引与思考共享）。纯诱饵回合返回
   502 并说明原因。
6. **流判定**：按响应体首字节形状判定 SSE / JSON，不信任 `Content-Type`（网关高负载时
   会用 `application/json` 返回完整 SSE 帧），嗅探字节回放，不丢帧。

Kilo 车道无指纹闸门，不做 2/3/4，但 5/6 照做。

## Anthropic 协议

`POST /v1/messages` 与 `POST /v1/messages/count_tokens` 跟 OpenAI 入口共用同一条链路，
只在出入口做编码转换（`lib/anthropic.js`）：

| Anthropic | 本服务内部 |
|---|---|
| `system`（字符串或 text 块） | 首条 `role:"system"` 消息 |
| user 的 text / image 块 | `content` 字符串或 `image_url` 部分 |
| `tools[].input_schema` | `tools[].function.parameters` |
| assistant 的 `tool_use` 块 | `tool_calls[]` |
| user 的 `tool_result` 块 | 独立的 `role:"tool"` 消息 |
| `thinking.budget_tokens` | `reasoning_effort`（≤2048 low / ≤8192 medium / 更大 high） |

响应侧遵守 Anthropic 的块规则：

- `message_start` 只在开头发一次，`content_block_start/delta/stop` 严格配对；
- 同一时刻只有一个 text 或 thinking 块；tool_use 块彼此独立，可并行流式；
- **工具块只在知道名字后才开** —— 先到的参数片段先扣留，否则客户端会拿到一个无法执行的空名调用；
- `stop_reason` 为 `end_turn` / `tool_use` / `max_tokens`（截断优先于工具调用）；
- 失败时先发 `error` 事件再 `message_stop`，不带 `stop_reason`。

`thinking` 块不带 `signature`：这一侧无法生成可验证的签名，空字符串会是一个无法核验的声明，
所以该块只作为信息返回，不会被回传上游。`count_tokens` 是估算（4 字符 ≈ 1 token，
图片固定 1024），本服务不附带 tokenizer。

## 代理

发给 OpenCode 与 Kilo 的请求可以先经过用户自己配置的代理。控制台「高级配置 → 代理」里打开开关、填地址、
保存即生效，无需重启。保存后服务端**立即用新路径重新拉取一次清单并等待结果**，再把结果告诉界面。

| 项 | 说明 |
|---|---|
| 支持的协议 | `http://` 与 `https://`，可带 `user:pass@` 做 Basic 认证 |
| 隧道方式 | HTTPS 目标走 `CONNECT host:443`，TLS 在隧道内部握手 |
| 保存位置 | `data/settings.json` 的 `proxy` 块（与 Key 同文件，0600） |
| 探测 | 「测试连通性」只发两次清单请求（不花生成），分别报两条车道的状态与耗时 |

不支持 SOCKS（`socks5://` 会被明确拒绝而不是半通）。代理拨号失败、CONNECT 被拒、隧道超时分别归类为
`TRANSPORT` / `INVALID_CREDENTIAL` / `TIMEOUT`——**不会**被误判成模型不可用。

### 清单拉取失败时不会破坏已有状态

需要代理才能访问上游的机器上，这个边界必须明确：

- **失败不删除模型。** 清单删除只对**这次真正应答的车道**生效。某条车道请求失败（代理没开、地址错、
  隧道断）时，它名下的模型原样保留，不会被“上游没返回”误解成“模型没了”。
- **失败不冒充成功。** `POST /api/settings/proxy` 返回 `listing.opencode/kilo` 与 `listing.error`；
  面板上显示「已保存，但 …列表拉取失败：<原因>」，开关保持开启（这是用户的意图，地址改对就能用）。
- **空表会解释自己。** 清单为 0 或只有部分车道时，模型表上方给出黄色提示：失败的是哪条车道、原因是什么、
  以及“若本机需要代理…”。用户不会面对一个空白列表去猜。
- **恢复了就清掉。** 代理改对或关掉后重新拉取成功，提示自动消失。
- **不抢用户正在做的操作。** 控制台每 2 秒轮询一次设置；代理控件在有未保存修改时归用户所有，
  轮询不会把开关拨回去、也不会覆盖正在输入的地址。
- **失败不会变成洪流。** 清单为空时，自动重试带退避（5 秒起、逐次翻倍，上限 60 秒）；
  保存新代理会立即清除退避，用户的操作永远不被延迟。

本服务**不**自动读取系统代理或 `HTTPS_PROXY` 环境变量：代理是显式配置项，避免一个看不见的
环境变量改变流量走向。请求透视里的「路由」标签永远是这次请求的真实路径。

## 思考强度

`reasoning_effort` 在 OpenCode 车道上**不被上游执行**（网关接收 `reasoning_effort`、
`thinking.budget_tokens`、`enable_thinking` 后全部忽略，实测低档产生的思考 token 甚至
更多）。唯一真实生效的是 `max_tokens`：思考与正文共享这份预算。

| `reasoning_effort` | OpenCode 车道 | Kilo 车道 |
|---|---|---|
| `low` | `max_tokens = 2048` | `reasoning = {effort:"low"}` |
| `medium` | `max_tokens = 8192` | `reasoning = {effort:"medium"}` |
| `high` | 不设上限（模型全部容量） | `reasoning = {effort:"high"}` |

调用方显式给出 `max_tokens` 时以它为准。Kilo 的 `reasoning` 必须是对象，裸字符串会被上游拒绝
（`expected object, received string`）；关思考用 `none`，不是 `off`。

## 控制台

控制台只有一个页面：**模型清单** + 快速接入。其余内容全部收在底部的「高级配置」折叠区里（默认折叠）。

- **模型**：完整清单（仅免费池）、车道徽章、逐模型测试（TTFT / 用量 / 错误码）、TEST ALL。
- **高级配置 → 请求透视**：**默认关闭**。开启后记录每条请求的三栏对照——入站原生请求、
  上游端点与转换后请求体、响应摘要；转换点以标签标注（`injected` / `renamed` / `effort→…` / `路由`）。
  关闭立即清空缓冲，不记录任何东西。状态持久化到 `settings.json`，重启保持。
- **高级配置 → 代理**：开关、地址、连通性测试与当前路由。

记录只在内存（默认上限 50 条，单条 payload 截断 256 KB）。

## 打包为单个 exe（Windows x64）

```powershell
npm run build:exe          # 产出 dist/ofm-server.exe
```

产物是**单文件、内嵌 Node、无需安装 Node** 的可执行文件（约 83 MB），控制台资源
（`index.html` / `app.js` / `style.css`）也嵌在里面，不需要旁边的 `public/` 目录。

构建流程（`scripts/build-exe.mjs`，每步验证后才进下一步）：

1. `esbuild --bundle --format=cjs` —— SEA 的入口只支持 CommonJS，所以先把 ESM 打成一个 CJS 文件；
2. `node --experimental-sea-config` —— 生成 SEA blob（含 3 个 asset）；
3. 复制当前 `node.exe` 为 `ofm-server.exe`；
4. `postject` 把 blob 注入（构建期工具，不进产物）；
5. **自检**：启动刚构建的 exe，要求 `--version`、监听成功、`/` 与 `/app.js` 从内嵌资源返回、
   未鉴权的 `/api/settings` 返回 401、带 key 的 `/v1/models` 返回 200。

自检未通过则构建失败，不会留下一个“看起来像成功”的产物。

说明：

- **平台限定**：SEA 不能交叉编译，产物是 `win32-x64`；在 Windows x64 上构建才能得到可用的 exe。
- **数据目录**：默认是 exe 所在目录的 `data\`；若把 exe 放在只读位置（如 `Program Files`），
  用 `--data-dir` 指向可写目录。
- **签名**：注入会让 Node 自带的签名失效（`postject` 会提示 `signature seems corrupted`，属预期）；
  需要分发给终端用户时自行用代码签名证书重签。
- **体积**：绝大部分是内嵌的 Node 运行时；本项目自身代码仅约 108 KB（bundle 后）。

## 测试

```powershell
npm test          # 单测 + 离线 e2e（fake upstream 断言线上字节）+ 代理隧道
python test/ui_check.py <本地 key>          # 可选：Playwright 走一遍控制台
python test/ui_proxy_notice.py              # 可选：代理不可达时清单与提示的行为
python test/ui_proxy_switch.py              # 可选：开关不被轮询回弹、失败不刷屏
python test/logging_proxy.py 17890          # 可选：打印每次 CONNECT 的本地代理
```

e2e 覆盖：指纹头逐项、session 粘滞、诱饵抑制、索引重编号、别名还原、effort 映射、
JSON-content-type 的 SSE 嗅探、401/403/429 映射、Kilo 车道不加指纹、付费 id 不进清单。
代理测试另起一个真实 CONNECT 代理与自签 HTTPS 上游，验证：隧道确实被拨开、Basic 认证上报、
407 归类为凭据错误、代理不可达归类为 TRANSPORT。`test/catalog.test.mjs` 固定住“清单失败不得
删除模型”这条边界，`test/proxy-settings.test.mjs` 验证保存代理后返回真实拉取结果。

## 已知边界

- 仅 OpenAI Chat Completions 与 Anthropic Messages；`/v1/responses`（Responses API）未实现。
- 免费额度由上游单方面提供，随时可能限流、改闸门或下线。若某天全线 403
  `FingerprintRejected`，说明上游升级了客户端指纹——对照
  dsh-our-free-model 的 `docs/free-lane-wire.md` 重新实测。
- Kilo 免费池的模型卡声明 prompt 可能被上游记录用于改进服务；**不要通过免费车道
  发送密码、密钥、个人信息或商业机密**。
- 本服务只是客户端，不托管模型；模型输出由上游生成。
- 非流式调用会把整轮缓冲到结束（便于统一的诱饵抑制与组装），首字延迟对这类调用不可见。

## 目录

```
server.mjs             路由 / 鉴权 / 静态资源
lib/fingerprint.js     v2 指纹：工具定义、session 铸造、applyFingerprint
lib/sessions.js        seed → session 持久映射
lib/lane-opencode.js   OpenCode 车道
lib/lane-kilo.js       Kilo 车道
lib/sse.js             形状嗅探 / SSE 解析 / 回放
lib/assets.js          控制台静态资源（磁盘或 SEA 内嵌）
lib/transport.js       出口传输：直连 fetch 或 CONNECT 隧道
lib/transform.js       effort 映射 + 工具线（抑制/重编号/别名）
lib/chat.js            两个协议入口；runTurn 为共用核心
lib/anthropic.js       Anthropic Messages 双向转换（请求 / 流帧 / Message）
lib/probe.js           模型可用性探测（启动扫描与手动测试）
lib/catalog.js         两车道清单合并与刷新
lib/inspector.js       请求透视环形缓冲
lib/auth.js            本地 Key
public/                控制台（原生 JS）
scripts/build-exe.mjs  单文件 exe 构建（esbuild + SEA + postject + 自检）
data/                  运行时：settings.json / sessions.json
```
