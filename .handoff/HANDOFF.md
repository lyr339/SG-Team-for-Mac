# 交接任务书：会话过程流 P0 全链路修复

> **唯一权威交接文档。** 旧版判活交接书与账号“切换并重启”交接书均已移除。
>
> 项目：拾光 / SG Team（`shiguang-team`）
>
> 工作区：仓库根目录（macOS / Windows 均可）
>
> 当前基线：`0c296e6 Harden virtual turn persistence and process lifecycle`
>
> 写作日期：2026-09-02（Asia/Shanghai）
>
> 本文来自只读审查：三张用户截图、当前源码、Git 历史、正式软件 SQLite 数据与当前 Cursor 运行态交叉核对。业务源码在调查与交接编写期间保持零变更。

***

## 0. 接手人先读

### 0.1 本任务只解决这些问题

1. 会话内容在回复后数秒及每次 keepalive 周期发生闪动、增高或跳动。
2. 用户发送的新消息与上一轮过程在时间线中错位。
3. Thinking、过程 message 与最终正文失去原有渐进打字效果，改为整段瞬间出现。
4. 普通编号列表被误生成“建议操作”，按钮字面显示 Markdown `**` 与反引号。
5. 图片消息虽然投递、解析均成功，但用户头像、名称和时间被错误隐藏。
6. TeamRun 在已投递消息正在处理时自动结束，导致真实回复以 `visible=0` 落库。
7. 最终正文同时进入 `processBlocks` 与回复正文，造成重复展示和错误归档。

### 0.2 明确排除

- Cursor 账号切换、Token 兑换、奥仔流程。

- 会话侧栏拖拽与大厅视觉设计。

- 模型选择、费用统计、背景图等独立需求。

- 重新设计整套 Team/MCP 工具面。

### 0.3 实施纪律

- 先修领域状态和事件契约，再修渲染；禁止从 CSS 或超时常量开始遮盖症状。

- 保留当前 MCP 通信模型：`check_messages` / `record_reply` 与 SQLite 通道。

- 不重新引入 Composer 身份硬门、外置插件依赖或另一套过程上报协议。

- `getSnapshot()` 最终应成为纯投影函数，读取快照期间禁止写 SQLite。

- 每个阶段通过事件级回归后再进入下一阶段；禁止一次堆入多个互相补偿的条件分支。

- 实机验收只发一个测试会话，避免重复消耗额度。

***

## 1. 用户看到的四组症状

### 1.1 周期闪动

回复完成后，会话区域隔一段时间闪一下、内容高度变化或被重新拉到底部。用户确认此前版本没有此现象。

### 1.2 过程不再渐进呈现

过去过程流有类似 Cursor 的连续输出观感；当前 Thinking 和中间文字经常整段出现，最终正文在结束时也会瞬间补齐。

### 1.3 建议按钮出现 Markdown 源字符

截图中的按钮显示：

```text
**顶部文字**
**中间多组工具调用块**：交替出现 `mcp--` ...
```

这两项实际是回答中的图片内容说明，并非下一步建议。

### 1.4 图片消息没有用户身份头

- 07:58 的普通消息显示头像与“你”。

- 08:00 的图片消息只显示橙色气泡和已发送时间，头像与“你”消失。

- 图片本身成功进入 Cursor，Agent 对图片的描述正确。

***

## 2. 当前系统的真实端到端链路

### 2.1 Cursor 原生过程链

```text
Cursor composerDataHandleManager 写入
  markDirty / markMessageDirty / updateWithoutMarkingDirty / pushComposer
→ CursorStreamObserver 注入 wrapper（写后触发）
→ queueMicrotask 合并同批写信号
→ processSnapshot(getComposerDataIfLoaded)
→ sgTeamProcess CDP binding
→ CursorStreamObserver.handleMessage
→ parseProcessStream
→ DesktopSessionService.notifyNativeProcessSnapshot
→ updateLiveCursorProcess
→ liveCursorProcess[channelId]
→ DesktopSessionService.getSnapshot
→ attachEmbeddedVirtualProcessSegments
→ ChannelMessageRelay.attachProcessToReply
→ channel_replies.process_blocks_json
→ Electron IPC snapshot
→ App.acceptSnapshot / shareSnapshotStructure
→ projectVirtualProcessTurns
→ SessionWorkspace.timelineItems
→ ProcessTurnCard / LiveAgentResponse
→ useBottomFollow ResizeObserver
```

