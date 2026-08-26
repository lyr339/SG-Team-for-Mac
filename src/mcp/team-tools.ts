import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { TaskAgentService } from '../application/task-agent-service'
import type { TeamCollaborationAgentService } from '../application/team-collaboration-agent-service'
import type { TeamMemoryAgentService } from '../application/team-memory-agent-service'
import type { TeamControlRepository } from '../application/team-control-repository'
import { buildChannelWaitInstruction } from '../domain/channel-wait-policy'
import { QUNSHU_MCP_SERVER_NAME } from '../domain/channel-message'
import { TaskPoolError } from '../domain/task-pool'

/** 单通道运行时：统一服务器按 channel_id 懒加载并缓存。 */
export interface TeamChannelRuntime {
  service: TaskAgentService
  collaboration?: TeamCollaborationAgentService
  memory?: TeamMemoryAgentService
  controlRepository?: TeamControlRepository
}

export interface TeamToolsDeps {
  /** 解析/缓存通道运行时；未注册通道抛授权错误（围栏兜底）。 */
  runtimeFor(channelId: string): TeamChannelRuntime
  refreshIdentity?: (channelId: string) => void
  /** team_check_in 返回的角色简报（S4 底层注入）。 */
  briefingFor?: (channelId: string) => string | undefined
  /** 单服务器暴露角色超集；实际权限按每次调用的身份围栏校验。 */
  exposeAllRoleTools?: boolean
}

/** 所有工具必传 channel_id：单 MCP 条目下区分通道的唯一参数。 */
const channelSchema = {
  channel_id: z.string().regex(/^\d+$/)
    .describe('群枢分配给当前 Agent 的通道号（如 "2"），启动指令中声明，每次调用必传')
}

function waitingAction(channelId: string): Record<string, string> {
  return {
    type: 'enter_channel_wait',
    channelId,
    communicationServer: QUNSHU_MCP_SERVER_NAME,
    instruction: buildChannelWaitInstruction({
      channelId,
      communicationServerName: QUNSHU_MCP_SERVER_NAME
    })
  }
}

function toolSuccess(agentSessionId: string, data: Record<string, unknown>) {
  const payload = { ok: true, agentSessionId, ...data }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  }
}

function toolFailure(agentSessionId: string, error: unknown) {
  const payload = {
    ok: false,
    agentSessionId,
    code: error instanceof TaskPoolError ? error.code : 'internal_error',
    message: error instanceof Error ? error.message : String(error)
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true
  }
}

function taskStatusResult(
  collaboration: TeamCollaborationAgentService | undefined,
  input: Parameters<TeamCollaborationAgentService['reportTaskStatus']>[0]
): Record<string, unknown> {
  if (!collaboration) return {}
  try {
    const coordinationMessage = collaboration.reportTaskStatus(input)
    return coordinationMessage ? { coordinationMessage } : {}
  } catch (error) {
    // The task mutation has already succeeded. A transient collaboration
    // failure must be visible, but must not turn that successful mutation into
    // an MCP error that encourages the model to repeat it.
    return {
      coordinationWarning: error instanceof Error ? error.message : String(error)
    }
  }
}

async function safely(
  service: TaskAgentService,
  operation: () => Record<string, unknown> | null,
  refreshIdentity?: () => void
) {
  try {
    refreshIdentity?.()
    return toolSuccess(service.identity.agentSessionId, operation() ?? {})
  } catch (error) {
    return toolFailure(service.identity.agentSessionId, error)
  }
}

