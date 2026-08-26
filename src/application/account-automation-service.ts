import type { AozaiService } from './aozai-service'
import type { AozaiCardVault } from './aozai-card-vault'
import type { CursorAccountVault } from './cursor-account-vault'
import type { AccountAutomationSettingsStore } from './account-automation-store'
import type { CursorAccountDeleter, CursorAccountDeleteResult } from '../infrastructure/cursor/cursor-account-deleter'
import type { InBrowserDeleteResult } from '../infrastructure/cursor/cursor-in-browser-account-deleter'
import type { InternalBrowserDeleteResult } from '../infrastructure/cursor/cursor-internal-browser-deleter'
import {
  IDLE_ACCOUNT_AUTOMATION_RUN,
  type AccountAutomationRun,
  type AccountAutomationSettings
} from '../domain/account-automation'

export interface AccountAutomationServiceDeps {
  settings: AccountAutomationSettingsStore
  aozai: Pick<AozaiService, 'processToken' | 'warmup'>
  cardVault: Pick<AozaiCardVault, 'maskedCode'>
  accounts: Pick<CursorAccountVault, 'list' | 'credential' | 'replaceToken' | 'remove'>
  /** 读取浏览器当前 WorkosCursorSessionToken；存在时用于执行前校验「浏览器会话与群枢凭据一致」。 */
  readBrowserToken?: () => string
  /** 刷新浏览器会话并返回新 WorkosCursorSessionToken（奥仔处理后旧 token 失效，须经浏览器换发）。 */
  refreshBrowserToken: (previousToken: string) => Promise<string>
  deleter: Pick<CursorAccountDeleter, 'deleteAccount'>
  /**
   * 内置浏览器秒级通道（首选）：完全脱离外部浏览器依赖，在群枢内嵌 Chromium 中完成
   * 「刷新会话 → 删除账号」全流程。内置 stealth 绕过 Cloudflare，删除脚本预注入，
   * 页面加载完成即自动执行，无外部轮询延迟。
   */
  internalBrowserDeleter?: {
    prepareRefresh: () => Promise<void>
    deleteWhenReady: () => Promise<InternalBrowserDeleteResult>
    dispose: () => void
  }
  /**
   * AppleScript 秒级通道（回退）：页面刷新后直接在浏览器会话内删除官网账号——
   * 删除不需要 token 值，绕开 cookie 落盘等待（~20s → ~3s）。
   * 不可用时返回 retry_legacy，服务回退 cookie 轮换通道。
   */
  inBrowserDeleter?: {
    prepareRefresh: () => Promise<void>
    deleteWhenReady: () => Promise<InBrowserDeleteResult>
  }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

type AccountAutomationListener = (run: AccountAutomationRun) => void

const TICK_MS = 500

/**
 * 账号自动化编排器（玩法 A）：一键创建会话全部提交成功后触发。
 *
 * 链条（每步失败即中止并保留本地账号记录）：
 *   倒计时（可取消）→ 奥仔自助处理（扣 1 次）→ 先用当前会话删除官网账号（仍有效则直接完成）
 *   → 会话已失效时走秒级通道（刷新页面并在浏览器会话内直接删除，~3s）
 *   → 秒级通道不可用时回退 cookie 轮换（换发新 token 入库后用新会话删除，~15-30s）
 *   → 移除群枢本地记录
 *
 * 与 AgentSessionLauncher 解耦：launcher 只发「全部提交成功」事件，
 * 本服务自行判断开关状态决定是否执行；同一 plan 只执行一次。
 */
export class AccountAutomationService {
  private readonly listeners = new Set<AccountAutomationListener>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private run: AccountAutomationRun = { ...IDLE_ACCOUNT_AUTOMATION_RUN }
  private lastHandledPlanId: string | undefined
  private cancelRequested = false
  private running = false
  /** 运行序号：新一轮触发取代倒计时中的旧轮，旧链检测到序号变化即静默退出。 */
  private runSeq = 0

