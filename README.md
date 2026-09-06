# 拾光

Independent Electron control plane for Cursor multi-Agent teamwork. 通道消息与活性
经拾光内嵌 MCP（SG Team 单条目）+ SQLite 队列直达 Cursor，不依赖晴天插件进程；
本应用拥有会话投影、持久任务调度、带回执的 Agent 间协作、自动检查点、
一键恢复与进程绑定的 Agent MCP 接入。

```bash
npm install
npm run dev
```

Verification:

```bash
npm test
npm run build
npm run smoke:mcp       # 团队角色 stdio 冒烟（构建产物）
npm run smoke:channel   # 通道角色 stdio 冒烟（构建产物）
npm run verify:mac
```

Design walkthrough (pure-browser preview with a mocked desktop API, plus a
headless screenshot matrix over the right-hand inspector: panels × light/dark ×
narrow × transparent × reduced-motion × hover states):

```bash
npm run preview:ui      # http://127.0.0.1:5174/preview.html
npm run preview:shots   # writes preview-screenshots/*.png (needs Chrome or Edge)
```

Architecture and protocol decisions live in `docs/`.