### 2.2 用户消息与回复链

```text
SessionWorkspace.submit
→ preload sendMessage IPC
→ DesktopSessionService.sendMessage
→ ChannelMessageRelay.sendMessage
→ channel_outbox（created_at）
→ Agent 调 check_messages
→ markOutboundDelivered（delivered_at）
→ channel_presence = processing + pendingReplySyncSince + pendingOutboundId
→ Cursor 生成过程与可见回复
→ Agent 调 record_reply
→ ChannelMessageService.recordReply
→ channel_replies（visible + outbound_id）
→ Relay.pollReplies
→ ConversationEntry
→ renderer 时间线
```

### 2.3 图片附件链

```text
ComposerWorkbench.onPaste
→ filesFromTransfer
→ FileReader.readAsDataURL
→ MessageAttachment(data, mimeType, previewUrl)
→ IPC attachmentOf
→ ChannelMessageRelay.prepareAttachments
→ 图片写入 channel-attachments/<messageId>/
→ channel_outbox.attachments_json
→ check_messages
→ deliveredContentBlocks：前导 text + MCP image block
→ Cursor Agent
```

关键文件清单见第 10 节。

***

## 3. 正式软件实机证据

数据库：

```text
~/Library/Application Support/sg-team/task-pool.sqlite3
```

### 3.1 事故时间线

| 事件                         |         精确时间 |
| -------------------------- | -----------: |
| 当前 TeamRun 创建              | 19:58:01.601 |
| Cursor 会话批量启动              | 19:58:29.800 |
| CH-1 用户消息“你是谁”入队           | 19:58:57.951 |
| Agent 取走该消息                | 19:58:58.374 |
| TeamRun 自动结束               | 19:58:58.997 |
| CH-1 对该消息执行 `record_reply` | 19:59:00.795 |
| 图片消息入队                     | 20:00:30.582 |
| 图片消息被取走                    | 20:00:31.540 |
| 图片回复落库                     | 20:01:00.810 |

### 3.2 被自动结束破坏的第一条回复

“你是谁”的回复行：

```text
visible = 0
outbound_id = NULL
```

它是用户可见回答，却因 TeamRun 收尾清掉 reply-sync 门禁而被当成后台回复。

### 3.3 图片链路正常

图片消息：

```text
attachments_json = 162166 chars
delivered_at = 20:00:31.540
```

图片回复：

```text
outbound_id = bbee7f1f-71a2-4b3d-8605-f8470ae16f70
visible = 1
```

Agent 回复准确描述了图片中的 `mcp--`、`capability:30` 与 Thought，证明图像内容成功传入 Cursor。

### 3.4 回复完成后仍被追加过程

CH-3 回复完成：`19:59:28.380`。

回复后仍追加：

```text
19:59:30.462  capability:30 + “正在调用 check_messages”
20:00:32.943  capability:30 + keepalive thinking
20:01:35.342  capability:30 + keepalive thinking
```

CH-1 图片回复完成：`20:01:00.810`。

回复后仍追加：

```text
20:01:02.249  capability:30 + check_messages
20:02:04.137  capability:30 + keepalive thinking
```

62～63 秒间隔与 `CHANNEL_KEEPALIVE_TIMEOUT_MS = 60_000` 一致。

### 3.5 最终正文被重复存入过程

两条最新回复均满足：

```text
channel_replies.content
=== processBlocks 中 cursor-msg.text 的前缀和正文
```

即最终回答既是回复正文，又被当成过程 message。

***

## 4. 根因树

### RC-1：持续会话与“一次性 TeamRun”语义冲突

