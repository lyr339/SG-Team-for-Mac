# 三大难题评审基线（reviewer / CH-3）

本文档是评审工作底稿：《验证手段清单》+《验收清单》。
前后端产出回报后，reviewer 按验收清单逐项评审并向 lead 提交结论。

## 一、验证手段清单

项目：qingtian-team（Electron + React 19 + TypeScript strict + electron-vite + vitest + zod + node:sqlite）。
分层：domain / application / infrastructure / main / preload / renderer / mcp。

| # | 手段 | 命令 / 入口 | 覆盖范围 | 需要重启群枢？ |
|---|------|------------|----------|----------------|
| 1 | 类型检查 | `npm run typecheck`（tsc --noEmit，strict） | 全部 src / tests / scripts | 否 |
| 2 | 单元与集成测试 | `npm test`（vitest run） | 基线：49 文件 / 333 用例全绿（含 channel-message、team-*、sqlite 仓库、renderer-format 等） | 否 |
| 3 | 前端设计走查（纯浏览器） | `npx vite --port <端口> src/renderer` 后访问 `/preview.html` | renderer 全应用 UI，preload API 全部 mock；支持 query 场景开关：`?setup=1` `?detectedWorkspace=1` `?missingToken=1` `?activeExecuting=1` `?handoff=1` `?offlineSessions=1` `?messageFormat=1` `?runStatus=<状态>` | 否 |
| 4 | 生产构建 | `npm run build`（typecheck + electron-vite build + build:mcp） | 主进程 / preload / renderer / MCP bundle 四类产物 | 否 |
| 5 | MCP stdio 冒烟（构建产物） | `npm run smoke:mcp`、`npm run smoke:channel` | 团队角色 / 通道角色 MCP 全链路（投递→守门→同步→再投递），真实 stdio + 构建产物 + 临时 SQLite | 否（用临时库，不触生产库） |
| 6 | 打包验证 | `npm run verify:mac`（pack:mac + 打包产物冒烟） | 打包后 app 内 MCP bundle | 否（输出到独立 release 目录） |
| 7 | Electron dev 实例 | `npm run dev`（electron-vite dev，renderer 热更新） | 真实 Electron 环境联调 | ⚠️ 会另起 dev 实例；不触碰正在运行的群枢实例，动用前需用户允许 |

评审基线（2026-08-25 06:31 实测）：typecheck 通过；333/333 测试通过；preview.html HTTP 200。

硬约束：未经用户允许不得重启群枢软件。评审验证只走路径 1–6；路径 7 需用户显式批准。

## 二、验收清单

### 难题 1：过程展示（前端 UI + 后端 record_reply 扩展数据链路）

领域契约（已存在于 `src/domain/conversation-entry.ts`）：
`ProcessBlock = ProcessBlockTool | ProcessBlockThinking | ProcessBlockCommand`，挂在 `ConversationEntry.processBlocks`。
现状链路：MCP `record_reply` → `ChannelMessageService.recordReply` → `SqliteChannelMessageRepository`（`channel_replies` 表）→ `ChannelMessageRelay.pollReplies` → `ConversationEntry` → 快照推送 renderer。

后端验收项：

1. `record_reply` 工具 schema 增加可选 `processBlocks` 字段（zod 校验 kind 枚举与必填字段），旧调用不带该字段仍成功（向后兼容）。
2. 数据链路全段贯通：MCP 工具 → service → repository 持久化（新增列或 JSON 列）→ relay 转成 `ConversationEntry.processBlocks` → 快照到 renderer，无断点。
3. 持久化可靠：过程区块随回复落库，应用重启后可恢复、不丢失。
4. 大小防护：processBlocks 有条数与序列化体积上限，超限行为明确（报错或截断，二选一并写明）。
5. 单测覆盖：repository 存取回环、relay 转换、MCP schema 校验（含拒绝坏输入）。

前端验收项：

1. 三类区块完整渲染：tool（工具名 / 摘要 / 状态 / 错误）、thinking（文本 / 状态）、command（命令 / 输出 / exitCode）。
2. 状态可视：running 有运行中动效；done / failed 明确区分；failed 展示 error 文本。
3. 可展开明细：input / output 可折叠展开；长输出限高滚动，不撑爆消息气泡。
4. 与既有 `CursorProcessPanel`（transcript 侧过程）层级清晰、不重复展示；processBlocks 归属对应消息气泡。
5. 旧消息（无 processBlocks）渲染不回归。
6. preview.html 浏览器走查通过（含 mock 数据各场景），控制台无报错。

