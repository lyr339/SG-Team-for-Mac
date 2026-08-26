export interface ResizablePaneSpec {
  defaultSize: number
  minSize: number
  maxSize: number
}

export const RESIZE_HANDLE_SIZE = 10

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

export function defaultPaneSizes(specs: readonly ResizablePaneSpec[]): number[] {
  return specs.map((spec) => clamp(spec.defaultSize, spec.minSize, spec.maxSize))
}

/**
 * Keeps all fixed panes inside their own bounds and preserves the final
 * flexible pane's minimum width. If the window is narrower than the combined
 * minimums, the minimums win and the owning view can fall back to scrolling.
 */
export function fitPaneSizes(
  values: readonly number[],
  specs: readonly ResizablePaneSpec[],
  containerWidth: number,
  finalPaneMinSize: number,
  handleSize = RESIZE_HANDLE_SIZE
): number[] {
  const sizes = specs.map((spec, index) => clamp(
    Number.isFinite(values[index]) ? values[index]! : spec.defaultSize,
    spec.minSize,
    spec.maxSize
  ))
  const budget = Math.max(0, Math.floor(containerWidth - finalPaneMinSize - handleSize * specs.length))
  let overflow = sizes.reduce((total, size) => total + size, 0) - budget
  if (overflow <= 0) return sizes

  for (let index = sizes.length - 1; index >= 0 && overflow > 0; index -= 1) {
    const reducible = Math.max(0, sizes[index]! - specs[index]!.minSize)
    const reduction = Math.min(reducible, overflow)
    sizes[index] = sizes[index]! - reduction
    overflow -= reduction
  }
  return sizes
}

export function resizePane(
  values: readonly number[],
  specs: readonly ResizablePaneSpec[],
  index: number,
  requestedSize: number,
  containerWidth: number,
  finalPaneMinSize: number,
  handleSize = RESIZE_HANDLE_SIZE
): number[] {
  if (!specs[index]) return fitPaneSizes(values, specs, containerWidth, finalPaneMinSize, handleSize)
  const current = fitPaneSizes(values, specs, containerWidth, finalPaneMinSize, handleSize)
  const otherSize = current.reduce((total, size, candidateIndex) => (
    candidateIndex === index ? total : total + size
  ), 0)
  const available = containerWidth - finalPaneMinSize - handleSize * specs.length - otherSize
  const spec = specs[index]!
  const maximum = Math.max(spec.minSize, Math.min(spec.maxSize, available))
  current[index] = clamp(requestedSize, spec.minSize, maximum)
  return current
}
