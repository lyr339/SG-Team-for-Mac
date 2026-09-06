import WebSocket from 'ws'
import type { CursorUsageEvent, CursorUsageSample } from '../../domain/cursor-usage'
import { nativeUsagePayload } from './cursor-native-usage'
import { CHANNEL_USER_DELIVERY_MARKER } from '../../domain/channel-delivery-policy'
import { parseProcessStream, type CursorProcessStream } from './cursor-cdp-session-creator'

/**
 * Cursor 过程流写信号观察者（事件驱动层）。
 *
 * 在 Cursor workbench 渲染进程内 hook composerDataHandleManager 的写路径
 * （markDirty / markMessageDirty / updateWithoutMarkingDirty / pushComposer——
 * 每次模型写入与持久化批次必经），经 CDP Runtime binding「sgTeamStream」
 * 把写信号推回主进程：真正的事件推送，空闲期零事件（实测 0/3s）、
 * 投递延迟 p50=0ms。
 *
 * 页面内同时推送 composerId 写信号与当前 Composer 的原生有序过程快照；
 * thinking、工具参数/结果、todo 均在写后同一微任务读取，不再经过主进程
 * 二次 evaluate，也不读取 transcript 或 Agent 主动上报的过程。
 *
 * hook 的生命周期必须跟随「文档」而不是「socket」：Cursor 窗口原地重载
 *（Reload Window / 同窗口切换文件夹 / 切号重启后重开工作区）时 CDP target 与
 * socket 都不变，旧文档里的 hook 却随文档消失；binding 由 Runtime 域自动注入新
 * 文档，于是出现「binding 在、hook 不在、状态 connected、永远零帧」（2026-09-05
 * 事故）。因此三重保障：
 * 1. Page.enable + Page.addScriptToEvaluateOnNewDocument——不启用 Page 域时
 *    该脚本只登记不执行（Chromium 语义，Electron 43 实测）；
 * 2. Runtime.executionContextsCleared / executionContextCreated 事件驱动重装；
 * 3. 低频健康自检（探针只读；hook 缺席才重装），兜住一切未知路径。
 * 状态 connected 的含义是「hook 已在当前文档验证就位」，不是「socket 开着」。
 * 连接断开按退避重连。运行时轮询只承担会话存活与正文状态核验，不承担过程
 * 重建；observer 缺席时明确没有过程帧，避免用低保真来源伪装成 Cursor 原生体验。
 *
 * 用量通道（usage）：bundle 补丁（patch-cursor-usage-hook.ts）在
 * turnEnded 消费点调用 __sgTeamUsage(JSON)——本 observer 注册同名 binding
 * 接收每回合真实计费 token 并解析转发（onUsageEvent）。
 */

export const CURSOR_STREAM_BINDING_NAME = 'sgTeamStream'
export const CURSOR_USAGE_BINDING_NAME = '__sgTeamUsage'
export const CURSOR_PROCESS_BINDING_NAME = 'sgTeamProcess'
/** 页面内 hook 版本：不一致时 install 会先还原旧 wrapper 再重装（拾光强退后遗留的旧版）。 */
export const CURSOR_STREAM_HOOK_VERSION = 22
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000
const ATTACH_TIMEOUT_MS = 8_000
/** hook 健康自检周期：探针只读一次 evaluate，缺席才重装；成本可忽略。 */
const HOOK_HEALTH_INTERVAL_MS = 20_000
/** executionContextCreated 成批到达（主帧 + 各 iframe），合并后再装。 */
const HOOK_CONTEXT_SETTLE_MS = 300

/**
 * 页面内注入的 hook 源码：幂等守卫（manager 身份 + wrapped 标记双保险）+
 * 透明包装写方法 + binding 推送 composerId + 原始函数存档（供 dispose 还原）。
 * workbench 服务异步就绪：new-document 场景下 manager 可能未加载——页面内
 * 自轮询重试（2s 间隔，上限 60 次），保证重载后 hook 自动恢复，不依赖重连。
 */
