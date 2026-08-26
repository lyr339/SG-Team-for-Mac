# 群枢软件优化清单（reviewer / CH-3 审计产出）

审计基线（2026-08-25 实测）：typecheck ✅、vitest 49 文件 355 用例全绿、build + smoke:channel/mcp ✅。
产物体积：renderer 764K JS + 117K CSS；main 495K；mcp 970K。
优先级：P0 立即 / P1 近期 / P2 择机。成本：S ≤0.5 天，M 1–2 天，L ≥3 天。

状态更新（2026-08-25 08:26）：P0 已清零；P1 性能链路已完成结构共享/增量重建/遥测空闲降频；本轮继续完成过程样式并块、文件大小格式化共享出口、ProcessBlocks ARIA 精化、ProcessBlocks/ComposerWorkbench 组件测试和最小 CI。

## 1. 性能

| # | 项 | 优先级 | 成本 | 依据 |
|---|----|--------|------|------|
| 1.1 | 根目录误置构建产物清理：`index-FYVr4WmZ.js`（704K，8/22）与 `index.js`（476K，8/24）不是源码，删除并加 .gitignore | P0 | S | 根目录 ls 实测 |
| 1.2 | 空目录 `cursor-bridge-extension/`（0 文件）删除 | P0 | S | ls 实测 |
| 1.3 | ✅ 已完成：快照→渲染链路完成结构共享、SessionRailCard memo、稳定回调；长列表虚拟化暂缓（500 条上限下滚动锚定/分组跨窗风险高于收益） | P1 | M–L | snapshot-sharing / App acceptSnapshot / SessionRailCard |
| 1.4 | ✅ 已完成：主进程定时器采取克制收敛，最重的 Cursor telemetry 空闲期 2s → 10s 降频，活跃期不变；统一总线暂缓以避免时序风险 | P1 | M | desktop-session-service |
| 1.5 | ✅ 已完成：relay conversations 引用共享 + session fingerprint 缓存 + enrich 层同步缓存；基准 4 通道 × 200 轮显示 conversations 75% 复用、session 100% 复用 | P1 | S–M | channel-message-relay / desktop-session-service |
| 1.6 | 依赖瘦身择机：MCP bundle 970K（zod v4 + MCP SDK），renderer 764K；评估树摇与按需引入 | P2 | M | out/ 实测 |

## 2. 交互与视觉一致性

| # | 项 | 优先级 | 成本 | 依据 |
|---|----|--------|------|------|
| 2.1 | styles.css 142 处硬编码 hex（对照 419 处 var(--*)），集中在过程/状态徽章区。按 DESIGN-SYSTEM.md 收敛进设计令牌 | P1 | M | grep 实测计数 |
| 2.2 | ✅ 已完成：过程样式并为唯一 ProcessBlocks 样式块，状态徽章与节点色回收既有令牌，避免两段级联互相覆盖 | P1 | S | styles.css |
| 2.3 | 错误态策略普查：sendError / attachmentError 常驻不消退，建议自动消退或手动关闭统一 | P2 | S | ComposerWorkbench / SessionWorkspace |

## 3. 可访问性

| # | 项 | 优先级 | 成本 | 依据 |
|---|----|--------|------|------|
| 3.1 | fs-10（10px）字号使用 110 处，辅助文字普遍偏小；配合 faint/muted 低对比色在浅色主题下对比度风险。关键状态文本建议 ≥11px 基线 + 对比度抽测 | P1 | M | grep 实测计数 |
| 3.2 | 键盘补全：Escape 返回会话列表、会话列表方向键导航（现有 Enter 发送 / 按钮可聚焦已达标） | P2 | S–M | 走查实测 |
| 3.3 | ✅ 已完成：ProcessBlocks 仅在可展开时输出 aria-expanded；不可展开 disabled head 不再伪装 disclosure | P2 | S | ProcessBlocks.tsx + process-blocks.test.tsx |

## 4. 代码健康度

| # | 项 | 优先级 | 成本 | 依据 |
|---|----|--------|------|------|
| 4.1 | ✅ 已完成：文件大小格式化抽到 shared 唯一出口，renderer 继续 re-export，domain 投递清单直接复用 | P1 | S | shared/format-file-size.ts |
| 4.2 | 死代码普查：跑 ts-prune / knip 一次；产物与空目录见 1.1/1.2 | P2 | S | — |
| 4.3 | 类型严格性保持：strict + noUncheckedIndexedAccess 已开，src 零 `: any` / `as any` ✅（现状良好，仅守护） | — | — | grep 实测 |

## 5. 测试与发布质量

| # | 项 | 优先级 | 成本 | 依据 |
|---|----|--------|------|------|
| 5.1 | 附件校验零单测：attachmentRejection（白名单/大小/文案）与 handleFileSelect 的 quota/合计逻辑仅靠本次浏览器手测，无回归保护。抽纯函数 + vitest 边界用例 | P0 | S | ComposerWorkbench.tsx + tests/ 实测 |
| 5.2 | ✅ 部分完成：新增 ProcessBlocks 三态/ARIA 测试与 ComposerWorkbench 快捷提示词/附件/错误态 SSR 测试；SessionWorkspace/App 组件级测试仍可择机补 | P1 | M | tests/process-blocks.test.tsx / tests/composer-workbench.test.tsx |
| 5.3 | ✅ 已完成：新增 GitHub Actions 最小 CI，跑 `npm ci`、typecheck、test、build、smoke:channel | P1 | S–M | .github/workflows/ci.yml |
| 5.4 | 发布门禁：verify:mac（打包产物冒烟）纳入定期发布流程；冒烟场景已覆盖通信/团队工具/附件清单 ✅ | P2 | S | package.json |

## 已收编的已知残留

- styles.css 过程样式重叠 → 2.2 ✅
- attachmentSizeLabel / formatFileSize 多处实现 → 4.1 ✅
