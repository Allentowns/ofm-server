# ofm-server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey.svg)](#1-下载程序)

**不用登陆，运行即可：免费白嫖 OpenCode + Kilo 的模型，给任何 agent 用。**

在你的电脑上跑一个小服务，它把上游的免费模型池包装成标准 OpenAI / Anthropic 接口。
你的 agent（pi、Claude Code、Cline、Cursor、OpenAI SDK、curl……）只要把 base URL 指过来，
就能用上 28 个免费模型，不用买 API Key，不用翻墙配置一堆东西。

- **零依赖、零配置**：一个 exe，双击就跑
- **两种协议**：OpenAI 兼容 + Anthropic 兼容，主流 agent 都能接
- **自带控制台**：看有哪些模型、哪些能通、每个请求到底发了什么
- **数据不出本机**：只有你本机的程序能调用，服务默认只听 `127.0.0.1`

---

## 快速开始

### 1. 下载程序

**下载地址：<https://github.com/Allentowns/ofm-server/releases/latest>**

打开后在 **Assets** 里点 `ofm-server.exe` 下载，放到任意文件夹（比如 `D:\tools\ofm-server\`）。

> 不需要安装 Node，不需要装任何东西。单个文件即可运行（约 83 MB，体积基本是内嵌的 Node 运行时）。

直接下载当前版本：

| 文件 | 说明 |
|---|---|
| [`ofm-server.exe`](https://github.com/Allentowns/ofm-server/releases/download/v0.1.0/ofm-server.exe) | 主程序（Windows x64） |
| [`ofm-server.exe.sha256`](https://github.com/Allentowns/ofm-server/releases/download/v0.1.0/ofm-server.exe.sha256) | 校验值 |

**Windows 可能弹出 SmartScreen 警告，这是预期的。** 打包时把 Node 运行时注入 exe，会让 Node 自带的
代码签名失效，而这个发布包没有商业代码签名证书。点「更多信息 → 仍要运行」即可，也可以自己核对校验值：

```powershell
Get-FileHash .\ofm-server.exe -Algorithm SHA256
# 应为 95AF1EC1F7ED105868CA0D4CBC6CDB51567FF3702267C987E184ADBCF5146205
```

> 开源项目，代码在 [GitHub](https://github.com/Allentowns/ofm-server)。如果下载链接打不开，
> 可以自己从源码构建（见文末）。

### 2. 双击运行

双击 `ofm-server.exe`，会弹出一个黑色窗口，里面有几行字：

```
ofm-server 0.1.0 listening on http://127.0.0.1:18900
  base URL : http://127.0.0.1:18900/v1
  local key: ofm-XOJM8A7_fb45X-ZUM23ixmMxaJg_xIwf
  console  : http://127.0.0.1:18900/
```

**这个窗口不要关**，关掉服务就停了。

### 3. 打开控制台

浏览器访问 <http://127.0.0.1:18900/>，把上面那行 `local key` 粘进去。

你会看到 28 个免费模型，以及每一条的真实可用状态（启动时会自动测试一轮，约 1 分钟）。

### 4. 把 agent 接过来

控制台最上方的「快速接入」有两个地址，点右边的「复制」就能粘贴到你的 agent 里：

| 你的 agent 协议 | Base URL | API Key |
|---|---|---|
| OpenAI 兼容 | `http://127.0.0.1:18900/v1` | 你的 `local key` |
| Anthropic 兼容 | `http://127.0.0.1:18900` | 你的 `local key` |

就这两项。模型名从控制台的模型清单里复制。

---

## 接法示例

<details>
<summary><b>pi</b></summary>

编辑 `~/.pi/agent/models.json`：

```json
{
  "providers": {
    "ofm-server": {
      "baseUrl": "http://127.0.0.1:18900/v1",
      "api": "openai-completions",
      "apiKey": "<你的 local key>",
      "models": [
        { "id": "deepseek-v4.1-flash-free" },
        { "id": "glm-5.3-flash-free" },
        { "id": "kilo/kilo-auto/free" }
      ]
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b></summary>

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:18900"
$env:ANTHROPIC_AUTH_TOKEN="<你的 local key>"
claude
```
</details>

<details>
<summary><b>OpenAI SDK (Python)</b></summary>

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:18900/v1", api_key="<你的 local key>")