### 难题 2：输入框附件上传

领域契约：`MessageAttachment { id, name, mimeType, size, data?, path?, previewUrl? }`，挂在 `ConversationEntry.attachments`；发送签名 `onSend(text, attachments?)`。

验收项：

1. 入口：`ComposerWorkbench` 输入框提供附件添加入口（按钮 / 拖拽 / 粘贴，至少其一，按实现声明验收）。
2. 格式白名单：图片（png / jpeg / gif / webp）+ 常见文档文本类；可执行等危险类型拒绝并给出明确错误文案。
3. 大小与数量限制：单文件大小上限（实现需声明具体值）与单次附件数量上限（不超过 record_reply files 的 32 条上限）；超限在前端拦截并提示，不进队列。
4. 待发送展示：附件 chip 显示名称 + 格式化大小；图片显示预览；发送前可移除单个附件。
5. 发送链路：附件随消息进入出站队列并可被 Agent 侧感知；pending / failed 状态语义与纯文本消息一致。
6. 时间线回显：用户消息气泡渲染附件（图片缩略图 / 文件卡片含名称与大小）。
7. 类型检查通过；格式化与校验逻辑有单测。

### 难题 3：价格显示（模型定价表 + 计算口径）

领域契约（`src/domain/session-token-usage.ts`）：
`TokenPrice { label, inputPerMillionUsd, outputPerMillionUsd }`；`tokenPriceFor(modelName, options)`；`estimateTokenCost(input, output, price) = (input × inPrice + output × outPrice) / 1_000_000`。
展示口径（`src/renderer/src/format.ts`）：`formatEstimatedCost` 统一出口（< $0.01 四位小数，< $1 三位小数，否则两位；undefined → 「价格未知」），展示一律带「估算」字样；数据缺失时显示「Token 待采集」。

验收项：

1. 定价表集中维护于 `tokenPriceFor`，UI 与任何其他模块不得另写价格常数。
2. 模型匹配：名称归一化（小写、非字母数字转空格）+ `fast` 选项分支；未知名称返回 undefined，UI 显示「价格未知」，不得显示 $0 或报错。
3. 计算口径：仅本地估算（`source: 'local-estimate'`），输入 / 输出分开计价后相加，单位 USD / 1M tokens；展示保留「估算」标识，不得冒充账单数字。
4. 费率正确性：逐条核对定价表与官方公布价格一致；新增模型必须走同一出口并有匹配测试。
5. 单测覆盖：各模型匹配分支、fast 分支、未知模型、estimateTokenCost 计算与 formatEstimatedCost 档位。
6. UI：`tokenUsage` 缺失时显示「Token 待采集」，不显示误导性价格。

---

## 三、第一轮评审记录（前端渲染层 + 附件上传，2026-08-25）

评审范围：`conversation-entry.ts`、`desktop-api.ts`、`ProcessBlocks.tsx`、`SessionWorkspace.tsx`、`ComposerWorkbench.tsx`、`App.tsx`、`styles.css`。
验证手段：typecheck ✅、vitest 339/339 ✅、preview.html 浏览器实测（含实际上传 2 个文件交互）✅。

### 难题 1 过程展示 UI：基本达标，1 个中等问题 + 2 个清理项

通过项：三类区块渲染（tool/thinking/command）完整；running 脉冲、failed 红色调与 error 区块、command 失败带 exitCode；明细可展开且 `pre` 限高 200px 滚动；与 CursorProcessPanel 数据源和视觉位置不重复；无 processBlocks 的旧消息渲染不回归。

- **[中] ThinkingBlock 展开后思考全文显示两遍**：`process-head` 内 `expanded ? block.text : preview` 已是全文，展开的 `process-details` 里又渲染一次 `process-thinking-full`。修复：展开时头部保持折叠预览，全文只留 details 区。
- **[低] `formatFileSize` 重复定义**：`ComposerWorkbench.tsx` 与 `SessionWorkspace.tsx` 各一份。项目惯例是格式化函数在 `format.ts` 唯一出口，应收编。
- **[低] `styles.css` 过程样式重复定义且不一致**：`.process-details` / `.process-detail-section` / `.process-thinking-full` / `.process-pulse` 在 744-751 与 1194-1204 两处定义，`word-break`（break-word vs break-all）、颜色（硬编码 `#b04a3d` vs `var(--red)`）不一致。级联后功能正常，需去重合并。