`TeamFailoverService` 在所有团队通道投影为离线且没有 in-flight 时，等待 20 秒便调用 `completeRun()`。

当前产品同时要求 Agent 长期循环 `check_messages`，因此 TeamRun 自动结束已经不再等价于会话生命周期结束。

#### RC-1.1：运行态验证抹掉了正面的 processing 证据

`ChannelMessageService.checkMessages()` 在取走真实用户消息后写入：

```text
connectionPhase = processing
pendingReplySyncSince = deliveredAt
pendingOutboundId = message.id
```

但 `verifyAgentRuntime.stoppedSession()` 会改写为：

```text
status = offline
online = false
waiting = false
connectionPhase = ''
```

随后 `TeamFailoverService` 使用这个已经被清空的 `member.runtime.connectionPhase` 调用 `hasInFlightExecution()`。

结果是：消息刚被 Agent 取走所形成的强 in-flight 证据，在进入 failover 前被运行态投影层删除。

#### RC-1.2：Telemetry 暂时缺少 Composer 被当成明确停止

`verifyAgentRuntime()` 对绑定的 `composerId` 未出现在 telemetry 列表时直接调用 `stoppedSession()`。

Cursor 新 Composer 水合、转录索引延迟或目标窗口短暂错拍都可能形成“该帧未列出”，这属于证据暂缺，却被投影成明确停止。

#### RC-1.3：run 完成清除了正在处理消息的回复关联

`DesktopSessionService` 观察到 run completed 后调用：

```text
ChannelMessageRelay.completeScope
→ repository.retireScopeBefore
→ pendingReplySyncSince = NULL
→ pendingOutboundId = NULL
```

因此随后到达的 `record_reply` 得到：

```text
visible = false
outboundId = undefined
```

这条链与 19:58:58～19:59:00 的实机时间完全吻合。

### RC-2：虚拟回合只有开始边界，没有关闭边界

`partitionVirtualProcessBlocks()` 只寻找：

```text
block.startedAt 之前最近的 user.deliveredAt
```

它没有使用：

```text
reply.replyToEntryId / reply.timestamp
```

所以同一 Cursor 原生长 turn 中，回复后的 `check_messages`、keepalive、capability 与 thinking 会继续归属于最近一个已完成用户消息。

正确的不变式：

```text
虚拟回合开放：outbound.deliveredAt
虚拟回合关闭：对应 reply.createdAt（以 outboundId 精确关联）
```

回合关闭之后、下一条用户消息投递之前的内容属于传输空档，不属于任何用户可见回复。

### RC-3：过程源没有区分“缺席”与“明确空快照”

以下两种情况都变成 `process === undefined`：

1. Runtime inspect 本次本来就不负责携带过程。
2. Observer 已完整观察 Composer，过滤内部协议后可见过程为空。

服务层为了保护第一种情况，会在 `isGenerating=true` 时保留旧过程；这让第二种情况也无法撤销旧块。

后果：

```text
部分水合 MCP → 暂时产生 mcp--
完整水合 MCP → 识别为 check_messages 并过滤
过滤结果为空 → undefined
服务层保留旧 mcp--
```

过程事件契约需要显式表达：

- 来源是否拥有过程快照；

- 本帧是否为完整快照；

- 完整空集合；

- 前部是否因 256 项窗口截断；

- 当前可见 ID 或撤销 ID。

### RC-4：过程服务把完整快照当成追加日志

`updateLiveCursorProcess()` 每帧先复制上一帧所有普通 block，再 upsert 本帧 block。

除 plan/todos 外，上一帧存在、本帧缺席的 block 永远保留。

这与 Observer 实际传递的“当前 Composer 完整可见快照”语义冲突。

超长回合又有 256 项窗口，因此正确合并需要两种规则：

- 未截断完整帧：当前集合具有权威性，缺席项应撤下。

- 截断帧：窗口外历史保留，窗口内以当前帧为准。

### RC-5：内部协议过滤只针对工具名，没有针对整组 Bubble