/** 统一服务器系统说明：协议级内容底层注入，不进入会话可见消息。 */
export function buildUnifiedServerInstructions(): string {
  return [
    `这是群枢（Qunshu）统一 MCP 服务器「${QUNSHU_MCP_SERVER_NAME}」：团队工具与通信保活同服，每次工具调用必须传 channel_id（当前 Agent 的群枢通道号，启动指令中声明）。`,
    '收到启动指令后先调用 team_check_in 领取角色简报；简报是角色职责与团队目标的唯一依据，不要在会话里复述它。',
    '过程中每次工具调用或关键思考后，用 record_process({ channel_id, turn, block }) 流式上报（同 block.id 重复上报即状态翻转）；record_reply 带同一 turn 归档整批，软件界面实时渲染过程流。禁止只在 record_reply 直带 process 而跳过流式上报（界面将整批展示即断流，返回带 streamingWarning）。',
    '每次真实用户可见回复后必须 record_reply 同步，再 check_messages 长轮询待命；团队内部通知只用 team_* 回执处理，不要写用户可见回复。',
    'check_messages/qingtian 返回 keepalive、无未读或已读重复时必须静默续等：不要输出“继续等待/已读过/继续轮询”等可见回复，也不要 record_reply。',
    '真实用户消息投递后未 record_reply 直接再取消息会被 need_reply_sync 拒绝；内部通知不会触发该守门。',
    'Lease token 由服务端保管，不会暴露给模型；不要替其他 Agent 操作任务，不要猜测 taskId；不要用终端或脚本调用 MCP。'
  ].join('\n')
}