### 难题 2 附件上传：展示与交互达标，校验与防护缺失，判返工

通过项：附件按钮入口可用；浏览器实测上传 png + txt 后 chip 正确展示（图片缩略图 / 文件图标 + 名称 + 格式化大小 + 移除按钮）；发送按钮支持纯附件（无文本）发送；发送成功后附件清空；时间线回显代码就位（图片缩略 / 文件卡片）。

- **[阻塞] 无大小限制**：`readFileAsAttachment` 直接 `readAsDataURL` 读全文件进 base64 内存，任意大小文件无拦截。违反验收项 2.3。
- **[阻塞] 白名单无二次校验**：仅靠 `<input accept>` 软约束，文件选择器切「所有文件」即可绕过；`handleFileSelect` 未校验 mimeType / 扩展名，无拒绝文案。违反验收项 2.2。
- **[阻塞] 无数量上限**：可无限添加，未对齐 32 条上限。违反验收项 2.3。
- **[低] 读取失败仅 console.error**：用户无任何可见提示，应进 `sendError` 或等价错误位。

### 走查附注

- 价格显示顺带验证通过：mock 会话 Fable 5（$10/$50 per 1M）输入 118,400 + 输出 16,800 = $2.024，UI 显示「估算 $2.02」，口径正确。
- `preview/mock-data.ts` 未覆盖 processBlocks / attachments 场景，新组件在设计走查入口无法目验，要求补 mock 场景（验收项 1.6 / 2.7 的支撑）。
- 前端未新增 renderer 侧单测（新增 6 个测试均在后端文件：channel-message-relay / sqlite 仓库 / mcp 集成 / session-token-usage）。

### 结论

难题 1：条件通过（修复 ThinkingBlock 重复渲染后可过）。难题 2：不通过，需返工补齐三项防护（大小上限 / 白名单二次校验 / 数量上限）与错误提示。后端链路（record_reply 扩展落库与 relay 投影）正在由后端成员实现，打通后进行第二轮全链路评审。

---

## 四、第二轮评审记录（全链路 + 定价 + 团队人数，2026-08-25）

验证手段：typecheck ✅、vitest 341/341 ✅（与 lead 自报一致）、定向 5 测试文件 34/34 ✅、`npm run build` + `smoke:channel`（真实 stdio + 构建产物 + 临时库）✅、preview.html 临时注入 mock 数据实测渲染（已回滚，回滚后 341 全绿）✅。

### 难题 1 全链路（record_reply process → ProcessBlocks 渲染）：通过

- MCP schema：`z.discriminatedUnion('kind')` 三类区块与 domain 完全同构；大小上限明确（output/text 4000、error 2000、summary 300、command 500、数组 ≤200 条）；`process` 可选，旧调用向后兼容；返回 `processBlocks` 计数。
- 持久化：`channel_replies.process_json` 新列 + 老库 `ALTER TABLE` 增量迁移；`processBlocksOf` 防御性解析，脏数据不拖垮读取；仓储层 `slice(0, 200)` 二次防护。
- relay 透出：`pollReplies` → `ConversationEntry.processBlocks` → 快照，无断点。
- 渲染实测（临时 mock 注入）：三类区块在消息气泡内正确渲染；失败工具红色调 + 错误区可展开；40 行命令输出限高滚动不撑爆气泡；长思考折叠；running 脉冲正常。
- 测试：集成测试真实 stdio 覆盖三类区块归档回环 + schema 拒绝坏输入；relay 测试覆盖透出。
- 遗留（第一轮已报，本轮复查仍未修，不阻塞链路验收）：ThinkingBlock 展开全文显示两遍；formatFileSize 双处重复；styles.css 过程样式两段重复。

### 难题 3 价格显示：通过

