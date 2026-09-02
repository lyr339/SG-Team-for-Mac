import { randomUUID } from 'node:crypto'
import type { DesktopSnapshot } from '../shared/desktop-api'
import type { AgentLaunchItem, AgentLaunchPlan, AgentLaunchRequest } from '../domain/agent-launch'
import type { CursorModelSelection } from '../domain/cursor-model'
import { isAgentOnDuty } from '../domain/channel-message'
import { cursorComposerBindingMarker } from '../domain/cursor-telemetry'
import { CURSOR_CDP_UNAVAILABLE_HINT } from '../infrastructure/cursor/cursor-cdp-session-creator'

export interface AgentLaunchPromptPort {
  /** 从晴天插件取指定通道的标准开场提示词（含插件侧状态准备）。 */
  fetchStartPrompt(channelId: string, timeoutMs?: number): Promise<string>
}

export interface AgentLaunchCreateReceipt {
  ok: boolean
  message: string
  composerId?: string
}

export interface AgentLaunchCreatorPort {
  /** 在 Cursor 窗口内创建新 Agent 会话并提交开场提示词；成功必须返回真实 composerId。 */
  createAgentSession(input: {
    channelId: string
    name: string
    prompt: string
    workspacePath?: string
    modelSelection?: CursorModelSelection
  }): Promise<AgentLaunchCreateReceipt>
}

export interface AgentLaunchContextPort {
  /** 当前团队工作区路径（用于在多窗口中定位正确 Cursor 窗口）。 */
  activeWorkspacePath(): string | undefined
  /** 当前通道运行绑定的 bindingKey（存在时为开场白追加精确绑定标记）。 */
  bindingKeyForChannel(channelId: string): string | undefined
  /** 席位持久化的默认模型；本次 launch request 可覆盖。 */
  modelSelectionForChannel?(channelId: string): CursorModelSelection | undefined
  /** 离线旧 Composer 重建前原子轮换绑定键；在线/在途时返回 undefined。 */
  prepareComposerRelaunch?(channelId: string): string | undefined
}

export interface AgentLaunchSnapshotPort {
  getSnapshot(): DesktopSnapshot
}

export interface AgentSessionLauncherOptions {
  triggerTimeoutMs?: number
  composerTimeoutMs?: number
  waitingTimeoutMs?: number
  pollIntervalMs?: number
  staggerMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** 本轮所有通道均已创建提交成功（CDP 硬回执齐全）时触发一次；后续 composer/waiting 验证继续。 */
  onAllTriggered?: (plan: AgentLaunchPlan) => void
  /** 整轮进入终态时触发；供上层把创建失败收敛回 TeamRun 状态机。 */
  onFinished?: (plan: AgentLaunchPlan) => void
}

const DEFAULT_TRIGGER_TIMEOUT_MS = 15_000
const DEFAULT_COMPOSER_TIMEOUT_MS = 45_000
const DEFAULT_WAITING_TIMEOUT_MS = 180_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_STAGGER_MS = 0

/**
 * 一键批量创建 Cursor Agent 会话的编排器。
 *
 * 创建路径：CDP 直连 Cursor 渲染进程；按席位 modelSelection 创建带独立
 * partialState.modelConfig 的 Composer，再由晴天网关联接 submitByComposerId 提交——
 * 纯程序化、无 DOM、无焦点竞争，因此全部通道真并发（默认无 stagger）。
 * 每个通道独立走三级证据判定，总耗时取决于最慢的一个而非求和：
 *   1. trigger：CDP 创建 + 提交完成，返回真实 composerId（硬回执）
 *   2. composer：遥测确认该通道绑定到这个全新的 composerId
 *   3. waiting：该通道真实进入 check_messages 待命（会话活性租约）
 * 任一级超时即明确报出卡在哪一级，不自动重试（避免重复会话）。
 */
export class AgentSessionLauncher {
  private readonly triggerTimeoutMs: number
  private readonly composerTimeoutMs: number
  private readonly waitingTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly staggerMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private current: AgentLaunchPlan | undefined
  private readonly onAllTriggered?: (plan: AgentLaunchPlan) => void
  private readonly onFinished?: (plan: AgentLaunchPlan) => void