当前仅过滤工具：

- `check_messages`

- `record_reply`

同一内部协议阶段伴随的这些块仍会进入过程：

- `capability:30`

- keepalive thinking

- “正在调用 check\_messages”

- serviceStatus

- 被错误判为中间输出的 assistant message

过滤单位应从“单个工具名”提升为“同一 Bubble/协议阶段”。业务工具 `team_task`、文件读取、命令、浏览器操作等继续展示。

#### RC-5.1：部分 MCP 气泡会生成 `mcp--`

现代 MCP ToolCall 首帧可能只有 `toolCase = mcpToolCall`，真实 `toolName` 下一帧才水合。

当前 `toolInfo()` 会把不完整 case 当成工具名继续发出。随后真实工具名虽然到齐，但 RC-3/RC-4 会让旧占位无法撤销。

### RC-6：最终回答识别把后续 keepalive 当成业务工作

最终正文探测与 processSnapshot 都使用“后面是否还有 work”判断。

但 keepalive thinking、capability 与内部 serviceStatus 也会让 `laterWork=true`。

因此真正最终回答被当成中间过程 message，进入 `cursor-msg`；`record_reply` 又保存一次最终回答。

正确顺序是：先对 Bubble 做协议分组和内部噪音分类，再判断正文之后是否存在用户业务工作。

### RC-7：过程持久化发生在 `getSnapshot()` 内

当前 `DesktopSessionService.getSnapshot()` 调用 `attachEmbeddedVirtualProcessSegments()`，后者会进一步执行 SQLite UPDATE。

后果：

- unrelated telemetry/presence/UI 拉取也可能触发过程持久化；

- 快照读取具有副作用；

- 已完成回复可被多次重写；

- 渲染更新频率受多个 watcher 联合驱动；

- 测试很难区分“读取”与“状态推进”。

过程归档应由明确事件驱动：回复出现、过程帧更新或 turn 关闭。`getSnapshot()` 只组装状态。

### RC-8：React 时间线没有稳定的回合身份

同一业务回合可能经历这些 key：

```text
active-turn:<sessionId>
active-turn:<sessionId>:prelude
active-turn:<sessionId>:<outboundEntryId>
entry-wrap:<replyId>
```

排队、投递、实时、完成、持久化每次切换都可能卸载旧组件并创建新组件。

组件本地状态随之重置：

- 打字机缓冲；

- Thought 展开状态；

- 工具展开状态；

- 内容高度；

- ResizeObserver 贴底位置。

业务回合从入队到历史应始终使用：

```text
turn:<outboundId>
```

### RC-9：过程文本没有真正的流式展示状态

`ProcessTurnCard` 对 Thinking 与 message 直接渲染完整 `MessageContent`。

`LiveAgentResponse` 只有最终正文带字符缓冲，但遇到 `status=complete` 会立即把全文写入 visible。

同时 `LiveProcessState` 没有向 renderer 传递服务内部的 `generating`，renderer 只能通过“某块 running”猜测 live 状态。新到达但已标记 done 的 Thinking 因而无法识别为需要播放的实时文本。

需要显式区分：

- live append；

- live completed but catching up；

- history hydration；

- reduced motion。

### RC-10：自动贴底是放大器，不是原始根因

`useBottomFollow()` 的 ResizeObserver 在 following 状态下会在每次内容高度变化后设置 `scrollTop = scrollHeight`。

本身的用户意图模型基本合理；真正的问题是上游在回复完成后仍不断：

- 追加过程块；

- 自动展开 running block；

- remount 整个 turn；

- 重复插入最终正文。

若只关闭 ResizeObserver，用户会失去实时贴底，同时数据污染仍在。

### RC-11：建议提取有语义误判与文本规范化两个缺陷

`suggestedActionsFromText()` 在没有“接下来可以”等明确标题时，会扫描回复末尾八行里的编号列表。

于是图片内容说明被误判为建议操作。

候选又直接作为普通 `<span>` 渲染，没有经过 Markdown 到纯文本规范化；点击按钮时也会把 `**` 和反引号原样填回输入框。

