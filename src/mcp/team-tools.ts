import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { TaskAgentService } from '../application/task-agent-service'
import type { TeamCollaborationAgentService } from '../application/team-collaboration-agent-service'
import type { TeamMemoryAgentService } from '../application/team-memory-agent-service'
import type { TeamControlRepository } from '../application/team-control-repository'
import { buildChannelWaitInstruction } from '../domain/channel-wait-policy'
import {
  SG_TEAM_MCP_SERVER_ID,
  hasInFlightExecution,
  isExplicitlyStoppedPhase,
  type ChannelPresence
} from '../domain/channel-message'
import { TaskPoolError } from '../domain/task-pool'

/**
 * 团队工具面（S5 收敛版）：7 个团队工具 + 2 个通信工具，共 9 个。
 *
 * 旧版按"一个服务方法一个工具"暴露了 35 个工具，模型每轮都要在几十个近义名字里挑
 * （list_mine / list_available / list_reviews / list_board / get_task 都是"看任务"）。
 * 现按对象划分：看任务 team_tasks、推进任务 team_task、独立验收 team_review、
 * 团队消息 team_message、团队记忆 team_memory、运行与主控 team_run，再加在岗登记
 * team_check_in（含上下文快照）。每个工具的 action/view 枚举即该对象的全部动作；
 * 角色权限仍由服务层按每次调用的通道身份校验（暴露超集、调用时收口）。
 */

/** 单通道运行时：统一服务器按 channel_id 懒加载并缓存。 */
export interface TeamChannelRuntime {
  service: TaskAgentService
  collaboration?: TeamCollaborationAgentService
  memory?: TeamMemoryAgentService
  controlRepository?: TeamControlRepository
  isChannelOnline?: (channelId: string) => boolean
  /** 主控接管必须读取完整相位，裸 online/no-pong 不足以区分“忙碌”与“死亡”。 */
  channelPresence?: (channelId: string) => ChannelPresence | undefined
}

export interface TeamToolsDeps {
  /** 解析/缓存通道运行时；未注册通道抛授权错误（围栏兜底）。 */
  runtimeFor(channelId: string): TeamChannelRuntime
  refreshIdentity?: (channelId: string) => void
  /** team_check_in 返回的角色简报（S4 底层注入）。 */
  briefingFor?: (channelId: string) => string | undefined
}

/** 团队工具名（供简报、文档与测试引用；通信工具见 channel-communication-tools）。 */
export const TEAM_TOOL_NAMES = [
  'team_check_in',
  'team_tasks',
  'team_task',
  'team_review',
  'team_message',
  'team_memory',
  'team_run'
] as const

/** 所有工具必传 channel_id：单 MCP 条目下区分通道的唯一参数。 */
const channelSchema = {
  channel_id: z.string().regex(/^\d+$/)
    .describe('拾光分配给当前 Agent 的通道号（如 "2"），启动指令中声明，每次调用必传')
}

const taskIdSchema = z.string().min(1).max(200).optional()
  .describe('任务 id；省略时作用于当前唯一活动任务')
const ttlSchema = z.number().int().min(5).max(600).optional()
  .describe('续租时长（秒）；仅 renew 使用')
const clientMessageIdSchema = z.string().regex(/^[a-zA-Z0-9:_-]{8,200}$/).optional()
  .describe('幂等键：同一键重复调用不会产生第二条消息')

