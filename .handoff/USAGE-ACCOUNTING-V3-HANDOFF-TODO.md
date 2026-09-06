# 接手待办：Cursor 会话 Token / Cost 统计 V3（精确优先、实时估算、最终校准）

> **2026-09-05 19:00 用户简化需求（本段优先于下文）**
> - 数字用于个人近似展示：Input / Output / Cache Write / Cache Read 全英文，K/M/B 格式；删除回合数及冗长结算提示。内部仍保留来源字段。
> - 已按用户参考图四个模型及合计行的比例，拆分累计输入并估计输出；费用复用每回合固定牌价。不复制参考图金额，不引入新采集系统。
> - aborted/completed 会发最后一拍 sample；采样终止帧落盘并封口，全零伪结算不清除已有数值；新 generation 独立累计。
> - 显式结束 run 后只读补收一拍再冻结，读取失败保留数值；新 run 竞态通过 runId 防串账。
> - 现有 V3 估算（含冻结值）首次加载补齐参考拆分；精确账保持原值，已补过的账重复加载稳定。
> - 已验证：1222 项全量测试、build、smoke:channel；实际 hook 表达式→中断→落盘→重启回放；深浅色 UI 及面板重开。
> - 本次简化尚未打包/重启，未创建真实付费测试会话。

> **2026-09-05 实施状态更新（以本段覆盖下文的早期方案假设）**
> - 已实现：generation 级单 reducer；实时上下文估算、同回合精确四桶替换、跨回合累计、重启幂等；存储 V3。
> - 已核实：该现场 modelCallId 与 toolCallId 相同，未证明是模型请求 ID；因此不再展示采样次数为“请求次数”。
> - 采集：write hook 与 inspect 共用 `cursor-native-usage.ts`，直接读原生 composer，不再读 bridge 精简摘要；Auto 尝试原生 tokenDetails，缺数据保持未知。
> - 精度：运行中为上下文变化估算（非真实逐请求账单）；输出未知显示待结算，缓存拆分标注假设。服务端完整 turnEnded 到达后替换该 generation。没有逐请求精确源的证据，不承诺误差范围。
> - 计价：沿用已有牌价表，每个原生回合首次观测时固定牌价；混合回合跨回合相加。Cost 始终是估算，不等同 Cursor 账单。
> - 生命周期：新 runId 清零；显式 endActiveRun 成功后冻结（含迟到结算），同 run 状态抖动不 reset；回合账本与冻结位落盘。
> - V2 旧账没有 generation，保留为 legacy 展示直到新 run，不作猜测迁移或补录。
> - 验证：真实 hook 表达式→估算→四桶校准→存储→恢复的隔离回放；在当前 Cursor bundle 内容副本上验证 V3 双锚点升级、语法及幂等。
> - 尚未执行：正式打包/重启、安装 V3 bundle 补丁、真实付费模型请求验收。运行中的 Cursor 和拾光未被本次统计任务重启；现有会话仍使用旧正式版。
> - 下文 exact-request、modelCallId 幂等、固定大小去重集合均为早期设想；当前实际采用原生 generation 账本，不再添加这些未验证机制。


> 编写时间：2026-09-05  
> 项目：拾光 / SG Team（`shiguang-team`）  
> 工作区：仓库根目录（macOS / Windows 均可）  
> 调查基线：`37253bf Auto-grow and drag-resize the composer, add image attachment viewer, show Thinking → Thought`  
> 性质：**只读调查后的交接任务书；本文编写过程没有改业务代码。**  
> 本文取代 `.handoff/USAGE-REALTIME-TODO.md` 中“沿用织梦采样算法作为最终主通道”的结论；旧文仅保留为历史实施记录。

---

## 0. 接手纪律

