import type { InBrowserDeleteResult } from './cursor-in-browser-account-deleter'

/**
 * 账号自动化链的浏览器宿主统一契约。
 *
 * 两条可选路径实现同一形状，AccountAutomationService 的浏览器依赖
 * （readBrowserToken / refreshBrowserToken / inBrowserDeleter）经由本接口装配：
 *   - ExternalBrowserAccountHost   系统浏览器（Edge/Chrome 旧三件套：AppleScript + cookie 库）
 *   - FingerprintAccountChannel    指纹浏览器（RoxyBrowser profile + CDP 直连）
 *
 * 关键领域约束（实机实证）：奥仔处理后旧 token 失效，删除前必须让认证链重放、
 * token 轮换完成——各实现自行把该守门纳入 prepareRefresh / deleteWhenReady 语义。
 */
export interface AccountAutomationBrowserHost {
  /** preflight：读宿主内当前登录态 WorkosCursorSessionToken（未登录/不可达抛带引导错误）。 */
  readToken(): Promise<string>
  /** fallback 轮换通道：刷新会话并返回换发的新 token（超时抛错）。 */
  refresh(previousToken: string): Promise<string>
  /** 奥仔完成后为页内删除做准备（指纹=导航刷新 profile 页；外部=刷新标签页并捕获 tab id）。 */
  prepareRefresh(): Promise<void>
  /** 页内秒级删除；返回 deleted / not_logged_in / retry_legacy（回退协议链）。 */
  deleteWhenReady(): Promise<InBrowserDeleteResult>
  /**
   * 清空宿主内 cursor.com 站点数据（账号隔离）。仅在官网账号已删除后调用；
   * 外部浏览器宿主不实现（mac 旧链路，用户自己的浏览器不代清）。
   */
  clearSiteData?(): Promise<void>
  /**
   * 删除确认后的完整收尾事务（指纹宿主专属）：
   * 页面卸载 → 关窗 → Roxy clear_local_cache / clear_server_cache → random_env。
   * 在关窗后清理（页面回写源切断）；外部浏览器宿主不实现。
   */
  finalizeDeletedAccount?(): Promise<void>
  /** 一轮自动化结束清理（指纹=关窗断连；外部=noop——不能关用户的浏览器）。 */
  dispose(): Promise<void>
}
