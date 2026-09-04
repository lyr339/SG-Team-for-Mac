# 待办任务书：会话 Token/费用统计近实时化 + 定价表补全

> **状态（2026-09-04）：阶段 A/B/C 已全部落地并提交**（遥测落盘态接线 + 双源互斥、
> applyRequestSample 缓存拆分计价、定价表补全与词边界匹配），事件级测试全绿。
> 与任务书的两处有意偏差：① 无写入溢价厂商的 cacheWritePerM = inputPerM 而非 0
> （0 会把新进上下文算成免费，见 cursor-usage.ts 注释）；② 价格表未外置 JSON，
> 采用文件内快照日期常量 MODEL_PRICES_SNAPSHOT_DATE。
> 剩余：第 7 节验收 1/3/4 需实机打包验证（≤5s 出数、误差对照、基线落盘）。
>
> **性质：只读调查产出，业务代码零变更。** 本文档由 CH-3 独立席位于 2026-09-03 完成端到端调查后编写，
> 供任意接手 Agent 自包含理解任务，无需重新侦察。
>
> 项目：拾光 `qingtian-team`
>
> 工作区：`/Users/lyr/Downloads/qingtian/qingtian-team`
>
> 调查基线：`0c296e6 Harden virtual turn persistence and process lifecycle`（另有 33 文件未提交改动，属 P0 过程流修复，见下）
>
> **与 `.handoff/HANDOFF.md` 的关系**：HANDOFF.md 是「会话过程流 P0 全链路修复」的权威交接书，优先级高于本任务。
> 本任务与过程流正交，但 `src/application/desktop-session-service.ts` 是两个任务共同触碰的文件——
> **本任务应在 P0 修复合入后再动工**，避免在同一文件上制造合并冲突。

***

## 0. 接手人先读

### 0.1 用户诉求（原始需求）

1. 当前 TOKENS / COST 统计只能在「真正一轮对话结束」后出现，持续对话模式下页头恒显示占位符「—」。
2. 希望实现**实时（约 5 秒刷新一次）**的 token 与费用统计；**近似值可接受**。
3. 用户指出：token 分输入 / 输出 / 缓存读 / 缓存写四桶，当前计算公式**没有覆盖所有模型的 API 定价**——此判断经核实**属实**（见第 5 节）。

### 0.2 任务范围

- 让用量统计在持续对话（Agent 循环 `check_messages`、Cursor 回合永不结束）期间近实时更新；
- 修正采样通道的费用估算精度（当前为全价上界，agentic 场景高估 6~9 倍）；
- 补全模型定价表并按 provider 区分缓存计费口径。

### 0.3 明确排除

- UI 组件（`SessionUsageStat.tsx`）**无需改动**：占位符在 `usage.turns > 0` 后自动原地替换，推送链路现成。
- 不改变「等价 API 成本」的产品定位（不是 Cursor 真实账单，Cursor 是请求计费/混合额度制；代码注释与 UI 文案均已明确）。
- 不重做 bundle 补丁体系（`scripts/patch-cursor-usage-hook.ts` 保持 turnEnded hook；请求级 hook 是可选后续增强，见阶段 D）。
- 不新增任何轮询循环——现有 250ms 遥测循环已经读到所需数据。

***

## 1. 现状架构：三条采集通道与实际生效情况

聚合器 `CursorUsageTracker`（`src/application/cursor-usage-tracker.ts`）接收三条通道，
以让位机制防双计（`polledComposers` / `requestSampledComposers` / `contextLastUsed` 基线存在性）：

| 通道 | 入口方法 | 数据源 | 实际生效情况 |
|---|---|---|---|
| 事件通道 | `record()` | bundle 补丁在渲染进程 `turnEnded` 分支注入 `__sgTeamUsage` binding，推真实四桶 | 仅回合结束触发 |
| CDP 快照通道 | `recordTurnSnapshot()` | runtime inspect 循环捎带 `composerData.turnTokenUsage` | `turnTokenUsage` **仅 turnEnded 写入、回合开始清空**（`src/main/index.ts` 约 280 行注释 + 实证），本质也是回合结束才有 |
| 请求级采样通道 | `recordRequestSample()` | CDP 读内存态 `composerData.contextTokensUsed` | 设计为长会话主通道，**实际从未生效**（证据见第 2 节） |

**关键背景**：拾光的持续对话模式下 Agent 永远在 `check_messages` 循环里，Cursor 的回合（turn）永不结束，
`turnEnded` 永不触发 → 前两条通道在长会话中恒为零。这正是用户观察到「只能一轮对话结束才统计」的机制成因。

其他已确认的基础设施状态（接手后不要重复调查）：

