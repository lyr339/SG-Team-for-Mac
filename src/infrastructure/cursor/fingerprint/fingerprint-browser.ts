import type { FingerprintBrowserOpenResult, FingerprintBrowserWindow } from './fingerprint-browser-types'

/**
 * 指纹浏览器 Local API 统一契约。
 *
 * 账号自动化链的浏览器宿主抽象：生产装配 RoxyBrowserClient（比特已全面退役），
 * 通道层（fingerprint-account-channel）只依赖本接口（保留注入点供测试替身）。
 * 关键行为：
 *   - openWindow 重复调用幂等（返回当前实例的 CDP ws endpoint）
 *   - closeWindow 尽力而为（失败静默；cookie/登录态保留在 profile）
 *   - listWindows 返回归一化的 {id, name, seq?}
 */
export interface FingerprintBrowser {
  /** 健康检查；不可达/鉴权失败抛带引导信息错误。 */
  health(): Promise<void>
  listWindows(): Promise<FingerprintBrowserWindow[]>
  openWindow(profileId: string): Promise<FingerprintBrowserOpenResult>
  closeWindow(profileId: string): Promise<void>
  /** 账号用毕后的 profile 清场：清本地/服务端缓存并生成下一轮新指纹（关窗后执行）。 */
  finalizeProfile?(profileId: string): Promise<void>
}
