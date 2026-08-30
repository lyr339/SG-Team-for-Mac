# 流拓扑定址报告（rt-spike / task-5798d234）

> **状态（2026-08-29）**：本报告与《STREAM-TOPOLOGY.md》为同日侦察期的两个阶段性
> 结论（本篇选定 always-local 进程 TLS 原型 tap），互相矛盾且均已被最终生产方案
> 取代——`cursor-stream-observer` 采用「composer 数据模型写信号 + CDP evaluate」
> 架构。保留作为侦察方法论记录；原始抓包产物已清理。

日期：2026-08-27 ｜ 执行：builder(CH-2)，attempt 3 ｜ 观测方式：全程只读附加式（CDP / SIGUSR1 inspector / evaluate / Network 域 / TLS 原型 hook / mihomo 连接表），未重启 Cursor、未触碰群枢进程。

## 1. 进程归属结论（实锤）

**Cursor Agent 对话流由 `always-local` extension host 持有，直连 `agentn.global.api5.cursor.sh:443`（HTTP/2 双长连接）。**

证据链（三重交叉验证）：

| 证据层 | 观测 | 结论 |
|---|---|---|
| mihomo 连接表（宿主） | `198.18.0.1:53353/53354 → agentn.global.api5.cursor.sh:443`，建立于 21:06:53（会话启动时刻），长连保持 | 对话通道独立域名 `agentn.global.api5.cursor.sh`，与遥测 `api2/api3.cursor.sh` 物理分离 |
| lsof 端口归属 | 53353/53354 属 PID 44657 = `Cursor Helper (Plugin): extension-host (always-local)` | 持有进程 = always-local |
| 进程内 handle 枚举（09 号脚本，61200 inspector） | 进程内恰有 2 个 `TLSSocket`，servername=`agentn.global.api5.cursor.sh`，`alpn=h2` | Node 原生 TLS + HTTP/2，双连接 |

extension-host 四角色分工（CDP 枚举 + SIGUSR1 验证）：

- `user` / `retrieval`：未见外网对话流量
- `always-local`（PID 44657，inspector :61200）：**Agent 对话流（agentn）** + 遥测（api2/api3）
- `agent-exec`（PID 44658，inspector :54686/:50323）：agent 执行环境、Canvas webview 伺服（:50323）、traces 上报（api2 /v1/traces）

## 2. 观测面与盲区（方法论结论）

| 观测手段 | 能看到 | 看不到 |
|---|---|---|
| 9333 CDP / renderer Network 域 | workbench renderer 全部 fetch/XHR（本例：仅本地回环） | 其他进程；非 HTTP 流量 |
| Node inspector Network 域（05/08 脚本） | extension-host 经 Chromium net 栈的请求（api2 遥测，401 明文 JSON） | **Node 原生 TLS socket（agentn 完全不可见）** |
| 工厂型 hook（06 脚本：tls.connect/https.request） | 装 hook 后新建的 TLS 连接（api2 帧样本到手） | **装 hook 前已建立的长连接（agentn 于 21:06 建立，hook 21:43 才装）** |
| 原型级 hook（10 脚本：TLSSocket.prototype.write/writev/emit） | 已建连接的后续帧（api2 明文帧验证有效） | 见第 4 节结论 |
| mihomo external-controller /connections | 全部进程的真实外网连接（fake-ip → 域名映射） | 明文内容 |
| renderer QT_TRACE 探针（青天既有） | bridge.* IPC 调用事件（listComposers 等，含 65 个 composer 状态） | LLM wire format |

## 3. 当前实例的特殊形态（影响 tap 点选择的关键背景）

1. **Cursor 未登录**：全部 `aiserver.v1.*` 请求 401（`ERROR_NOT_LOGGED_IN`），原生遥测在空转重试。
2. **agentn 双连接当前空闲**：见第 4 节。
3. **青天桥接层活跃**：renderer 内探针向 `127.0.0.1:26399/auto-chat/{log,trace,cmd}`（3700+ 请求挂起，无监听者）、`36530/api/seamless-log`（全部 REFUSED）高频上报 QT_TRACE；26400–26418 为每通道 health 端口组，当前全部无监听。唯一在线的本地服务是 **51823 /v1/switch（Cursor 主进程 PID 31580，204 心跳轮询，~1.5s 周期）**。
4. 本地 auto-chat 通道组（26399–26418）是青天多通道服务的预期端口——当前未运行，renderer 探针在空转等待。

## 4. 候选 tap 点时序对比与最终选定