- `collecting` 门禁已解耦：`src/main/index.ts` 约 545 行 `cursorUsageTracker.setCollecting(true)` 恒真，
  只有 run 切换才 `reset()`（2026-09-01 实证教训：run 被误判结束期间事件被 `collecting=false` 丢弃过）。
- tracker 通知节流 `DEFAULT_NOTIFY_DELAY_MS = 800ms`，持久化与通知同拍（防抖合并高频采样）。
- 持久化：`CursorUsageStore`（`~/Library/Application Support/qingtian-team/cursor-usage.json`，
  version 2，按 runId 绑定，上限 1000 会话）。
- UI：`SessionUsageStat.tsx` 以 `usage.turns > 0` 判定就绪，未就绪渲染 ghost「—」（提交 `cac7c4f` 故意保持挂载，
  不得改回条件卸载——会违反 hooks 数量规则）。

## 2. 实证证据（2026-09-03 采集）

正式软件用量文件 `~/Library/Application Support/qingtian-team/cursor-usage.json`（17:35 更新）唯一一条账：

```json
{
  "turns": 1,
  "inputTokens": 3535934,
  "outputTokens": 41793,
  "cacheReadTokens": 3442424,
  "cacheWriteTokens": 93402,
  "estimatedCostUsd": 10.05,
  "pricedModel": "Claude Opus"
}
```

判读：

1. 四桶齐全 → 来自快照/事件通道（某次回合真正结束时记账）；
2. **无 `contextLastUsed` 字段** → 采样通道基线从未建立，`recordRequestSample` 一次都没被调用过；
3. 缓存命中率 3.44M / 3.54M ≈ **97%**——agentic 长会话典型形态，是第 4 节精度方案的定量依据；
4. `release/mac-arm64` 构建于 2026-09-03 15:14，包含全部三通道代码（含提交 `0da91c3` 请求级采样）——**排除版本原因**。

## 3. 根因：两个 `contextTokensUsed` 的分野

同名字段存在于两处，活性完全不同——这是本任务最重要的一条信息：

| 位置 | 读取方 | 活性 |
|---|---|---|
| 渲染进程**内存态** `composerData.contextTokensUsed`（CDP `bridge.getComposerData()` 注入表达式读取，`cursor-cdp-session-creator.ts` 约 536-563 行） | CDP inspect 循环 → `TurnUsageSink`（`main/index.ts` 分派） | **恒空**。当前 Cursor 版本在回合进行中不维护该内存字段，采样通道因此无活水 |
| **落盘态** `state.vscdb` 的 `composerData:<id>.contextTokensUsed`（`cursor-composer-telemetry.ts` 约 491 行 SQL `json_extract`） | 遥测轮询（活跃 250ms / 空闲 10s，`desktop-session-service.ts` `DEFAULT_TELEMETRY_POLL_MS`） | **持续有值、持续更新**。会话卡上「Context: X%」显示正常即为此源；但当前只喂 UI，未喂 tracker |

结论：把落盘态这条活水接到已存在的 `recordRequestSample()` 入口即可，无需新增采集机制。

## 4. 实施方案（按依赖顺序）

### 阶段 A：遥测通道接线（核心，达成近实时）

在 `DesktopSessionService.refreshTelemetry()` 成功刷新后，对每个有绑定的 composer，
将 `composer.contextUsage.used` 喂给 `tracker.recordRequestSample({ composerId, used, occurredAt })`。

要求：

1. 复用 `applyRequestSample` 既有语义：首样本建基线零累计、同值去重、值变化（无论方向，含上下文压缩回落）按当时读数记账；
   基线 `contextLastUsed` 已随快照持久化，跨重启不双计——这些都已实现，不要重写。
2. 双源互斥：CDP 内存态采样（若未来 Cursor 版本恢复供水）与遥测采样对同一 composer 只允许一源记账。
   建议：遥测源调用前检查该 composer 是否已被 CDP 采样接管；或统一经由同一 sink 收口。
   tracker 现有让位集合（`requestSampledComposers`）语义是「采样通道整体」，两个采样源共用它即可，但注意
   两源 `used` 读数时间错位可能被误判为「新请求」造成重复记账——**最稳妥做法是同一时刻只启用一源**（CDP 在场用 CDP，否则用遥测）。
3. 注意 tracker 需要 `resolveModelForComposer` 能解析到模型（现有注入已做，确认遥测路径下 composer→model 映射可用即可）。
4. 时序注意：`refreshTelemetry` 有 `refreshing` 重入保护，接线点放在指纹比较之后、`emit()` 附近，
   但**不要**依赖 `changed` 分支——context 读数变化不一定改变遥测指纹中已有字段的顺序拼接结果，需确认 used 在指纹内
   （实查：指纹含 `contextUsage?.used`，在 `getSnapshot` 组装处约 453 行——变化会触发 emit，但记账不应依赖 emit，独立喂 tracker）。
