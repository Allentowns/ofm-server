# 贡献指南

感谢你愿意改进 ofm-server。

## 先说清楚这个项目的边界

它是一个**客户端**：把上游公开的免费接口包装成标准协议。所以有两类改动不会被接受：

- **绕过上游限制的功能**（自动换 IP、伪造更多身份、并行刷额度等）
- **让你能发送敏感数据的改动**（日志落盘、请求持久化到磁盘、上报遥测）

## 环境

- Node.js ≥ 20，无任何依赖
- Windows x64（如果要构建 exe）

```powershell
git clone https://github.com/Allentowns/ofm-server.git
cd ofm-server
npm test        # 49 项，不需要网络
node server.mjs # 默认 127.0.0.1:18900
```

## 改动前请先跑测试

```powershell
npm test
```

测试全部离线：用 fake upstream 起一个本地 HTTP 服务，断言发出去的**字节**（不是"大概调用了某个函数"）。
所以涉及指纹、请求头、SSE 的改动，测试会直接告诉你破坏了什么。

UI 相关的回归测试需要 Playwright：

```powershell
pip install playwright && playwright install chromium
python test/ui_proxy_notice.py
python test/ui_proxy_switch.py
```

## 代码风格

- ESM（`.mjs` / `"type": "module"`），不引入依赖
- 注释写**为什么**，不写**是什么**。`// increment i` 这种没有价值的注释不要写
- 文件级注释在最上方，说明这个模块负责什么、边界在哪

## 提交信息

```
一句话说清改了什么（英文，祈使句）

为什么这么改。如果是修 bug，写清楚复现路径和根因，不只是"修了个问题"。
```

## 特别提醒：指纹常量不要动

`lib/fingerprint.js` 里的 `CLIENT_UA`、工具定义字符串、session 编码规则，是**逐字**匹配上游校验的。
格式化、改引号、调整空格都可能导致 403。要改必须先在真机上实测通过，并在提交信息里写清实测结果。

## 新增模型车道

参考 `lib/lane-kilo.js`（没有指纹闸门，结构最简单）和 `lib/lane-opencode.js`（完整指纹）。
需要实现 `fetchListing()` 与 `postTurn()`，然后在 `lib/catalog.js` 的 `refresh()` 中接入。

注意：清单删除只对**这次真正应答的车道**生效。一个车道的请求失败不能被当成"它的模型下线了"。