/** 团队工具全集注册（单服务器，channel_id 贯穿）。 */
export function registerTeamTools(server: McpServer, deps: TeamToolsDeps): void {
  const safe = (
    channelId: string,
    operation: (rt: TeamChannelRuntime) => Record<string, unknown> | null
  ) => {
    const rt = deps.runtimeFor(channelId)
    return safely(
      rt.service,
      () => operation(rt),
      deps.refreshIdentity ? () => deps.refreshIdentity!(channelId) : undefined
    )
  }

  server.registerTool(
    'team_check_in',
    {
      title: '确认 Agent 已启动并领取角色简报',
      description: '确认当前 Cursor Agent 已读取 TeamRun 目标和角色边界；返回完整角色简报（职责/目标/协作规范）。外置软件只有收到该回执才显示为已确认。',
      inputSchema: z.object(channelSchema).extend({
        note: z.string().max(2_000).optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, note }) => safe(channel_id, (rt) => ({
      receipt: rt.service.checkIn(note),
      briefing: deps.briefingFor?.(channel_id)
    }))
  )

  server.registerTool(
    'team_list_available',
    {
      title: '列出可领取任务',
      description: '按当前 AgentSession 的 run 和能力，列出依赖已完成、可安全领取的任务。',
      inputSchema: z.object(channelSchema),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ channel_id }) => safe(channel_id, (rt) => {
      const tasks = rt.service.listAvailable()
      return tasks.length ? { tasks } : { tasks, nextAction: waitingAction(channel_id) }
    })
  )

  server.registerTool(
    'team_list_mine',
    {
      title: '列出我的任务',
      description: '查看当前 AgentSession 已领取、执行中或等待验收的任务。',
      inputSchema: z.object(channelSchema),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ channel_id }) => safe(channel_id, (rt) => {
      const tasks = rt.service.listMine()
      const hasActiveTask = tasks.some(({ task }) => task.status === 'leased' || task.status === 'running')
      return hasActiveTask ? { tasks } : { tasks, nextAction: waitingAction(channel_id) }
    })
  )

  server.registerTool(
    'team_get_task',
    {
      title: '读取任务详情',
      description: '读取指定 taskId 的目标、约束、验收标准、依赖和当前 Attempt。',
      inputSchema: z.object(channelSchema).extend({ taskId: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ channel_id, taskId }) => safe(channel_id, (rt) => ({ task: rt.service.getTask(taskId) }))
  )

  server.registerTool(
    'team_claim_task',
    {
      title: '领取任务',
      description: '原子领取指定任务；不传 taskId 时按优先级领取下一条匹配能力的任务。',
      inputSchema: z.object(channelSchema).extend({ taskId: z.string().min(1).max(200).optional() }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, taskId }) => safe(channel_id, (rt) => {
      const assignment = rt.service.claim(taskId)
      return assignment
        ? {
            assignment,
            ...taskStatusResult(rt.collaboration, {
              taskId: assignment.task.id,
              subject: `已领取任务：${assignment.task.title}`,
              content: `已领取第 ${assignment.attemptNumber} 次执行，准备开始。`,
              eventKey: `claimed:${assignment.attemptId}`
            })
          }
        : {
            assignment: null,
            message: '当前没有依赖已完成且能力匹配的任务。',
            nextAction: waitingAction(channel_id)
          }
    })
  )

  server.registerTool(
    'team_start_task',
    {
      title: '开始任务',
      description: '把当前已领取任务从 leased 推进到 running。',
      inputSchema: z.object(channelSchema).extend({ taskId: z.string().min(1).max(200).optional() }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, taskId }) => safe(channel_id, (rt) => {
      const task = rt.service.start(taskId)
      return {
        task,
        ...taskStatusResult(rt.collaboration, {
          taskId: task.task.id,
          subject: `已开始任务：${task.task.title}`,
          content: '任务已进入执行中。',
          eventKey: `started:${task.attempt?.id ?? task.task.currentAttemptId ?? 'current'}`
        })
      }
    })
  )

  server.registerTool(
    'team_renew_lease',
    {
      title: '续租任务',
      description: '延长当前活动任务的 Lease；长任务应定期调用，避免掉线回池。',
      inputSchema: z.object(channelSchema).extend({
        taskId: z.string().min(1).max(200).optional(),
        ttlSeconds: z.number().int().min(5).max(600).optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id, taskId, ttlSeconds }) => safe(channel_id, (rt) => ({
      leaseExpiresAt: rt.service.renew(taskId, ttlSeconds === undefined ? undefined : ttlSeconds * 1_000)
    }))
  )

  server.registerTool(
    'team_report_progress',
    {
      title: '汇报任务进度',
      description: '更新当前任务的单调进度和阶段性摘要；进度不会倒退，最大为 99。',
      inputSchema: z.object(channelSchema).extend({
        taskId: z.string().min(1).max(200).optional(),
        progress: z.number().int().min(0).max(99),
        summary: z.string().max(4_000).optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, taskId, progress, summary }) => safe(channel_id, (rt) => {
      const task = rt.service.report(taskId, progress, summary)
      return {
        task,
        ...taskStatusResult(rt.collaboration, {
          taskId: task.task.id,
          subject: `任务进度：${task.task.title}`,
          content: `进度 ${progress}%${summary?.trim() ? `\n${summary.trim()}` : ''}`,
          eventKey: `progress:${progress}:${summary?.trim() ?? ''}`
        })
      }
    })
  )

  server.registerTool(
    'team_submit_for_review',
    {
      title: '提交任务验收',
      description: '提交完整交付结果并释放 Lease，任务进入 review；这不是直接完成。',
      inputSchema: z.object(channelSchema).extend({
        taskId: z.string().min(1).max(200).optional(),
        output: z.string().min(1).max(50_000)
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, taskId, output }) => safe(channel_id, (rt) => {
      const task = rt.service.submit(taskId, output)
      return {
        task,
        ...taskStatusResult(rt.collaboration, {
          taskId: task.task.id,
          subject: `已提交验收：${task.task.title}`,
          content: `任务已进入独立验收。\n${output.trim()}`,
          eventKey: `submitted:${output.trim()}`
        }),
        nextAction: waitingAction(channel_id)
      }
    })
  )

  server.registerTool(
    'team_fail_task',
    {
      title: '报告任务失败',
      description: '报告明确失败原因；系统按 maxAttempts 决定回池重试或进入 failed。',
      inputSchema: z.object(channelSchema).extend({
        taskId: z.string().min(1).max(200).optional(),
        reason: z.string().min(1).max(4_000)
      }),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id, taskId, reason }) => safe(channel_id, (rt) => {
      const task = rt.service.fail(taskId, reason)
      return {
        task,
        ...taskStatusResult(rt.collaboration, {
          taskId: task.id,
          subject: `任务失败：${task.title}`,
          content: `第 ${task.attemptCount} 次执行失败；当前状态 ${task.status}。\n${reason.trim()}`,
          eventKey: `failed:${task.attemptCount}:${reason.trim()}`
        }),
        nextAction: waitingAction(channel_id)
      }
    })
  )

  if (deps.exposeAllRoleTools) {
    server.registerTool(
      'team_list_reviews',
      {
        title: '列出待验收任务',
        description: '质量角色专用：列出当前 TeamRun 中可领取或由自己持有的独立验收。',
        inputSchema: z.object(channelSchema),
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ channel_id }) => safe(channel_id, (rt) => {
        const reviews = rt.service.listReviews()
        return reviews.length ? { reviews } : { reviews, nextAction: waitingAction(channel_id) }
      })
    )

    server.registerTool(
      'team_claim_review',
      {
        title: '领取独立验收',
        description: '质量角色专用：原子领取一条验收；实现者不能验收自己的任务。',
        inputSchema: z.object(channelSchema).extend({ taskId: z.string().min(1).max(200).optional() }),
        annotations: { readOnlyHint: false, idempotentHint: true }
      },
      async ({ channel_id, taskId }) => safe(channel_id, (rt) => {
        const review = rt.service.claimReview(taskId)
        return review
          ? {
              review,
              ...taskStatusResult(rt.collaboration, {
                taskId: review.task.id,
                subject: `已领取验收：${review.task.title}`,
                content: '已领取独立验收，开始复现与核对证据。',
                eventKey: `review-claimed:${review.review.id}`
              })
            }
          : { review: null, message: '当前没有可领取的独立验收。', nextAction: waitingAction(channel_id) }
      })
    )

    server.registerTool(
      'team_renew_review',
      {
        title: '续租独立验收',
        description: '延长当前验收 Lease；需要较长时间复现或运行测试时调用。',
        inputSchema: z.object(channelSchema).extend({
          taskId: z.string().min(1).max(200).optional(),
          ttlSeconds: z.number().int().min(5).max(600).optional()
        }),
        annotations: { readOnlyHint: false, idempotentHint: false }
      },
      async ({ channel_id, taskId, ttlSeconds }) => safe(channel_id, (rt) => ({
        leaseExpiresAt: rt.service.renewReview(taskId, ttlSeconds === undefined ? undefined : ttlSeconds * 1_000)
      }))
    )

    server.registerTool(
      'team_submit_review',
      {
        title: '提交独立验收结论',
        description: '质量角色专用：提交通过或打回结论。必须提供实际验证证据；打回必须说明原因。',
        inputSchema: z.object(channelSchema).extend({
          taskId: z.string().min(1).max(200).optional(),
          decision: z.enum(['accept', 'reject']),
          evidence: z.string().min(1).max(50_000),
          reason: z.string().max(4_000).optional()
        }),
        annotations: { readOnlyHint: false, idempotentHint: true }
      },
      async ({ channel_id, taskId, decision, evidence, reason }) => safe(channel_id, (rt) => {
        const task = rt.service.submitReview(taskId, decision, evidence, reason)
        return {
          task,
          ...taskStatusResult(rt.collaboration, {
            taskId: task.id,
            subject: `验收${decision === 'accept' ? '通过' : '打回'}：${task.title}`,
            content: [
              `验收结论：${decision === 'accept' ? '通过' : '打回'}`,
              reason?.trim() ? `原因：${reason.trim()}` : undefined,
              `证据：${evidence.trim()}`
            ].filter(Boolean).join('\n'),
            eventKey: `review:${decision}:${reason?.trim() ?? ''}:${evidence.trim()}`
          }),
          nextAction: waitingAction(channel_id)
        }
      })
    )
  }

  server.registerTool(
    'team_get_context',
    {
      title: '读取团队上下文',
      description: '读取当前稳定 AgentSlot、团队成员目录（含真实 capabilities）、未读消息和待回应数；不会把完整聊天灌入上下文。',
      inputSchema: z.object(channelSchema),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ channel_id }) => safe(channel_id, (rt) => ({
      context: {
        ...(rt.collaboration ? rt.collaboration.getContext() : {}),
        memory: rt.memory?.contextBrief()
      }
    }))
  )

  server.registerTool(
    'team_list_inbox',
    {
      title: '列出团队收件箱',
      description: '列出发给当前 AgentSlot 的团队消息摘要；不会推进“已读取”回执。',
      inputSchema: z.object(channelSchema).extend({
        unreadOnly: z.boolean().optional().default(true),
        limit: z.number().int().min(1).max(100).optional().default(30)
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ channel_id, unreadOnly, limit }) => safe(channel_id, (rt) => ({
      messages: rt.collaboration ? rt.collaboration.listInbox(unreadOnly, limit) : []
    }))
  )

  server.registerTool(
    'team_read_message',
    {
      title: '读取团队消息',
      description: '读取一条发给当前 AgentSlot 的完整消息，并原子记录“已读取”回执。',
      inputSchema: z.object(channelSchema).extend({ messageId: z.string().min(1).max(240) }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, messageId }) => safe(channel_id, (rt) => ({
      message: rt.collaboration ? rt.collaboration.readMessage(messageId) : null
    }))
  )

  server.registerTool(
    'team_send_message',
    {
      title: '发送团队消息',
      description: '给当前 TeamRun 中一个稳定 AgentSlot 发送持久化消息。只有主控可以发送 directive。',
      inputSchema: z.object(channelSchema).extend({
        recipientSlotId: z.string().min(3).max(240),
        kind: z.enum(['directive', 'question', 'status', 'notice']),
        subject: z.string().max(160).optional(),
        content: z.string().min(1).max(20_000),
        clientMessageId: z.string().regex(/^[a-zA-Z0-9:_-]{8,200}$/).optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, recipientSlotId, kind, subject, content, clientMessageId }) => safe(channel_id, (rt) => ({
      message: rt.collaboration
        ? rt.collaboration.sendMessage({ recipientSlotId, kind, subject, content, clientMessageId })
        : null
    }))
  )

  server.registerTool(
    'team_respond_message',
    {
      title: '回应团队消息',
      description: '回应一条发给当前 AgentSlot 的消息；回复会与原 messageId 关联并推进明确回应回执。',
      inputSchema: z.object(channelSchema).extend({
        messageId: z.string().min(1).max(240),
        content: z.string().min(1).max(20_000),
        clientMessageId: z.string().regex(/^[a-zA-Z0-9:_-]{8,200}$/).optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, messageId, content, clientMessageId }) => safe(channel_id, (rt) => ({
      message: rt.collaboration ? rt.collaboration.respondMessage({ messageId, content, clientMessageId }) : null
    }))
  )

  if (deps.exposeAllRoleTools) {
    server.registerTool(
      'team_broadcast',
      {
        title: '向团队广播并等待真实回应',
        description: '主控专用：把同一问题或通知分别发送给所有其他在岗 Agent，并返回每条可追踪的 messageId。不得代替成员作答。',
        inputSchema: z.object(channelSchema).extend({
          kind: z.enum(['question', 'notice']).optional().default('question'),
          subject: z.string().max(160).optional(),
          content: z.string().min(1).max(20_000),
          clientMessageId: z.string().regex(/^[a-zA-Z0-9:_-]{8,200}$/).optional()
        }),
        annotations: { readOnlyHint: false, idempotentHint: true }
      },
      async ({ channel_id, kind, subject, content, clientMessageId }) => safe(channel_id, (rt) => {
        const messages = rt.collaboration
          ? rt.collaboration.broadcast({ kind, subject, content, clientMessageId })
          : []
        return {
          messages,
          messageIds: messages.map((message) => message.id),
          nextAction: '调用 team_collect_responses 并传入这些 messageIds；只能汇总实际 response，不得替成员生成回应。'
        }
      })
    )

    server.registerTool(
      'team_collect_responses',
      {
        title: '收集团队真实回应',
        description: '主控专用：按 messageId 查询广播或提问的投递、读取与回应状态，并返回成员实际回复正文。仍在等待时不得自行补写。',
        inputSchema: z.object(channelSchema).extend({
          messageIds: z.array(z.string().min(1).max(240)).max(100).optional()
        }),
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ channel_id, messageIds }) => safe(channel_id, (rt) => {
        const responses = rt.collaboration ? rt.collaboration.collectResponses(messageIds) : []
        const pending = responses.filter((item) => item.stage !== 'responded')
        return {
          responses,
          complete: responses.length > 0 && pending.length === 0,
          pendingMessageIds: pending.map((item) => item.messageId),
          nextAction: pending.length
            ? '仍有成员未回应；向用户如实说明等待状态，稍后再次调用本工具。禁止代答。'
            : '只基于 response 字段汇总团队成员的真实回应。'
        }
      })
    )

    server.registerTool(
      'team_list_board',
      {
        title: '读取全局任务板',
        description: '主控专用：读取当前 TeamRun 的全部任务、负责人和安全脱敏后的 Attempt。',
        inputSchema: z.object(channelSchema),
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ channel_id }) => safe(channel_id, (rt) => ({
        tasks: rt.collaboration ? rt.collaboration.listTaskBoard() : []
      }))
    )

    server.registerTool(
      'team_plan_tasks',
      {
        title: '规划并定向团队任务',
        description: '主控专用：仅在真实用户明确要求开始、分配、拆任务或执行后，原子创建 1–30 条带依赖和稳定 AgentSlot 定向的可验收任务。requiredCapabilities 只能复制 team_get_context 中成员的真实 capabilities；已指定 targetSlotId 时可省略。key 在 TeamRun 内必须唯一。',
        inputSchema: z.object(channelSchema).extend({
          tasks: z.array(z.object({
            key: z.string().min(1).max(160),
            title: z.string().min(1).max(160),
            description: z.string().max(8_000).optional(),
            acceptance: z.string().max(4_000).optional(),
            priority: z.number().int().min(0).max(3).optional(),
            dependsOn: z.array(z.string().min(1).max(160)).max(30).optional(),
            requiredCapabilities: z.array(z.string().min(1).max(80)).max(32).optional(),
            targetSlotId: z.string().min(3).max(240).optional(),
            maxAttempts: z.number().int().min(1).max(10).optional()
          })).min(1).max(30)
        }),
        annotations: { readOnlyHint: false, idempotentHint: false }
      },
      async ({ channel_id, tasks }) => safe(channel_id, (rt) => ({
        tasks: rt.collaboration ? rt.collaboration.planTasks(tasks) : []
      }))
    )

    server.registerTool(
      'team_ping',
      {
        title: '发送活性验证 ping',
        description: '主控/临时主控专用：向指定通道发送活性验证，目标应在 5 秒内调用 team_pong 响应。连续 3 次失败标记为 confirmed_offline。',
        inputSchema: z.object(channelSchema).extend({
          targetChannelId: z.string().regex(/^\d+$/),
          timeoutMs: z.number().int().min(1000).max(30000).optional().default(5000)
        }),
        annotations: { readOnlyHint: false, idempotentHint: false }
      },
      async ({ channel_id, targetChannelId, timeoutMs }) => safe(channel_id, (rt) => {
        if (!rt.collaboration) throw new TaskPoolError('collaboration_unavailable', '当前通道未接入团队协作服务')
        const result = rt.collaboration.ping({ targetChannelId, timeoutMs })
        return {
          ...result,
          message: `已向 CH-${targetChannelId} 发送活性验证，等待 ${timeoutMs}ms 内响应`,
          nextAction: waitingAction(channel_id)
        }
      })
    )

    server.registerTool(
      'team_pong',
      {
        title: '响应活性验证 ping',
        description: '任何成员可调用：响应主控发送的活性验证 ping，证明当前通道具备执行能力。',
        inputSchema: z.object(channelSchema).extend({
          pingId: z.string().min(8).max(200)
        }),
        annotations: { readOnlyHint: false, idempotentHint: true }
      },
      async ({ channel_id, pingId }) => safe(channel_id, (rt) => {
        if (!rt.collaboration) throw new TaskPoolError('collaboration_unavailable', '当前通道未接入团队协作服务')
        rt.collaboration.pong({ pingId })
        return {
          message: '已响应活性验证',
          pingId,
          nextAction: waitingAction(channel_id)
        }
      })
    )

    server.registerTool(
      'team_check_liveness',
      {
        title: '检查通道活性状态',
        description: '主控/临时主控专用：查询指定通道的活性状态（active/suspected_offline/confirmed_offline）。',
        inputSchema: z.object(channelSchema).extend({
          targetChannelId: z.string().regex(/^\d+$/)
        }),
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ channel_id, targetChannelId }) => safe(channel_id, (rt) => {
        if (!rt.collaboration) throw new TaskPoolError('collaboration_unavailable', '当前通道未接入团队协作服务')
        const liveness = rt.collaboration.checkLiveness(targetChannelId)
        return {
          channelId: targetChannelId,
          liveness: liveness?.liveness ?? 'unknown',
          lastVerifiedAt: liveness?.lastVerifiedAt,
          consecutiveFailures: liveness?.consecutiveFailures ?? 0,
          nextAction: waitingAction(channel_id)
        }
      })
    )

    server.registerTool(
      'team_start_run',
      {
        title: '启动 TeamRun',
        description: '任何已注册成员可调用：当 TeamRun 满足启动条件（目标已填写、MCP 已安装）时，将状态从 ready/draft 推进到 launching。实际指令投递由主进程异步完成，失败自动回滚。',
        inputSchema: z.object(channelSchema),
        annotations: { readOnlyHint: false, idempotentHint: false }
      },
      async ({ channel_id }) => safe(channel_id, (rt) => {
        if (!rt.controlRepository) throw new TaskPoolError('control_unavailable', '当前通道未接入团队控制仓库')
        const agent = rt.collaboration?.['currentAgent']()
        if (!agent) throw new TaskPoolError('agent_not_authorized', '当前 Agent 未授权')
        const state = rt.controlRepository.loadTeamControl()
        const run = state.runs.find((candidate) => candidate.id === agent.runId)
        if (!run) throw new TaskPoolError('run_not_found', '当前 Agent 不属于任何 TeamRun')
        if (!['draft', 'ready'].includes(run.status)) {
          throw new TaskPoolError('run_not_startable', `TeamRun 当前状态为 ${run.status}，只有 draft/ready 可以启动`)
        }
        if (!run.goal.trim()) throw new TaskPoolError('goal_required', '请先填写并保存团队目标')
        const bindings = state.bindings.filter((binding) => binding.runId === run.id)
        const slots = state.slots.filter((slot) => slot.runId === run.id)
        const boundSlotIds = new Set(bindings.map((binding) => binding.slotId))
        const unboundSlots = slots.filter((slot) => !boundSlotIds.has(slot.id))
        if (unboundSlots.length) {
          throw new TaskPoolError('mcp_not_installed', `以下席位尚未安装 MCP：${unboundSlots.map((slot) => slot.name).join('、')}`)
        }
        rt.controlRepository.beginLaunch(run.id, Date.now(), `start-run:${randomUUID()}`)
        return {
          runId: run.id,
          status: 'launching',
          message: 'TeamRun 已启动，指令投递中。若投递失败将自动回滚为 ready。',
          nextAction: waitingAction(channel_id)
        }
      })
    )

    server.registerTool(
      'team_transfer_lead',
      {
        title: '显式主控转移',
        description: '主控/临时主控专用：将主控权限临时转移给指定在线成员。目标必须已绑定且在线。转移后原主控保留角色但失去权限，直到清除临时主控。',
        inputSchema: z.object(channelSchema).extend({
          targetSlotId: z.string().min(3).max(240),
          reason: z.string().max(500).optional()
        }),
        annotations: { readOnlyHint: false, idempotentHint: true }
      },
      async ({ channel_id, targetSlotId, reason }) => safe(channel_id, (rt) => {
        if (!rt.controlRepository) throw new TaskPoolError('control_unavailable', '当前通道未接入团队控制仓库')
        const agent = rt.collaboration?.['currentAgent']()
        if (!agent) throw new TaskPoolError('agent_not_authorized', '当前 Agent 未授权')
        if (agent.roleTemplateKey !== 'lead' && !agent.isActingLead) {
          throw new TaskPoolError('lead_only_transfer', '只有主控协调或临时主控可以转移主控权限')
        }
        const state = rt.controlRepository.loadTeamControl()
        const run = state.runs.find((candidate) => candidate.id === agent.runId)
        if (!run || !['launching', 'running', 'attention'].includes(run.status)) {
          throw new TaskPoolError('run_inactive', '只有运行中的 TeamRun 可以转移主控')
        }
        const targetSlot = state.slots.find((slot) => slot.id === targetSlotId.trim() && slot.runId === run.id)
        if (!targetSlot) throw new TaskPoolError('target_slot_not_found', '目标 AgentSlot 不属于当前 TeamRun')
        const targetBinding = state.bindings.find((binding) => binding.slotId === targetSlot.id && binding.runId === run.id)
        if (!targetBinding) throw new TaskPoolError('target_not_bound', '目标 Agent 尚未完成 MCP 绑定')
        rt.controlRepository.setActingLead({ runId: run.id, slotId: targetSlot.id, at: Date.now() })
        return {
          actingLeadSlotId: targetSlot.id,
          message: `主控权限已转移给 ${targetSlot.name}`,
          reason: reason?.trim(),
          nextAction: waitingAction(channel_id)
        }
      })
    )

    server.registerTool(
      'team_clear_acting_lead',
      {
        title: '清除临时主控',
        description: '主控/临时主控专用：清除临时主控设置，恢复原始 lead 角色的完整权限。',
        inputSchema: z.object(channelSchema),
        annotations: { readOnlyHint: false, idempotentHint: true }
      },
      async ({ channel_id }) => safe(channel_id, (rt) => {
        if (!rt.controlRepository) throw new TaskPoolError('control_unavailable', '当前通道未接入团队控制仓库')
        const agent = rt.collaboration?.['currentAgent']()
        if (!agent) throw new TaskPoolError('agent_not_authorized', '当前 Agent 未授权')
        if (agent.roleTemplateKey !== 'lead' && !agent.isActingLead) {
          throw new TaskPoolError('lead_only_clear', '只有主控协调或临时主控可以清除临时主控')
        }
        rt.controlRepository.setActingLead({ runId: agent.runId, slotId: null, at: Date.now() })
        return {
          message: '临时主控已清除，恢复原始 lead 权限',
          nextAction: waitingAction(channel_id)
        }
      })
    )
  }

  server.registerTool(
    'team_memory_search',
    {
      title: '检索本轮上下文',
      description: '只检索当前 TeamRun 内经过确认、未被取代的接替上下文；不会读取上一次团队。',
      inputSchema: z.object(channelSchema).extend({
        query: z.string().max(500).optional(),
        kinds: z.array(z.enum(['decision', 'constraint', 'fact', 'risk', 'lesson'])).max(5).optional(),
        includeProposed: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(50).optional().default(20)
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ channel_id, query, kinds, includeProposed, limit }) => safe(channel_id, (rt) => ({
      brief: rt.memory?.contextBrief(),
      items: rt.memory ? rt.memory.search({ query, kinds, includeProposed, limit }) : []
    }))
  )

  server.registerTool(
    'team_memory_propose',
    {
      title: '记录本轮关键上下文',
      description: '记录当前 TeamRun 内带来源的决策、约束、事实、风险或经验，供本轮 Agent 接替使用。',
      inputSchema: z.object(channelSchema).extend({
        scope: z.literal('run').optional().default('run'),
        kind: z.enum(['decision', 'constraint', 'fact', 'risk', 'lesson']),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(20_000),
        sources: z.array(z.object({
          type: z.enum(['message', 'task', 'file']),
          ref: z.string().min(1).max(2_000),
          label: z.string().min(1).max(240)
        })).min(1).max(20),
        supersedesId: z.string().max(240).optional(),
        clientProposalId: z.string().regex(/^[a-zA-Z0-9:_-]{8,200}$/).optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, scope, kind, title, content, sources, supersedesId, clientProposalId }) => safe(channel_id, (rt) => ({
      memory: rt.memory
        ? rt.memory.propose({ scope, kind, title, content, sources, supersedesId, clientProposalId })
        : null
    }))
  )

  if (deps.exposeAllRoleTools) {
    server.registerTool(
      'team_memory_review',
      {
        title: '审核团队记忆',
        description: '主控/质量角色审核记忆提案；项目长期记忆必须由质量角色确认，且禁止自审。',
        inputSchema: z.object(channelSchema).extend({
          memoryId: z.string().min(1).max(240),
          decision: z.enum(['accept', 'reject']),
          note: z.string().max(4_000).optional()
        }),
        annotations: { readOnlyHint: false, idempotentHint: true }
      },
      async ({ channel_id, memoryId, decision, note }) => safe(channel_id, (rt) => ({
        memory: rt.memory ? rt.memory.review({ memoryId, decision, note }) : null
      }))
    )
  }
}