export const CURSOR_STREAM_HOOK_EXPRESSION = `(() => {
  const HOOK_VERSION = ${CURSOR_STREAM_HOOK_VERSION}
  let attempts = 0
  const pendingSnapshots = new Set()
  let snapshotQueued = false
  function classifyTool(name) {
    const n = String(name || '').toLowerCase()
    if (n.includes('todo')) return 'todo'
    if (n.includes('browser') || n.includes('computer') || n.includes('screenshot') || n.includes('navigate') || n.includes('click') || n.includes('fetch')) return 'browser'
    if (n.startsWith('mcp-') || n.startsWith('get_mcp_tools') || n.includes('_mcp_') || n.includes('mcptool')) return 'mcp'
    if (n.includes('read') || n.includes('lint') || n.includes('ls_tool') || n.includes('lstool')) return 'read'
    if (n.includes('glob') || n.includes('grep') || n.includes('search') || n.includes('find')) return 'search'
    if (n.includes('edit') || n.includes('apply') || n.includes('delete')) return 'edit'
    if (n.includes('write') || n.includes('create_file')) return 'write'
    if (n.includes('shell') || n.includes('terminal') || n.includes('command') || n.includes('run_') || n.includes('exec')) return 'command'
    return 'other'
  }
  function toolInfo(td) {
    const wrapped = td?.toolCall?.tool
    const value = wrapped?.value
    const toolCase = typeof wrapped?.case === 'string' ? wrapped.case : ''
    const legacy = typeof td?.name === 'string' ? td.name
      : typeof td?.tool === 'string' ? td.tool
      : ''
    let name = legacy || toolCase || (td?.tool !== undefined ? 'cursorTool:' + String(td.tool) : '')
    const args = value?.args || td?.params || (() => {
      try { return JSON.parse(String(td?.rawArgs || '{}')) } catch (e) { return {} }
    })()
    const result = value?.result || td?.result
    let mcpPending = false
    if (toolCase.toLowerCase() === 'mcptoolcall') {
      const server = args?.server || args?.serverName || value?.serverName || ''
      const called = args?.toolName || args?.name || value?.toolName || ''
      if (called) name = 'mcp-' + String(server || 'server') + '-' + String(called)
      // MCP ToolCall 首帧可能只有 toolCase、真实工具名下一帧才水合（RC-5.1）：
      // 占位名（mcpToolCall/mcp--）暂缓展示，水合后按真实名称分类展示或隐藏。
      else mcpPending = true
    }
    const rawStatus = String(td?.status || value?.status || '').toLowerCase()
    let status = rawStatus === 'completed' || rawStatus === 'success' || rawStatus === 'done'
      ? 'done'
      : rawStatus === 'error' || rawStatus === 'failed' ? 'failed' : 'running'
    const resultCase = String(result?.result?.case || result?.case || '').toLowerCase()
    if (status === 'running' && result !== undefined) status = resultCase === 'error' || resultCase === 'failure' ? 'failed' : 'done'
    const error = td?.error || result?.error || (resultCase === 'error' || resultCase === 'failure' ? result : undefined)
    return { name, args, result, status, error, mcpPending }
  }
  function isTransportNoise(name) {
    const lower = String(name || '').toLowerCase()
    return ['check_messages', 'record_reply', 'wait_messages', 'qingtian'].some(item => (
      lower === item || lower.endsWith('-' + item) || lower.endsWith('_' + item)
    ))
  }
  // 传输工具结果里的文本片段（不裁剪、不展开 image/base64）：MCP 结果在 Cursor 内存与
  // 落盘态都是双层 JSON 字符串 {"result":"{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":…}]}"}。
  function collectResultTexts(value, depth, out) {
    if (value === null || value === undefined || depth > 6 || out.length > 30) return
    if (typeof value === 'string') {
      const text = value.trim()
      if ((text.startsWith('{') || text.startsWith('[')) && text.length < 2000000) {
        try { collectResultTexts(JSON.parse(text), depth + 1, out); return } catch (e) {}
      }
      out.push(value)
      return
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 30)) collectResultTexts(item, depth + 1, out); return }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') out.push(value.text)
      for (const key of ['result', 'output', 'content', 'contents']) {
        if (value[key] !== undefined) collectResultTexts(value[key], depth + 1, out)
      }
    }
  }
  // 「本次 check_messages 投递了真实用户消息」：结果文本含投递协议标题（正面证据）。
  // keepalive 返回体、内部协作通知、need_reply_sync、会话围栏文本都不含它。结果一旦到齐
  // 不再变化——按 bubbleId 记忆，长会话里不重复解析同一结果。
  const USER_DELIVERY_MARKER = ${JSON.stringify(CHANNEL_USER_DELIVERY_MARKER)}
  const deliveryByBubble = new Map()
  function isUserDelivery(bubbleId, tool) {
    if (!tool || !tool.name || tool.result === undefined || tool.result === null) return false
    const lower = String(tool.name).toLowerCase()
    if (!(lower === 'check_messages' || lower.endsWith('-check_messages') || lower.endsWith('_check_messages'))) return false
    const key = String(bubbleId || '')
    if (key && deliveryByBubble.has(key)) return deliveryByBubble.get(key)
    let delivered = false
    try {
      const texts = []
      collectResultTexts(tool.result, 0, texts)
      delivered = texts.some(text => text.includes(USER_DELIVERY_MARKER))
    } catch (e) { delivered = false }
    if (key && tool.status !== 'running') {
      if (deliveryByBubble.size > 2000) deliveryByBubble.clear()
      deliveryByBubble.set(key, delivered)
    }
    return delivered
  }
  function thinkingInfo(message) {
    const direct = typeof message?.thinking === 'string'
      ? { text: message.thinking, durationMs: message.thinkingDurationMs }
      : message?.thinking && typeof message.thinking === 'object'
        ? { text: message.thinking.text, durationMs: message.thinking.thinkingDurationMs ?? message.thinking.durationMs ?? message.thinkingDurationMs }
        : undefined
    if (typeof direct?.text === 'string' && direct.text.length > 1) return direct
    const blocks = Array.isArray(message?.allThinkingBlocks) ? message.allThinkingBlocks : []
    const texts = blocks.flatMap(block => {
      const text = typeof block === 'string' ? block : block && typeof block.text === 'string' ? block.text : ''
      return text ? [text] : []
    })
    if (!texts.length) return undefined
    const durationMs = blocks.reduce((sum, block) => sum + (typeof block?.thinkingDurationMs === 'number'
      ? block.thinkingDurationMs
      : typeof block?.durationMs === 'number' ? block.durationMs : 0), 0)
    return { text: texts.join('\\n\\n'), durationMs: durationMs || message?.thinkingDurationMs }
  }
  function clipText(value, limit) {
    const text = String(value || '')
    return text.length > limit
      ? text.slice(0, limit) + '\\n…[Cursor 原生内容过长，另有 ' + (text.length - limit) + ' 字符未内联]'
      : text
  }
  function safePlain(value, depth) {
    if (value === null || value === undefined) return value
    if (depth > 3) return '[nested]'
    if (typeof value === 'string') return clipText(value, 8000)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return String(value)
    if (Array.isArray(value)) return value.slice(0, 30).map(item => safePlain(item, depth + 1))
    if (typeof value === 'object') {
      const out = {}
      for (const key of Object.getOwnPropertyNames(value).slice(0, 60)) {
        try {
          if (typeof value[key] === 'function') continue
          const lower = key.toLowerCase()
          out[key] = (lower === 'data' || lower.includes('base64') || lower.includes('imagedata'))
            && typeof value[key] === 'string' && value[key].length > 200
            ? '[binary/image payload omitted]'
            : safePlain(value[key], depth + 1)
        } catch (e) {}
      }
      return out
    }
    return clipText(value, 1000)
  }
  function outputText(result) {
    try {
      if (!result) return ''
      if (typeof result === 'string') {
        const text = result.trim()
        if ((text.startsWith('{') || text.startsWith('[')) && text.length < 2000000) {
          try { return outputText(JSON.parse(text)) } catch (e) {}
        }
        return text.length > 12000 && /^[A-Za-z0-9+/=\\s]+$/.test(text)
          ? '[binary/image payload omitted]'
          : clipText(text, 12000)
      }
      if (Array.isArray(result)) {
        const parts = result.slice(0, 30).flatMap(item => {
          if (item?.type === 'image') return ['[image result]']
          const text = outputText(item)
          return text ? [text] : []
        })
        return clipText(parts.join('\\n'), 12000)
      }
      if (Array.isArray(result.content)) return outputText(result.content)
      for (const key of ['output', 'contents', 'content', 'text', 'stdout', 'result']) {
        if (result[key]) {
          const text = outputText(result[key])
          if (text) return text
        }
      }
      const json = JSON.stringify(safePlain(result, 0), null, 2)
      return json && json !== '{}' ? clipText(json, 12000) : ''
    } catch (e) { return '' }
  }
  function toolSummary(td, parsedArgs) {
    const candidates = [parsedArgs?.args, parsedArgs, td?.params]
    try {
      const firstToolParams = td?.params?.tools?.[0]?.parameters
      if (typeof firstToolParams === 'string') candidates.unshift(JSON.parse(firstToolParams))
    } catch (e) {}
    for (const value of candidates) {
      const a = value && typeof value === 'object' ? value : {}
      for (const k of ['path','file_path','targetFile','target_file','command','query','pattern','url','filename','name','server']) {
        if (typeof a[k] === 'string' && a[k]) return a[k].slice(0, 160)
      }
    }
    return ''
  }
  function processSnapshot(data) {
    if (!data) return undefined
    const headers = data.fullConversationHeadersOnly || []
    const map = data.conversationMap || {}
    let lastUserIdx = -1
    for (let i = headers.length - 1; i >= 0; i--) {
      if (headers[i] && headers[i].type === 1) { lastUserIdx = i; break }
    }
    const turnId = lastUserIdx >= 0 ? String(headers[lastUserIdx]?.bubbleId || '') : ''
    const turnBubbles = headers.slice(lastUserIdx + 1)
    const generatingIds = data.generatingBubbleIds
    const generatingBubbleCount = Array.isArray(generatingIds)
      ? generatingIds.length
      : typeof generatingIds?.size === 'number'
        ? generatingIds.size
        : generatingIds && typeof generatingIds === 'object' ? Object.keys(generatingIds).length : 0
    const generatingBubbleSet = new Set(Array.isArray(generatingIds)
      ? generatingIds.map(String)
      : generatingIds && typeof generatingIds[Symbol.iterator] === 'function'
        ? [...generatingIds].map(String)
        : generatingIds && typeof generatingIds === 'object' ? Object.keys(generatingIds) : [])
    const isGenerating = data.isGenerating === true || generatingBubbleCount > 0
    const items = []
    let todos
    function bubbleStartedAt(header, message) {
      const raw = message?.createdAt ?? header?.createdAt
      const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw || ''))
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }
    // ---- 阶段 D：以 Bubble 为单位的内部协议相位分组（RC-5 / RC-6）----
    // pass 1：每个气泡的事实——工具分类（transport/business/pending）、思考、
    // capability/serviceStatus、消息文本。pending = MCP ToolCall 未水合真实名。
    const facts = turnBubbles.map(h => {
      const m = map[h && h.bubbleId] || {}
      const td = m.toolFormerData
      const tool = toolInfo(td)
      let toolClass = null
      if (td && tool.mcpPending) toolClass = 'pending'
      else if (td && tool.name) toolClass = isTransportNoise(tool.name) ? 'transport' : 'business'
      const thought = thinkingInfo(m)
      return { m, td, tool, toolClass, thought, startedAt: bubbleStartedAt(h, m) }
    })
    // pass 2：传输相位归属（两套标记，用途不同）。
    // 前向规则：非工具气泡之后最近的工具是内部协议 → 该气泡属协议相位
    // （模型思考完直接轮询 check_messages → keepalive 思考、调用通告 capability）。
    // 带正文的 message 气泡重置相位：模型输出了用户可见文字，之后再来的
    // record_reply/check_messages 脚手架不得回溯吞掉正文之前的业务思考——
    // 否则每次落库回复时，产出答案的 Thought 会在过程卡上凭空消失。
    // - transportStrict：只认已水合的内部协议工具。用于 thinking 显示：pending
    //   （MCP ToolCall 首帧尚无真实名）不隐藏其前置思考，避免每个业务 MCP 调用
    //   开始时思考块消失一帧再重播（打字机从头再来）。
    // - transportBiased：pending 按传输倾向处理。用于工作判定与 capability/
    //   serviceStatus 显示：持续会话里 MCP 首帧几乎都是 check_messages 轮询，
    //   若按未知归组，其前的 thinking 会构成「后续工作」，最终正文被误判为
    //   中间过程（cursor-msg 与回复正文双渲染，2026-09-03 事故）；水合后自愈。
    // 后向兜底：其后再无正文、且前一工具是内部协议（回合尾部的轮询余波），两套
    // 标记同时生效。例外——前一工具是「投递了真实用户消息」的 check_messages：
    // 其后的 thinking 是新回合的业务思考，不是余波。结构上两者完全相同（前一
    // 工具都是 check_messages、其后都暂无正文），只能靠工具结果区分；不区分就会把
    // 投递后的首段（往往最长的）思考整段隐藏到正文出现才蹦出（2026-09-04 事故：
    // 38s Thought 全程只显示占位，随后无打字机整段出现）。
    function hasText(f) { return typeof f.m.text === 'string' && Boolean(f.m.text.trim()) }
    const transportStrict = new Array(facts.length).fill(false)
    const transportBiased = new Array(facts.length).fill(false)
    let nextToolClass = null
    for (let i = facts.length - 1; i >= 0; i--) {
      if (facts[i].toolClass) { nextToolClass = facts[i].toolClass; continue }
      if (hasText(facts[i])) { nextToolClass = null; continue }
      if (nextToolClass === 'transport') transportStrict[i] = true
      if (nextToolClass === 'transport' || nextToolClass === 'pending') transportBiased[i] = true
    }
    // 后缀预扫描（O(n)）：messageAhead[i] = 其后是否还有带正文的气泡。
    // 长持续回合的 turnBubbles 可达数千，逐气泡内层扫描会是 O(n²) 页面热点。
    const messageAhead = new Array(facts.length).fill(false)
    for (let i = facts.length - 2; i >= 0; i--) {
      messageAhead[i] = messageAhead[i + 1] || hasText(facts[i + 1])
    }
    let prevToolClass = null
    let prevToolIndex = -1
    for (let i = 0; i < facts.length; i++) {
      if (facts[i].toolClass) { prevToolClass = facts[i].toolClass; prevToolIndex = i; continue }
      if (transportBiased[i]) continue
      if (!messageAhead[i] && prevToolClass === 'transport'
        && !isUserDelivery(turnBubbles[prevToolIndex] && turnBubbles[prevToolIndex].bubbleId, facts[prevToolIndex].tool)) {
        transportStrict[i] = true
        transportBiased[i] = true
      }
    }
    // pass 3：工作判定（RC-6）。内部协议工具、待水合 MCP、传输相位思考与
    // capability/serviceStatus 都不算工作——最终正文之后只剩内部协议噪声时，
    // 正文仍被识别为最终回答，不再误入 cursor-msg 与回复正文重复。业务工具、
    // 业务思考、plan 更新算工作。
    const hasWork = facts.map((f, i) => (
      f.toolClass === 'business'
      || (!!f.thought?.text && !transportBiased[i])
      || (!f.toolClass && !f.thought?.text && !!f.m.planUpdate)
    ))
    const hasLaterWork = new Array(hasWork.length).fill(false)
    let workSeen = false
    for (let i = hasWork.length - 1; i >= 0; i--) {
      hasLaterWork[i] = workSeen
      workSeen = workSeen || hasWork[i]
    }
    for (let i = 0; i < facts.length; i++) {
      const h = turnBubbles[i]
      const { m, td, tool, toolClass, thought, startedAt } = facts[i]
      const bubbleGenerating = generatingBubbleSet.has(String(h?.bubbleId || ''))
      if (thought?.text && !transportStrict[i]) {
        items.push({
          kind: 'thinking', id: 'cursor-th:' + h.bubbleId, text: clipText(thought.text, 24000),
          status: bubbleGenerating && !tool.name ? 'running' : 'done',
          durationMs: typeof thought.durationMs === 'number' ? thought.durationMs : undefined,
          startedAt
        })
      }
      // Cursor 原生 assistant-message 只在其后仍有工作时属于过程；回合最后一段
      // 正文由 liveAgentResponse / record_reply 展示，避免重复。
      const messageText = typeof m.text === 'string' ? m.text.trim() : ''
      const laterWork = hasLaterWork[i] || toolClass === 'business'
      if (messageText && laterWork) {
        items.push({
          kind: 'message', id: 'cursor-msg:' + h.bubbleId,
          text: clipText(messageText, 12000), status: 'done', startedAt
        })
      }
      // 待水合 MCP（pending）暂缓展示；内部协议工具隐藏；业务工具完整保留。
      if (toolClass === 'business') {
        items.push({
          kind: 'tool', id: 'cursor:' + h.bubbleId,
          toolName: String(tool.name).slice(0, 120), toolKind: classifyTool(tool.name),
          summary: toolSummary(td, tool.args),
          status: bubbleGenerating ? 'running' : tool.status,
          input: safePlain(tool.args, 0), output: outputText(tool.result),
          error: typeof tool.error === 'string' ? clipText(tool.error, 8000) : outputText(tool.error),
          startedAt
        })
      }
      // capability/serviceStatus 属协议脚手架：传输相位内整组隐藏（含 pending 倾向，
      // 它们不是打字机内容，晚一帧出现无感）；业务侧保留。planUpdate 始终保留（业务）。
      if (!toolClass && !thought?.text && (!transportBiased[i] || m.planUpdate)
        && (m.capabilityType !== undefined || m.serviceStatusUpdate || m.planUpdate)) {
        const capabilityName = m.planUpdate ? 'planUpdate'
          : m.capabilityType !== undefined ? 'capability:' + String(m.capabilityType) : 'serviceStatus'
        items.push({
          kind: 'tool', id: 'cursor-capability:' + h.bubbleId,
          toolName: capabilityName, toolKind: m.planUpdate ? 'todo' : 'other',
          summary: typeof m.simulatedMessageMetadata?.title === 'string' ? m.simulatedMessageMetadata.title.slice(0, 160) : '',
          status: bubbleGenerating ? 'running' : 'done',
          input: safePlain(m.planUpdate || m.capabilityContexts || m.serviceStatusUpdate || {}, 0),
          output: outputText(m.subagentReturn || m.serviceStatusUpdate || m.planUpdate),
          startedAt
        })
      }
      if (Array.isArray(m.todos) && m.todos.length) {
        todos = m.todos.slice(0, 100).flatMap(t => t && typeof t.content === 'string'
          ? [{ content: t.content.slice(0, 500), status: String(t.status || 'pending').slice(0, 40) }]
          : [])
      }
    }
    if (!todos && Array.isArray(data.todos) && data.todos.length) {
      todos = data.todos.slice(0, 100).flatMap(t => t && typeof t.content === 'string'
        ? [{ content: t.content.slice(0, 500), status: String(t.status || 'pending').slice(0, 40) }]
        : [])
    }
    if (data.plan && !items.some(item => item.toolName === 'planUpdate')) {
      items.unshift({
        kind: 'tool', id: 'cursor:plan', toolName: 'planUpdate', toolKind: 'todo',
        summary: '执行计划', status: data.hasPendingPlan ? 'running' : 'done',
        input: safePlain(data.plan, 0), output: ''
      })
    }
    // 流式正文（阶段 G 数据层）：与 Cursor 自身 UI 同一写信号、同一微任务读取
    // 当前回合的最终正文候选——最后一个「其后没有业务工作」的正文气泡（与
    // runtime inspect 的定位规则一致）。此前正文只经 inspect 轮询到达
    //（120ms 节流 + CDP 往返 + 150ms 快循环），打字机输入是 150–250ms 的粗粒度
    // chunk；写后直推把输入粒度对齐到 Cursor 原生 token 批次，是匀速播放的前提。
    let response
    for (let i = facts.length - 1; i >= 0; i--) {
      const text = typeof facts[i].m.text === 'string' ? facts[i].m.text : ''
      if (!text.trim()) continue
      if (!hasLaterWork[i] && facts[i].toolClass !== 'business') {
        const bubbleId = String(turnBubbles[i]?.bubbleId || '')
        response = { id: bubbleId, text: clipText(text, 100000), generating: generatingBubbleSet.has(bubbleId) }
      }
      break
    }
    const totalItemCount = items.length
    const keptItems = items.slice(-256)
    return {
      isGenerating,
      response,
      // 写后快照始终是当前回合可见窗口的完整集合（含空集）：snapshotComplete
      // 标记本帧权威，服务层据此撤下缺席块。空集不坍缩成 undefined——否则
      // 「过滤后无可见过程」与「本帧无过程载荷」不可区分，旧块永远无法撤回。
      process: {
        turnId, items: keptItems, todos, generatingBubbleCount, snapshotComplete: true,
        truncatedItemCount: Math.max(0, totalItemCount - keptItems.length) || undefined
      }
    }
  }
  function scheduleProcessSnapshot(composerId) {
    if (!composerId) return
    pendingSnapshots.add(composerId)
    if (snapshotQueued) return
    snapshotQueued = true
    queueMicrotask(() => {
      snapshotQueued = false
      const service = globalThis.__qtComposerService?.composerDataService
      for (const id of pendingSnapshots) {
        try {
          const data = service?.getComposerDataIfLoaded?.(id)
          // 独立 usage binding：过程块裁剪/过滤不会吞掉计数。
          try {
            const usage = (${nativeUsagePayload.toString()})(data, id)
            if (usage && globalThis.${CURSOR_USAGE_BINDING_NAME}) globalThis.${CURSOR_USAGE_BINDING_NAME}(JSON.stringify(usage))
          } catch (usageError) { /* 计数链路异常不阻断过程流 */ }
          const snapshot = processSnapshot(data)
          if (snapshot && globalThis.${CURSOR_PROCESS_BINDING_NAME}) {
            let payload = JSON.stringify({ composerId: id, observedAt: Date.now(), ...snapshot })
            // 线径守卫：observer socket maxPayload 4MB。超长回合帧（256 项 × 24K 文本）
            // 可达 6MB，超限会杀死 socket——重连后同一巨帧再次超限，形成永久断连循环。
            // 先按字符数粗判，再按 UTF-8 字节精算，从头部分批裁剪并如实计入
            // truncatedItemCount：截断披露，绝不伪装完整。
            if (payload.length > 900_000 && snapshot.process && Array.isArray(snapshot.process.items)) {
              const measure = (text) => (typeof TextEncoder !== 'undefined'
                ? new TextEncoder().encode(text).length
                : text.length * 3)
              let bytes = measure(payload)
              while (bytes > 3_000_000 && snapshot.process.items.length > 8) {
                const drop = Math.max(1, Math.floor(snapshot.process.items.length / 4))
                snapshot.process.items = snapshot.process.items.slice(drop)
                snapshot.process.truncatedItemCount = (snapshot.process.truncatedItemCount || 0) + drop
                payload = JSON.stringify({ composerId: id, observedAt: Date.now(), ...snapshot })
                bytes = measure(payload)
              }
            }
            globalThis.${CURSOR_PROCESS_BINDING_NAME}(payload)
          }
        } catch (e) {}
      }
      pendingSnapshots.clear()
    })
  }
  globalThis.__sgTeamProcessSchedule = scheduleProcessSnapshot
  function install() {
    try {
      const svc = globalThis.__qtComposerService
      const manager = svc && svc.composerDataService && svc.composerDataService.composerDataHandleManager
      if (!manager) {
        if (++attempts <= 60) setTimeout(install, 2000)
        return 'no-manager'
      }
      const proto = Object.getPrototypeOf(manager)
      if (globalThis.__sgTeamStreamHook && globalThis.__sgTeamStreamHookManager === manager) {
        if (globalThis.__sgTeamStreamHookVersion === HOOK_VERSION) return 'already'
        // 拾光被强退时 dispose 无机会还原；新版必须主动替换旧 wrapper，不能因
        // boolean 幂等标记永远沿用旧语义（例如旧版“写前通知”）。
        const stale = globalThis.__sgTeamStreamOriginals || {}
        for (const name of Object.keys(stale)) {
          try { proto[name] = stale[name] } catch (e) {}
        }
      }
      const originals = {}
      let installed = 0
      for (const name of ['markDirty', 'markMessageDirty', 'updateWithoutMarkingDirty', 'pushComposer']) {
        const original = proto[name]
        if (typeof original !== 'function') continue
        if (original.__sgTeamStreamWrapped) { installed += 1; continue }
        originals[name] = original
        const wrapped = function (...args) {
          const signalAfterWrite = () => {
            try {
              const first = args[0]
              let composerId = ''
              if (typeof first === 'string') composerId = first
              else if (first && typeof first === 'object') composerId = String(first.composerId ?? first.id ?? '')
              if (composerId) globalThis.${CURSOR_STREAM_BINDING_NAME}(composerId)
              if (composerId) scheduleProcessSnapshot(composerId)
            } catch (e) {}
          }
          const result = original.apply(this, args)
          // 关键顺序：先让 Cursor 完成数据模型写入，再通知拾光读取；旧实现写前通知，
          // inspector 可能读到上一帧，最终状态甚至要等下一次写或轮询才能出现。
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).then(signalAfterWrite, signalAfterWrite)
          } else {
            signalAfterWrite()
          }
          return result
        }
        wrapped.__sgTeamStreamWrapped = true
        proto[name] = wrapped
        installed += 1
      }
      globalThis.__sgTeamStreamOriginals = originals
      globalThis.__sgTeamStreamHookManager = manager
      globalThis.__sgTeamStreamHook = installed > 0
      globalThis.__sgTeamStreamHookVersion = HOOK_VERSION
      // 重连/拾光重启后立即补发当前已加载 Composer，不等待下一次模型写入。
      try {
        const ids = new Set()
        const loaded = svc.composerDataService.getLoadedComposers?.() || []
        for (const item of loaded) ids.add(String(item?.composerId ?? item?.id ?? item ?? ''))
        for (const id of manager.loadedComposers?.ids || []) ids.add(String(id || ''))
        const handles = manager.composerDataHandles || manager.handles
        if (handles && typeof handles.keys === 'function') for (const id of handles.keys()) ids.add(String(id || ''))
        for (const id of ids) if (id) scheduleProcessSnapshot(id)
      } catch (e) {}
      return installed
    } catch (e) {
      if (++attempts <= 60) setTimeout(install, 2000)
      return 'error'
    }
  }
  return install()
})()`

