import { useEffect, useState } from 'react'

/**
 * 给「12 分钟前」这类相对时间提供一个会走动的 now：默认每 30s 重渲染一次，
 * 窗口不可见时不计时（回到前台立即校正）。只在有相对时间可显示时才需要挂载。
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: number | undefined
    const tick = (): void => setNow(Date.now())
    const start = (): void => {
      if (timer !== undefined) return
      timer = window.setInterval(tick, intervalMs)
    }
    const stop = (): void => {
      if (timer === undefined) return
      window.clearInterval(timer)
      timer = undefined
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        tick()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs])
  return now
}
