import type { CursorModelOption, CursorModelVariant } from './cursor-model'

/**
 * 目录是否存在 maxMode=true 的 variant 条目：
 * 存在 → maxMode 参与组合约束（开启 MAX 会联动参数，如 GPT-5.6 Sol 的 1M）；
 * 不存在（全 false）但模型 supportsMaxMode → MAX Mode 是模型级正交开关，
 * 不参与组合约束——Kimi K3 目录即此形态（2026-09 运行态深度逆向实证）。
 */
function catalogConstrainsMaxMode(option: CursorModelOption): boolean {
  return (option.variants ?? []).some((variant) => variant.maxMode === true)
}

/**
 * variant 是否支持目标模式。
 * 约束型目录（含 true 条目）：严格 variant.maxMode === mode；
 * 正交型目录（全 false 条目）：只受模型级 supports 闸门约束，任何参数组合两种模式皆可。
 */
export function cursorVariantSupportsMode(
  option: CursorModelOption,
  variant: CursorModelVariant,
  mode: boolean
): boolean {
  if (catalogConstrainsMaxMode(option)) return variant.maxMode === mode
  if (!mode) return option.supportsNonMaxMode !== false
  return option.supportsMaxMode !== false
}

/**
 * 选中该 variant 后的最终 maxMode。
 * 约束型目录：由 variant 决定（联动）；正交型目录：保留用户偏好（开关独立可拨）。
 */
export function cursorVariantResolvedMode(
  option: CursorModelOption,
  variant: CursorModelVariant,
  preferred: boolean
): boolean {
  if (catalogConstrainsMaxMode(option)) return variant.maxMode
  return preferred
}