/** 还原页面内 hook：恢复原型原始方法并清除全局标志（dispose 时尽力执行）。 */
const STREAM_HOOK_RESTORE_EXPRESSION = `(() => {
  const originals = globalThis.__sgTeamStreamOriginals
  if (originals) {
    try {
      const svc = globalThis.__qtComposerService
      const manager = svc && svc.composerDataService && svc.composerDataService.composerDataHandleManager
      const proto = manager && Object.getPrototypeOf(manager)
      if (proto) {
        for (const name of Object.keys(originals)) {
          try { proto[name] = originals[name] } catch (e) {}
        }
      }
    } catch (e) {}
  }
  delete globalThis.__sgTeamStreamOriginals
  delete globalThis.__sgTeamStreamHookManager
  delete globalThis.__sgTeamStreamHook
  delete globalThis.__sgTeamStreamHookVersion
  delete globalThis.__sgTeamProcessSchedule
  return 'restored'
})()`

/**
 * hook 存活探针（只读，不安装）：hook 是否在当前文档里以当前版本就位；
 * scheduler 存在而 hook 缺席 = 页面内 install 自轮询仍在等 manager。
 */
export const CURSOR_STREAM_HOOK_PROBE_EXPRESSION = `/* sg-team-hook-probe */ ({
  hook: globalThis.__sgTeamStreamHook === true,
  version: globalThis.__sgTeamStreamHookVersion,
  scheduler: typeof globalThis.__sgTeamProcessSchedule
})`