正确约束：

- 仅明确建议区生成建议；

- 建议按钮使用纯展示文本；

- 正文继续由 MessageContent 负责 Markdown；

- 描述性编号列表保持正文，不生成操作按钮。

### RC-12：消息分组按持久 entry 计算，而非按可视时间线计算

`renderTimelineItems()` 只有遇到 `entry` 才更新 `previousEntry`；`live-turn` 和 placeholder 不会打断它。

图片事故中的可视时间线：

```text
用户“你是谁”
Agent 实时回复/过程
用户图片
```

分组算法实际看到：

```text
用户“你是谁”
用户图片
```

两条同为 desktop user，间隔 93 秒，小于五分钟，于是图片消息被标记 `grouped`。

此外分组条件完全没有考虑 attachments。附件消息本身也应开启新的视觉组。

***

## 5. 最近提交与回归归属

| 提交        | 引入/改变的行为                                            |
| --------- | --------------------------------------------------- |
| `82d41ab` | 完成回复首帧直接显示全文；引入 native/transcript 过程恢复与更复杂的数据源交接    |
| `f8f61c4` | 引入虚拟时间线分段、turn-specific React key、ResizeObserver 贴底 |
| `48dbb21` | 引入按 deliveredAt 的虚拟分段和过程持久化；分段只有下界                  |
| `0c296e6` | 扩大归档/合并/committed blocks 逻辑；已完成回复继续接受同 turn 新块      |

注意：图片分组条件源自更早代码，但“回复被隐藏 + live-turn 不打断 entry 分组”让它在当前链路中稳定暴露。

***

## 6. 一次性修复方案

### 阶段 A：先修 TeamRun 与消息门禁

目标：任何已经 delivered 的用户消息，都有稳定的 outbound 身份和回复关闭权；运行态错拍不会清除它。

要求：

1. `verifyAgentRuntime` 保留原 transport `connectionPhase`、pending reply 与队列证据。
2. telemetry 暂时未列出绑定 Composer 时按“证据待确认”处理；只有 CDP 明确 `!found`、错误终止或更新的终止证据进入 stopped。
3. Failover 的 in-flight 判定读取未被投影删除的事实源。
4. `pendingReplySyncSince`、`pendingOutboundId` 或已投递待回复存在时，TeamRun 不进入 all-offline 完成计时。
5. run 状态切换不得清除已投递但尚未回复的关联；至少允许该 outbound 正常 record\_reply 收尾。
6. 明确产品语义：持续团队会话是否仍允许“全部离线自动结束”。当前建议改为显式结束或明确终止证据驱动。

优先文件：

- `src/application/verify-agent-runtime.ts`

- `src/application/team-failover-service.ts`

- `src/application/desktop-session-service.ts`

- `src/application/channel-message-relay.ts`

- `src/infrastructure/channel-messages/sqlite-channel-message-repository.ts`

### 阶段 B：建立虚拟回合窗口

以 `outboundId` 为聚合根：

```text
queued → delivered → responding → sealed
```

每个 turn 包含：

- 用户消息与附件；

- deliveredAt；

- process blocks；

- live response；

- persisted reply；

- sealedAt。

分段规则：

```text
open = outbound.deliveredAt
close = reply.createdAt where reply.outboundId = outbound.id
```

旧数据缺少 outboundId 时保留时间窗回退，但新数据必须走精确关联。

### 阶段 C：修正过程帧契约

建议在现有 `CursorProcessStream` 上最小扩展，而不是新增另一条总线：

```text
turnId
items
generatingBubbleCount
snapshotComplete
truncatedItemCount
```

规则：

- Observer 事件的 `snapshotComplete=true` 表示当前窗口权威。

- Runtime inspect 未携带过程时不设置该标志。

- 完整空集合仍产生明确过程事件。

- 截断帧仅保护窗口外历史，窗口内仍以当前帧为准。

### 阶段 D：以 Bubble 为单位过滤内部协议

