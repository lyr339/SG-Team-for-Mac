# 接手待办：账号与 Cursor 页 → 左侧导航设置页（方案 A）

> **状态（2026-09-08）：设置页已接入，已完成测试迁移与浏览器走查；尚未打包实机验收。**
> 进度更新：五分组常驻保留草稿；离开账号组清除删除/重启确认；hash 恢复与变更同步；预览引入 settings.css；删除旧 LobbyAccountTile 与无引用时间轴样式。原状态测试迁入 settings-page.test.tsx，新增导航/草稿/确认测试。未改后台服务或执行真实账号操作。下文保留原调查方案供追溯。 方向已经用户确认为「方案 A：左侧导航标准设置页」；
> 本文档由 CH-2 独立席位于 2026-09-08 完成端到端只读调查后编写，业务代码零变更。
> 供任意接手 Agent 自包含理解任务，**无需重新侦察**。
>
> 项目：拾光 / SG Team（`shiguang-team`）
>
> 工作区：仓库根目录（macOS / Windows 均可）
>
> 调查基线：`70fc274 Fix Cursor delivery hydration and restart continuity`
> （另有 26 项未提交改动：窗口布局 `ResizableColumns` / `window-layout.ts`、
> 模型供应商 Logo（`ModelProviderLogo.tsx` + `assets/model-logos/`）、主题 surface 等，
> 与本任务正交——**接手前先 `git status` 确认归属并保护，不要覆盖**）
>
> **与 `.handoff/HANDOFF.md` 的关系**：HANDOFF.md 是「会话过程流 P0 全链路修复」的权威交接书，
> 优先级高于本任务。两任务触碰的文件不相交（P0 在会话过程链，本任务在账号设置页），
> 但都经过 `src/renderer/src/App.tsx`——若 P0 正在改 App.tsx，本任务等其合入后再动工。

***

## 0. 接手人先读

### 0.1 用户诉求（原始需求）

1. 顶栏右上角头像入口打开的「账号与 Cursor」页（用户称其为「Cursor 账号管线页」），
   整体前端设计过于粗糙，布局样式不精致。
2. 把它做成**设置页**。方向已选定：**方案 A —— 左侧分组导航 + 右侧内容面板**的标准设置中心
   （参考 macOS 系统设置 / Cursor 自身设置页的心智模型）。
3. 用户明确警告：「这里是很长的一条长链，怕你破坏逻辑，之前搞了很久」——
   **逻辑正确性优先于视觉收益**，实施纪律见 0.3。

### 0.2 任务范围

- 重做 `activeModule === 'account'` 时的页面：单张超长卡片 → 左侧导航 + 右侧分组内容。
- 管线运行状态（倒计时 / 实时消息 / 失败）从「布局主轴」降级为「自动化分组内的顶部横幅」，
  非活跃时完全不占位。
- 视觉规格对齐 `docs/DESIGN-SYSTEM.md`（边框优先、圆角 9-17px、状态色仅表状态、正文炭灰）。

### 0.3 实施纪律（本任务的最高优先级）

1. **`accountPanel` props 面保持不变。** `App.tsx` 里约 200 行的 props 组装（41 个 props）
   是全部刷新联动的中枢，一个字符都不改。新组件树整体接收这个 props 包，组内自取所需字段。
2. **不改任何 useEffect / 回调 / IPC 调用 / 领域函数。** 本任务只动「展示层重排」：
   JSX 结构、组件文件归属、CSS。应用层、主进程、preload、IPC 面全部冻结。
3. **纯函数导出路径保持可用。** `accountFlowStatesFor` / `accountStatusLineFor` /
   `accountMembershipPlanFor` / `automationDurationText` / `automationFailedStepHint` /
   `isActiveAutomationPhase` 当前从 `lobby/LobbyAccountTile.tsx` 导出并被测试直接 import；
   迁移文件后保留 re-export 或同步改测试 import（二选一，不要两边都断）。
4. **运行态 disabled 判定共用同一 `phase` 源。** `isActiveAutomationPhase(phase)` 当前散布在
   十余个按钮的 disabled 上；拆组后从同一 props 读取，禁止各组自行推导相位。
5. **`lastActiveStep` 保持 render 期派生 state 模式**（React 官方模式），不要改成 useEffect。
6. 每个阶段通过测试 + 预览截图后再进下一阶段；禁止一次堆入多个互相补偿的条件分支。

### 0.4 明确排除

