export type CursorWorkspaceDetectionState = 'detected' | 'ambiguous' | 'unavailable'

export interface DetectedCursorWorkspace {
  id: string
  name: string
  path: string
  cursorWorkspaceId?: string
}

/**
 * Cursor 当前 IDE 窗口打开的本地文件夹（经 CDP 读窗口配置得到的真实身份）。
 * 只做展示与创建前核对，不会替用户切换运行作用域；多窗口或未开工作区时给出说明。
 */
export interface CursorWorkspaceDetection {
  state: CursorWorkspaceDetectionState
  workspace?: DetectedCursorWorkspace
  candidates: DetectedCursorWorkspace[]
  detail: string
  observedAt: number
}
