import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import { attachmentNameFor, ComposerWorkbench, filesFromTransfer } from '../src/renderer/src/ComposerWorkbench'

const session: AgentSession = {
  id: 'session-1',
  channelId: '2',
  generation: 1,
  displayName: '架构实现',
  roleName: '实现席',
  status: 'waiting',
  currentTask: '',
  queueDepth: 0,
  connectionPhase: 'keepalive',
  online: true,
  connected: true,
  waiting: true,
  workingFiles: [],
  healthEvidence: [],
  telemetry: { state: 'bound', detail: 'Cursor 已绑定' }
}

describe('ComposerWorkbench', () => {
  it('renders the focused composer toolbar, duration and attached files', () => {
    const html = renderToStaticMarkup(
      <ComposerWorkbench
        session={session}
        draft="当前草稿"
        canSend
        notWaiting={false}
        submitting={false}
        sendError=""
        onDraftChange={() => {}}
        onSubmit={() => {}}
        attachments={[{
          id: 'att-1',
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 2048,
          data: 'IyByZXBvcnQ='
        }]}
        onAttachmentsChange={() => {}}
      />
    )

    expect(html).not.toContain('composer-quick-prompts')
    expect(html).toContain('title="添加图片或文件附件"')
    expect(html).toContain('report.md')
    expect(html).toContain('2.0 KB')
    expect(html).not.toContain('session-usage')
    expect(html).not.toContain('composer-binding-status')
    expect(html).toContain('composer-queue-popover')
    expect(html).toContain('composer-duration is-running')
    expect(html).toContain('composer-duration__text')
    expect(html).toContain('aria-label="会话运行时间：')
    expect(html).toContain('队列为空')
    expect(html).toContain('Agent 正在监听：下一条消息会立即投递')
  })

  it('lists queued messages in the queue popover with withdraw and release actions', () => {
    const html = renderToStaticMarkup(
      <ComposerWorkbench
        session={{ ...session, queueDepth: 3, waiting: false, status: 'running', connectionPhase: 'processing' }}
        draft=""
        canSend
        notWaiting
        submitting={false}
        sendError=""
        onDraftChange={() => {}}
        onSubmit={() => {}}
        queuedEntries={[
          {
            id: 'outbox:a', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
            timestamp: new Date(2026, 8, 4, 20, 5).getTime(), text: '先把队列弹层收尾'
          },
          {
            id: 'outbox:b', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
            timestamp: new Date(2026, 8, 4, 20, 6).getTime(), text: '【会话交接】来自 CH-1', heldForNextSession: true,
            attachments: [{ id: 'att', name: 'a.png', mimeType: 'image/png', size: 10 }]
          }
        ]}
        onWithdrawQueued={() => {}}
        onReleaseQueued={() => {}}
      />
    )
    // 数字口径 = 服务端计数（含 1 条内部静默消息），列表口径 = 用户可见条目
    expect(html).toContain('队列 <b>3</b>')
    expect(html).toContain('另有 1 条系统内部消息在队列中')
    expect(html).toContain('Agent 正在处理当前任务：新消息按顺序等待')
    expect(html).toContain('先把队列弹层收尾')
    expect(html).toContain('等待新会话')
    expect(html).toContain('1 个附件')
    expect(html).toContain('composer-queue-item is-held')
    // 撤回对每条可用，放行只对保持位消息出现
    expect(html.match(/>撤回</g)?.length).toBe(2)
    expect(html.match(/>放行</g)?.length).toBe(1)
    // 芯片上的保持位角标
    expect(html).toContain('composer-queue-status__held')
  })

  it('renders send errors as alerts without hiding the draft', () => {
    const html = renderToStaticMarkup(
      <ComposerWorkbench
        session={{ ...session, online: false, connected: false, status: 'offline' }}
        draft="稍后发送"
        canSend={false}
        notWaiting={false}
        submitting={false}
        sendError="Agent 当前离线"
        onDraftChange={() => {}}
        onSubmit={() => {}}
      />
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('Agent 当前离线')
    expect(html).toContain('稍后发送')
    expect(html).toContain('composer-duration is-inactive')
  })

  it('uses the current project name as the composer chip primary label', () => {
    const html = renderToStaticMarkup(
      <ComposerWorkbench
        session={{ ...session, online: false, connected: false, status: 'offline', deliveryMode: 'queued' }}
        currentProjectName="demo-app"
        draft=""
        canSend
        notWaiting={false}
        submitting={false}
        sendError=""
        onDraftChange={() => {}}
        onSubmit={() => {}}
      />
    )

    expect(html).toContain('<strong>demo-app</strong>')
    expect(html).toContain('Agent 离线')
    expect(html).not.toContain('<strong>Agent 离线</strong>')
  })

  it('extracts copied or dropped files from DataTransfer files first', () => {
    const copied = { name: 'copied.png', type: 'image/png', size: 12 } as File
    const item = { name: 'item.png', type: 'image/png', size: 18 } as File
    expect(filesFromTransfer({
      files: [copied],
      items: [{ kind: 'file', getAsFile: () => item }]
    })).toEqual([copied])
  })

  it('falls back to DataTransfer items for clipboard images', () => {
    const image = { name: '', type: 'image/png', size: 32 } as File
    expect(filesFromTransfer({
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => image }
      ]
    })).toEqual([image])
    expect(attachmentNameFor(image, 0)).toBe('clipboard-image-1.png')
  })

  it('prefers clipboard file payloads when text/plain is present in the same paste', () => {
    const image = { name: 'shot.png', type: 'image/png', size: 11 } as File
    const fallback = { name: 'fallback.png', type: 'image/png', size: 12 } as File
    expect(filesFromTransfer({
      files: [image],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => fallback }
      ]
    })).toEqual([image])
  })
})