- 不改 MCP 工具面、不改 IPC、不改主进程与应用层任何文件。
- 不收编顶栏「外观设置」弹层（用户选择了纯方案 A；外观仍留在顶栏齿轮里）。
- 不重设计奥仔 / 自动化的业务语义与文案契约（按钮 title、错误消息原文保留）。
- 不动会话页、运行页、大厅的其他部分。

***

## 1. 现状：为什么它读起来「粗糙」

### 1.1 信息架构错位（根因）

当前页面 = 一个 `LobbyAccountTile`（792 行）渲染在 `configuration-panel` 里，
用左侧编号时间轴（1→5，`flow-step`）把 **7 类性质完全不同的内容**串成「管线」：

| 内容 | 性质 | 现状位置 |
|---|---|---|
| 账号列表（选择/删除/切换并重启） | 高频管理操作 | 步骤 1「获取 Token」内 |
| 账号导入（指纹/系统浏览器/本机/手动 4 入口 + 手动表单） | 中频操作 | 步骤 1 内 |
| 浏览器来源（宿主切换 / Roxy Key / 执行窗口 / 环境清理） | 稳定设置项 | 步骤 1 内（`AccountBrowserPanel`） |
| 自动化开关 + 处理前/加固前倒计时滑杆 | 稳定设置项 | 步骤 2「倒计时」 |
| 奥仔卡密 / 余额 / 单账号处理 | 第三方服务 | 步骤 3「奥仔处理」 |
| 管线运行状态（倒计时数字 / live 消息 / 失败原因） | **瞬时运行时状态** | 步骤 2-5 |
| Cursor 本机维护（自动更新 / 模型数据政策） | 稳定设置项 | 卡片底部独立块 |

「管线」隐喻把稳定的用户设置与瞬时的执行进度混排：改设置要先理解 5 步流程；
运行时倒计时一出现，设置项被顶到移位；所有内容只有纵向堆叠一种组织方式。

### 1.2 视觉粗糙点（预览截图实测，浅/深色一致）

- 字号全局以 `--fs-10` 为主，密度过高、无呼吸感；
- 账号卡片限宽 845px 双列（`.lobby-account__list`），宽屏右侧大片空白；
  操作按钮（处理 / 切换并重启 / 删除）挤在卡片底部灰色条（`.lobby-account__row-actions`）；
- 4 个导入按钮等宽一排（`.lobby-account__quick` 4 列），文案截断，主推与次推无视觉分级；
- 状态色过载：会员档位 6 色（`.account-membership-plan.is-tier-*`）+ 流程状态 5 色同屏；
- `.configuration-frame` max-width 1520px 但只有一条内容柱，宽屏两侧全空；
- 顶栏另有独立「外观设置」齿轮弹层，设置概念分散两处（本任务不收编，见 0.4）。

### 1.3 预览复现

```bash
npm run preview:ui        # http://localhost:5174/preview.html#account（IPv6 绑定，curl 用 [::1]）
npm run preview:shots     # 截图矩阵已含 account-page 场景（scripts/preview-shots.mjs:177）
# 自动化运行中场景：?automation=countdown / processing / hardening-countdown / ...
```

***

## 2. 全链路逻辑地图（调查核心产出，改动时逐条对照）

### 2.1 四条链汇入一个组件

```text
App.tsx（状态中枢：约 20 个 useState + 5 个错误槽位）
  accountPanel props（App.tsx 841-1039 行组装）→ LobbyAccountTile
    ├─ 账号链    main/register-cursor-account-ipc.ts（14 个 handler）
    │            → application/cursor-account-vault.ts（加密 JSON，0o600，原子写）
    ├─ 奥仔链    main/register-aozai-ipc.ts（5 个 handler + aozaiProgress 事件）
    │            → application/aozai-service.ts（HTTP：登录→提交→400ms 轮询→刷余额）
    ├─ 自动化链  main/register-account-automation-ipc.ts（7 个 handler + progress 事件）
    │            → application/account-automation-service.ts（相位状态机，445 行）
    └─ 维护链    main/register-cursor-update-ipc.ts（2 个 handler）→ settings.json
```

### 2.2 账号 Vault 的两条硬契约（破坏即事故）

1. **切换顺序契约**（`cursor-account-switch.ts` 注释明示「不可倒置」）：
   取凭据 → 首次生成并绑定机器码 → 抑制 CDP auto-heal 看门 → 杀 Cursor → 写登录态/机器码
   → 带调试端口拉起 → **成功后才 `vault.select`**。
   倒置后果：切换失败时 Cursor 仍运行原账号，active 若已变，自动化会拿新 token 作用于旧登录态。