  constructor(
    private readonly prompts: AgentLaunchPromptPort,
    private readonly creator: AgentLaunchCreatorPort,
    private readonly context: AgentLaunchContextPort,
    private readonly snapshots: AgentLaunchSnapshotPort,
    options: AgentSessionLauncherOptions = {}
  ) {
    this.triggerTimeoutMs = options.triggerTimeoutMs ?? DEFAULT_TRIGGER_TIMEOUT_MS
    this.composerTimeoutMs = options.composerTimeoutMs ?? DEFAULT_COMPOSER_TIMEOUT_MS
    this.waitingTimeoutMs = options.waitingTimeoutMs ?? DEFAULT_WAITING_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.staggerMs = options.staggerMs ?? DEFAULT_STAGGER_MS
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
    this.onAllTriggered = options.onAllTriggered
    this.onFinished = options.onFinished
  }

  getPlan(): AgentLaunchPlan | undefined {
    return this.current ? structuredClone(this.current) : undefined
  }

  async launch(
    requests: Array<string | AgentLaunchRequest>,
    onProgress?: (plan: AgentLaunchPlan) => void
  ): Promise<AgentLaunchPlan> {
    if (this.current?.state === 'running') throw new Error('已有会话创建任务进行中')
    const unique = new Map<string, CursorModelSelection | undefined>()
    for (const request of requests) {
      const channelId = (typeof request === 'string' ? request : request.channelId).trim()
      if (!channelId || unique.has(channelId)) continue
      const requested = typeof request === 'string' ? undefined : request.modelSelection
      unique.set(channelId, requested ?? this.context.modelSelectionForChannel?.(channelId))
    }
    if (!unique.size) throw new Error('请选择需要创建会话的通道')
    const plan: AgentLaunchPlan = {
      id: randomUUID(),
      state: 'running',
      items: [...unique].map(([channelId, modelSelection]) => ({
        channelId,
        modelSelection: modelSelection ? structuredClone(modelSelection) : undefined,
        stage: 'trigger' as const,
        message: modelSelection ? `等待触发 · ${modelSelection.displayName}` : '等待触发 · Cursor 当前模型'
      })),
      startedAt: this.now()
    }
    this.current = plan
    let allTriggeredFired = false
    let createdAny = false
    const emit = (): void => {
      onProgress?.(structuredClone(plan))
      // 仅在确实创建了会话的前提下才触发（全部通道本已待命时不消耗自动化配额）
      if (!allTriggeredFired && createdAny
        && plan.items.every((item) => item.stage !== 'trigger' && item.stage !== 'failed')) {
        allTriggeredFired = true
        this.onAllTriggered?.(structuredClone(plan))
      }
    }
    emit()
    const markCreated = (): void => {
      createdAny = true
    }
    await Promise.all(plan.items.map((item, index) => this.launchOne(item, index, emit, markCreated)))
    plan.state = plan.items.every((item) => item.stage === 'done') ? 'done' : 'failed'
    plan.finishedAt = this.now()
    emit()
    this.onFinished?.(structuredClone(plan))
    return structuredClone(plan)
  }