1. MCP ToolCall 尚无真实 toolName 时暂缓展示。
2. 得到真实工具名后判断 transport/business。
3. transport bubble 及其关联 capability、thinking、serviceStatus、协议 message 整组隐藏。
4. 再计算 `hasLaterWork` 与最终回答。
5. 业务 MCP、文件、命令、浏览器、todo 原样保留。

### 阶段 E：事件驱动封口与持久化

1. 回复到达后，用 outboundId 定位开放 turn。
2. 收集关闭边界之前的过程块。
3. 将仍为 running 的块结算为完成态。
4. 持久化一次封口快照。
5. 后续 keepalive 过程进入 transport activity，不再写该回复。
6. 从 `getSnapshot()` 移出 SQLite 写操作。
7. 若回复先于最后过程帧到达，使用小型 pending-seal 队列，由下一过程事件或已存在的最新完整帧完成封口；禁止用长固定延迟猜测。

### 阶段 F：统一 renderer turn identity

`SessionWorkspace` 时间线应渲染统一 turn，而不是相互替换的 entry/live-turn：

```text
key = turn:<outboundId>
```

同一节点内部根据 phase 渲染：

- queued 用户气泡；

- delivered；

- Agent process；

- live response；

- persisted reply。

历史兼容 entry 可在 projection 层转换为 turn，避免直接重写所有存储结构。

### 阶段 G：恢复真实渐进展示

使用一个共享的 append-only 文本播放器，供：

- Thinking body；

- process message；

- LiveAgentResponse。

约束：

1. stable block ID 保留 visible buffer。
2. 文本增长时平滑追赶目标。
3. 状态转 complete 时继续播放剩余尾部，播放完成后静止。
4. 历史水合首帧直接完整显示。
5. 文本回退或 block identity 改变时按来源语义重置。
6. `prefers-reduced-motion` 直接完整显示。
7. 工具行按生命周期出现，不模拟逐字工具名。
8. 打字机只表达观看者到来之后发生的事：会话视图挂载（切换会话）时已存在的过程块与
   已流出的正文直接落位（`hydrate`），之后到达的增量与新块才播放——不论此刻来源是
   streaming 还是 done。分界由会话视图挂载时的块集合决定（`hydratedBlockIds`），
   不是由过程卡自身挂载决定：直播卡在首个块到达时才挂载，若以卡片挂载为界，观看者
   眼前到达的第一帧会被误判成历史。

### 阶段 H：修正建议与消息分组

建议：

- 移除无明确建议标题时的任意编号列表兜底。

- 候选进入按钮前转换为纯文本。

- 按纯文本去重与长度限制。

分组：

- 基于最终 `timelineItems` 的相邻可视 actor 计算。

- Agent live-turn、placeholder、时间分隔线均打断用户消息组。

- 当前消息或上一消息含附件时打断分组。

- role/source/time 只作为普通连续文本消息的进一步条件。

***

## 7. 明确禁止的局部补丁

| 伪修复                    | 遗留问题                                 |
| ---------------------- | ------------------------------------ |
| 只过滤字符串 `mcp--`         | capability、thinking、旧 block 与空快照歧义仍在 |
| 只隐藏 `capability:30`    | 最终正文仍会被 keepalive thinking 判成中间过程    |
| 只给附件消息强制显示头像           | 普通用户消息经过 live-turn 后仍会错误分组           |
| 只剥离 `**`               | 描述性编号列表仍被误生成按钮                       |
| 只给 ProcessTurnCard 加动画 | complete 跳全文与 React remount 仍会中断播放   |
| 只关闭自动贴底                | 用户失去实时跟随，数据污染保持原状                    |
| 只延长 all-offline 时间     | 仅推迟 TeamRun 误结束                      |
| 只在 renderer 丢弃回复后的块    | SQLite 历史仍被污染，重启后再次出现                |
| 再加一套过程缓存               | 增加第三份真相源，使 source handoff 更复杂        |

***

## 8. 回归测试任务

