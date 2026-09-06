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
npm run verify:mac      # 或 verify:win：打包产物 + 真实多进程冒烟
```

Packaged output: `release/mac-arm64/拾光.app` / `release/win-unpacked/拾光.exe`
(directory targets, unsigned). Both `pack:*` scripts reuse the Electron in
`node_modules/electron/dist`, so no Electron download is needed at pack time.
On Windows, electron-builder shells out to `powershell.exe`; make sure
`C:\Windows\System32\WindowsPowerShell\v1.0` is on `PATH` in the shell you run
it from.

Design walkthrough (pure-browser preview with a mocked desktop API, plus a
headless screenshot matrix over the right-hand inspector and the 运行 page:
panels / run states × light/dark × narrow × transparent × reduced-motion ×
interactions):

```bash
npm run preview:ui      # http://127.0.0.1:5174/preview.html
npm run preview:shots   # writes preview-screenshots/*.png (needs Chrome or Edge)
node scripts/preview-shots.mjs --only run-team-active-light,run-independent-mixed-dark
```

If Vite binds to `localhost` only, point the shot script at it with
`PREVIEW_BASE=http://localhost:5174`.

Architecture and protocol decisions live in `docs/`.