5. 刷新率结论：250ms 轮询 + 800ms 节流推送 → UI 秒级更新，优于用户要求的 5s。
   实际滞后上限由 Cursor 落盘 `state.vscdb` 的频率决定（不可控，几秒到几十秒），产品口径为「近实时」。

### 阶段 B：采样通道费用精度（缓存拆分近似）

现状：`applyRequestSample`（`src/domain/cursor-usage.ts` 约 230-262 行）把每次请求的完整上下文按输入全价记账，
注释自认「上界估算」。实测 97% 缓存命中率下高估 6~9 倍。

改进模型（Anthropic agentic 会话物理形态：每请求 = 前缀缓存命中 + 增量写入）：

```text
delta = used - contextLastUsed（>0 的新增部分）→ 按 cacheWritePerM 计价
contextLastUsed（存量前缀）              → 按 cacheReadPerM 计价
used 回落（上下文压缩）                  → 压缩后全量视为新前缀，按 cacheWrite 计价（保守），基线重建
输出 token                               → 上下文读数拿不到；可不计（轻微低估）或按 delta 的经验比例估算，
                                           二选一后在 cursorUsageDetail 文案里如实说明口径
```

token 计数口径不变（`inputTokens += used`，总量 = 输入 + 输出），只改成本估算拆分；
`cacheReadTokens`/`cacheWriteTokens` 桶可同步累计近似值，让 UI 分段条在采样模式下也有构成展示（可选）。

预期：误差从「数倍高估」收敛到 ±20% 量级。用户已明确接受近似。

### 阶段 C：定价表补全与口径修正

`MODEL_PRICES`（`src/domain/cursor-usage.ts` 约 72-84 行）现有 11 条：
Claude（opus 15/75、haiku 0.8/4、sonnet 3/15、泛化）、GPT（gpt-5 1.25/10、gpt-4.1 2/8、gpt-4o-mini 0.15/0.6、gpt-4o 2.5/10、泛化）、Gemini（gemini-3 2/12、泛化 1.25/10）。

缺失且实际会用到（Cursor 模型列表 / 代码中已出现的形态）：

- **Grok**（grok-4.5 / grok-4.6 在模型列表中存在）
- **Kimi**（K3 形态处理已写进 `cursor-model-variants.ts`，价格表却没有它）
- **DeepSeek**、**Qwen**、**OpenAI o 系列**、**composer**（Cursor 自家模型）

未命中一律按 Sonnet 档（3/15）估算并在标签注明「xxx · Sonnet 档估算」——对便宜模型高估一个数量级。

口径修正：`cacheWritePerM` 当前统一按输入 1.25 倍（Anthropic 口径），但各家不同：

- Anthropic：写 1.25×（5min TTL）/ 2×（1h），读 0.1× —— 现表一致；
- OpenAI：**缓存写免费**，读 0.1×~0.5×（按代际）—— 现表读价已对，写价应为 0；
- Gemini：显式缓存按存储时长另计费 —— 简化近似可接受，注明即可。

建议：牌价随时间漂移快，把价格表外置为用户数据目录下可编辑 JSON（缺省内置表兜底），
或至少在文件头注释记录牌价快照日期。填价前先联网核对当日牌价，不要沿用本文档写作时的记忆值。

### 阶段 D（可选后续增强，非本任务验收项）：bundle 补丁请求级 hook

`scripts/patch-cursor-usage-hook.ts` 现只 hook `turnEnded`。可扩展 hook 流式响应帧中的 per-request usage
字段（`streamUnifiedChatWithTools` 响应链路），拿到真实四桶每请求数据——精度最高，
但补丁随 Cursor 更新易碎。仅在阶段 A~C 落地后仍需更高精度时评估。

## 5. 陷阱清单（前人踩过 / 调查中确认）

