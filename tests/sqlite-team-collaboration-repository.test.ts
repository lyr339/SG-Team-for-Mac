import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConfiguredTeamBundle, createDefaultTeamBundle } from '../src/domain/team-control'
import { teamMessageReceiptStage } from '../src/domain/team-collaboration'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'

function fixture(workspaceId = 'alpha') {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-collaboration-')), 'team.sqlite3')
  const team = new SqliteTeamControlRepository(path)
  const bundle = createDefaultTeamBundle({
    workspaceId,
    workspaceName: workspaceId,
    workspacePath: `/workspace/${workspaceId}`,
    channelIds: ['1', '2', '3'],
    now: 100
  })
  team.upsertWorkspaceTeam(bundle)
  team.recordInstallation({
    workspaceId,
    runId: bundle.run.id,
    generation: 'generation123',
    agents: bundle.slots.map((slot) => ({
      agentSessionId: `${workspaceId}:ch-${slot.channelId}:generation123`,
      workspaceId,
      channelId: slot.channelId!,
      generation: 'generation123',
      runId: bundle.run.id,
      capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
    }))
  })
  const repository = new SqliteTeamCollaborationRepository(path)
  const slot = (key: string) => {
    const role = bundle.roles.find((candidate) => candidate.key === key)!
    return bundle.slots.find((candidate) => candidate.roleId === role.id)!
  }
  const identity = (key: string) => {
    const role = bundle.roles.find((candidate) => candidate.key === key)!
    const currentSlot = slot(key)
    return {
      agentSessionId: `${workspaceId}:ch-${currentSlot.channelId}:generation123`,
      runId: bundle.run.id,
      slotId: currentSlot.id,
      capabilities: [...role.capabilities]
    }
  }
  return { path, team, bundle, repository, slot, identity }
}

