import { inspectorDesktopApi } from './desktop-api'
import { requestReveal, type RevealTarget } from './reveal-bus'

export interface WorkspaceFileActions {
  /** 用编辑器深链打开仓库相对路径（scheme 未注册时主进程退到系统默认程序）。 */
  openFile(path: string): Promise<void>
  /** 复制仓库相对路径到剪贴板。 */
  copyPath(path: string): Promise<void>
  /** 在系统文件管理器中显示。 */
  revealFile(path: string): Promise<void>
  /** 复制任意文本（命令行等）。 */
  copyText(text: string, done?: string): Promise<void>
  /** 在时间线中定位过程块 / 条目；找不到时给出反馈。 */
  reveal(target: RevealTarget): Promise<void>
}

/**
 * 右栏各面板共用的文件 / 定位动作：把 IPC 调用、失败兜底与短暂反馈收口在一处，
 * 变更 / 活动 / 产物三个面板不再各写一份 openFile / copyPath / revealFile。
 * `flash` 由调用方的 useTransientFeedback 提供，反馈落在各自面板的 toast 上。
 */
export function useWorkspaceFileActions(flash: (message: string) => void): WorkspaceFileActions {
  const fail = (reason: unknown): void => flash(reason instanceof Error ? reason.message : String(reason))
  return {
    openFile: async (path) => {
      try {
        const api = inspectorDesktopApi()
        if (!api?.openWorkspaceFile) throw new Error('当前环境无法打开文件')
        const result = await api.openWorkspaceFile({ path })
        if (!result.ok) flash(result.message || '无法打开文件')
        else if (result.method === 'system') flash('已用系统默认程序打开')
      } catch (reason) {
        fail(reason)
      }
    },
    copyPath: async (path) => {
      try {
        await navigator.clipboard.writeText(path)
        flash('路径已复制')
      } catch {
        flash('复制失败')
      }
    },
    revealFile: async (path) => {
      try {
        const api = inspectorDesktopApi()
        if (!api?.revealWorkspaceFile) throw new Error('当前环境无法显示文件')
        await api.revealWorkspaceFile({ path })
      } catch (reason) {
        fail(reason)
      }
    },
    copyText: async (text, done = '已复制') => {
      try {
        await navigator.clipboard.writeText(text)
        flash(done)
      } catch {
        flash('复制失败')
      }
    },
    reveal: async (target) => {
      const found = await requestReveal(target)
      if (!found) flash('时间线里没有找到这一步：它可能不在当前会话，或已被折叠的历史回合覆盖')
    }
  }
}