| 陷阱 | 说明 |
|---|---|
| `promptTokenBreakdown` 不是计费拆分 | 它是 Cursor 原生**上下文构成分类**（系统提示/文件/消息等，`domain/agent-session.ts` `ContextUsageCategory`），与输入/输出/缓存四桶无关。不要试图从它拿计费数据 |
| 四桶直接相加会重复计费 | 缓存读/写是**输入的子集**（2026-09-01 三重证据定稿，见 `cursor-usage.ts` 文件头注释）。总量 = 输入 + 输出。旧口径曾把成本虚报 6 倍 |
| 不要按 run 状态停采 | `setCollecting(true)` 恒真是有意为之（run 误判结束期间 Composer 仍在消耗）。生命周期归 Composer，只有 run 切换 reset |
| `getSnapshot()` 副作用纪律 | P0 交接书要求 getSnapshot 成为纯投影。阶段 A 接线放在 refreshTelemetry 回调里，**不要**放进 getSnapshot |
| 读 `state.vscdb` 只读安全、写危险 | telemetry 已长期只读访问（Cursor 运行中）；架构文档警告的冻结事故是**写**场景（账号切换必须先杀 Cursor）。不要新增写路径 |
| UI 占位符不得改回条件卸载 | `cac7c4f` 修复过：早退位于 hooks 之间违反 React 规则，空会话整块消失被用户读作「组件坏了」 |
| 双源采样时间错位双计 | 阶段 A 第 2 条：CDP 内存态源与遥测落盘源读数有时间差，同一 composer 同时启用两源会把同一请求记两次 |

## 6. 测试要求（事件级，对齐 P0 交接书测试哲学）

现有相关测试：`tests/cursor-usage-tracker.test.ts`、`tests/cursor-usage.test.ts`、`tests/cursor-usage-store.test.ts`、
`tests/desktop-session-service.test.ts`（注意该文件在 P0 未提交改动中已 +867 行，动它前先确认 P0 合入状态）。

1. 遥测样本序列：`首样本建基线（零累计）→ 同值去重 → 值增长记账 → 值回落（压缩）记账` 全链断言 token 与成本。
2. 双源互斥：CDP 采样接管后遥测样本不再记账（或反向，按实现选定的互斥方向）。
3. 缓存近似口径：给定 `lastUsed=1M, used=1.05M`，断言成本 = 1M×cacheRead 价 + 50K×cacheWrite 价（而非 1.05M×input 全价）。
4. 跨重启基线延续：持久化快照恢复后首样本不重复记账（已有语义，回归保护）。
5. 定价表：新增模型条目的子串匹配命中；OpenAI 系缓存写零价；未命中模型标签仍显示真实模型名 + Sonnet 档注明。
6. run 切换 reset 后基线清空、UI 占位符回归「—」。

## 7. 验收标准

1. 持续对话模式下（Agent 循环 check_messages、回合不结束），发送一条消息后 **≤5s** 页头 TOKENS/COST 从「—」变为数值并随后续请求增长（实机：正式打包版 + CDP 9333 在场）。
2. 回合结束场景（真实 turnEnded）行为不回归：四桶精确账仍按事件/快照通道落账。
3. 采样模式成本与同会话 turnEnded 真值对照：误差 ≤ ±30%（97% 缓存命中率样本下，全价上界旧口径为 +600%~900%）。
4. `cursor-usage.json` 中采样会话出现 `contextLastUsed` 基线且跨重启延续。
5. 第 6 节事件级测试全绿；`npm run typecheck && npm test` 通过。
6. 用量明细文案（`cursorUsageDetail`）如实标注当前口径（采样近似 / 事件精确、输出是否计入）。

## 8. 关键文件索引

### 领域与聚合

- `src/domain/cursor-usage.ts` —— 价格表、`estimateTurnCostUsd`、`applyRequestSample`（阶段 B/C 主战场）
- `src/application/cursor-usage-tracker.ts` —— 三通道入口、让位机制、800ms 节流
- `src/infrastructure/cursor/cursor-usage-store.ts` —— JSON 持久化（version 2）

### 数据源

- `src/application/desktop-session-service.ts` —— `refreshTelemetry()`（阶段 A 接线点）、`DEFAULT_TELEMETRY_POLL_MS = 250`
- `src/infrastructure/cursor/cursor-composer-telemetry.ts` —— `state.vscdb` 读取（约 488-494 行 SQL）
- `src/infrastructure/cursor/cursor-cdp-session-creator.ts` —— CDP 注入表达式中的 usage 捎带（约 536-563 行）
- `src/main/index.ts` —— `TurnUsageSink` 分派（约 279-307 行）、tracker 创建与 collecting（约 322-346、529-546 行）
- `scripts/patch-cursor-usage-hook.ts` —— bundle 补丁（阶段 D 才动）

### UI（本任务零改动，仅索引）

- `src/renderer/src/SessionUsageStat.tsx` —— 页头 TOKENS/COST 度量组 + 悬浮明细
- `src/main/register-cursor-usage-ipc.ts` —— IPC 推送

### 实机数据位置

- 正式库：`~/Library/Application Support/qingtian-team/cursor-usage.json`（用量）、同目录 `task-pool.sqlite3`（通道/任务）
- Cursor 遥测源：工作区对应 `state.vscdb` 的 `cursorDiskKV` 表 `composerData:<composerId>` 键