测试必须覆盖事件序列，不只检查最终 class 或文字存在。

### 8.1 TeamRun 与门禁

1. `delivered → telemetry composer 暂缺 → failover reconcile`：run 保持活动，processing 证据保留。
2. `delivered → run 状态变化 → record_reply`：reply 仍为 visible 且 outboundId 精确。
3. CDP 明确停止且没有 pending outbound：允许进入离线收尾。
4. 多通道中一席暂缺 telemetry：不触发全团队完成。

### 8.2 虚拟回合

1. block 在 deliveredAt 之前：归入 prelude/上一轮。
2. block 位于 deliveredAt 与 reply.createdAt 之间：归入当前 outbound。
3. block 晚于 reply.createdAt：不进入已封口回复。
4. 下一条用户消息已入队但未 delivered：不夺走上一轮。
5. 下一条消息 delivered 后：创建新 turn。
6. block 缺少原生 startedAt：首次观测时间稳定，重连水合不将旧块挪入新 turn。

### 8.3 Observer 与快照

1. MCP partial → hydrated check\_messages：页面从未出现 `mcp--`。
2. 可见过程 → 完整空快照：旧可见块被撤下。
3. Runtime inspect process absent：保留 Observer 状态。
4. 256 项截断：窗口外历史保留，窗口内撤销有效。
5. transport bubble 的工具、thinking、capability、message 整组隐藏。
6. 业务 MCP bubble 完整保留。
7. 最终正文后只有 transport bubble：正文仍被识别为 final。

### 8.4 持久化

1. reply 首次封口后多次 keepalive：`process_blocks_json` 字节级不变。
2. 连续调用 `getSnapshot()`：SQLite `total_changes()` 保持不变。
3. app 重启：已封口过程恢复，transport 噪音不回流。
4. 最终回答只存在于 reply content，不重复成为 process message。

### 8.5 Renderer

1. queued → delivered → live → persisted：同一 turn DOM 节点保持 identity。
2. Thinking 文本增长：visible 文本单调增长。
3. complete 到达时：尾部继续追赶，不瞬间跳全文。
4. history hydration：直接完整显示。
5. 用户向上滚动：后续过程增长不改变当前视口。
6. 回到底部：恢复持续跟随。
7. `用户文字 → Agent live-turn → 用户图片`：图片显示头像、“你”和时间。
8. 普通编号内容列表：无建议按钮。
9. 明确“接下来可以”列表：生成纯文本按钮。

***

## 9. 实机验收脚本

### 9.1 验收前

```bash
cd <仓库根目录>
git status --short
npm run typecheck
npm test
```

打包后启动正式软件，并保留 Cursor 调试端口 9333。

### 9.2 单会话测试

只启动一个 CH，依次执行：

1. 发送普通短消息。
2. 观察 Thinking 与正文渐进输出。
3. 回复结束后保持页面两分钟，覆盖至少一次 60 秒 keepalive。
4. 检查历史过程没有新增 `mcp--`、`capability:30` 或保活 Thinking。
5. 发送一张图片。
6. 检查图片消息身份头、预览、Cursor 接收内容与回复关联。
7. 手动向上滚动，在 Agent 输出期间确认视口保持；回到底部后确认继续跟随。

### 9.3 数据库检查

```bash
DB="$HOME/Library/Application Support/sg-team/task-pool.sqlite3"

sqlite3 -readonly "$DB" '
SELECT id, channel_id, visible, outbound_id, created_at,
       length(process_blocks_json)
FROM channel_replies
ORDER BY created_at DESC
LIMIT 10;'
```

回复结束后记录一次 `process_blocks_json` 哈希，经过 keepalive 后再次读取；两次必须一致。

检查回复后的 block：

```text
每个 process block.startedAt <= 对应 reply.createdAt
```

检查当前回复：

```text
visible = 1
outbound_id = 对应 channel_outbox.id
```

### 9.4 UI 通过标准

- 页面没有周期性内容闪动或高度跳跃。

- 只有实时状态点自身允许低幅脉冲，整块内容不重建。

