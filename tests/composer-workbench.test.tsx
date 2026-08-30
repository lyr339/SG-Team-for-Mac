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
  it('renders quick prompts, attachment affordance and attached files', () => {
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

    expect(html).toContain('快捷提示词')
    expect(html).toContain('按建议来，做之前深度分析审查')
    expect(html).toContain('title="添加图片或文件附件"')
    expect(html).toContain('report.md')
    expect(html).toContain('2.0 KB')
    expect(html).toContain('Token 待读取')
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
  })

  it('uses the current project name as the composer chip primary label', () => {
    const html = renderToStaticMarkup(
      <ComposerWorkbench
        session={{ ...session, online: false, connected: false, status: 'offline', deliveryMode: 'queued' }}
        currentProjectName="qingtian"
        draft=""
        canSend
        notWaiting={false}
        submitting={false}
        sendError=""
        onDraftChange={() => {}}
        onSubmit={() => {}}
      />
    )

    expect(html).toContain('<strong>qingtian</strong>')
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