1. 用户固定使用 Cursor `3.6.31`，允许针对该版本做稳定锚点适配；仍必须保留锚点漂移检测和原 bundle 回滚副本。
2. **先完成统计主链，再做 UI 微调。** 不要同时重构会话页、过程流或其他业务。
3. 不要继续给 `CursorUsageTracker` 堆“某源出现后其他源永久让位”的条件判断；本任务的核心是把三条互斥累计链改成一个可校准状态机。
4. 不调用 subagent。
5. 当前工作树已有一组未提交的图片协议 / 会话交接改动，接手前先确认归属并保护，尤其不要覆盖：
   - `src/main/index.ts`
   - `src/shared/desktop-api.ts`
   - `src/renderer/src/styles.css`
   - `src/renderer/src/MessageContent.tsx`
   - `src/main/local-image-protocol.ts`
   - `src/shared/local-image.ts`
6. 不用真实账号反复烧额度。运行态探针最多做一个受控请求；执行前由用户明确安排测试窗口。

---

## 1. 用户要的最终行为

### 1.1 显示语义

- 每个 composer 独立统计 `Tokens` 和 `Cost`。
- 新 Team / 新独立批次启动时从 0 开始。
- 运行中数字近实时增长，目标延迟 **≤5 秒**。
- 用户显式结束 Team / 批次后立即冻结；重新打开软件仍保持冻结值。
- 下次启动新 Team / 新批次重新清零，不把上一轮混入。
- 长任务可运行数小时，不能因为心跳、在线状态抖动或 run 状态误判提前停采。

### 1.2 准确性语义

- 有 Cursor 精确数据时，以精确四桶为准：
  - `inputTokens`
  - `outputTokens`
  - `cacheReadTokens`
  - `cacheWriteTokens`
- 精确事件尚未到达时，可以显示实时估算；精确事件到达后必须**替换/校准**同一请求的估算，不能再加一遍。
- `cacheReadTokens` / `cacheWriteTokens` 是输入的子集；总 Token 口径保持：

  ```text
  totalTokens = inputTokens + outputTokens
  ```

- Cost 是“等价 API 成本估算”，不是 Cursor 套餐账单；但模型和价格必须在事件发生时固化，之后切模型不能追溯改价。

---

## 2. 当前实现的真实状态

### 2.1 当前三条入口

`src/application/cursor-usage-tracker.ts` 当前有三条互斥入口：

| 入口 | 数据 | 当前处理 |
|---|---|---|
| `record()` | bundle `turnEnded` 精确四桶 | 采样或快照曾出现后直接丢弃 |
| `recordTurnSnapshot()` | CDP `turnTokenUsage` | 以“数值回落”猜新回合 |
| `recordRequestSample()` | `contextTokensUsed` | 数值每变化一次就当成一次请求 |

防双计依赖：

- `polledComposers`
- `requestSampledComposers`
- 持久化的 `contextLastUsed`
- `cdpContextSampledComposers`

这些集合只能表达“永久选一个源”，不能表达“估算先显示、精确数据后校准”。

### 2.2 当前生产数据

正式存储：

`~/Library/Application Support/sg-team/cursor-usage.json`

调查时 CH-1 数据：

```json
{
  "turns": 222,
  "inputTokens": 117086814,
  "outputTokens": 0,
  "cacheReadTokens": 116355580,
  "cacheWriteTokens": 731234,
  "estimatedCostUsd": 38.22932,
  "contextLastUsed": 767939
}
```

同一 Cursor composer 的落盘会话中已确认：

- 614 个 bubble；
- 至少 410 个唯一 `toolFormerData.modelCallId`；
- transcript 中也有 410 个 assistant tool-use 调用；
- 当前采样只记了 222 次。

因此至少漏掉 `188 / 410 ≈ 45.9%` 的可识别模型调用。410 还只是带工具调用的下界，不能把 222 次测试绿灯解释成准确。

### 2.3 已验证的精确事件

Cursor bundle 的 `turnEnded` 事件可给出真实四桶，实机曾捕获：

```json
{"i":12168,"o":42,"r":3968,"w":0}
```

当前 `/Applications/Cursor.app` 内有两处 `__SG_TEAM_USAGE_PATCH__`，分别覆盖 local / cloud 路径。精确数据存在，问题是聚合器在请求采样接管后把它丢了。

---

## 3. P0 根因清单

### P0-1：用上下文数值变化冒充请求身份

