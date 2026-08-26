# 群枢

Independent Electron control plane for Cursor multi-Agent teamwork. 通道消息与活性
经群枢内嵌 MCP（qtwx-mcp-N / qt-ch-N）+ SQLite 队列直达 Cursor，不依赖晴天插件进程；
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

Architecture and protocol decisions live in `docs/`.