  constructor(private readonly deps: AccountAutomationServiceDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  getSettings(): AccountAutomationSettings {
    return this.deps.settings.load()
  }

  saveSettings(input: unknown): AccountAutomationSettings {
    return this.deps.settings.save(input)
  }

  getRun(): AccountAutomationRun {
    return structuredClone(this.run)
  }

  subscribe(listener: AccountAutomationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** launcher 钩子：本轮所有通道的会话都已创建提交成功（CDP 硬回执齐全）。 */
  onAllSessionsTriggered(planId: string): void {
    if (!planId || planId === this.lastHandledPlanId) return
    if (!this.getSettings().enabled) return
    if (this.running && this.run.phase !== 'countdown') return
    this.lastHandledPlanId = planId
    void this.execute(planId)
  }

  /** 仅倒计时阶段可取消；进入处理后不可中止（奥仔扣次/删号无回滚）。 */
  cancel(): AccountAutomationRun {
    if (this.run.phase !== 'countdown') return this.getRun()
    this.cancelRequested = true
    return this.getRun()
  }

  private setRun(patch: Partial<AccountAutomationRun>): void {
    this.run = { ...this.run, ...patch }
    for (const listener of this.listeners) listener(structuredClone(this.run))
  }

  /**
   * 删除调用统一入口：官网报「先退出团队」时每 2s 自动重试、最长 60s。
   * 奥仔 completed ≠ 副作用已落地——退团/会话失效有服务端延迟（实机实测：
   * completed 后 1s 删除撞 leave team，约一小时后 team_id 已清空）。
   * 其余结果（含重试中途会话失效 authExpired）原样返回，由调用方分支处理。
   */
  private async deleteWithTeamWait(token: string): Promise<CursorAccountDeleteResult> {
    const deadline = this.now() + 60_000
    let attempts = 0
    for (;;) {
      attempts += 1
      const result = await this.deps.deleter.deleteAccount(token)
      if (!result.needLeaveTeam) return result
      if (this.now() >= deadline) {
        return { ok: false, message: `官网持续要求先退出团队（已等待 60s 重试 ${attempts} 次）：${result.message}` }
      }
      this.setRun({ message: `官网要求先退出团队，等待团队状态生效后自动重试…（已试 ${attempts} 次）` })
      await this.sleep(2_000)
    }
  }

  private async execute(planId: string): Promise<void> {
    const mySeq = ++this.runSeq
    this.running = true
    this.cancelRequested = false
    const startedAt = this.now()
    try {
      const settings = this.getSettings()
      this.setRun({
        phase: 'countdown',
        planId,
        startedAt,
        finishedAt: undefined,
        remainingSec: settings.delaySec,
        message: `将在 ${settings.delaySec}s 后自动处理当前账号（可取消）`
      })

      // 前置校验放在倒计时之前亮相、倒计时之后复检（期间用户可能改动）
      const preflight = (): string | undefined => {
        if (!this.deps.cardVault.maskedCode()) return '未配置奥仔卡密，自动化中止'
        const active = this.deps.accounts.list().find((account) => account.active)
        if (!active) return '尚未选择 Cursor 账号，自动化中止'
        // 消耗卡密前的最后一道闸：浏览器会话必须可读且与群枢凭据一致——
        // 否则会把已失效/错误账号的 token 提交给奥仔，失败还浪费一次排查时间
        if (this.deps.readBrowserToken) {
          let browserToken = ''
          try {
            browserToken = this.deps.readBrowserToken().trim()
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            return `浏览器会话读取失败（${detail.replace(/\s+/g, ' ').slice(0, 80)}），自动化中止`
          }
          if (!browserToken) return '浏览器中未登录 cursor.com（请先登录并从浏览器导入 Token），自动化中止'
          let vaultToken = ''
          try {
            vaultToken = this.deps.accounts.credential(active.id).trim()
          } catch {
            vaultToken = ''
          }
          if (vaultToken && browserToken !== vaultToken) {
            return '浏览器会话与群枢凭据不一致（请重新从浏览器导入 Token），自动化中止'
          }
        }
        return undefined
      }
      const earlyIssue = preflight()
      if (earlyIssue) {
        this.setRun({ phase: 'failed', message: earlyIssue, remainingSec: undefined, finishedAt: this.now() })
        return
      }

      for (let left = settings.delaySec; left > 0; left -= 0.5) {
        if (this.runSeq !== mySeq) return // 已被新一轮触发取代，静默退出
        this.setRun({ remainingSec: left, message: `将在 ${left}s 后自动处理当前账号（可取消）` })
        // 倒计时末段预热奥仔登录：执行时直接进入提交，省一次往返
        if (left === Math.min(3, settings.delaySec)) {
          void this.deps.aozai.warmup().catch(() => {})
        }
        await this.sleep(TICK_MS)
        if (this.runSeq !== mySeq) return
        if (this.cancelRequested) {
          this.setRun({ phase: 'cancelled', message: '已取消本次自动化', remainingSec: undefined, finishedAt: this.now() })
          return
        }
      }
      this.setRun({ remainingSec: undefined })
      const issue = preflight()
      if (issue) {
        this.setRun({ phase: 'failed', message: issue, finishedAt: this.now() })
        return
      }

      const account = this.deps.accounts.list().find((candidate) => candidate.active)
      if (!account) {
        this.setRun({ phase: 'failed', message: '尚未选择 Cursor 账号，自动化中止', finishedAt: this.now() })
        return
      }

      this.setRun({ phase: 'processing', message: '奥仔自助处理中…' })
      const previousToken = this.deps.accounts.credential(account.id)
      const processed = await this.deps.aozai.processToken(
        previousToken,
        (_state, message) => {
          if (this.run.phase === 'processing') this.setRun({ message: `奥仔：${message}` })
        },
        { refreshRemaining: false }
      )
      if (!processed.ok) {
        this.setRun({ phase: 'failed', message: `奥仔处理失败：${processed.message}（本地账号已保留）`, finishedAt: this.now() })
        return
      }

      const internalBrowser = this.deps.internalBrowserDeleter
      const inBrowser = this.deps.inBrowserDeleter

      // 主路径：奥仔完成后旧 token 通常已失效，新会话首先出现在浏览器内存中。
      // 优先使用内置浏览器通道（完全脱离外部浏览器依赖），失败后回退 AppleScript 通道。
      if (internalBrowser) {
        this.setRun({ phase: 'deleting', message: '奥仔已完成，正在内置浏览器中刷新会话并秒级删除官网账号…' })
        let fast: InternalBrowserDeleteResult
        try {
          await internalBrowser.prepareRefresh()
          fast = await internalBrowser.deleteWhenReady()
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          fast = { kind: 'retry_legacy', message: detail.replace(/\s+/g, ' ').slice(0, 160) }
        }
        if (fast.kind === 'deleted') {
          this.deps.accounts.remove(account.id)
          this.setRun({ phase: 'done', message: '自动化完成：已处理、官网账号已删除（内置浏览器秒级执行）、本地记录已移除', finishedAt: this.now() })
          return
        }
        if (fast.kind === 'not_logged_in') {
          this.setRun({ phase: 'failed', message: `${fast.message}（本地账号已保留）`, finishedAt: this.now() })
          return
        }
        this.setRun({ phase: 'importing', message: `内置浏览器通道不可用（${fast.message}），回退 AppleScript 通道…` })
      }

      if (inBrowser) {
        this.setRun({ phase: 'deleting', message: '奥仔已完成，正在刷新浏览器会话并秒级删除官网账号…' })
        let fast: InBrowserDeleteResult
        try {
          await inBrowser.prepareRefresh()
          fast = await inBrowser.deleteWhenReady()
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          fast = { kind: 'retry_legacy', message: detail.replace(/\s+/g, ' ').slice(0, 160) }
        }
        if (fast.kind === 'deleted') {
          this.deps.accounts.remove(account.id)
          this.setRun({ phase: 'done', message: '自动化完成：已处理、官网账号已删除（浏览器会话内秒级执行）、本地记录已移除', finishedAt: this.now() })
          return
        }
        if (fast.kind === 'not_logged_in') {
          this.setRun({ phase: 'failed', message: `${fast.message}（本地账号已保留）`, finishedAt: this.now() })
          return
        }
        this.setRun({ phase: 'importing', message: `秒级通道不可用（${fast.message}），回退 cookie 轮换通道…` })
      } else {
        // 无浏览器秒级通道时保留旧行为：先尝试当前 token，若已失效再轮换。
        this.setRun({ phase: 'deleting', message: '正在删除 Cursor 官网账号（不可撤销）…' })
        const direct = await this.deleteWithTeamWait(previousToken)
        if (direct.ok) {
          this.deps.accounts.remove(account.id)
          this.setRun({ phase: 'done', message: '自动化完成：已处理、官网账号已删除（当前会话直接执行）、本地记录已移除', finishedAt: this.now() })
          return
        }
        if (!direct.authExpired) {
          this.setRun({ phase: 'failed', message: `${direct.message}（本地账号已保留）`, finishedAt: this.now() })
          return
        }
        this.setRun({ phase: 'importing', message: '会话已失效，正在刷新浏览器会话获取新 Token…' })
      }
      let newToken: string
      try {
        newToken = await this.deps.refreshBrowserToken(previousToken)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.setRun({ phase: 'failed', message: `新 Token 获取失败：${detail}（本地账号已保留）`, finishedAt: this.now() })
        return
      }
      try {
        this.deps.accounts.replaceToken(account.id, newToken)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.setRun({ phase: 'failed', message: `新 Token 入库失败：${detail}`, finishedAt: this.now() })
        return
      }

      this.setRun({ phase: 'deleting', message: '正在用新会话删除 Cursor 官网账号（不可撤销）…' })
      const deleted = await this.deleteWithTeamWait(newToken)
      if (!deleted.ok) {
        this.setRun({ phase: 'failed', message: `${deleted.message}（新 Token 已入库，本地记录已保留）`, finishedAt: this.now() })
        return
      }

      this.deps.accounts.remove(account.id)
      this.setRun({ phase: 'done', message: '自动化完成：已处理、新凭据已用毕、官网账号已删除、本地记录已移除', finishedAt: this.now() })
    } catch (error) {
      if (this.runSeq !== mySeq) return // 静默让位给新一轮
      const detail = error instanceof Error ? error.message : String(error)
      this.setRun({ phase: 'failed', message: `自动化异常中止：${detail}`, finishedAt: this.now() })
    } finally {
      if (this.runSeq === mySeq) this.running = false
    }
  }
}