2. **活跃位顺延**：`remove` 删除活跃账号时 activeId 顺延到列表第一个——
   UI 上的一致性指示（runtimeMatch）与档位都依赖这个锚点，所以删除后必须三连刷（见 2.5）。

### 2.3 一致性核对与档位（账号页 + 发起闸门共用）

- `verifyCursorRuntimeAccountMatch`（`cursor-runtime-account-verify.ts`）：
  Cursor 运行态 JWT sub vs vault 活跃账号 JWT sub；兼容 `user_xxx::jwt` 复合格式；
  一侧解析不出保守判错，**绝不给假绿灯**。四态：matched / mismatch / cursor_unavailable / vault_empty。
- `resolveCursorMembership`（`cursor-membership-resolver.ts`）：运行态凭据优先；
  `auth_expired` 时仅当 sub 相同才回落 vault 凭据（防跨账号读档位）。
- **外部消费方**：`App.tsx` 的 `launchAgentSessions` 发起闸门——
  `resolveRuntimeLaunchGate`（身份闸门，`RuntimeAccountGuardDialog`）+
  `resolveMembershipLaunchGate`（档位闸门，`MembershipGuardDialog`，free 硬阻断）。
  账号页状态行与这两个弹窗共享 `runtimeMatch` / `membershipStatus` 数据源。

### 2.4 自动化状态机（`AccountAutomationService`）

```text
触发：AgentSessionLauncher.onAllTriggered(plan)        [main/index.ts 约 462 行]
  → onAllSessionsTriggered：幂等 lastHandledPlanId；开关关→忽略；运行中非倒计时→忽略
idle → countdown（可取消；末段 warmup 奥仔登录）
     → processing（奥仔处理，扣 1 次，失败退还）
     → hardening-countdown（可取消）
     → deleting：首选页内秒删（~3s）→ retry_legacy 回退 cookie 轮换（~15-30s，
        含退团等待 2s×60s + 限流退避 5s→120s/5min 窗口）→ 轮换超时且旧会话有效时兜底直删
     → importing（换发新 token 原地入库 replaceToken）
     → cleaning（站点数据清场 + Roxy 缓存/指纹轮换）
     → done / failed / cancelled
```

- 取消语义：仅 `countdown` / `hardening-countdown` 可取消；请求发出后不可中止。
- `runSeq` 序号：新一轮触发取代倒计时中的旧轮，旧链静默退出。
- 失败一律保留本地账号记录（消息后缀「（本地账号已保留）」）。
- 渲染侧相位 → 步骤映射：`ACTIVE_PHASE_STEP`；`importing` 归 deleting 步。

### 2.5 App.tsx 刷新联动矩阵（**拆分时唯一的高危区**）

| 时机 | 动作 |
|---|---|
| 挂载（一个 useEffect） | 并行拉 8 项：账号列表→各账号档位、奥仔状态、自动化设置、自动化 run（非 idle 才入状态）、Roxy 窗口列表、Roxy Key 状态、更新偏好 |
| 30s 轮询 | `refreshRuntimeMatch`（`document.hidden` 时跳过） |
| 账号 save / select / remove / 三路 import 后 | 三连刷：`refreshRuntimeMatch` + `refreshMembership` + `refreshAccountMemberships` |
| `onAccountAutomationProgress` 终态（done/failed） | 五连刷：账号列表 + 奥仔余额 + runtimeMatch + membership + 各账号档位 |
| `restartCursorWithAccount` 成功 | 三连刷（`refreshAccountMemberships([accountId])` 定向） |
| `onSetModelDataPolicyAutoAcknowledge` 换发了 token | `listCursorAccounts()` 重读 |

错误槽位 5 个互相独立：`cursorAccountError`（账号区）/ `aozaiError`（奥仔区）/
`cursorUpdateError`（维护区）/ `policyFeedback`（政策确认反馈）/ `bitProfilesMessage`（窗口列表）。

### 2.6 测试锚点（改动前后的回归网）

- `tests/lobby-account-tile.test.tsx`：**33 个 it**，`renderToStaticMarkup` SSR 断言，
  锁定流程状态机映射、状态行文案与 tone、档位六色系 class、浏览器来源分支、
  Roxy Key 有无、平台差异（Windows 隐藏系统浏览器宿主）。
- `tests/account-browser-panel.test.tsx`：2 个 it。
- 应用层（本任务碰不到，但作为安全网存在）：`account-automation-service` /
  `cursor-account-switch` / `cursor-runtime-account-verify` / `cursor-account-memberships` /
  `cursor-account-vault` 等 10+ 个测试文件。