resp = client.chat.completions.create(
    model="deepseek-v4.1-flash-free",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```
</details>

<details>
<summary><b>curl</b></summary>

```bash
curl http://127.0.0.1:18900/v1/chat/completions \
  -H "Authorization: Bearer <你的 local key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}]}'
```
</details>

---

## 模型名怎么填

控制台「模型清单」里的 id 直接复制，原样填进 agent。

- **OpenCode 车道的模型**：用原名，例如 `deepseek-v4.1-flash-free`
- **Kilo 车道的模型**：带 `kilo/` 前缀，例如 `kilo/kilo-auto/free`

两种模型可以混着用，服务会自动路由到对应的上游。

---

## 常用设置

所有设置都在控制台的「高级配置」里，改完立即生效，不用重启。

<details>
<summary><b>上不了网 / 模型列表是空的</b></summary>

如果你的电脑需要代理才能访问外网：

1. 打开「高级配置 → 代理」
2. 拨开开关，填代理地址，例如 `http://127.0.0.1:7890`
3. 点「保存并应用」

如果代理地址填错，界面会直接告诉你**哪条车道拉取失败、失败原因是什么**，开关会保持打开
（地址改对就能用），模型清单也不会被清空。

支持 `http://` 和 `https://` 代理，可带用户名密码：`http://user:pass@10.0.0.1:8080`。
不支持 SOCKS。
</details>

<details>
<summary><b>想看 agent 到底发了什么请求</b></summary>

「高级配置 → 请求透视 LOG 详细」打开开关。

之后每个请求都会记录下来，能看到三样东西并排对比：

1. 你的 agent 发来的原始请求
2. 服务改写后真正发给上游的请求（改了什么会标出来）
3. 上游返回的响应

排查 agent 兼容问题时非常有用。**默认关闭**，关闭时不记录任何内容，也不落盘。
</details>

<details>
<summary><b>想换个端口</b></summary>

```powershell
.\ofm-server.exe --port 19000
```
</details>

<details>
<summary><b>想让局域网里其他设备也能用</b></summary>

```powershell
.\ofm-server.exe --lan
```

注意：`--lan` 会让服务监听所有网卡，同一网络的人都能访问（仍需 local key）。
只在可信网络里用。
</details>

<details>
<summary><b>想清空会话记录</b></summary>

免费额度按上游 session 计量，服务会持久化 session 映射来避免触发限流。
需要重置时，删掉 `data\sessions.json` 后重启即可。
</details>

---

## 数据放在哪

程序运行时的文件在 exe 同目录的 `data\` 文件夹里：

| 文件 | 内容 |
|---|---|
| `settings.json` | 本地 Key、代理配置、控制台开关状态 |
| `sessions.json` | 会话映射（避免重复触发限流） |

如果 exe 放在 `Program Files` 这类只读目录，用 `--data-dir` 指定一个可写位置：

```powershell
.\ofm-server.exe --data-dir D:\ofm-data
```

---

## 命令行参数

```powershell
.\ofm-server.exe --help
```

| 参数 | 说明 |
|---|---|
| `--port <n>` | 监听端口，默认 `18900` |
| `--lan` | 监听 `0.0.0.0` 而不是 `127.0.0.1` |
| `--data-dir <path>` | 数据目录 |
| `--inspector` | 本次启动强制打开请求透视 |
| `--no-probe` | 跳过启动时的模型可用性测试 |
| `--version` | 显示版本 |
| `--help` | 显示帮助 |

---

## 会踩的坑

**免费额度有限。** 上游按 session 计费，一个 session 用完了要等一段时间（实测约 20 小时）。
服务已经做了会话粘滞和指纹处理来尽量延展额度，但它终究是免费池——不要拿它跑重活。

**上游随时可能变。** 免费模型是上游单方面提供的，可能限流、改规则、下线。
如果某天突然全部 403，大概率是上游升级了客户端校验。

**不要发敏感信息。** Kilo 免费池的条款里写了 prompt 可能被记录用于改进服务。
**不要通过这里发送密码、密钥、个人信息或商业机密。**

**模型输出由上游生成。** 本服务只是转发，不托管模型，不对内容负责。

---

## 开发者信息

技术实现细节见 [`docs/design.md`](docs/design.md)：

- 中间层做了什么（会话粘滞、工具指纹、响应侧修复、流判定）
- Anthropic 协议的块规则与转换细节
- 思考强度（`reasoning_effort`）在两车道上的真实行为
- 构建与测试

从源码运行：

```powershell
git clone https://github.com/Allentowns/ofm-server.git
cd ofm-server
node server.mjs        # 需要 Node ≥ 20，无依赖
npm test               # 49 项测试
npm run build:exe      # 构建单文件 exe（Windows x64）
```

---

## 免责声明

本工具只是客户端，不托管模型，也不提供模型能力。它不包含、不代理、不转售任何模型服务，
只是把上游公开提供的免费接口包装成标准协议。

免费额度由 OpenCode 与 Kilo 单方面提供，与本项目无关。使用时请自行遵守各自的服务条款，
包括但不限于频率限制、内容政策与商用限制。**因使用本工具导致的任何账号限制、服务中断或
法律风险，由使用者自行承担。**

本项目以 MIT 协议开源，不对适用性或特定用途作任何担保。

## 许可

[MIT](LICENSE) © 2026 Allentowns

你可以自由使用、修改、分发、商用，唯一要求是保留版权声明与许可声明。