- `tokenPriceFor` 唯一出口，UI 无价格常数；Kimi K3 $3/$15 与 Claude Opus 4.8 $5/$25 双形态（slug / 显示名）均命中；既有 slug 回归断言齐全（grok / gpt / composer / opus 5）。
- 未知模型返回 undefined → UI「价格未知」，测试断言 `estimateTokenCost` 为 undefined；「估算」标识保留（formatEstimatedCost 未动）。
- 计算口径精确：1M 输入 + 100K 输出 × K3 费率 = $4.5 断言通过；走查实测 Fable 5 $2.02 与 $10/$50 口径吻合。

### 问题六 团队人数可指定：通过（附 1 个低优先观察项）

- 步进器 −/+ 与数字输入，界内 1..16（MAX_TEAM_MEMBERS）；增员优先占用未上岗通道、不足时从 max+1 合成新数字通道号并跳过占用；减员正确维护选中席位。
- `team-setup.ts` 放行 `/^\d{1,12}$/` 新数字通道为离线备用通道，非数字 / 重复仍拒绝；测试覆盖三种情形。
- [低] 观察项：成员数上限 16 仅前端约束，服务端 `resolveTeamSetupMembers` 无数量上限防御；桌面端是唯一入口时风险低，建议服务端补一道。

### 难题 2 附件上传（全链路复查）：不通过，阻塞升级

第一轮三项防护（大小上限 / 白名单二次校验 / 数量上限）复查仍未实现。本轮新发现主进程链路三处断裂：

- **[阻塞] IPC 边界剥离附件**：`register-session-ipc.ts` 的 `sendInputOf` 只返回 `{ channelId, text }`，`attachments` 在 renderer→main 边界即被丢弃。
- **[阻塞] 纯附件消息被主进程拒绝**：`relay.sendMessage` 对空文本抛「消息不能为空」，与前端「允许纯附件发送」按钮逻辑直接冲突，用户会收到报错。
- **[阻塞] 附件不入队不回显**：`enqueueOutbound` 只存文本，`appendEntry` 不携带 attachments，附件静默丢失。

归属建议：主进程链路（IPC 透传 + relay + outbox schema）尚无明确 owner，请 lead 指派；前端 renderer 部分待三项防护补齐后可复验。

---

## 五、第三轮评审记录（问题四启动状态 + 问题五在线误判，2026-08-25）

验证手段：typecheck ✅、vitest 349/349 ✅、`npm run build` + `smoke:channel` + `smoke:mcp`（真实 stdio 构建产物）✅。

### 问题四 TeamRun 启动状态：通过

- 修复正确：`recordInstallation` 的 UPDATE 增加 `WHERE status IN ('draft','ready')` 守卫，launching / running 不再被回置，`launched_at` 只在未启动时清空；注释写清状态撕裂根因（check_in 白名单不含 ready vs 消息通道不校验 run 状态）。
- 测试语义强且直击真实事故：install → beginLaunch（launching）→ 安装批次重登记 → 状态保持 launching、`launchedAt` 保留 → check_in 正常推进 acknowledged。既有「未启动拒绝 check_in」护栏测试保留，未放松。

### 问题五 在线状态误判：通过（三层 + verify 降级全部成立）

- ① 分相活性：`CHANNEL_PROCESSING_STALE_MS` 30min（processing / need_reply_sync）vs `CHANNEL_PRESENCE_STALE_MS` 120s（waiting / keepalive）；relay 按 `isProcessingPhase` 分相取阈值，语义注释清晰（证据缺失 ≠ 死亡证据；声称矛盾才严格）。测试双边界：processing 超 120s 保持在线、超 30min 判离线；waiting 超 120s 判离线。
- ② record_reply 新鲜度：`RECENT_TRANSCRIPT_GRACE_MS` 30s 落盘窗口内判 active、窗口外判 stopped；双侧测试覆盖；通道级信号（`channelActivityFromSignals`）同口径。
- ③ 统一服务器通道识别：`channelIdFromToolInput` 依序取 server → namespace → `arguments.channel_id`（`/^\d{1,12}$/` 校验）；`user-qunshu` + `channel_id` 形态有测试；`GetDynamicTools` 正确跳过（发现工具 ≠ 动作）。
- verify 层 waiting 竞态：传输存活时 `unverifiedSession` 降级标注（「时序差」），传输死亡仍判 stopped——两个测试夹住边界。

### 附带领域变更（不阻塞，团队需知晓）

- `estimateTextTokens` 口径修正：CJK 表意文字按约 1 token/字（Han/Hiragana/Katakana/Hangul），其余按 UTF-8 字节 /4；旧纯字节口径把中文低估一半以上。中文会话的 token 与价格估算会相应上升，属有意的精度修正而非回归；「估算」标识兜底，定价表层正交不受影响。

