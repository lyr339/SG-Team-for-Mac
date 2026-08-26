import type { QingtianDesktopApi } from '../../shared/desktop-api'

declare global {
  interface Window {
    qingtianDesktop: QingtianDesktopApi
  }
}

export {}