`applyRequestSample()` 仅比较 `contextLastUsed`：

- 相同：认为还是同一次请求；
- 不同：认为发生新请求并把完整 `used` 加到账上。

多个模型调用可能在两次落盘采样间完成，最终只看到一个值；也可能一次请求中发生多次上下文写入。没有 `requestId/modelCallId` 时，数值变化不是可靠幂等键。

### P0-2：精确 `turnEnded` 被错误地永久让位

`CursorUsageTracker.record()` 在以下任一条件成立后直接返回：

- `polledComposers.has(composerId)`
- `requestSampledComposers.has(composerId)`
- `contextLastUsed !== undefined`

这使实时估算一旦启动，后续精确四桶永远没有机会校准；输出 Token 因此长期保持 0。

### P0-3：`applyTurnUsage()` 把“当前回合快照”和“会话累计”塞进同一对象

当前回落分支会：

```text
turns += 1
inputTokens = 新快照 inputTokens
outputTokens = 新快照 outputTokens
estimatedCostUsd = 旧成本 + 新快照成本
```

即 Token 丢掉旧回合累计，Cost 却继续累计。现有测试明确断言“5,000 回落到 500 后 inputTokens 应为 500”，属于**把错误行为写成绿灯**。

### P0-4：双源接管不可恢复

`cdpContextSampledComposers` 只在 run reset 时清除。CDP 内存态只要偶然出现过一次，落盘遥测源就永久让位；后续 CDP 停供也不会恢复。

### P0-5：事件缺少身份字段

当前 `CursorUsageEvent` 只有 composerId、四桶、时间，没有：

- request / model call ID
- native turn / generation ID
- model ID
- 来源与精度级别

所以聚合器无法做幂等、乱序处理、估算替换或 checkpoint 校准。

### P0-6：生命周期绑定错对象

`src/main/index.ts` 当前每次 run 快照变化都执行：

```ts
cursorUsageTracker.setCollecting(true)
```

这是为了规避历史上的“run 被误判结束但 Cursor 仍在消耗”事故，但副作用是显式结束后仍可能继续吸收旧 composer 的遥测。统计生命周期应该绑定：

```text
runId + composerId + generation/session binding + 用户确认的开始/结束事件
```

不能只看在线状态，也不能永远 true。

### P0-7：模型只在入账时临时查询

精确事件本身不带模型，tracker 到当前 session 快照里临时解析。事件乱序、模型刚切换或 session 已解绑时可能用错价格。模型与价格快照必须和请求/精确事件一起固化。

---

## 4. 外部参考逆向结论：不要继续照搬织梦

已解包并对比：

- macOS 织梦 `1.1.54`
- Windows 织梦 `1.1.60`

两版计费模块、主进程接线、价格表和 UI 说明的语义完全相同。执行了 60,617 项跨版本定向/模糊对比，差异为 0。

织梦算法同样只是：

1. 读取 `contextTokens`；
2. 首样本建基线；
3. 每次数值变化把完整上下文加一次；
4. 按当前模型输入价估算；
5. 不读取 `modelCallId`、输出或缓存精确事件。

额外缺陷：空闲时约 60 秒复查，发现变化后才切到约 3 秒；模型切换会用当前模型价格重算全部累计 Token。1.1.60 没有修正这些问题。

结论：织梦只能作为实时估算 fallback 的参考，不可再作为拾光最终统计架构。

---

## 5. 目标架构：一个 reducer、两层数值、两级校准

### 5.1 统一观测模型

保留各数据源适配器，但所有入口最后收口到一个 reducer：

```ts
type UsageObservation =
  | { kind: 'request-boundary'; runId; composerId; requestId; nativeTurnId?; modelId?; at }
  | { kind: 'context-sample'; runId; composerId; requestId?; used; at }
  | { kind: 'exact-request'; runId; composerId; requestId; nativeTurnId?; modelId; usage; at }
  | { kind: 'exact-turn-checkpoint'; runId; composerId; nativeTurnId; modelId?; usage; at }
  | { kind: 'freeze-run'; runId; at }
```