interface HookProbe {
  /** hook 已在当前文档验证就位（版本匹配）。 */
  alive: boolean
  /** 页面内 install 链是否仍在自轮询等待 manager。 */
  pendingInstall: boolean
}

/** 测试可注入的最小 socket 面（对齐 ws 事件子集）。 */
export interface StreamObserverSocket {
  send(text: string): void
  close(): void
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export interface CursorStreamObserverOptions {
  port?: number
  fetchPageSocketUrl?: (port: number, timeoutMs: number) => Promise<string | undefined>
  openSocket?: (webSocketDebuggerUrl: string) => StreamObserverSocket
  /** 写信号回调：Cursor 每次模型写入（含持久化批次）即触发。 */
  onWriteSignal?: (composerId: string, at: number) => void
  /** 用量事件回调：bundle 补丁在每个回合 turnEnded 推送真实计费 token。 */
  onUsageEvent?: (event: CursorUsageEvent) => void
  onUsageSample?: (sample: CursorUsageSample) => void
  /** Cursor 内存模型写后直接推送的原生顺序过程快照。 */
  onProcessEvent?: (event: CursorNativeProcessEvent) => void
  onStatus?: (status: { state: 'connected' | 'reconnecting' | 'unavailable'; detail: string; updatedAt: number }) => void
}

/** 写后快照携带的当前回合流式正文（最后一个其后无业务工作的正文气泡）。 */
export interface CursorNativeResponse {
  /** Cursor 原生 bubbleId；与 runtime inspect 的 responseId 同源，可跨来源合并。 */
  id: string
  text: string
}

export interface CursorNativeProcessEvent {
  composerId: string
  observedAt: number
  isGenerating: boolean
  process?: CursorProcessStream
  response?: CursorNativeResponse
}

/** 宽容解析写后快照里的正文载荷；缺失/非法时返回 undefined（不影响过程帧）。 */
export function parseNativeResponse(value: unknown): CursorNativeResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 200) : ''
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 100_000) : ''
  if (!id || !text) return undefined
  return { id, text }
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class CursorStreamObserver {
  private readonly port: number
  private readonly fetchPageSocketUrl: NonNullable<CursorStreamObserverOptions['fetchPageSocketUrl']>
  private readonly openSocket: NonNullable<CursorStreamObserverOptions['openSocket']>
  private readonly onWriteSignal: NonNullable<CursorStreamObserverOptions['onWriteSignal']>
  private readonly onUsageEvent: NonNullable<CursorStreamObserverOptions['onUsageEvent']>
  private readonly onUsageSample: NonNullable<CursorStreamObserverOptions['onUsageSample']>
  private readonly onProcessEvent: NonNullable<CursorStreamObserverOptions['onProcessEvent']>
  private readonly onStatus: NonNullable<CursorStreamObserverOptions['onStatus']>
  private socket?: StreamObserverSocket
  private seq = 0
  private readonly pending = new Map<number, PendingCall>()
  private stopped = false
  private retryAttempts = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private attaching = false
  /** 已注册的 new-document 脚本标识：重连前移除旧的，防止 target 上脚本累积。 */
  private newDocumentScriptId?: string
  /** hook 已在当前文档验证就位；文档重载（executionContextsCleared）即清零。 */
  private hookVerified = false
  private ensuringHook = false
  private hookHealthTimer?: ReturnType<typeof setInterval>
  private hookSettleTimer?: ReturnType<typeof setTimeout>
  private lastStatus?: { state: 'connected' | 'reconnecting' | 'unavailable'; detail: string }

  constructor(options: CursorStreamObserverOptions = {}) {
    const envPort = Number(process.env.QINGTIAN_CURSOR_CDP_PORT)
    this.port = options.port
      ?? (Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : 9333)
    this.fetchPageSocketUrl = options.fetchPageSocketUrl ?? defaultFetchPageSocketUrl
    this.openSocket = options.openSocket ?? defaultOpenSocket
    this.onWriteSignal = options.onWriteSignal ?? (() => {})
    this.onUsageEvent = options.onUsageEvent ?? (() => {})
    this.onUsageSample = options.onUsageSample ?? (() => {})
    this.onProcessEvent = options.onProcessEvent ?? (() => {})
    this.onStatus = options.onStatus ?? (() => {})
  }

  get connected(): boolean {
    return this.socket !== undefined
  }

  /** 幂等附加：解析 workbench 窗口 → 持久连接 → binding + hook 注入。失败退避重试。 */
  async attach(): Promise<boolean> {
    if (this.stopped || this.socket || this.attaching) return this.socket !== undefined
    this.attaching = true
    try {
      const webSocketDebuggerUrl = await this.fetchPageSocketUrl(this.port, ATTACH_TIMEOUT_MS)
      if (this.stopped) return false
      if (!webSocketDebuggerUrl) throw new Error('未找到 Cursor workbench 窗口')
      const socket = this.openSocket(webSocketDebuggerUrl)
      this.socket = socket
      this.retryAttempts = 0
      socket.on('message', (data) => {
        if (this.socket === socket) this.handleMessage(data)
      })
      socket.on('close', () => this.handleDisconnect(socket))
      socket.on('error', () => undefined)
      // 等待连接建立：ws 在 open 前 send 会抛错；握手失败（error）立即失败而非等满超时
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('observer socket 未在时限内建立')), ATTACH_TIMEOUT_MS)
        socket.on('open', () => { clearTimeout(timer); resolve(undefined) })
        socket.on('error', () => { clearTimeout(timer); reject(new Error('observer socket 连接失败')) })
      })
      if (this.stopped) throw new Error('observer disposed during attach')
      await this.call('Runtime.enable', {})
      await this.call('Runtime.addBinding', { name: CURSOR_STREAM_BINDING_NAME })
      await this.call('Runtime.addBinding', { name: CURSOR_USAGE_BINDING_NAME })
      await this.call('Runtime.addBinding', { name: CURSOR_PROCESS_BINDING_NAME })
      // Page 域不启用时 addScriptToEvaluateOnNewDocument 只登记不执行（Chromium 语义，
      // Electron 43 实测）：窗口原地重载后 hook 就此消失而 socket 仍然连着。
      // 启用失败不阻断 attach——下方的 executionContext 事件重装仍能兜底。
      try {
        await this.call('Page.enable', {})
      } catch (error) {
        process.stderr.write(`[cursor-stream-observer] Page.enable 失败，仅依赖上下文事件重装 hook：${error instanceof Error ? error.message : String(error)}\n`)
      }
      // 上一次连接注册的 new-document 脚本在 target 上持久存在——先移除再注册，
      // 防止重连累积（脚本幂等但重复注册浪费且语义模糊）。
      if (this.newDocumentScriptId) {
        try {
          await this.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.newDocumentScriptId })
        } catch { /* 尽力而为 */ }
        this.newDocumentScriptId = undefined
      }
      const added = await this.call('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR_STREAM_HOOK_EXPRESSION })
      const identifier = (added as { identifier?: unknown } | undefined)?.identifier
      this.newDocumentScriptId = typeof identifier === 'string' && identifier ? identifier : undefined
      // 已加载文档立即安装并验证；脚本异常（exceptionDetails）视为 attach 失败重试，
      // 不再把「socket 开着」误报成「过程流已连接」。
      await this.ensureHook('install')
      this.startHookHealthLoop()
      return true
    } catch (error) {
      // 半途失败必须关闭已建立的 socket，否则泄漏连接且 retry 另建新连接。
      const socket = this.socket
      this.socket = undefined
      this.hookVerified = false
      this.stopHookHealthLoop()
      try { socket?.close() } catch { /* 尽力而为 */ }
      this.setStatus('reconnecting', error instanceof Error ? error.message.slice(0, 240) : 'Cursor 原生过程流连接失败')
      this.scheduleRetry()
      return false
    } finally {
      this.attaching = false
    }
  }

  /**
   * 确保 hook 在当前文档就位并据此上报状态。
   * - install：直接注入（幂等：已装返回 'already'）再探针验证——attach / 文档重载后使用；
   * - probe：先只读探针，缺席才注入——健康自检使用（注入本身幂等，页面内自轮询链
   *   等到 manager 后各自收敛为 'already'）。
   * evaluate 的脚本异常与协议错误向上抛：attach 里转为重连，其余路径由调用方兜住。
   */
  private async ensureHook(mode: 'install' | 'probe'): Promise<boolean> {
    if (!this.socket || this.ensuringHook) return this.hookVerified
    this.ensuringHook = true
    try {
      let probe = mode === 'install' ? await this.installHook() : await this.probeHook()
      if (!probe.alive && mode === 'probe') probe = await this.installHook()
      this.hookVerified = probe.alive
      if (probe.alive) {
        this.setStatus('connected', 'Cursor 原生过程流已连接')
      } else {
        this.setStatus('reconnecting', probe.pendingInstall
          ? '等待 Cursor 工作台就绪后安装过程 hook'
          : '过程 hook 未就位，正在重装')
      }
      return probe.alive
    } finally {
      this.ensuringHook = false
    }
  }

  private async installHook(): Promise<HookProbe> {
    await this.evaluateChecked(CURSOR_STREAM_HOOK_EXPRESSION)
    return this.probeHook()
  }

  private async probeHook(): Promise<HookProbe> {
    const value = await this.evaluateChecked(CURSOR_STREAM_HOOK_PROBE_EXPRESSION)
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const alive = raw.hook === true && raw.version === CURSOR_STREAM_HOOK_VERSION
    return { alive, pendingInstall: !alive && raw.scheduler === 'function' }
  }

  /** Runtime.evaluate 并把页面脚本异常（exceptionDetails）转成错误，而不是静默当成功。 */
  private async evaluateChecked(expression: string): Promise<unknown> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true }) as {
      result?: { value?: unknown }
      exceptionDetails?: { text?: unknown; exception?: { description?: unknown } }
    } | undefined
    const exception = result?.exceptionDetails
    if (exception) {
      const detail = exception.exception?.description ?? exception.text ?? 'unknown'
      throw new Error(`页面脚本异常：${String(detail).replace(/\s+/g, ' ').slice(0, 200)}`)
    }
    return result?.result?.value
  }

  private startHookHealthLoop(): void {
    this.stopHookHealthLoop()
    this.hookHealthTimer = setInterval(() => {
      if (!this.socket || this.stopped) return
      void this.ensureHook('probe').catch((error) => {
        this.setStatus('reconnecting', `过程 hook 自检失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`)
      })
    }, HOOK_HEALTH_INTERVAL_MS)
    this.hookHealthTimer.unref?.()
  }

  private stopHookHealthLoop(): void {
    if (this.hookHealthTimer) clearInterval(this.hookHealthTimer)
    this.hookHealthTimer = undefined
    if (this.hookSettleTimer) clearTimeout(this.hookSettleTimer)
    this.hookSettleTimer = undefined
  }

  /** 新文档的执行上下文就位后重装 hook（主帧与 iframe 的事件成批到达，合并一次）。 */
  private scheduleHookReinstall(): void {
    if (this.hookSettleTimer || this.stopped) return
    this.hookSettleTimer = setTimeout(() => {
      this.hookSettleTimer = undefined
      if (!this.socket || this.hookVerified) return
      void this.ensureHook('install').catch((error) => {
        // 导航中途上下文可能再次销毁：交给下一次 executionContextCreated / 健康自检重试。
        this.setStatus('reconnecting', `重装过程 hook 失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`)
      })
    }, HOOK_CONTEXT_SETTLE_MS)
    this.hookSettleTimer.unref?.()
  }

  /** 状态去重：同一 (state, detail) 不重复上报，健康自检每拍不制造快照噪音。 */
  private setStatus(state: 'connected' | 'reconnecting' | 'unavailable', detail: string): void {
    if (this.lastStatus?.state === state && this.lastStatus.detail === detail) return
    this.lastStatus = { state, detail }
    this.onStatus({ state, detail, updatedAt: Date.now() })
  }

  dispose(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.stopHookHealthLoop()
    this.hookVerified = false
    const socket = this.socket
    this.socket = undefined
    for (const pending of this.pending.values()) pending.reject(new Error('observer disposed'))
    this.pending.clear()
    // 离场不留痕（尽力而为，fire-and-forget）：还原页面内原型包装 + 移除注入脚本。
    // 不还原的话，退出后 Cursor 每次模型写入都会调用死 binding，直到窗口重载。
    if (socket) {
      try {
        socket.send(JSON.stringify({
          id: ++this.seq,
          method: 'Runtime.evaluate',
          params: { expression: STREAM_HOOK_RESTORE_EXPRESSION, returnByValue: true }
        }))
      } catch { /* 尽力而为 */ }
      if (this.newDocumentScriptId) {
        try {
          socket.send(JSON.stringify({
            id: ++this.seq,
            method: 'Page.removeScriptToEvaluateOnNewDocument',
            params: { identifier: this.newDocumentScriptId }
          }))
        } catch { /* 尽力而为 */ }
      }
    }
    this.newDocumentScriptId = undefined
    try { socket?.close() } catch { /* 尽力而为 */ }
    this.setStatus('unavailable', 'Cursor 原生过程观察器已停止')
  }

  private handleMessage(data: unknown): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      // 页面原地重载/导航：旧文档连同 hook 一起消失，socket 与 target 却不变。
      // 立即撤销 connected——在新文档验证就位前，过程流事实上不存在。
      this.hookVerified = false
      this.setStatus('reconnecting', 'Cursor 工作台已重载，正在重新安装过程 hook')
      return
    }
    if (message.method === 'Runtime.executionContextCreated') {
      const context = (message.params as { context?: { auxData?: { isDefault?: unknown } } } | undefined)?.context
      // 只认主世界（isDefault）：扩展/隔离世界里没有 Cursor 的 composer 服务。
      if (context?.auxData?.isDefault === true && !this.hookVerified) this.scheduleHookReinstall()
      return
    }
    if (message.method === 'Runtime.bindingCalled') {
      const params = message.params as { name?: unknown; payload?: unknown } | undefined
      if (params?.name === CURSOR_STREAM_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
        this.onWriteSignal(params.payload.slice(0, 120), Date.now())
      }
      if (params?.name === CURSOR_PROCESS_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
        try {
          const raw = JSON.parse(params.payload) as Record<string, unknown>
          const composerId = typeof raw.composerId === 'string' ? raw.composerId.trim().slice(0, 120) : ''
          if (composerId) {
            this.onProcessEvent({
              composerId,
              observedAt: typeof raw.observedAt === 'number' ? raw.observedAt : Date.now(),
              isGenerating: raw.isGenerating === true,
              process: parseProcessStream(raw.process),
              response: parseNativeResponse(raw.response)
            })
          }
        } catch {
          // 单个坏帧不影响后续原生过程事件。
        }
      }
      if (params?.name === CURSOR_USAGE_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
        this.dispatchUsagePayload(params.payload)
      }
    }
  }

  /** 写后样本/结算共用 binding；旧补丁无 generation 的事件仅兼容解析。 */
  private dispatchUsagePayload(payload: string): void {
    try {
      const raw = JSON.parse(payload) as Record<string, unknown>
      const composerId = typeof raw.c === 'string' ? raw.c.trim() : ''
      if (!composerId) return
      const generationId = typeof raw.g === 'string' && raw.g.length <= 200 ? raw.g : undefined
      const modelId = typeof raw.m === 'string' ? raw.m.slice(0, 160) : undefined
      if (raw.kind === 'sample') {
        if (generationId && typeof raw.used === 'number' && Number.isSafeInteger(raw.used) && raw.used > 0) {
          this.onUsageSample({ composerId, generationId, modelId, used: raw.used,
            ...(raw.stopped === true ? { stopped: true } : {}),
            occurredAt: typeof raw.t === 'number' ? raw.t : Date.now() })
        }
        return
      }
      if ([raw.i, raw.o, raw.r, raw.w].some((value) => value !== undefined
        && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))) return
      const toCount = (value: unknown): number => {
        const num = Number(value ?? 0)
        return Number.isFinite(num) && num > 0 ? num : 0
      }
      this.onUsageEvent({
        composerId,
        ...(generationId ? { generationId } : {}),
        ...(modelId ? { modelId } : {}),
        inputTokens: toCount(raw.i),
        outputTokens: toCount(raw.o),
        cacheReadTokens: toCount(raw.r),
        cacheWriteTokens: toCount(raw.w),
        occurredAt: toCount(raw.t) || Date.now()
      })
    } catch {
      // 非法 JSON / 结构漂移：丢弃，不影响写信号通道
    }
  }

  private handleDisconnect(source: StreamObserverSocket): void {
    // 旧 socket 的迟到 close 不得清掉重连后已就位的新 socket。
    if (this.socket !== source) return
    this.socket = undefined
    this.hookVerified = false
    this.stopHookHealthLoop()
    for (const pending of this.pending.values()) pending.reject(new Error('observer disconnected'))
    this.pending.clear()
    this.setStatus('reconnecting', 'Cursor 原生过程流已断开，正在重连')
    if (!this.stopped) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempts, RETRY_MAX_MS)
    this.retryAttempts += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.attach()
    }, delay)
    this.retryTimer.unref?.()
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('observer not attached'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`observer call timeout: ${method}`))
      }, ATTACH_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

async function defaultFetchPageSocketUrl(port: number, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal })
    if (!response.ok) return undefined
    const targets = await response.json() as Array<Record<string, unknown>>
    const page = targets.find((target) => (
      target.type === 'page'
      && typeof target.webSocketDebuggerUrl === 'string'
      && target.webSocketDebuggerUrl.startsWith('ws')
      && typeof target.url === 'string'
      && /workbench/i.test(target.url)
    ))
    return page ? page.webSocketDebuggerUrl as string : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function defaultOpenSocket(webSocketDebuggerUrl: string): StreamObserverSocket {
  const socket = new WebSocket(webSocketDebuggerUrl, {
    handshakeTimeout: 5_000,
    maxPayload: 4 * 1024 * 1024
  })
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
    // ws 的 on 签名兼容（多事件重载按需绑定）
    on: (event, listener) => {
      if (event === 'open') socket.on('open', listener as () => void)
      else if (event === 'message') socket.on('message', listener as (data: unknown) => void)
      else if (event === 'close') socket.on('close', listener as () => void)
      else socket.on('error', listener as (error: Error) => void)
    }
  }
}
