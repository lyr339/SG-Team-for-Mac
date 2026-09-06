# 拾光

Independent Electron control plane for Cursor multi-Agent teamwork (macOS + Windows).
通道消息与活性经拾光内嵌 MCP（SG Team 单条目）+ SQLite 队列直达 Cursor；
本应用拥有会话投影、持久任务调度、带回执的 Agent 间协作、自动检查点、
一键恢复与进程绑定的 Agent MCP 接入。

```bash
npm install             # package.json 的 allowScripts 已放行 electron / esbuild 的安装脚本（npm 11）
npm run dev
```

Verification:

```bash
npm run typecheck       # 含 tests/**/*.tsx
npm test
npm run build
npm run smoke:mcp       # 团队角色 stdio 冒烟（构建产物）
npm run smoke:channel   # 通道角色 stdio 冒烟（构建产物）
npm run verify:mac      # 或 verify:win：打包产物 + 真实三进程冒烟
```

Design walkthrough (pure-browser preview with a mocked desktop API, plus a
headless screenshot matrix over the right-hand inspector: panels × light/dark ×
narrow × transparent × reduced-motion × hover states):

```bash
npm run preview:ui      # http://127.0.0.1:5174/preview.html
npm run preview:shots   # writes preview-screenshots/*.png (needs Chrome or Edge)
```

Architecture and protocol decisions live in `docs/`.