### 待办

- 前端附件三项防护返工完成后复验（截至本轮复查仍未交付）。
- 第一轮遗留清理项仍未修：ThinkingBlock 展开重复、formatFileSize 双处重复、styles.css 过程样式两段重复。

---

## 六、附件链路后端段复验（2026-08-25）

验证手段：typecheck ✅、vitest 355/355 ✅（lead 自报 352，实测期间又有新增）、代码逐段走查。

### 第二轮三处断点全部修复：通过

- **断点① IPC 边界**：`sendInputOf` 透传 attachments，`attachmentOf` 做结构化校验（name/mimeType 必填字符串，畸形条目静默丢弃，size 兜底 0）。
- **断点② 纯附件契约**：`relay.sendMessage` 改为 `!text && !attachments?.length` 才拒绝，与前端「文本或附件至少其一」按钮逻辑对齐；测试覆盖纯附件从输入框到出站队列与时间线。
- **断点③ 持久化与透出**：`channel_outbox.attachments_json` 新列 + 老库 `migrateColumn` 增量迁移 + 防御性解析；`appendEntry` 透出 attachments 到时间线条目。

### 防护与上下文安全：通过

- 上限常量集中在 domain（8 个 / 单文件 2MB / 合计 8MB / 路径引用 >20MB 仅路径），`prepareAttachments` 超限抛清晰中文错误；文件名消毒（路径分隔符→`_`，120 字符截断）。
- base64 小文件落盘 `channel-attachments/<messageId>/`，清 data 留 path；path 引用不复制；previewUrl ≤4MB 保留或为图片重建——base64 不进 Agent 上下文。
- 投递清单 `buildAttachmentManifest` 追加在原文之后、系统后缀之前：名称（mimeType · 大小）→ Read 工具路径；无路径无 data 时诚实标注「仅元信息」。
- 测试：relay 层覆盖落盘 + 透出 + 纯附件 + 三项上限拒绝且队列无残留；集成测试真实 stdio 覆盖投递清单内容与 base64 防爆断言。

### 观察项（低，不阻塞）

- `attachmentSizeLabel`（channel-delivery-policy.ts）成为第三处文件大小格式化实现（renderer 两处 + domain 一处）；跨层无法直接复用，建议注释互相指向或后续抽到 shared。

### 问题二终验待办

前端三项防护（大小预检 / 白名单二次校验 / 数量上限提示）+ preview mock 附件场景 + renderer 单测交付后，做完整全链路终验（renderer→IPC→relay→outbox→投递清单→Agent Read→时间线回显）。

---

## 七、终验记录（问题二全链路 + 前端返工 7 项，2026-08-25）

验证手段：typecheck ✅、vitest 355/355 ✅、`npm run build` + `smoke:channel` ✅、preview.html 浏览器交互实测（文件上传拒绝路径、草稿切换持久、DOM 断言）✅、控制台无错误 ✅。

### 问题二 附件上传 全链路终验：通过

- 类型二次校验实测：`.bin` / `.exe` 拒绝，逐文件文案「类型不支持」，`role=alert` 用户可见（不再只 console.error）。
- 单文件超限实测：2.5MB png 拒绝，文案含「超过单文件 2.0 MB 上限」并引导工作区路径引用（与后端错误语义对齐）；同批合法文件正常进 chip（混合接受/拒绝正确）。
- 数量 8 个 / 合计 8MB 上限：代码审查确认（quotaLeft 切片 + 合计校验），与后端 `CHANNEL_ATTACHMENT_MAX_*` 同值兜底。
- 链路全段贯通：renderer chip → IPC `attachmentOf` 透传 → relay `prepareAttachments`（落盘/上限/文件名消毒）→ outbox `attachments_json` → 投递清单（base64 防爆）→ 时间线回显。
- 纯附件消息前后端契约一致（按钮逻辑 = relay 守卫）。
- preview mock 已覆盖 processBlocks + attachments 场景，设计走查可目验。

### 前端返工 7 项复验