现有 `record / recordTurnSnapshot / recordRequestSample` 可以暂时保留为薄适配器，内部不再各自累计，也不再维护永久让位集合。

### 5.2 会话状态必须分层

建议最小状态：

```ts
interface CursorSessionUsageV3 {
  composerId: string
  confirmed: UsageBuckets       // 已有精确依据的累计
  provisional: UsageBuckets     // 尚待精确事件替换的估算
  estimatedCostUsd: number      // confirmedCost + provisionalCost
  confirmedCostUsd: number
  quality: 'exact' | 'mixed' | 'estimated'
  requestCount: number
  seenExactRequestIds: string[]
  activeRequest?: {
    id: string
    nativeTurnId?: string
    modelId: string
    contextBaseline?: number
    provisional?: UsageBuckets
  }
  frozenAt?: number
  lastUpdatedAt: number
}
```

UI 总值始终投影为：

```text
display = confirmed + provisional
```

同一 request 的 `exact-request` 到达时：

```text
删除该 request 的 provisional
加入 exact 到 confirmed
```

不是“精确值再加一次”。

### 5.3 数据源优先级

1. **精确请求事件**：最终主数据。
2. **精确 turn checkpoint**：对整个 native turn 做总量校准，补齐遗漏的 request event。
3. **request-boundary + context sample**：只生成 provisional，保证 ≤5 秒可见。
4. 没有请求身份时的纯 `contextTokensUsed` 数值变化：最后 fallback，必须标记 estimated，不能阻止后续精确事件。

---

## 6. 分阶段实施顺序

### 阶段 A：先做一次固定版本运行态探针（不改统计主链）

目标：确认 Cursor 3.6.31 每次模型调用最稳定的身份与精确用量落点。

已知候选：

- `ToolCallStartedUpdate / ToolCallCompletedUpdate / PartialToolCallUpdate` 都带 `modelCallId`；
- 协议还有 `stepStarted(stepId)` / `stepCompleted(stepId, duration)`，可能比工具气泡更完整地覆盖纯文本模型调用；
- `TokenDeltaUpdate(tokens)` 存在，但当前 `AgentResponseAdapter` 对 `tokenDelta` 直接 `break`，它的增量/累计语义尚未实机确认；
- `turnEnded` 有精确四桶，但持续 `check_messages` 的长 turn 中只在真正结束时出现。

探针必须回答：

1. 一个模型 API 调用对应一个 `modelCallId`、一个 `stepId`，还是两者多对多？
2. 纯文本、不调用业务工具的请求是否仍能取得稳定 request ID？
3. `TokenDeltaUpdate.tokens` 是本帧增量、当前请求累计还是别的口径？
4. 在每个 model call 结束位置，是否已经能取得 input/output/cacheRead/cacheWrite 四桶？
5. `turnEnded` 四桶是 native turn 汇总还是最后一次 model call？

**阶段门槛**：只有真实捕获样本证明四桶是“每 request”口径，才实施 `exact-request` hook；否则不要凭字段名猜。

### 阶段 B：先重构 reducer，再接新 hook

改动集中在：

- `src/domain/cursor-usage.ts`
- `src/application/cursor-usage-tracker.ts`
- `src/infrastructure/cursor/cursor-usage-store.ts`

要求：

1. 把“累计账”和“当前 provisional”拆开。
2. 删除 `polledComposers` / `requestSampledComposers` 的永久互斥语义。
3. `contextLastUsed` 只能属于某个 request 的估算状态，不能再充当“永久禁用精确事件”的开关。
4. 保持 UI 现有聚合字段兼容，先不改视觉层；必要时由 tracker 输出旧 `CursorSessionUsage` 投影视图。
5. `applyTurnUsage()` 不再直接操作会话总累计；改成“更新当前 native turn provisional/checkpoint”的 reducer 分支。

### 阶段 C：接入请求身份

优先顺序：

1. 运行态探针证明可靠的 native request ID；
2. `modelCallId`；
3. `stepId + generationId` 合成 ID；
4. 最后才使用本地生成的 provisional ID。

