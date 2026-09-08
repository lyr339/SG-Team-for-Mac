# 接手待办：团队席位接入「会话上下文交接」

> **状态（2026-09-08）：阶段 A–D 已全部落地（工作树，未提交）。** 与下文原方案的有意偏差：
> - 阶段 A 团队席位的开放口径改为与独立席位一致：`activeRun.status !== 'completed'` 即开放上下文交接
>   （含 draft / ready 未 launch 但已一键创建会话的情形）；只有「团队席位 + 离线 + running/attention」
>   才走职责迁移。三态判定收口在 `src/renderer/src/handoff-entry.ts`。
> - 第 1.3 条的开放问题已关闭：`snapshot.sessions` 由 `channel_links.embedded=1` 的全部通道重建，
>   备用通道一定在内，弹窗不需要另传 standby 会话；只传 `standbyChannelIds` 用于标注与排序。
> - 阶段 B 的团队接收方说明除「不是任务板任务」外，还显式解除角色简报「不要读取或复述 Cursor
>   历史聊天」对本次读取的约束，并禁止据此 plan / claim / broadcast / 上报——否则模型会拒读转录
>   或把「接续上下文」当成开工指令。接收方是否团队席位按**目标通道**此刻的角色判断（备用通道不附）。
> - 阶段 D 不能按「迁移成功后再调 deliverSessionHandoff」实现：`rebindSlot*` 会把原席位绑定的
>   channel_id 改成接手通道并清空 composer_id，迁移后 `context(原通道)` 已定位不到转录。改为主进程内
>   编排 `src/application/manual-handoff-with-context.ts`：迁移前解析上下文 → 迁移 → 用预解析上下文
>   投递接手通道；`manualHandoff` IPC 入参扩展 `includeContext`（不新增 IPC 通道），投递失败不回滚
>   迁移，结果在 `contextHandoff` 里由迁移弹窗结果页展示。
> - 已知限制（按用户偏好保留手动语义，不做自动转投）：团队席位选「本会话（等待新会话）」后若被
>   `TeamFailoverService` 自动接替，保持位消息留在原通道队列——备用接管清空令牌取不到、原通道在本轮
>   已无席位，之后也无法再从该通道解析上下文文档。用户可在原通道会话页撤回这条消息；要把上下文交给
>   接手者，应在席位离线后走「交接」→ 职责迁移弹窗并勾选「同时交接上下文文档」，而不是等自动接替。
>
> 状态（2026-09-04）：待办，未动工。独立席位的上下文交接已在 `47d261f` 落地并提交；
> 本文档只覆盖把同一能力扩展到团队席位（lead / builder / reviewer / …）的工作。
>
> 项目：拾光 / SG Team（`shiguang-team`） · 工作区：仓库根目录
>
> 基线：`37253bf`（含独立席位交接、队列保持位协议、图片附件查看器）

## 0. 接手人先读

### 0.1 现状：同一个「交接」按钮，两套语义

| 席位 | 按钮行为（`src/renderer/src/App.tsx` `onHandoff`） | 实现 |
| --- | --- | --- |
| 独立席位（`roleTemplateKey === 'solo'`） | 打开 `SessionHandoffDialog`：定位 Cursor 转录 → 投递到本会话（等待新会话）/ 其他会话 | `SessionHandoffService`（application）+ `session-handoff.ts`（domain） |
| 团队席位 | 仅当成员**离线**且 run 为 running/attention 时可用：打开 `ManualHandoffDialog`，把 AgentSlot 迁移给在线的备用/成员通道（`role_rebind` / `lead_authority`） | `TeamHandoffService` + `TeamFailoverService`（`team-handoff.ts` domain） |

团队席位**在线**时按钮是灰的（title：「当前会话无需交接或没有有效团队角色」）。用户诉求：在线团队席也能做上下文交接。

### 0.2 已经可以直接复用的部件

- `SessionHandoffService.context(channelId)` / `deliver(request)`：与角色无关，按通道工作；只依赖 `team.bindings`（composerId、sessionToken）与 `relay.conversationsOf`。团队席位调用它**不需要改后端**。
- 「等待新会话」保持位（`channel_outbox.hold_session_token`）对团队席位同样成立：团队 launch 不轮换令牌、换席重建（`prepareComposerRelaunch`）轮换令牌、standby 接管清空令牌（见 `docs/ARCHITECTURE.md` 会话围栏一节）。
- `SessionHandoffDialog` 的候选列表来自 `snapshot.sessions`，已经包含团队通道。

### 0.3 明确排除

- 不合并两套语义为一个弹窗里的「模式切换」——离线职责迁移改变的是 AgentSlot/任务/主控权，上下文交接只是排一条消息；混在一起会让用户搞不清点下去发生了什么。
- 不改 MCP 工具面、不改 team_check_in 简报格式。

## 1. 要解决的具体问题

