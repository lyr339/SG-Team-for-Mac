# Cursor Agent 流拓扑定址报告（rt-spike 产物）

> **状态（2026-08-29）**：本报告为侦察期历史结论（选定渲染进程 protobuf 解码边界
> 作为 hook 点），已被最终生产方案**取代**——`cursor-stream-observer` 实际采用
> 「composer 数据模型写信号 + CDP evaluate 读取」的 DOM 层混合架构（事件驱动 +
> 轮询兜底）。结论以本文档摘录为准；原始侦察脚本与抓包产物（scripts/spike-stream-topology/）已清理。

日期：2026-08-27 ｜ 执行：CH-3 架构实现（侦察 1–60%）→ CH-1 主控（接管至结论）
环境：Cursor 3.6.31（Electron 39.8.1 / Chrome 142），单实例多 composer，macOS

## 结论（TL;DR）

Cursor Agent 对话流的管道是：

```
Cursor 后端 (api2/api5.cursor.sh)
  ⇄ HTTPS/HTTP2，Chromium net 栈
【Electron 主进程 PID】（socket 终点，字节流在此）
  ⇄ Electron IPC / MessagePort（结构化帧）
【workbench 渲染进程】（protobuf-es 解码 → composer 模型 → DOM）
```

- 渲染进程**零直连外网**（CDP Network 域实测 150s 窗口，11.5k+ 事件无一外网请求，仅本地回环）。
- 全部 Node 进程（4 个 extension host 角色 + shared-process）经 Node 层 tap（http/https/http2/tls 全覆盖）**未见对话流**，只有遥测 401 回环。
- 主进程 nettop 实测：在 Agent 回合活跃期主进程进出流量持续抬升（采样窗 +7.6KB in / +15.9KB out），其余进程静默。
- workbench bundle（`workbench.desktop.main.js`，61MB）内嵌完整 **protobuf-es 生成的 aiserver.v1 schema 与 ChatService 客户端**（connect-web，`streamUnifiedChatWithTools` 为 BiDiStreaming，另有 SSE/Poll/Idempotent 变体）。

## 因此

1. **最早字节观测点 = 主进程 Chromium net 栈**。无重启手段不可及（--log-net-log 需启动参数；CDP browser target 无 Network 域，实测 `'Network.enable' wasn't found`）。受「禁止重启 Cursor」约束，此点放弃。
2. **可行最早观测点 = 渲染进程内 JS 层**。流以帧形式经 IPC 抵达渲染进程后解码——hook 点应设在渲染进程的流分发/解码边界（protobuf-es `fromBinary` 或流 async-iterator 出口）。观测到的内容与面板同一 tick，满足「真实时」。
3. **解码 schema 无需逆向**：bundle 内有全部 protobuf-es 字段清单（typeName + newFieldList），可静态提取生成解码器，比社区逆向更准（与当前版本严格一致）。
4. 已有注入资产：workbench bundle 已被打过两次补丁（`.qingtian.backup`、`.before-usage-limit-hotfix`），`__qtComposerBridge` 证明渲染进程内 JS 钩子可行；CDP 9333 在线。

## 证据链

| 步骤 | 产物 | 结论 |
|---|---|---|
| CDP 枚举（01） | out-01-targets.txt | 单窗口 workbench + worker×2 |
| 页面 Network（02/08） | out-02-page-network.jsonl / out-08-network.jsonl（5.5MB） | renderer 零外网；仅 26399/auto-chat（挂起无监听）、36530（REFUSED）、51823/v1/switch（群枢本地服务） |
| Node 标记 hook（04/06） | out-04-node-54686.jsonl 等 | extension-host 可见 ConnectRPC 遥测（401） |
| TLS 明文 tap（07） | out-07-taps.jsonl（776K） | api2 明文 protobuf 帧可抓（Dashboard/Analytics 等） |
| v3 全进程 tap（09/09b，主控） | tap-*.jsonl（http/https/http2/tls） | 4 ext-host + shared-process 均无对话流；main 无 Node 层流量 |
| nettop 进程流量 | 本报告 | 回合活跃期唯主进程流量显著 |
| 静态分析 | workbench.desktop.main.js 偏移 23173532 等 | ChatService 全方法与消息类型在渲染 bundle |

## 下一步（rt-probe 修订方向）

- tap 点从「渲染进程 fetch hook」修订为「**渲染进程流解码边界 hook**」：
  候选 A：protobuf-es 响应消息 `fromBinary`（结构化、逐帧、与面板同 tick）；
  候选 B：流 async-iterator 的分发出口；
  候选 C：MessagePort/MessageChannel 边界（若每流建独立通道）。
- 落地方式排序：CDP Runtime.evaluate 运行时 hook（零文件改动，优先）→ 补丁复用（需窗口重载，备选）。
- 先静态提取 aiserver.v1 schema 落盘（`src/infrastructure/cursor/aiserver-schema`，供 rt-decoder 使用）。
- 注意：bundle 符号被 minify，运行时定位需借助 protobuf-es 的 typeName 字符串锚点（"aiserver.v1.StreamUnifiedChatWithToolsResponse" 等全局唯一串）做模块注册表反查。

## 约束继承

禁止重启 Cursor / 在用 qunshu MCP（团队记忆 team-memory:ec9af9be）；全程只读观测，补丁仅作备选。