同一个 ID 重放必须幂等。不要再用 `used` 数值本身作为 ID。

CDP 内存态和 `state.vscdb` 落盘态可同时作为同一 request 的观测来源；两者不是互斥账本，只是更新同一 provisional 的不同证据。新证据覆盖旧 provisional，不累计两份。

### 阶段 D：接精确 request hook

若阶段 A 找到每请求四桶落点，扩展：

- `scripts/patch-cursor-usage-hook.ts`
- `src/infrastructure/cursor/cursor-stream-observer.ts`
- `CursorUsageEvent` 契约

binding 载荷至少包含：

```json
{
  "v": 2,
  "composerId": "...",
  "requestId": "...",
  "nativeTurnId": "...",
  "modelId": "...",
  "inputTokens": 0,
  "outputTokens": 0,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "occurredAt": 0
}
```

补丁要求：

- local / cloud 两条路径都覆盖；
- 幂等；
- 原 bundle 备份；
- 锚点数量不符立即中止；
- 固定 Cursor 版本 / bundle SHA 记录；
- `--restore` 实测有效；
- 不把凭据或正文放入载荷。

### 阶段 E：保留 `turnEnded`，改为 checkpoint 校准

现有 turnEnded 不能丢。它应携带 `nativeTurnId/generationId` 并表示该 native turn 的权威汇总。

校准规则：

1. 汇总该 native turn 已确认的 request 四桶；
2. 与 checkpoint 比较；
3. 一致：只标记 turn finalized；
4. checkpoint 更大：写入一条 `reconciliation` 差额；
5. checkpoint 更小或字段冲突：用 checkpoint 原子替换该 turn 的 confirmed 汇总并记录诊断，不做负数累加。

这样即使请求 hook 漏一条，最终仍能回到 Cursor 的精确 turn 总数。

### 阶段 F：修正 run 生命周期

新增明确动作语义：

```text
beginRun(runId)  -> 清零并开始采集
resumeRun(runId) -> 恢复同 run 快照并继续
freezeRun(runId) -> 固定数字并拒绝迟到的普通遥测
```

`freezeRun` 只响应**权威用户结束/新 run 建立**，不要响应：

- 心跳过期；
- Cursor 暂时离线；
- presence 抖动；
- 推导出来的短暂 completed 状态。

冻结后可以接受一个带相同 runId/nativeTurnId 的迟到精确 checkpoint 做最终校准；校准完成后再次持久化，不恢复普通采样。

### 阶段 G：存储升级

继续使用当前小型 JSON 存储即可，先不要为此新建 SQLite 子系统。将 schema 升到 v3，保存：

- runId 与状态（active/frozen）；
- confirmed；
- provisional；
- 当前 request；
- 有界的近期 exact request ID（用于重启幂等）；
- modelId、价格快照和 cost component；
- frozenAt / updatedAt。

写盘继续采用临时文件 + rename。ID 集合设明确上限，例如每 composer 最近 512～2048 条；binding 只推实时事件，不会重放无限历史。

V2 旧账不能伪装成 exact：迁移时标记 `legacyEstimated`，或在下一次 `beginRun` 直接按用户规则清零。不要把当前 117M 当作精确基线带入 V3。

### 阶段 H：价格与费用

继续复用现有 `priceForModel()` 与四桶公式，但必须在每个 request 入账时固化：

- `modelId`
- 命中的 `price.label`
- 牌价快照日期
- 四项成本分量

混合模型只做聚合展示，不得用最后一个模型重新计算历史费用。

实时 context fallback 仍按“旧上下文缓存读 + 新增部分缓存写”估算；输出未知时保持 0，并让 `quality` 显示 mixed/estimated。精确事件到达后替换。

---

## 7. 测试要求：删掉假绿，围绕事件序列

### 7.1 reducer 必测序列

