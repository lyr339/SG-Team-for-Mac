/** 单位为 CSS/Electron 逻辑像素；原生窗口与嵌套分栏共用同一空间预算。 */
export const SESSION_CONTENT_MIN_WIDTH = 680
export const SESSION_SIDEBAR_SPEC = { defaultSize: 326, minSize: 286, maxSize: 400 } as const
export const SESSION_INSPECTOR_SPEC = { defaultSize: 360, minSize: 300, maxSize: 480 } as const
export const WINDOW_MIN_WIDTH = 1440
// 双栏最小需求 1314px；1440px 窗口保留 126px 调节余量，而不是把侧栏锁在最小值。