1. ✅ 三项防护（上述实测）。
2. ✅ ThinkingBlock 重复渲染修复：DOM 实测展开后 head 恒为 120 字截断预览，全文仅在 details 出现一次。
3. ✅ formatFileSize 收编 format.ts 唯一出口，两处改为引用。
4. ⚠️ styles.css 去重「基本达标、有残留」：`.process-details` 家族已合并为唯一块（限高 200px / break-word / 变量颜色 / 错误标题色保留），但 706-742 与 1170-1199 两块仍存在重叠选择器（`.process-action` / `.process-summary` / `.process-status` / `.process-pulse` 等），值有微妙分歧（状态徽章背景色来自前块、文字色被后块覆盖）。视觉走查正常，建议后续彻底并块。
5. ✅ preview mock-data 补 processBlocks（thinking/tool/command/失败工具）与 attachments（图片预览 + 路径引用）。
6. ✅ 问题八草稿保留：draft + attachments 提升 App 层按 channelId 保存；实测 CH-2 草稿+附件切 CH-1 再切回不丢失、CH-1 隔离为空；发送成功后清空对应通道（代码确认）。
7. ✅ formatContextUsage 的「万」改 K/M/B：formatContextTokenCount 委托 formatTokenCount 统一出口。

### 当前全部结论汇总

| 项 | 结论 |
| --- | --- |
| 难题 1 过程展示（UI + 数据链路） | 通过 |
| 难题 2 附件上传（全链路） | 通过 |
| 难题 3 价格显示（定价表 + 口径） | 通过 |
| 问题四 TeamRun 启动状态 | 通过 |
| 问题五 在线状态误判 | 通过 |
| 问题六 团队人数可指定 | 通过（低：服务端人数上限防御建议） |
| 问题八 草稿保留 | 通过 |

残留低优先清理：styles.css 过程样式重叠选择器并块；attachmentSizeLabel 第三处实现互相指向或抽 shared。

---

## 八、流式过程展示全链路评审（record_process，2026-08-25）

验证手段：typecheck ✅、vitest 370/370 ✅（与自报一致）、build ✅、smoke:mcp / smoke:channel ✅（record_process 在构建产物工具清单）、preview 走查（live mock 场景）✅、控制台 0 错误。

### 后端：通过（从严逐项）

- schema：turn（1-120）+ block 复用 processBlockSchema（与 record_reply process 同构）；`idempotentHint: true` 与 upsert 语义一致；工具描述完整覆盖 turn 生命周期。
- upsert：`UNIQUE(channel_id, turn, block_id)` + `ON CONFLICT DO UPDATE`，翻转行不增（集成测试实测 1→1）；seq / created_at 保留、updated_at 前进。
- 防护：未归档 500 上限拒绝并引导 record_reply；已归档 10min TTL 写入时顺手清理；live 查询有匹配索引。
- 归档：record_reply 带同 turn 于同事务 `archived=1`；replies 表 turn 列 + 老库迁移。
- relay：fingerprint（turn:count:updatedAt）门控不空推；取最新活跃 turn；归档后 live 消失 + emit；resetScope 清空；时间线重建 reply.process 优先、否则按 turn 重建，零缺损（两条路径均有测试）。

### 渲染（lead）：通过

- live 气泡位于时间线底部，chat-row 结构 + 头像 +「实时过程中」徽标（pulse）走查确认；复用 ProcessBlocks，live 与归档视觉一致（贴近原生）；preview mock live 场景（done 搜索 + running 思考）就位。

### 基座规则「过程上报纪律」：通过（附观察项）

- turn 分配 / 动作后上报 / ≤4000 自截断 / record_reply 带 turn 归档 / 直带 process 优先——与实现逐条吻合；旧构建无 record_process 优雅跳过 ✅。
- [低] 观察项：已在线会话的规则副本是启动时快照，不含新纪律；新纪律只对规则重载后的会话生效，与「旧构建跳过」条款互补，不影响正确性。

### record_process 刷 presence 与问题五闭环：通过

- recordProcess → touchPresence(processing) → 30min 分相宽限：长任务期间持续上报即持续保鲜，与 waiting 相 120s 严格判定解耦——问题五修复设计的活性来源闭环成立。

### 从严非阻塞项

- [低] fingerprint 由 turn/count/updatedAt 组成：同毫秒内容变时理论漏一次 emit，下一秒轮询自愈，可接受。
- [建议] live 徽标可带过程块计数（「实时过程中 · N 块」），纯增强。
