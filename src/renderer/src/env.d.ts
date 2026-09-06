import type { SgDesktopApi } from '../../shared/desktop-api'

declare global {
  interface Window {
    sgDesktop: SgDesktopApi
  }
}

export {}