- 预览截图：`scripts/preview-shots.mjs` 的 `account-page` 场景（1440×900 浅色）。

***

## 3. 实施方案（方案 A，按依赖顺序分四个阶段）

### 阶段 A：布局骨架（不改任何内容归属）

1. 新建 `src/renderer/src/settings/` 目录：
   - `SettingsPage.tsx`：双栏布局（左导航 200-240px 固定 + 右内容区滚动）；
     受控分组切换；hash 深链（`#account` 默认第一组，`#account:automation` 直达指定组——
     读取/写入沿用 `App.tsx` 现有 `window.location.hash` 模式）。
   - `SettingsSection.tsx`：分组外壳（标题 + 描述 + 内容插槽 + 卡片容器）。
   - `settings.css`：布局与导航样式；新类名一律 `settings-` 前缀，不复用 `lobby-` 类名。
2. `App.tsx` 只改渲染分支：`activeModule === 'account'` 时
   `<LobbyAccountTile {...accountPanel} />` → `<SettingsPage {...accountPanel} />`；
   props 对象原样透传（阶段内不做字段拆分）。
3. `SettingsPage` 内部先渲染**与现状一致**的内容（可把 `LobbyAccountTile` 整棵挂在第一组），
   验证导航骨架 + 深链 + 测试全绿后再进阶段 B。

### 阶段 B：内容拆组（展示层重排，零逻辑变更）

把 `LobbyAccountTile` 的 JSX 按归属拆成 5 个分组组件（同一 props 包入参，各自取用）：

| 分组组件 | 导航名 | 内容来源 |
|---|---|---|
| `SettingsAccounts.tsx` | 账号 | 状态行（`accountStatusLineFor`）、账号列表、手动添加表单、安全提示 |
| `SettingsImportSource.tsx` | 导入来源 | `AccountBrowserPanel`（宿主/Key/窗口/清理）+ 4 个导入入口（主次分级：指纹导入主按钮，其余次级） |
| `SettingsAutomation.tsx` | 自动化 | 开关 + 双滑杆 + 跟随说明；**运行状态横幅**（倒计时/live 消息/失败/取消）收进本组顶部，非活跃不渲染；导航项在活跃时显示状态圆点 |
| `SettingsAozai.tsx` | 奥仔服务 | 卡密保存/更换、余额、单账号处理入口（处理按钮从账号卡移入本组，按账号下拉选择） |
| `SettingsMaintenance.tsx` | Cursor 维护 | 自动更新开关、模型数据政策开关、反馈行 |

拆分红线：
- 步骤 3「奥仔处理」里的**单账号「处理」按钮**当前在账号卡操作行——
  迁移后账号卡操作行保留：选择 / 切换并重启 / 删除；「处理」移入奥仔组。
  这是唯一一处「功能归属变更」，实施前与用户确认（或在奥仔组保留按账号选择器）。
- `stepShell` / `flow-step` / 时间轴样式整体退役；`FLOW_STATE_LABEL` 等被横幅复用的映射保留。
- 各组的二次确认态（`confirmRemove` / `confirmRestart` / `cleanupArmed`）随组件迁移，
  作用域天然隔离（拆组后互不干扰，是收益不是风险）。

### 阶段 C：视觉规格落地

- 字号：正文提至 `--fs-11`/`--fs-12`，分组标题 `--fs-13`，导航项 `--fs-11`；
  说明文字保留 `--fs-10` 但行高 ≥1.5。
- 导航选中态：`--accent-wash` 底 + 左侧 2-3px `--accent` 指示条；hover 用 `--surface-soft`。
- 账号卡片：取消 845px 限宽，占满内容区；操作按钮改内联主次按钮
  （主=选择/切换，次=删除（红色仅 hover 显色，遵守「状态色不用于装饰」））。
- 导入区：主按钮仅「从指纹浏览器导入（推荐）」；其余入口次级按钮或折叠进「其他方式」。
- 横幅：倒计时横幅沿用现有蓝系（`--blue-soft`），失败红、取消灰、完成绿——
  状态色只出现在状态语义处。
- 内容区 max-width 建议 860-980px 单列；宽屏居中。
- 深色 / 浅色 / reduced-motion / 窄断点（<760px 导航折叠为顶部横排）全量走查。

### 阶段 D：测试与预览矩阵迁移

1. `tests/lobby-account-tile.test.tsx` 迁移为 `tests/settings-page.test.tsx`：
   - 33 个断言按分组重挂（状态机纯函数测试不动，只改 import 路径）；
   - 新增：导航切换渲染对应分组、hash 深链、自动化活跃时导航圆点 + 组内横幅、
     非活跃时横幅不渲染、奥仔组处理入口按账号触发 `onProcessAozaiAccount`。
