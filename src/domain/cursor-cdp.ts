/** CDP 调试端口设置（auto-heal 看门开关）。 */

export interface CursorCdpSettings {
  /** 自动保持：检测到 Cursor 运行但调试端口未就绪时，倒计时后自动重启带参拉起。默认关。 */
  autoHealEnabled: boolean
}

export const DEFAULT_CURSOR_CDP_SETTINGS: CursorCdpSettings = {
  autoHealEnabled: false
}

export function normalizeCursorCdpSettings(value: unknown): CursorCdpSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CURSOR_CDP_SETTINGS }
  const raw = value as Record<string, unknown>
  return {
    autoHealEnabled: raw.autoHealEnabled === true
  }
}

/**
 * auto-heal 看门事件（渲染层倒计时提示的数据契约）：
 * countdown（显示可取消倒计时）→ restarting（执行中）→ done / cancelled。
 * 定义在 domain 层：渲染层可安全引用（keeper 实现含 node 依赖，不可直接 import）。
 */
export type CdpAutoHealEvent =
  | { phase: 'countdown'; processKey: string; deadlineAt: number; port: number }
  | { phase: 'restarting'; processKey: string }
  | { phase: 'done'; processKey: string; ok: boolean; message: string }
  | { phase: 'cancelled'; processKey: string }