| 候选 | 位置 | 时序 | 可行性结论 |
|---|---|---|---|
| A. renderer fetch/XHR hook | workbench renderer | 对话流不经 renderer 网络栈（0 外网请求实锤），此处无流可 tap | **排除**（方案 A 若指 renderer fetch hook，则不成立） |
| B. always-local 进程内 TLS 明文 tap | TLSSocket 原型层 | 应用数据进 TLS 之前/出 TLS 之后——本机可及的**最早明文点** | **选定**（详见下） |
| C. 主进程 tap | 主进程 31580 | 主进程不持对话连接（mihomo/lsof 无其外网记录）；SIGUSR1 对其无效（inspector 未开） | **排除** |
| D. 网络层 tap（mihomo/pf） | 宿主网络栈 | TLS 密文，只能看元数据 | 辅助证据层，非明文 tap |

**最终选定：B —— always-local 进程内、对 `TLSSocket.prototype` 的原型级 hook（覆盖 `write` / `writev` / `_writeGeneric` 与 `emit('data')`）。**

关键性质：原型级 hook **对已建立的 HTTP/2 长连接同样生效**（方法分派走原型链），解决了工厂型 hook"必须赶在连接建立前注入"的时效死结。注入方式：向 always-local 发 SIGUSR1 开 inspector（61200），CDP `Runtime.evaluate` 一次性安装，**无需重启 Cursor，只读无副作用**（write 路径仅复制缓冲区头部，不改数据）。

## 5. agentn 流量观测结果

- 150s 原型 tap 窗口：api2.cursor.sh 明文帧 42r/15w（HTTP/1.1 401 + Connect-RPC protobuf 样本已落盘），**agentn 帧 = 0**。复测窗口（v2，补 writev/_writeGeneric）同样 0 帧；实测确认 api2 流量确实走 `writev` 路径（chunks 为 `{chunk, encoding}` 对象数组），证明 http/1.1 与 h2 写路径均被 hook 覆盖——agentn 0 帧是**连接真实空闲**，不是观测盲区。
- 判读：未登录态下 agentn 双连接建立后保持空闲（连 HTTP/2 PING 都未出现，或 keepalive 周期 > 观测窗）。当前实例的 Agent 会话（本对话）未在 agentn 上产生帧——与该 composer 由青天桥接层驱动的形态一致。
- 含义：**agentn 是 Cursor 原生登录态 Agent 的通道**；本机当前对话流由青天体系承载（renderer bridge IPC → 本地通道/群枢 Helper）。两种形态共用同一 tap 方法论（B 方案对 agentn；bridge 探针对青天层）。

## 6. 帧样本与 wire-format 初步标注

样本目录：`scripts/spike-stream-topology/frames/`（08-* 系列，3800+ 请求体），`out-07-taps.jsonl` / `out-10-proto-taps.jsonl`（TLS 明文帧）。

- `aiserver.v1` 遥测：HTTP/1.1 POST，`content-type: application/json`（401 错误体）/ Connect-RPC protobuf（traces 帧首 `0a d8 09 ...` = field1 嵌套消息，含 `service.name="extension-host-agent-exec"`、`service.version="3.6.31"`）。
- renderer 青天上行：JSON `{clientId:"qt-*", windowScopeId:"qtw-*", message:"QT_TRACE <method>:<phase> {...}"}`。
- agentn：HTTP/2（h2），帧样本待登录态会话补抓（当前空闲）。

## 7. 注入时机方案

1. **always-local / agent-exec**：`kill -USR1 <pid>` → 轮询 `lsof` 拿 inspector 端口 → CDP `Runtime.evaluate` 安装原型 hook。全程 < 3s，无需重启，对用户会话无影响（已实测 4 个进程安全）。
2. **renderer（workbench）**：9333 CDP `Page.addScriptToEvaluateOnNewDocument` 适合下轮启动注入；当前轮可用 `Runtime.evaluate` 直接挂 bridge 探针（QT_TRACE 证明桥接面在 renderer 全局可达）。
3. 主进程：SIGUSR1 无效；如需主进程观测，走 mihomo 连接表层（元数据）。

## 8. 结论：选定点是否为本机可及的最早观测点？

**是。** 对原生 Cursor Agent 流：always-local 内 TLSSocket 原型 hook 拿到的就是应用层明文（进 TLS 前 / 出 TLS 后），早于一切网络层观测点（mihomo/路由/对端），且不依赖连接建立时机。对青天承载的对话流：renderer bridge 探针（既有 QT_TRACE 面）是最早应用层观测点，但其位置在 delta 回流之后——若目标是上行请求体（本地工具结果从哪上行），**always-local 的 TLS 写侧 hook 是唯一兼具"明文 + 最早"的点**。

## 9. 遗留风险与后续

- agentn 帧样本空缺（需登录态真实 Agent 回合触发；已具备随时抓取的常驻能力）。
- http2 写路径若走 `writev`/`_writeGeneric` 已覆盖；若 Electron net 模块接管 socket（Chromium 栈直接写），则需补 `net.Socket` 原型层——10 号脚本已按此假设加固，v2 窗口未见 agentn 帧即空闲证据。
- renderer 向 26399/36530 的空转请求（>7000 次/窗）是既有插件行为，与本次注入无关，不构成副作用。
