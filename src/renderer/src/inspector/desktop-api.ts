import type { QingtianDesktopApi } from '../../../shared/desktop-api'

/**
 * 静态渲染 / 测试环境没有 preload 注入的 API：面板退化为空态提示，不抛错。
 * 只暴露右栏用到的方法，避免面板悄悄依赖别的 IPC。
 */
export type InspectorDesktopApi = Pick<
  QingtianDesktopApi,
  | 'getWorkspaceReview'
  | 'getWorkspaceReviewFile'
  | 'applyWorkspaceReviewAction'
  | 'revealWorkspaceFile'
  | 'openWorkspaceFile'
  | 'onWorkspaceReviewChanged'
>

export function inspectorDesktopApi(): Partial<InspectorDesktopApi> | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { qingtianDesktop?: Partial<InspectorDesktopApi> }).qingtianDesktop
}