1. **入口**：团队席位在线时也需要可点的「交接」，且与离线职责迁移区分开。
2. **接收方是团队席位时的语义**：团队席位的 Cursor 会话开场是 launch hint → `team_check_in` → 简报。交接消息作为普通用户消息经 `check_messages` 投递，模型收到时已经是团队角色，会按简报流程工作（team_check_in 已随简报返回上下文快照，再处理收件箱）。交接消息里的「读转录后向用户确认已接手」与团队协议里「只有处理真实用户消息才 record_reply」不冲突（这就是一条真实用户消息），但需要在消息里明确它**不是任务板任务**，避免主控把它当成要拆解的目标。
3. **目标选择**：团队 run 里其他通道是有角色的成员。把实现席的上下文投给验收席通常没有意义；候选列表应显示角色名，并把「同角色 / 备用通道」排前面。备用通道（standby，未编入本轮的在线 MCP 通道）目前不在 `snapshot.sessions`？——需核实 `TeamControlSnapshot.standbyChannels` 与 `DesktopSnapshot.sessions` 的交集，缺则补。
4. **与失效接管的关系**：成员离线时，用户可能既想迁移职责（现有），也想把上下文一并交给接手者。最小方案：`ManualHandoffDialog` 确认迁移后，追加一步「同时把原席位的上下文文档投递给接手通道」（复选框，默认勾选，复用 `deliverSessionHandoff({ target: { kind: 'channel', channelId: 接手通道 } })`）。这样离线路径一次点击完成两件事，在线路径走独立的上下文交接弹窗。

## 2. 实施建议（按依赖顺序）

### 阶段 A：入口与文案

- `App.tsx`：`onHandoff` 分流改为三态——
  - 团队席位 & 成员离线 & run 活跃 → `ManualHandoffDialog`（现状）；
  - 团队席位 & 其他情况（在线 / run 已 launch）→ `SessionHandoffDialog`；
  - solo → `SessionHandoffDialog`（现状）。
- `handoffTitle` 对应三种说明。`ComposerWorkbench` 不需要改。

### 阶段 B：交接消息的团队变体

- `src/domain/session-handoff.ts` `buildSessionHandoffMessage` 增加 `sourceRole?: { name: string; templateKey: string }` 与 `targetIsTeamSeat?: boolean`：
  - 标题带角色：`【会话交接】来自 CH-2（架构实现 · 实现席 · Claude Opus）`；
  - 团队接收方追加一句：「这是用户发起的上下文交接，不是任务板任务；读取后不要 team_task plan 拆任务，也不要向主控上报为进度」。
- `SessionHandoffService.context()` 从 `team.members` 补出 `roleName / templateKey`（按 channelId 找 member）。

### 阶段 C：候选排序与备用通道

- `SessionHandoffDialog` 的 `others` 排序增加「同角色模板优先、standby 其次、再按在线/待命」。
- 若 `standbyChannels` 不在 `snapshot.sessions`，在 `SessionHandoffDialog` props 里另传 `standby: TeamRuntimeChannelView[]`（来自 `teamControl.standbyChannels`），投递仍走 `sendMessage`（standby 通道已 embedded 即可入队）。

### 阶段 D：离线迁移附带上下文（可选）

- `ManualHandoffDialog` 增加复选框「同时交接上下文文档」；确认后在 `confirmManualHandoff` 成功路径里调用 `deliverSessionHandoff`。失败不回滚迁移，只提示。

## 3. 测试要求（事件级）

1. `App` 分流：同一会话在 online/offline × solo/team 四种组合下按钮 title 与打开的弹窗正确（`tests/session-workspace.test.tsx` 或新建 `tests/app-handoff-entry.test.tsx` 静态渲染）。
2. `buildSessionHandoffMessage` 团队变体：含角色、含「不是任务板任务」提示；solo 变体不含。
3. `SessionHandoffService.context()` 对团队通道返回 roleName/templateKey；对 solo 不变。
4. 候选排序：同角色 > standby > 在线待命 > 在线忙碌 > 离线。
5. 阶段 D：迁移成功后 `deliverSessionHandoff` 被调用且目标 = 接手通道；迁移失败时不调用。

## 4. 验收

- 团队 run 中任选一个在线成员，点「交接」能看到上下文弹窗，投递到另一成员后，对方在下一次轮询收到消息并阅读，且**没有**创建任务板任务。
- 成员离线时，「交接」仍先走职责迁移；勾选附带上下文后接手者队列里多一条交接消息。
- `npm run typecheck && npm test` 全绿；不引入新的 IPC。

## 5. 关键文件

- `src/renderer/src/App.tsx`（`onHandoff` / `handoffTitle` / `SessionHandoffDialog` 挂载）
- `src/renderer/src/SessionHandoffDialog.tsx`
- `src/renderer/src/team/ManualHandoffDialog.tsx`
- `src/domain/session-handoff.ts`、`src/application/session-handoff-service.ts`
- `src/domain/team-handoff.ts`、`src/application/team-handoff-service.ts`
- `tests/session-handoff.test.ts`、`tests/session-handoff-service.test.ts`、`tests/session-handoff-dialog.test.tsx`