1. `context provisional → 同 request exact`：总量替换，不翻倍。
2. `exact 先到 → 迟到 context sample`：精确值不被覆盖。
3. 同一 `requestId` 精确事件重放两次：只计一次。
4. 两个请求乱序到达：总量正确、时间戳单调。
5. 模型 A 请求后切模型 B：历史成本不重算。
6. context 增长、同值、压缩回落：只更新对应 provisional。
7. request hook 漏一条，turn checkpoint 补差额。
8. checkpoint 小于已累计 request 总和：turn 级原子校准，不产生负桶。
9. 应用重启恢复同 run：同 request 重放不双计。
10. `freezeRun` 后普通采样不再改数；允许同 run 迟到 checkpoint 最终校准。
11. 新 `beginRun` 清空上一 run；旧 run 迟到事件被 runId 围栏拒绝。

### 7.2 删除/改写的旧测试

以下断言不能保留：

- “采样接管后 turnEnded 必须让位”；
- “持久化 contextLastUsed 后精确事件继续让位”；
- “回合快照从 5,000 回落到 500 后会话累计 inputTokens 应变成 500”。

它们是当前根因的自动化固化，不是回归保护。

### 7.3 真实 fixture

从 Cursor 3.6.31 捕获一组脱敏事件序列作为唯一 golden fixture，至少包含：

```text
新用户消息
→ thinking
→ model request A
→ 工具调用（带 modelCallId）
→ model request B
→ check_messages
→ 下一条用户消息
→ turnEnded checkpoint
```

测试必须回放整段序列，断言最终四桶与捕获的 turnEnded 完全一致。不要用几十个彼此脱离的 mock 替代这条主链。

---

## 8. 实机验收门槛

全部满足才可报告完成：

1. 启动新 Team / 独立批次后所有会话显示 0/占位，不继承旧 run。
2. 发送第一条消息后 ≤5 秒出现 Tokens / Cost。
3. 连续至少 5 次快速模型调用，页面 requestCount 与捕获到的唯一 request ID 数一致。
4. 运行中 provisional 平滑增长，无重复跳涨。
5. 精确 request 或 turn checkpoint 到达后，数值只校准一次，不翻倍。
6. 正常结束后 `outputTokens > 0`，四桶与 Cursor 精确载荷一致。
7. 同一会话切换模型后，切换前成本保持不变。
8. 用户显式结束后等待 2 分钟、切换会话、重启拾光，冻结数字不变。
9. 启动下一批次后重新归零。
10. Cursor/CDP 短暂断开并恢复，不丢失已确认账，也不永久禁用 telemetry fallback。
11. `npm run typecheck && npm test && npm run verify:mac` 全部通过。

验收时同时保存：

- 一组真实 binding 载荷（脱敏）；
- reducer 最终状态；
- Cursor turnEnded 四桶；
- 页面显示值；
- 四者对账表。

---

## 9. 建议改动边界

核心实现尽量控制在以下文件，不要扩散：

1. `src/domain/cursor-usage.ts`
2. `src/application/cursor-usage-tracker.ts`
3. `src/infrastructure/cursor/cursor-usage-store.ts`
4. `src/infrastructure/cursor/cursor-stream-observer.ts`
5. `src/main/index.ts`
6. `scripts/patch-cursor-usage-hook.ts`
7. 对应 3～4 个测试文件

UI 第一阶段沿用现有 `CursorSessionUsage` 投影。只有当核心准确性验收通过后，再给 `SessionUsageStat` 增加一个很轻的来源提示（精确 / 校准中 / 估算），不要先动视觉。

---

## 10. 完成定义

本任务不是“又加一种采样源”，也不是“测试全绿”。完成必须同时证明：

```text
实时：≤5 秒可见
身份：按真实 request ID 幂等
准确：精确事件覆盖估算
最终：turn checkpoint 可对账
生命周期：开始清零、结束冻结、重启保持、下轮归零
成本：按事件发生时模型和价格固化
工程：单 reducer 收口，不再堆永久让位条件
```

如果阶段 A 证明 Cursor 3.6.31 没有可取的每请求四桶，也必须完成“request ID 驱动的 provisional + turnEnded 最终 checkpoint 校准”，并把运行中状态明确标记为估算；不得继续把 `contextTokensUsed` 数值变化包装成精确请求数。