  private async launchOne(item: AgentLaunchItem, index: number, emit: () => void, markCreated: () => void): Promise<void> {
    if (index > 0 && this.staggerMs > 0) await this.sleep(index * this.staggerMs)
    const existing = this.sessionView(item.channelId)
    let bindingKey = this.context.bindingKeyForChannel(item.channelId)
    if (isAgentOnDuty(existing) && !bindingKey) {
      item.stage = 'done'
      item.composerId = existing?.composerId
      item.message = '该通道已有待命会话'
      emit()
      return
    }
    if (!bindingKey && existing?.composerId) {
      bindingKey = this.context.prepareComposerRelaunch?.(item.channelId)
      if (!bindingKey) {
        this.fail(item, '旧会话绑定仍在使用，已停止创建以避免重复 Composer', emit)
        return
      }
    }

    const previousComposerId = existing?.composerId
    this.setStage(item, 'trigger', '正在取开场提示词…', emit)
    let prompt: string
    try {
      prompt = await this.prompts.fetchStartPrompt(item.channelId, this.triggerTimeoutMs)
    } catch (reason) {
      this.fail(item, `未能取得开场提示词：${this.reasonOf(reason)}`, emit)
      return
    }

    if (bindingKey) {
      prompt += `\n\n本次 Cursor 会话绑定标记：${cursorComposerBindingMarker({ bindingKey, channelId: item.channelId })}`
    }

    this.setStage(
      item,
      'trigger',
      `正在 Cursor 窗口内创建 ${item.modelSelection?.displayName ?? '当前模型'} 会话…`,
      emit
    )
    let receipt: AgentLaunchCreateReceipt
    try {
      receipt = await this.creator.createAgentSession({
        channelId: item.channelId,
        name: `CH-${item.channelId} · 拾光会话`,
        prompt,
        workspacePath: this.context.activeWorkspacePath(),
        modelSelection: item.modelSelection
      })
    } catch (reason) {
      this.fail(item, `创建调用未能完成：${this.reasonOf(reason)}`, emit)
      return
    }
    if (!receipt.ok) {
      this.fail(
        item,
        receipt.message || 'Cursor 拒绝了创建请求',
        emit,
        receipt.message.includes(CURSOR_CDP_UNAVAILABLE_HINT) ? 'cdp_unavailable' : undefined
      )
      return
    }
    const receiptComposerId = receipt.composerId
    markCreated()
    if (receiptComposerId) {
      item.composerId = receiptComposerId
    }

    this.setStage(item, 'composer', '会话已创建提交，等待遥测确认绑定…', emit)
    const composerId = await this.poll(
      this.composerTimeoutMs,
      () => {
        const view = this.sessionView(item.channelId)
        const candidate = view?.composerId
        if (!candidate) return undefined
        if (receiptComposerId) return candidate === receiptComposerId ? candidate : undefined
        return candidate !== previousComposerId ? candidate : undefined
      },
      (elapsedSec) => {
        item.message = `会话已创建提交，等待遥测确认绑定…（已等 ${elapsedSec}s）`
        emit()
      }
    )
    if (!composerId) {
      this.fail(
        item,
        receiptComposerId
          ? '超时未被遥测确认绑定：会话已创建，但未能与通道建立绑定（请检查该会话是否执行了开场提示词）'
          : '超时未识别到新会话：提示词可能未能提交进 Cursor（请确认 Cursor 窗口处于前台且网关注入有效）',
        emit
      )
      return
    }
    item.composerId = composerId

    this.setStage(item, 'waiting', '会话已创建，等待 Agent 进入待命…', emit)
    const waiting = await this.poll(
      this.waitingTimeoutMs,
      () => {
        const view = this.sessionView(item.channelId)
        // 在岗 = 在线且处于协议内相位（长轮询/保活/处理中），不能只认裸 waiting：
        // 新会话签到、首次 record_reply 等启动动作均处于 processing 相位。
        return isAgentOnDuty(view) ? true : undefined
      },
      (elapsedSec) => {
        const activityAt = this.sessionView(item.channelId)?.lastAgentActivityAt
        const active = activityAt !== undefined && activityAt >= this.now() - 30_000
        item.message = active
          ? `Agent 执行中，等待进入待命…（已等 ${elapsedSec}s）`
          : `等待 Agent 进入待命…（已等 ${elapsedSec}s）`
        emit()
      }
    )
    if (!waiting) {
      this.fail(item, '会话已创建但 Agent 未进入待命：开场提示词可能未被执行，请检查该会话', emit)
      return
    }
    item.stage = 'done'
    item.message = '会话已就绪'
    emit()
  }

  private sessionView(channelId: string): { online: boolean; waiting: boolean; connectionPhase?: string; composerId?: string; lastAgentActivityAt?: number } | undefined {
    const session = this.snapshots.getSnapshot().sessions.find((candidate) => candidate.channelId === channelId)
    if (!session) return undefined
    return {
      online: session.online,
      waiting: session.waiting,
      connectionPhase: session.connectionPhase,
      composerId: session.composerId,
      lastAgentActivityAt: session.lastAgentActivityAt
    }
  }

  private async poll<T>(
    timeoutMs: number,
    probe: () => T | undefined,
    onWait?: (elapsedSec: number) => void
  ): Promise<T | undefined> {
    const startedAt = this.now()
    const deadline = startedAt + timeoutMs
    let lastAnnouncedBucket = -1
    while (this.now() < deadline) {
      const value = probe()
      if (value !== undefined) return value
      if (onWait) {
        const elapsedSec = Math.floor((this.now() - startedAt) / 1_000)
        const bucket = Math.floor(elapsedSec / 5)
        if (bucket !== lastAnnouncedBucket) {
          lastAnnouncedBucket = bucket
          onWait(elapsedSec)
        }
      }
      await this.sleep(this.pollIntervalMs)
    }
    return undefined
  }

  private setStage(item: AgentLaunchItem, stage: AgentLaunchItem['stage'], message: string, emit: () => void): void {
    item.stage = stage
    item.message = message
    emit()
  }

  private fail(
    item: AgentLaunchItem,
    message: string,
    emit: () => void,
    code?: AgentLaunchItem['code']
  ): void {
    item.code = code
    this.setStage(item, 'failed', message, emit)
  }

  private reasonOf(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason)
  }
}