describe('SqliteTeamCollaborationRepository', () => {
  it('excludes solo seats from the collaboration member directory at the SQL boundary', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-collaboration-solo-')), 'team.sqlite3')
    const team = new SqliteTeamControlRepository(path)
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'solo-directory', workspaceName: 'solo-directory', workspacePath: '/workspace/solo-directory', now: 100,
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] },
        { channelId: '3', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
      ]
    })
    team.upsertWorkspaceTeam(bundle)
    const repository = new SqliteTeamCollaborationRepository(path)
    try {
      expect(repository.listRunMembers(bundle.run.id).map((member) => member.slotId)).toEqual([
        bundle.slots[0]!.id,
        bundle.slots[1]!.id
      ])
    } finally {
      repository.close()
      team.close()
    }
  })

  it('persists one idempotent directive and advances explicit receipts monotonically', () => {
    const data = fixture()
    try {
      const lead = data.repository.resolveAuthorizedAgent(data.identity('lead'))
      const builder = data.repository.resolveAuthorizedAgent(data.identity('builder'))
      const input = {
        runId: data.bundle.run.id,
        sender: { type: 'agent' as const, slotId: lead.slotId },
        recipient: { type: 'agent' as const, slotId: builder.slotId },
        kind: 'directive' as const,
        content: '请实现接口层，并按验收标准提交证据。',
        clientMessageId: 'lead-directive-0001',
        subject: '实现接口层'
      }

      const first = data.repository.createMessage(input)
      const duplicate = data.repository.createMessage(input)
      expect(duplicate.id).toBe(first.id)
      expect(data.repository.loadRun(data.bundle.run.id).messageOrder).toEqual([first.id])
      expect(teamMessageReceiptStage(first.receipt)).toBe('queued')

      data.repository.markNotificationSending(first.id, 'command-1')
      let message = data.repository.markNotificationResult(first.id, 'notified', '晴天已确认投递')
      expect(teamMessageReceiptStage(message.receipt)).toBe('notified')
      message = data.repository.markNotificationResult(first.id, 'failed', '迟到的失败回执')
      expect(message.receipt.notificationState).toBe('notified')
      message = data.repository.markRead(first.id, { type: 'agent', slotId: builder.slotId })
      expect(teamMessageReceiptStage(message.receipt)).toBe('read')
      message = data.repository.acknowledge(first.id, { type: 'agent', slotId: builder.slotId })
      expect(teamMessageReceiptStage(message.receipt)).toBe('acknowledged')

      message = data.repository.markNotificationResult(first.id, 'failed', '迟到的失败回执')
      expect(teamMessageReceiptStage(message.receipt)).toBe('acknowledged')
      expect(data.repository.loadRun(data.bundle.run.id).events.map((event) => event.type)).toContain('message.acknowledged')
    } finally {
      data.repository.close()
      data.team.close()
    }
  })

  it('recovers an orphaned sending receipt as uncertain without retrying it', () => {
    const data = fixture()
    try {
      const message = data.repository.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: data.slot('lead').id },
        recipient: { type: 'agent', slotId: data.slot('builder').id },
        kind: 'directive',
        content: '模拟应用在投递中崩溃。',
        clientMessageId: 'orphaned-sending-0001'
      })
      data.repository.markNotificationSending(message.id, 'orphan-command', 'sending', 1_000)
      expect(data.repository.recoverStaleSending(2_000)).toBe(1)
      expect(data.repository.loadRun(data.bundle.run.id).messages[message.id]?.receipt)
        .toMatchObject({ notificationState: 'uncertain' })
      expect(data.repository.recoverStaleSending(Date.now())).toBe(0)
      expect(data.repository.listPendingNotifications(data.bundle.run.id)).toEqual([])
    } finally {
      data.repository.close()
      data.team.close()
    }
  })

  it('correlates a response to the original message and wakes the original sender', () => {
    const data = fixture()
    try {
      const leadSlot = data.slot('lead')
      const builderSlot = data.slot('builder')
      const directive = data.repository.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: leadSlot.id },
        recipient: { type: 'agent', slotId: builderSlot.id },
        kind: 'directive',
        content: '请完成接口重构。',
        clientMessageId: 'lead-directive-0002'
      })
      data.repository.markRead(directive.id, { type: 'agent', slotId: builderSlot.id })
      const response = data.repository.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: builderSlot.id },
        recipient: { type: 'agent', slotId: leadSlot.id },
        kind: 'response',
        content: '已完成接口重构并提交测试证据。',
        clientMessageId: 'builder-response-0001',
        replyToMessageId: directive.id
      })

      const snapshot = data.repository.loadRun(data.bundle.run.id)
      expect(teamMessageReceiptStage(snapshot.messages[directive.id]!.receipt)).toBe('responded')
      expect(snapshot.messages[directive.id]!.receipt.responseMessageId).toBe(response.id)
      expect(data.repository.listPendingNotifications(data.bundle.run.id).map((message) => message.id))
        .toContain(response.id)

      expect(() => data.repository.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: data.slot('reviewer').id },
        recipient: { type: 'agent', slotId: leadSlot.id },
        kind: 'response',
        content: '伪造回复',
        clientMessageId: 'reviewer-response-01',
        replyToMessageId: directive.id
      })).toThrowError(/回复双方必须/)
    } finally {
      data.repository.close()
      data.team.close()
    }
  })

  it('supports operator-to-agent threads without pretending the operator needs a channel notification', () => {
    const data = fixture()
    try {
      const builderSlot = data.slot('builder')
      const question = data.repository.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: builderSlot.id },
        kind: 'question',
        content: '当前实现还需要我确认什么？',
        clientMessageId: 'operator-question-01'
      })
      expect(data.repository.listPendingNotifications(data.bundle.run.id).map((message) => message.id))
        .toEqual([question.id])
      const response = data.repository.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: builderSlot.id },
        recipient: { type: 'operator' },
        kind: 'response',
        content: '请确认旧接口是否需要兼容。',
        clientMessageId: 'builder-operator-response-01',
        replyToMessageId: question.id
      })

      expect(response.receipt.notificationState).toBe('not_required')
      expect(teamMessageReceiptStage(response.receipt)).toBe('notified')
      expect(data.repository.listPendingNotifications(data.bundle.run.id).map((message) => message.id))
        .toEqual([])
    } finally {
      data.repository.close()
      data.team.close()
    }
  })

  it('keeps identical reinstallations authorized and rejects a mismatched stable AgentSlot', () => {
    const data = fixture()
    try {
      const oldIdentity = data.identity('lead')
      expect(() => data.repository.resolveAuthorizedAgent({
        ...oldIdentity,
        slotId: data.slot('builder').id
      })).toThrowError(/AgentSlot/)

      data.team.recordInstallation({
        workspaceId: 'alpha',
        runId: data.bundle.run.id,
        generation: 'generation456',
        agents: data.bundle.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:generation456`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation: 'generation456',
          runId: data.bundle.run.id,
          capabilities: data.bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      expect(() => data.repository.resolveAuthorizedAgent(oldIdentity)).not.toThrow()
    } finally {
      data.repository.close()
      data.team.close()
    }
  })

  it('clears persisted collaboration state for a recreated run', () => {
    const data = fixture()
    try {
      data.repository.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: data.slot('lead').id },
        recipient: { type: 'operator' },
        kind: 'status',
        content: '上一轮遗留状态消息。',
        clientMessageId: 'operator-stale-status-0001'
      })
      data.repository.recordLiveness({
        channelId: '1',
        runId: data.bundle.run.id,
        verified: true,
        at: 1_500
      })

      const previousRevision = data.repository.revision()
      expect(data.repository.loadRun(data.bundle.run.id).messageOrder).toHaveLength(1)
      expect(data.repository.listLiveness(data.bundle.run.id)).toHaveLength(1)

      expect(data.repository.clearRun(data.bundle.run.id, 2_000)).toBe(true)
      const snapshot = data.repository.loadRun(data.bundle.run.id)
      expect(snapshot.revision).toBe(previousRevision + 1)
      expect(snapshot.messageOrder).toEqual([])
      expect(snapshot.threads).toEqual([])
      expect(snapshot.events).toEqual([])
      expect(data.repository.listLiveness(data.bundle.run.id)).toEqual([])
      expect(data.repository.clearRun(data.bundle.run.id, 3_000)).toBe(false)
    } finally {
      data.repository.close()
      data.team.close()
    }
  })

  it('rejects stale authorization after the team channel topology changes', () => {
    const data = fixture()
    try {
      const oldIdentity = data.identity('builder')
      const changed = createDefaultTeamBundle({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        channelIds: ['1', '3'],
        now: 200
      })
      data.team.upsertWorkspaceTeam(changed)

      expect(() => data.repository.resolveAuthorizedAgent(oldIdentity)).toThrowError(/已被撤销/)
    } finally {
      data.repository.close()
      data.team.close()
    }
  })
})
