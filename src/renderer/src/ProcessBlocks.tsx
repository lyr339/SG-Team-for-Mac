import type { ProcessBlock } from '../../domain/conversation-entry'
import { ProcessTurnCard } from './ProcessTurnCard'

/** 兼容入口：Cursor 原生过程统一交给 ProcessTurnCard。 */
export function ProcessBlocks({ blocks }: { blocks: ProcessBlock[] }): React.JSX.Element | null {
  return (
    <ProcessTurnCard
      id={blocks[0]?.id ?? 'process-blocks'}
      blocks={blocks}
      startedAt={blocks.map((block) => block.startedAt).find((value) => value !== undefined)}
      updatedAt={blocks.map((block) => block.completedAt).filter((value): value is number => value !== undefined).at(-1)}
      defaultOpen
      compact
    />
  )
}