- 用户停留底部时跟随输出；用户向上浏览时保持位置。

- 历史刷新、切换会话、重启应用后内容顺序一致。

- 图片消息显示完整身份头。

- 最终正文只展示一次。

***

## 10. 关键文件索引

### Cursor 数据源

- `src/infrastructure/cursor/cursor-stream-observer.ts`

  - `CURSOR_STREAM_HOOK_EXPRESSION`

  - `toolInfo`

  - `processSnapshot`

  - `scheduleProcessSnapshot`

  - `handleMessage`

- `src/infrastructure/cursor/cursor-cdp-session-creator.ts`

  - `CursorProcessStream`

  - `parseProcessStream`

  - `buildRuntimeInspectionExpression`

### 消息与回合

- `src/application/channel-message-service.ts`

  - `checkMessages`

  - `recordReply`

- `src/application/channel-message-relay.ts`

  - `sendMessage`

  - `pollReplies`

  - `attachProcessToReply`

  - `completeScope`

- `src/infrastructure/channel-messages/sqlite-channel-message-repository.ts`

  - `markOutboundDelivered`

  - `recordReply`

  - `attachReplyProcess`

  - `retireScopeBefore`

- `src/domain/virtual-process-turn.ts`

  - `partitionVirtualProcessBlocks`

### 运行状态

- `src/application/verify-agent-runtime.ts`

  - `stoppedSession`

  - `verifyAgentRuntime`

- `src/application/team-failover-service.ts`

  - `reconcile`

- `src/domain/channel-message.ts`

  - `isPresenceOnline`

  - `hasInFlightExecution`

### 主进程聚合

- `src/application/desktop-session-service.ts`

  - `getSnapshot`

  - `attachEmbeddedVirtualProcessSegments`

  - `applyLiveCursorProcess`

  - `updateLiveCursorProcess`

  - `updateLiveAgentResponse`

  - `liveAgentResponseSnapshot`

### Renderer

- `src/renderer/src/virtual-process-turns.ts`

- `src/renderer/src/SessionWorkspace.tsx`

- `src/renderer/src/ProcessTurnCard.tsx`

- `src/renderer/src/LiveAgentResponse.tsx`

- `src/renderer/src/use-bottom-follow.ts`

- `src/renderer/src/process-turn-view.ts`

- `src/renderer/src/MessageContent.tsx`

- `src/renderer/src/snapshot-sharing.ts`

- `src/renderer/src/ComposerWorkbench.tsx`

### 现有测试

- `tests/virtual-process-turns.test.ts`

- `tests/desktop-session-service.test.ts`

- `tests/cursor-stream-observer.test.ts`

- `tests/cursor-cdp-session-creator.test.ts`

- `tests/session-workspace.test.tsx`

- `tests/process-turn-view.test.ts`

- `tests/process-blocks.test.tsx`

- `tests/bottom-follow.test.tsx`

- `tests/channel-message-service.test.ts`

- `tests/channel-message-relay.test.ts`

***

## 11. 当前测试为何是假绿

现有相关定向测试共 119 个，全部通过，但它们主要验证单层最终值。

当前缺少：

- TeamRun completed 与 pending reply 的并发序列；

- transport `connectionPhase` 被 verify projection 清除；

- reply 后 keepalive 污染历史；

- partial MCP 的撤销；

- 显式空快照；

- final message 与 process message 去重；

- React DOM identity；

- process text 的字符级增长；

- live-turn 对消息分组的打断；

- Markdown 描述列表误生成建议。

因此后续新增测试应围绕第 8 节的事件链，而不是继续增加孤立 happy-path 数量。

***

## 12. 完成定义

本任务仅在以下全部成立时结束：

1. 第 8 节事件级测试全部通过。
2. 第 9 节单会话正式软件实机通过。
3. 回复后至少经历一次 keepalive，SQLite 过程哈希不变。
4. `getSnapshot()` 经验证无持久化副作用。
5. live → persisted 保持 DOM identity 与播放状态。

