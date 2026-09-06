/** 在 Cursor 页面中执行；保持自包含，供写后 hook 与 inspect 共用。只取计数，不传正文。 */
export function nativeUsagePayload(data: {
  chatGenerationUUID?: string; latestChatGenerationUUID?: string; status?: string
  modelConfig?: { selectedModels?: Array<{ modelId?: string }>; modelName?: string }
  turnTokenUsage?: Record<string, number | bigint | undefined>
  contextTokensUsed?: number
  conversationState?: { tokenDetails?: { usedTokens?: number } }
} | undefined, composerId: string): Record<string, unknown> | undefined {
  if (!data) return undefined
  const generationId = data.chatGenerationUUID || data.latestChatGenerationUUID
  if (typeof generationId !== 'string' || !generationId) return undefined
  const modelId = data.modelConfig?.selectedModels?.[0]?.modelId || data.modelConfig?.modelName
  const turn = data.turnTokenUsage
  if (turn && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some((key) => Number(turn[key] ?? 0) > 0)) {
    return { c: composerId, g: generationId, m: modelId, t: Date.now(),
      i: Number(turn.inputTokens ?? 0), o: Number(turn.outputTokens ?? 0),
      r: Number(turn.cacheReadTokens ?? 0), w: Number(turn.cacheWriteTokens ?? 0) }
  }
  // 原生 Context 也是估算；Auto 没有此字段时尝试原生 tokenDetails，不猜上下文上限。
  const used = data.contextTokensUsed ?? data.conversationState?.tokenDetails?.usedTokens
  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used <= 0) return undefined
  const stopped = data.status === 'aborted' || data.status === 'completed'
  if (data.status !== 'generating' && !stopped) return undefined
  return { kind: 'sample', c: composerId, g: generationId, m: modelId, used, stopped, t: Date.now() }
}