function waitingAction(channelId: string): Record<string, string> {
  return {
    type: 'enter_channel_wait',
    channelId,
    communicationServer: SG_TEAM_MCP_SERVER_ID,
    instruction: buildChannelWaitInstruction({
      channelId,
      communicationServerName: SG_TEAM_MCP_SERVER_ID
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

/** 动作级必填参数校验：schema 是扁平可选字段，缺参在这里给出指向具体 action 的错误。 */
function required<T>(value: T | undefined, action: string, field: string): T {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    throw new TaskPoolError('invalid_arguments', `action "${action}" 需要参数 ${field}`)
  }
  return value
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

function requireCollaboration(rt: TeamChannelRuntime): TeamCollaborationAgentService {
  if (!rt.collaboration) throw new TaskPoolError('collaboration_unavailable', '当前通道未接入团队协作服务')
  return rt.collaboration
}

function requireControl(rt: TeamChannelRuntime): TeamControlRepository {
  if (!rt.controlRepository) throw new TaskPoolError('control_unavailable', '当前通道未接入团队控制仓库')
  return rt.controlRepository
}

function currentAgent(rt: TeamChannelRuntime) {
  const agent = rt.collaboration?.['currentAgent']()
  if (!agent) throw new TaskPoolError('agent_not_authorized', '当前 Agent 未授权')
  return agent
}

async function safely(
  service: TaskAgentService,
  operation: () => Record<string, unknown> | null | Promise<Record<string, unknown> | null>,
  refreshIdentity?: () => void
) {
  try {
    refreshIdentity?.()
    return toolSuccess(service.identity.agentSessionId, await operation() ?? {})
  } catch (error) {
    return toolFailure(service.identity.agentSessionId, error)
  }
}

/**
 * 统一服务器系统说明：协议的唯一完整陈述，底层注入、不进入会话可见消息。
 * 投递后缀、工具 nextAction、角色简报只保留触发当下动作所需的一两句，不再各自复述整套协议。
 */
export function buildUnifiedServerInstructions(): string {
  return [
    `这是拾光（SG Team）统一 MCP 服务器「${SG_TEAM_MCP_SERVER_ID}」。每次工具调用必传 channel_id（启动指令中声明的通道号）；启动指令给出 session 令牌时，check_messages / record_reply 一并附带。`,
    '工具按对象划分：team_check_in 登记在岗并读取简报与团队上下文；team_tasks 看任务（view）；team_task 推进任务（action）；team_review 独立验收（action）；team_message 团队消息（action）；team_memory 团队记忆（action）；team_run 运行与主控（action）。团队席先调用 team_check_in 领取简报（职责与目标的唯一依据，不要在会话里复述）；独立席只用 check_messages / record_reply，不调用 team_*。',
    '对话循环：check_messages 长轮询取用户消息 → 在 Cursor 里正常回答 → record_reply 同步同一份完整可见回复 → 再 check_messages。每次真实用户可见回复后必须 record_reply；未同步就再取消息会被 need_reply_sync 拒绝。',
    '静默规则：check_messages 返回 keepalive、无未读或已读重复时必须静默续等（keepalive 形如 <sg_team_keepalive/>）：不要输出“继续等待/已读过/继续轮询”等可见回复，也不要 record_reply，也不要用文字说“我会继续循环”代替调用。团队内部通知只用 team_message 回执处理，不写用户可见回复；内部通知不会触发该守门。',
    '边界：思考、工具调用与过程由拾光直接读取 Cursor 原生会话事件，不要复述或上报过程；不要用终端或脚本调用 MCP；不要替其他 Agent 操作任务或猜测 taskId；Lease token 由服务端保管。',
    '终止：收到「会话围栏」终止指令即停止轮询并结束，不要重试；出现 usage limit / quota / billing / authorization / isRetryable:false 等明确错误时停止自动续等并等待用户处理，禁止快速、并发或无限重试。'
  ].join('\n')
}

/** 团队工具注册（单服务器，channel_id 贯穿）。 */
export function registerTeamTools(server: McpServer, deps: TeamToolsDeps): void {
  const safe = (
    channelId: string,
    operation: (rt: TeamChannelRuntime) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>
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
      title: '登记在岗并读取团队上下文',
      description: '确认当前 Cursor Agent 已启动并读取 TeamRun 目标与角色边界；返回完整角色简报（职责/目标/协作规范）与本轮团队上下文快照（稳定成员目录及真实 capabilities、未读消息与待回应数、本轮已确认记忆）。外置软件只有收到该回执才显示为已确认。启动、接替、权限变更后或需要刷新上下文时调用；不会把完整聊天灌入上下文。',
      inputSchema: z.object(channelSchema).extend({
        note: z.string().max(2_000).optional().describe('可选备注，展示在拾光的席位状态里')
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, note }) => safe(channel_id, (rt) => ({
      receipt: rt.service.checkIn(note),
      briefing: deps.briefingFor?.(channel_id),
      context: {
        ...(rt.collaboration ? rt.collaboration.getContext() : {}),
        memory: rt.memory?.contextBrief()
      }
    }))
  )

  server.registerTool(
    'team_tasks',
    {
      title: '查看任务',
      description: '只读。view=mine：我已领取/执行中/待验收的任务；view=available：依赖已完成、能力匹配、可领取的任务；view=reviews：可领取或由我持有的独立验收（质量角色）；view=board：全局任务板（主控）。传 taskId 时改为读取该任务详情（目标、约束、验收标准、依赖、当前 Attempt）。',
      inputSchema: z.object(channelSchema).extend({
        view: z.enum(['mine', 'available', 'reviews', 'board']).optional().default('mine'),
        taskId: z.string().min(1).max(200).optional().describe('读取单个任务详情时传入')
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ channel_id, view, taskId }) => safe(channel_id, (rt) => {
      if (taskId) return { task: rt.service.getTask(taskId) }
      switch (view) {
        case 'available': {
          const tasks = rt.service.listAvailable()
          return tasks.length ? { view, tasks } : { view, tasks, nextAction: waitingAction(channel_id) }
        }
        case 'reviews': {
          const reviews = rt.service.listReviews()
          return reviews.length ? { view, reviews } : { view, reviews, nextAction: waitingAction(channel_id) }
        }
        case 'board':
          return { view, tasks: requireCollaboration(rt).listTaskBoard() }
        default: {
          const tasks = rt.service.listMine()
          const hasActiveTask = tasks.some(({ task }) => task.status === 'leased' || task.status === 'running')
          return hasActiveTask ? { view, tasks } : { view, tasks, nextAction: waitingAction(channel_id) }
        }
      }
    })
  )

  server.registerTool(
    'team_task',
    {
      title: '推进任务',
      description: 'claim：原子领取（不传 taskId 按优先级领取下一条匹配能力的任务）；start：leased→running；renew：延长 Lease，长任务定期调用；progress：单调进度 0–99 + 阶段摘要；submit：提交完整交付并释放 Lease，任务进入 review（不是直接完成）；fail：报告明确失败原因，系统按 maxAttempts 回池或 failed；plan（主控专用）：仅在真实用户明确要求开始/分配/拆任务/执行后，原子创建 1–30 条带依赖与目标 AgentSlot 的可验收任务。所有动作重试安全。',
      inputSchema: z.object(channelSchema).extend({
        action: z.enum(['claim', 'start', 'renew', 'progress', 'submit', 'fail', 'plan']),
        taskId: taskIdSchema,
        ttlSeconds: ttlSchema,
        progress: z.number().int().min(0).max(99).optional().describe('progress 必填：0–99，不会倒退'),
        summary: z.string().max(4_000).optional().describe('progress 可选：阶段性摘要'),
        output: z.string().min(1).max(50_000).optional().describe('submit 必填：完整交付结果与验证证据'),
        reason: z.string().min(1).max(4_000).optional().describe('fail 必填：明确失败原因'),
        tasks: z.array(z.object({
          key: z.string().min(1).max(160).describe('TeamRun 内唯一'),
          title: z.string().min(1).max(160),
          description: z.string().max(8_000).optional(),
          acceptance: z.string().max(4_000).optional(),
          priority: z.number().int().min(0).max(3).optional(),
          dependsOn: z.array(z.string().min(1).max(160)).max(30).optional().describe('依赖任务的 key'),
          requiredCapabilities: z.array(z.string().min(1).max(80)).max(32).optional()
            .describe('只能复制 team_check_in 返回的成员真实 capabilities；已指定 targetSlotId 时可省略'),
          targetSlotId: z.string().min(3).max(240).optional(),
          maxAttempts: z.number().int().min(1).max(10).optional()
        })).min(1).max(30).optional().describe('plan 必填：任务清单')
      }),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id, action, taskId, ttlSeconds, progress, summary, output, reason, tasks }) => safe(channel_id, (rt) => {
      switch (action) {
        case 'claim': {
          const assignment = rt.service.claim(taskId)
          return assignment
            ? {
                action,
                assignment,
                ...taskStatusResult(rt.collaboration, {
                  taskId: assignment.task.id,
                  subject: `已领取任务：${assignment.task.title}`,
                  content: `已领取第 ${assignment.attemptNumber} 次执行，准备开始。`,
                  eventKey: `claimed:${assignment.attemptId}`
                })
              }
            : {
                action,
                assignment: null,
                message: '当前没有依赖已完成且能力匹配的任务。',
                nextAction: waitingAction(channel_id)
              }
        }
        case 'start': {
          const task = rt.service.start(taskId)
          return {
            action,
            task,
            ...taskStatusResult(rt.collaboration, {
              taskId: task.task.id,
              subject: `已开始任务：${task.task.title}`,
              content: '任务已进入执行中。',
              eventKey: `started:${task.attempt?.id ?? task.task.currentAttemptId ?? 'current'}`
            })
          }
        }
        case 'renew':
          return {
            action,
            leaseExpiresAt: rt.service.renew(taskId, ttlSeconds === undefined ? undefined : ttlSeconds * 1_000)
          }
        case 'progress': {
          const value = required(progress, action, 'progress')
          const task = rt.service.report(taskId, value, summary)
          return {
            action,
            task,
            ...taskStatusResult(rt.collaboration, {
              taskId: task.task.id,
              subject: `任务进度：${task.task.title}`,
              content: `进度 ${value}%${summary?.trim() ? `\n${summary.trim()}` : ''}`,
              eventKey: `progress:${value}:${summary?.trim() ?? ''}`
            })
          }
        }
        case 'submit': {
          const delivered = required(output, action, 'output')
          const task = rt.service.submit(taskId, delivered)
          return {
            action,
            task,
            ...taskStatusResult(rt.collaboration, {
              taskId: task.task.id,
              subject: `已提交验收：${task.task.title}`,
              content: `任务已进入独立验收。\n${delivered.trim()}`,
              eventKey: `submitted:${delivered.trim()}`
            }),
            nextAction: waitingAction(channel_id)
          }
        }
        case 'fail': {
          const why = required(reason, action, 'reason')
          const task = rt.service.fail(taskId, why)
          return {
            action,
            task,
            ...taskStatusResult(rt.collaboration, {
              taskId: task.id,
              subject: `任务失败：${task.title}`,
              content: `第 ${task.attemptCount} 次执行失败；当前状态 ${task.status}。\n${why.trim()}`,
              eventKey: `failed:${task.attemptCount}:${why.trim()}`
            }),
            nextAction: waitingAction(channel_id)
          }
        }
        case 'plan':
          return { action, tasks: requireCollaboration(rt).planTasks(required(tasks, action, 'tasks')) }
      }
    })
  )

  server.registerTool(
    'team_review',
    {
      title: '独立验收',
      description: '质量角色专用。claim：原子领取一条验收（实现者不能验收自己的任务；不传 taskId 领取下一条）；renew：延长验收 Lease；submit：提交 decision=accept/reject 结论，必须附实际验证证据 evidence，reject 必须给 reason。',
      inputSchema: z.object(channelSchema).extend({
        action: z.enum(['claim', 'renew', 'submit']),
        taskId: taskIdSchema,
        ttlSeconds: ttlSchema,
        decision: z.enum(['accept', 'reject']).optional().describe('submit 必填'),
        evidence: z.string().min(1).max(50_000).optional().describe('submit 必填：实际复现/验证证据'),
        reason: z.string().max(4_000).optional().describe('submit 且 reject 时必填：打回原因')
      }),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id, action, taskId, ttlSeconds, decision, evidence, reason }) => safe(channel_id, (rt) => {
      switch (action) {
        case 'claim': {
          const review = rt.service.claimReview(taskId)
          return review
            ? {
                action,
                review,
                ...taskStatusResult(rt.collaboration, {
                  taskId: review.task.id,
                  subject: `已领取验收：${review.task.title}`,
                  content: '已领取独立验收，开始复现与核对证据。',
                  eventKey: `review-claimed:${review.review.id}`
                })
              }
            : { action, review: null, message: '当前没有可领取的独立验收。', nextAction: waitingAction(channel_id) }
        }
        case 'renew':
          return {
            action,
            leaseExpiresAt: rt.service.renewReview(taskId, ttlSeconds === undefined ? undefined : ttlSeconds * 1_000)
          }
        case 'submit': {
          const verdict = required(decision, action, 'decision')
          const proof = required(evidence, action, 'evidence')
          if (verdict === 'reject') required(reason, action, 'reason')
          const task = rt.service.submitReview(taskId, verdict, proof, reason)
          return {
            action,
            task,
            ...taskStatusResult(rt.collaboration, {
              taskId: task.id,
              subject: `验收${verdict === 'accept' ? '通过' : '打回'}：${task.title}`,
              content: [
                `验收结论：${verdict === 'accept' ? '通过' : '打回'}`,
                reason?.trim() ? `原因：${reason.trim()}` : undefined,
                `证据：${proof.trim()}`
              ].filter(Boolean).join('\n'),
              eventKey: `review:${verdict}:${reason?.trim() ?? ''}:${proof.trim()}`
            }),
            nextAction: waitingAction(channel_id)
          }
        }
      }
    })
  )

  server.registerTool(
    'team_message',
    {
      title: '团队消息',
      description: 'inbox：列出发给我的团队消息摘要（不推进已读）；read：读取一条完整消息并原子记录“已读取”回执；send：给一个稳定 AgentSlot 发持久化消息（kind=directive 仅主控）；respond：回应一条消息，与原 messageId 关联并推进“已回应”回执；broadcast（主控专用）：把同一问题/通知分别发给所有其他在岗成员并返回可追踪的 messageIds；collect（主控专用）：按 messageIds 查询投递/读取/回应状态与成员真实回复正文，仍在等待时不得代答。',
      inputSchema: z.object(channelSchema).extend({
        action: z.enum(['inbox', 'read', 'send', 'respond', 'broadcast', 'collect']),
        messageId: z.string().min(1).max(240).optional().describe('read / respond 必填'),
        messageIds: z.array(z.string().min(1).max(240)).max(100).optional().describe('collect 可选：省略则查询全部待回应'),
        recipientSlotId: z.string().min(3).max(240).optional().describe('send 必填：目标稳定 AgentSlot'),
        kind: z.enum(['directive', 'question', 'status', 'notice']).optional()
          .describe('send 必填；broadcast 可选（question/notice，默认 question）'),
        subject: z.string().max(160).optional(),
        content: z.string().min(1).max(20_000).optional().describe('send / respond / broadcast 必填'),
        unreadOnly: z.boolean().optional().default(true).describe('inbox：只列未读'),
        limit: z.number().int().min(1).max(100).optional().default(30).describe('inbox：条数上限'),
        clientMessageId: clientMessageIdSchema
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, action, messageId, messageIds, recipientSlotId, kind, subject, content, unreadOnly, limit, clientMessageId }) => safe(channel_id, (rt) => {
      const collaboration = requireCollaboration(rt)
      switch (action) {
        case 'inbox':
          return { action, messages: collaboration.listInbox(unreadOnly, limit) }
        case 'read':
          return { action, message: collaboration.readMessage(required(messageId, action, 'messageId')) }
        case 'send': {
          const sendKind = required(kind, action, 'kind')
          return {
            action,
            message: collaboration.sendMessage({
              recipientSlotId: required(recipientSlotId, action, 'recipientSlotId'),
              kind: sendKind,
              subject,
              content: required(content, action, 'content'),
              clientMessageId
            })
          }
        }
        case 'respond':
          return {
            action,
            message: collaboration.respondMessage({
              messageId: required(messageId, action, 'messageId'),
              content: required(content, action, 'content'),
              clientMessageId
            })
          }
        case 'broadcast': {
          if (kind !== undefined && kind !== 'question' && kind !== 'notice') {
            throw new TaskPoolError('invalid_arguments', 'broadcast 的 kind 只能是 question 或 notice')
          }
          const messages = collaboration.broadcast({
            kind: kind ?? 'question',
            subject,
            content: required(content, action, 'content'),
            clientMessageId
          })
          return {
            action,
            messages,
            messageIds: messages.map((message) => message.id),
            nextAction: '调用 team_message({action:"collect", messageIds}) 收集真实回应；只能汇总实际 response，不得替成员生成回应。'
          }
        }
        case 'collect': {
          const responses = collaboration.collectResponses(messageIds)
          const pending = responses.filter((item) => item.stage !== 'responded')
          return {
            action,
            responses,
            complete: responses.length > 0 && pending.length === 0,
            pendingMessageIds: pending.map((item) => item.messageId),
            nextAction: pending.length
              ? '仍有成员未回应；向用户如实说明等待状态，稍后再次调用本工具。禁止代答。'
              : '只基于 response 字段汇总团队成员的真实回应。'
          }
        }
      }
    })
  )

  server.registerTool(
    'team_memory',
    {
      title: '团队记忆',
      description: 'search：只检索当前 TeamRun 内经过确认、未被取代的接替上下文（不读取上一次团队）；propose：记录带来源的决策/约束/事实/风险/经验，供本轮 Agent 接替使用；review（主控/质量角色）：审核提案 accept/reject，禁止自审。',
      inputSchema: z.object(channelSchema).extend({
        action: z.enum(['search', 'propose', 'review']),
        query: z.string().max(500).optional().describe('search 可选：关键词'),
        kinds: z.array(z.enum(['decision', 'constraint', 'fact', 'risk', 'lesson'])).max(5).optional().describe('search 可选：类型过滤'),
        includeProposed: z.boolean().optional().default(false).describe('search：是否包含待确认提案'),
        limit: z.number().int().min(1).max(50).optional().default(20).describe('search：条数上限'),
        kind: z.enum(['decision', 'constraint', 'fact', 'risk', 'lesson']).optional().describe('propose 必填'),
        title: z.string().min(1).max(200).optional().describe('propose 必填'),
        content: z.string().min(1).max(20_000).optional().describe('propose 必填'),
        sources: z.array(z.object({
          type: z.enum(['message', 'task', 'file']),
          ref: z.string().min(1).max(2_000),
          label: z.string().min(1).max(240)
        })).min(1).max(20).optional().describe('propose 必填：至少一个来源'),
        supersedesId: z.string().max(240).optional().describe('propose 可选：取代的旧记忆 id'),
        clientProposalId: z.string().regex(/^[a-zA-Z0-9:_-]{8,200}$/).optional().describe('propose 幂等键'),
        memoryId: z.string().min(1).max(240).optional().describe('review 必填'),
        decision: z.enum(['accept', 'reject']).optional().describe('review 必填'),
        note: z.string().max(4_000).optional().describe('review 可选：审核说明')
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, action, query, kinds, includeProposed, limit, kind, title, content, sources, supersedesId, clientProposalId, memoryId, decision, note }) => safe(channel_id, (rt) => {
      switch (action) {
        case 'search':
          return {
            action,
            brief: rt.memory?.contextBrief(),
            items: rt.memory ? rt.memory.search({ query, kinds, includeProposed, limit }) : []
          }
        case 'propose':
          return {
            action,
            memory: rt.memory
              ? rt.memory.propose({
                  scope: 'run',
                  kind: required(kind, action, 'kind'),
                  title: required(title, action, 'title'),
                  content: required(content, action, 'content'),
                  sources: required(sources, action, 'sources'),
                  supersedesId,
                  clientProposalId
                })
              : null
          }
        case 'review':
          return {
            action,
            memory: rt.memory
              ? rt.memory.review({
                  memoryId: required(memoryId, action, 'memoryId'),
                  decision: required(decision, action, 'decision'),
                  note
                })
              : null
          }
      }
    })
  )

  server.registerTool(
    'team_run',
    {
      title: '运行与主控',
      description: 'start：TeamRun 满足条件（目标已填写、席位均已安装 MCP）时从 draft/ready 推进到 launching，指令投递由主进程异步完成；transfer_lead（主控/临时主控）：把主控权限临时转给指定在线成员；claim_lead（任何已绑定成员）：仅在有效主控有可验证终止证据（cursor_stopped 或已无有效绑定）时自荐接管，processing/need_reply_sync 表示主控正在执行、无 pong 不算证据；clear_acting_lead（主控/临时主控）：清除临时主控恢复原 lead；ping（主控/临时主控）：向 targetChannelId 发活性验证，目标应在 timeoutMs 内 pong；pong（任何成员）：响应收到的活性验证 pingId；liveness（主控/临时主控）：查询 targetChannelId 的活性状态。',
      inputSchema: z.object(channelSchema).extend({
        action: z.enum(['start', 'transfer_lead', 'claim_lead', 'clear_acting_lead', 'ping', 'pong', 'liveness']),
        targetSlotId: z.string().min(3).max(240).optional().describe('transfer_lead 必填：目标稳定 AgentSlot'),
        targetChannelId: z.string().regex(/^\d+$/).optional().describe('ping / liveness 必填：目标通道号'),
        pingId: z.string().min(8).max(200).optional().describe('pong 必填：收到的 pingId'),
        timeoutMs: z.number().int().min(1_000).max(30_000).optional().describe('ping：等待 pong 的时长（默认 5000）；claim_lead：复核 pong 超时（默认 8000）'),
        reason: z.string().max(500).optional().describe('transfer_lead / claim_lead 可选：原因')
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, action, targetSlotId, targetChannelId, pingId, timeoutMs, reason }) => safe(channel_id, async (rt) => {
      switch (action) {
        case 'start':
          return { action, ...startRun(rt, channel_id) }
        case 'transfer_lead':
          return { action, ...transferLead(rt, channel_id, required(targetSlotId, action, 'targetSlotId'), reason) }
        case 'claim_lead':
          return { action, ...await claimLead(rt, channel_id, deps, reason, timeoutMs) }
        case 'clear_acting_lead': {
          const agent = currentAgent(rt)
          if (!agent.isEffectiveLead) {
            throw new TaskPoolError('lead_only_clear', '只有主控协调或临时主控可以清除临时主控')
          }
          requireControl(rt).setActingLead({ runId: agent.runId, slotId: null, at: Date.now() })
          return { action, message: '临时主控已清除，恢复原始 lead 权限', nextAction: waitingAction(channel_id) }
        }
        case 'ping': {
          const collaboration = requireCollaboration(rt)
          if (!collaboration.isCoordinator()) {
            throw new TaskPoolError('lead_only_ping', '只有当前有效主控可以发起活性验证')
          }
          const target = required(targetChannelId, action, 'targetChannelId')
          const timeout = timeoutMs ?? 5_000
          const result = collaboration.ping({ targetChannelId: target, timeoutMs: timeout })
          return {
            action,
            ...result,
            message: `已向 CH-${target} 发送活性验证，等待 ${timeout}ms 内响应`,
            nextAction: waitingAction(channel_id)
          }
        }
        case 'pong': {
          const id = required(pingId, action, 'pingId')
          requireCollaboration(rt).pong({ pingId: id })
          return { action, message: '已响应活性验证', pingId: id, nextAction: waitingAction(channel_id) }
        }
        case 'liveness': {
          const collaboration = requireCollaboration(rt)
          if (!collaboration.isCoordinator()) {
            throw new TaskPoolError('lead_only_liveness', '只有当前有效主控可以查询成员活性')
          }
          const target = required(targetChannelId, action, 'targetChannelId')
          const liveness = collaboration.checkLiveness(target)
          return {
            action,
            channelId: target,
            liveness: liveness?.liveness ?? 'unknown',
            lastVerifiedAt: liveness?.lastVerifiedAt,
            consecutiveFailures: liveness?.consecutiveFailures ?? 0,
            nextAction: waitingAction(channel_id)
          }
        }
      }
    })
  )
}

function startRun(rt: TeamChannelRuntime, channelId: string): Record<string, unknown> {
  const control = requireControl(rt)
  const agent = currentAgent(rt)
  const state = control.loadTeamControl()
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
  control.beginLaunch(run.id, Date.now(), `start-run:${randomUUID()}`)
  return {
    runId: run.id,
    status: 'launching',
    message: 'TeamRun 已启动，指令投递中。若投递失败将自动回滚为 ready。',
    nextAction: waitingAction(channelId)
  }
}

function transferLead(
  rt: TeamChannelRuntime,
  channelId: string,
  targetSlotId: string,
  reason: string | undefined
): Record<string, unknown> {
  const control = requireControl(rt)
  const agent = currentAgent(rt)
  if (!agent.isEffectiveLead) {
    throw new TaskPoolError('lead_only_transfer', '只有主控协调或临时主控可以转移主控权限')
  }
  const state = control.loadTeamControl()
  const run = state.runs.find((candidate) => candidate.id === agent.runId)
  if (!run || !['launching', 'running', 'attention'].includes(run.status)) {
    throw new TaskPoolError('run_inactive', '只有运行中的 TeamRun 可以转移主控')
  }
  const targetSlot = state.slots.find((slot) => slot.id === targetSlotId.trim() && slot.runId === run.id)
  if (!targetSlot) throw new TaskPoolError('target_slot_not_found', '目标 AgentSlot 不属于当前 TeamRun')
  const targetBinding = state.bindings.find((binding) => binding.slotId === targetSlot.id && binding.runId === run.id)
  if (!targetBinding) throw new TaskPoolError('target_not_bound', '目标 Agent 尚未完成 MCP 绑定')
  if (rt.isChannelOnline && !rt.isChannelOnline(targetBinding.channelId)) {
    throw new TaskPoolError('target_offline', '目标 Agent 当前离线，不能接收主控权限')
  }
  control.setActingLead({ runId: run.id, slotId: targetSlot.id, at: Date.now() })
  return {
    actingLeadSlotId: targetSlot.id,
    message: `主控权限已转移给 ${targetSlot.name}`,
    reason: reason?.trim(),
    nextAction: waitingAction(channelId)
  }
}

/**
 * 主控离线接管：只在有效主控有可验证终止证据时切换临时主控。ping 只做复核，
 * no-pong 本身不是接管证明——长命令、推理和生成阶段都可能暂时处理不了内部通知，
 * 必须再与通道相位/活性窗口交叉验证。
 */
async function claimLead(
  rt: TeamChannelRuntime,
  channelId: string,
  deps: TeamToolsDeps,
  reason: string | undefined,
  pongTimeoutMs: number | undefined
): Promise<Record<string, unknown>> {
  const control = requireControl(rt)
  const collaboration = requireCollaboration(rt)
  const agent = currentAgent(rt)
  const state = control.loadTeamControl()
  const run = state.runs.find((candidate) => candidate.id === agent.runId)
  if (!run || !['launching', 'running', 'attention'].includes(run.status)) {
    throw new TaskPoolError('run_inactive', '只有运行中的 TeamRun 可以接管主控')
  }
  const leadRole = state.roles.find((role) => role.runId === run.id && role.templateKey === 'lead')
  const leadSlot = leadRole
    ? state.slots.find((slot) => slot.runId === run.id && slot.roleId === leadRole.id)
    : undefined
  const effectiveLeadSlotId = run.actingLeadSlotId ?? leadSlot?.id
  if (agent.isEffectiveLead || effectiveLeadSlotId === agent.slotId) {
    return {
      actingLeadSlotId: agent.slotId,
      alreadyLead: true,
      message: '当前 Agent 已是有效主控，无需接管',
      nextAction: waitingAction(channelId)
    }
  }
  const evidence: string[] = []
  const effectiveLeadBinding = effectiveLeadSlotId
    ? state.bindings.find((binding) => binding.runId === run.id && binding.slotId === effectiveLeadSlotId)
    : undefined
  if (!effectiveLeadSlotId || !effectiveLeadBinding) {
    evidence.push('有效主控不存在或已无 MCP 绑定')
  } else {
    const beforePresence = rt.channelPresence?.(effectiveLeadBinding.channelId)
    if (hasInFlightExecution(beforePresence)) {
      throw new TaskPoolError(
        'lead_busy',
        '有效主控正在处理已领取的消息；执行期间不要求响应 pong，保持现有主控权限'
      )
    }
    const explicitlyStopped = isExplicitlyStoppedPhase(beforePresence?.connectionPhase ?? '')
    if (explicitlyStopped) {
      evidence.push(`Cursor 已明确终止（connectionPhase=${beforePresence!.connectionPhase}）`)
    }
    const prior = collaboration.checkLiveness(effectiveLeadBinding.channelId)
    if (prior && prior.liveness !== 'active') {
      evidence.push(`既有活性记录 ${prior.liveness}（连续失败 ${prior.consecutiveFailures} 次）`)
    }
    if (!explicitlyStopped) {
      const pongTimeout = pongTimeoutMs ?? 8_000
      const { sentAt } = collaboration.ping({
        targetChannelId: effectiveLeadBinding.channelId,
        timeoutMs: pongTimeout
      })
      const deadline = Date.now() + pongTimeout
      let answered = false
      while (Date.now() < deadline) {
        const record = collaboration.checkLiveness(effectiveLeadBinding.channelId)
        if (record?.liveness === 'active' && (record.lastPongAt ?? 0) >= sentAt) {
          answered = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      const afterPresence = rt.channelPresence?.(effectiveLeadBinding.channelId)
      const phase = afterPresence?.connectionPhase ?? ''
      const calledMcpAfterPing = (afterPresence?.lastSeenAt ?? 0) >= sentAt
      if (answered || calledMcpAfterPing) {
        throw new TaskPoolError(
          'lead_still_active',
          answered
            ? '有效主控对活性验证作出了 pong 回应，不能接管；如需转移请由其本人调用 team_run({action:"transfer_lead"})'
            : '有效主控在复核期间产生了新的 MCP 活性，不能接管'
        )
      }
      if (hasInFlightExecution(afterPresence)) {
        throw new TaskPoolError(
          'lead_busy',
          '有效主控已进入消息处理相位；执行期间无 pong 不代表掉线，保持现有主控权限'
        )
      }
      if (!isExplicitlyStoppedPhase(phase)) {
        throw new TaskPoolError(
          'lead_liveness_unproven',
          `有效主控在 ${Math.round(pongTimeout / 1000)}s 内没有 pong，但通道没有 Cursor/运行时明确终止证据；保持现有主控权限`
        )
      }
      evidence.push(`Cursor 已明确终止，复核 ${Math.round(pongTimeout / 1000)}s 无 pong`)
    }
  }
  const at = Date.now()
  control.setActingLead({ runId: run.id, slotId: agent.slotId, at })
  // 权限切换后立即刷新同一 MCP runtime 的动态身份；后续任务迁移与上下文
  // 生成必须以新主控权限执行，不能等下一次工具调用。
  let recoveredTaskIds: string[] = []
  let contextMessageId: string | undefined
  let recoveryWarning: string | undefined
  try {
    deps.refreshIdentity?.(channelId)
    recoveredTaskIds = effectiveLeadBinding
      ? rt.service.recoverLeadWork(effectiveLeadBinding.agentSessionId, agent.slotId)
      : []
    contextMessageId = collaboration.createLeadTakeoverContext({
      previousLeadSlotId: effectiveLeadSlotId,
      evidence,
      recoveredTaskIds
    }).id
  } catch (error) {
    // 权限切换已经持久生效；后续恢复失败必须显式返回 warning，不能把成功
    // 包装成 MCP error 诱导重复接管。
    recoveryWarning = error instanceof Error ? error.message : String(error)
  }
  let auditWarning: string | undefined
  try {
    collaboration.broadcast({
      kind: 'notice',
      subject: '主控离线接管审计',
      content: [
        `【接管审计】席位 ${agent.slotId} 通过 team_run claim_lead 接管临时主控权限。`,
        `失联证据：${evidence.join('；')}。`,
        reason?.trim() ? `接管原因：${reason.trim()}。` : '',
        '原主控恢复后可用 team_run transfer_lead 收回权限，或 clear_acting_lead 复位。'
      ].filter(Boolean).join('')
    })
  } catch (error) {
    // 接管已生效；审计广播失败只降级为警告，不把成功状态回滚成 MCP 错误。
    auditWarning = error instanceof Error ? error.message : String(error)
  }
  return {
    actingLeadSlotId: agent.slotId,
    previousLeadSlotId: effectiveLeadSlotId,
    recoveredTaskIds,
    contextMessageId,
    evidence,
    reason: reason?.trim(),
    ...(auditWarning ? { auditWarning } : {}),
    ...(recoveryWarning ? { recoveryWarning } : {}),
    message: '已接管临时主控权限',
    nextAction: waitingAction(channelId)
  }
}