2. `scripts/preview-shots.mjs`：`account-page` 场景扩展为每分组 × 浅/深两色 +
   自动化运行中场景（`?automation=countdown`）。
3. `preview-main.tsx` 的 mock（`previewCursorAccounts` 等）保持可用；若 props 形状未变则零改动。
4. 删除 `lobby.css` 中退役规则后跑 `npm run lint:dead`（knip）确认无死引用。

### 验证链（每阶段必跑）

```bash
npm run typecheck
npm test
npm run build
npm run preview:shots    # 截图走查浅/深 × 各分组
```

***

## 4. 明确禁止的做法

| 伪优化 | 遗留问题 |
|---|---|
| 顺手「优化」App.tsx 的 props 组装（合并 state、抽 hook） | 刷新联动矩阵错位，账号变更后状态不刷新 |
| 把运行态 phase 在各组内自行推导 | 多处 disabled 判定漂移，自动化运行中按钮状态不一致 |
| 步骤时间轴保留在某一组里「兼容」 | 管线隐喻残留，用户诉求未达成 |
| 拆分同时改文案/按钮 title | 33 个 SSR 断言大面积红，无法区分「拆坏」还是「改文案」 |
| 引入 UI 库（shadcn 等）重做组件 | 破坏现有设计系统变量体系，深色/透明背景契约失效 |
| 把 `LobbyAccountTile` 直接删掉再重写 | 丢失 792 行里所有边界处理（平台分支、确认态、禁用条件） |

***

## 5. 关键文件索引

### 渲染层（本任务的主战场）
- `src/renderer/src/App.tsx`：841-1039（accountPanel 组装）、1084-1090（渲染分支）、
  121-140（state 声明）、250-355（挂载拉取与订阅）、386-392（30s 轮询）
- `src/renderer/src/lobby/LobbyAccountTile.tsx`（792 行，拆分对象）
- `src/renderer/src/lobby/AccountBrowserPanel.tsx`（208 行，整体迁入导入来源组）
- `src/renderer/src/lobby/ToggleSwitch.tsx` / `RangeField.tsx` / `MenuSelect.tsx` / `FlowStatusIcon.tsx`（复用件）
- `src/renderer/src/lobby/lobby.css`（824 行；账号相关约 400 行，阶段 D 清理）
- `src/renderer/src/DesktopShell.tsx`：右上角 account-button 入口（**不动**）
- `src/renderer/src/AppearanceSettings.tsx`：外观弹层（**不动**，不收编）

### 逻辑层（只读参照，禁止改动）
- `src/application/account-automation-service.ts` / `aozai-service.ts` /
  `cursor-account-vault.ts` / `cursor-account-switch.ts` /
  `cursor-runtime-account-verify.ts` / `cursor-membership-resolver.ts`
- `src/main/register-cursor-account-ipc.ts` / `register-aozai-ipc.ts` /
  `register-account-automation-ipc.ts` / `register-cursor-update-ipc.ts`
- `src/domain/account-automation.ts`（相位与设置项定义）
- `src/shared/desktop-api.ts`（IPC 面，190-266 行）

### 测试与预览
- `tests/lobby-account-tile.test.tsx`（33 it）/ `tests/account-browser-panel.test.tsx`（2 it）
- `src/renderer/src/preview/preview-main.tsx`（mock API）
- `scripts/preview-shots.mjs`（截图矩阵，177 行 account-page 场景）

***

## 6. 完成定义

本任务仅在以下全部成立时结束：

1. `activeModule === 'account'` 呈现左侧导航 + 右侧分组内容；管线时间轴（`flow-step`）
   在账号页完全消失；hash 深链可达每个分组。
2. 自动化运行时：导航项出状态圆点，倒计时/live/失败以横幅呈现在自动化组顶部；
   非活跃时页面无任何运行态占位。
3. 第 2.5 节刷新联动矩阵行为不变（账号变更后状态行/档位立即刷新；
   自动化终态后五连刷；30s 轮询健在）。
4. 41 个 props 的组装代码（App.tsx 841-1039）零变更；应用层/主进程/IPC 零变更。
5. 测试全绿（含迁移后的 settings-page 测试与新增导航/横幅断言）；knip 无新增死代码。
6. 预览截图走查通过：各分组 × 浅/深 × 自动化运行中场景，符合
   `docs/DESIGN-SYSTEM.md`（边框优先、圆角 9-17px、状态色仅表状态）。
