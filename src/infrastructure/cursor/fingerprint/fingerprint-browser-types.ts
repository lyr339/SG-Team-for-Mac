/** 指纹浏览器统一类型的实体定义（各 client 实现共用）。 */

export interface FingerprintBrowserWindow {
  /** 窗口 id（Roxy：dirId）。 */
  id: string
  name: string
  seq?: number
}

export interface FingerprintBrowserOpenResult {
  /** browser 级 CDP WebSocket endpoint（ws://127.0.0.1:<port>/devtools/browser/<id>）。 */
  ws: string
  http?: string
  coreVersion?: string
}
