import { useEffect, useState } from 'react'
import { AttachmentThumbnail } from '../AttachmentImageViewer'
import { formatFullClock, formatRelativeClock } from '../format'
import type { ArtifactItem, ArtifactsView } from './artifacts-view'
import { ArtifactIcon, CopyIcon, FileGlyph, FolderIcon, OpenExternalIcon, TargetGlyph } from './InspectorIcons'
import type { InspectorTabId } from './InspectorShell'
import { InspectorGroupLabel, InspectorSectionHeader, InspectorState, InspectorToast, useTransientFeedback } from './InspectorState'
import { useNow } from './use-now'
import { useWorkspaceFileActions, type WorkspaceFileActions } from './use-workspace-file-actions'

const SOURCE_LABELS: Record<ArtifactItem['source'], string> = {
  reply: 'Agent 回复',
  user: '你发送的',
  worktree: '工作区新增'
}

function ImageCard({ item, now, actions }: { item: ArtifactItem; now: number; actions: WorkspaceFileActions }): React.JSX.Element | null {
  const [broken, setBroken] = useState(false)
  const source = item.attachment.previewUrl
  // 工作区新增图片按「工作区路径 + 仓库相对路径」拼装，工作区位于仓库子目录时可能
  // 拼错；预加载失败就整卡隐藏，不留破图。
  useEffect(() => {
    if (!source || item.source !== 'worktree' || typeof Image === 'undefined') return
    let disposed = false
    const probe = new Image()
    probe.onerror = () => { if (!disposed) setBroken(true) }
    probe.src = source
    return () => { disposed = true }
  }, [item.source, source])
  if (broken) return null
  return (
    <figure className={`artifact-card is-${item.source}`}>
      <div className="artifact-card__thumb">
        <AttachmentThumbnail attachment={item.attachment} className="artifact-card__image" />
      </div>
      <figcaption>
        <strong title={item.attachment.path ?? item.name}>{item.name}</strong>
        <span>
          {SOURCE_LABELS[item.source]}
          {item.at ? <> · <time dateTime={new Date(item.at).toISOString()} title={formatFullClock(item.at)}>{formatRelativeClock(item.at, now)}</time></> : null}
        </span>
      </figcaption>
      {/* 缩略图上方的悬停动作：会话来源可定位回消息；工作区新增可打开 / 复制路径 / 显示。 */}
      <span className="artifact-card__actions">
        {item.entryId ? (
          <button type="button" className="inspector-icon-button" title="在时间线中定位" aria-label={`在时间线中定位 ${item.name}`} onClick={() => void actions.reveal({ entryId: item.entryId })}><TargetGlyph /></button>
        ) : null}
        {item.relativePath ? (
          <>
            <button type="button" className="inspector-icon-button" title="在 Cursor 中打开" aria-label={`在编辑器中打开 ${item.relativePath}`} onClick={() => void actions.openFile(item.relativePath!)}><OpenExternalIcon /></button>
            <button type="button" className="inspector-icon-button" title="复制路径" aria-label={`复制路径 ${item.relativePath}`} onClick={() => void actions.copyPath(item.relativePath!)}><CopyIcon /></button>
            <button type="button" className="inspector-icon-button" title="在文件管理器中显示" aria-label={`在文件管理器中显示 ${item.relativePath}`} onClick={() => void actions.revealFile(item.relativePath!)}><FolderIcon /></button>
          </>
        ) : null}
      </span>
    </figure>
  )
}

export function ArtifactsPanel({ view, onOpenTab }: { view: ArtifactsView; onOpenTab?: (tab: InspectorTabId) => void }): React.JSX.Element {
  const [feedback, flash] = useTransientFeedback()
  const actions = useWorkspaceFileActions(flash)
  const now = useNow()
  const total = view.images.length + view.files.length
  return (
    <section className="inspector-artifacts" aria-label="会话产物">
      <InspectorSectionHeader
        title="产物"
        hint="回复引用的截图、你发送的图片、本次新增到工作区的文件"
        aside={total ? <b className="inspector-artifacts__count">{total}</b> : null}
      />
      {!total ? (
        <InspectorState
          icon={<ArtifactIcon />}
          title="还没有产物"
          hint={<>Agent 用 <code>![说明](/绝对路径.png)</code> 引用截图、或在工作区新建文件后，会出现在这里</>}
          action={onOpenTab ? <button type="button" className="inspector-link" onClick={() => onOpenTab('review')}>查看工作区变更</button> : undefined}
        />
      ) : (
        <div className="inspector-artifacts__body">
          {view.images.length ? (
            <>
              <InspectorGroupLabel count={view.images.length}>图片</InspectorGroupLabel>
              <div className="artifact-grid">
                {view.images.map((item) => <ImageCard key={item.id} item={item} now={now} actions={actions} />)}
              </div>
            </>
          ) : null}
          {view.files.length ? (
            <>
              <InspectorGroupLabel count={view.files.length}>新增文件</InspectorGroupLabel>
              <ul className="artifact-files">
                {view.files.map((item) => (
                  <li key={item.id}>
                    <span className="artifact-file__main" title={item.relativePath}>
                      <span className="activity-row__icon"><FileGlyph /></span>
                      <code>{item.relativePath}</code>
                    </span>
                    {item.relativePath ? (
                      <span className="artifact-file__actions">
                        <button type="button" className="inspector-icon-button" title="在 Cursor 中打开" aria-label={`在编辑器中打开 ${item.relativePath}`} onClick={() => void actions.openFile(item.relativePath!)}><OpenExternalIcon /></button>
                        <button type="button" className="inspector-icon-button" title="复制路径" aria-label={`复制路径 ${item.relativePath}`} onClick={() => void actions.copyPath(item.relativePath!)}><CopyIcon /></button>
                        <button type="button" className="inspector-icon-button" title="在文件管理器中显示" aria-label={`在文件管理器中显示 ${item.relativePath}`} onClick={() => void actions.revealFile(item.relativePath!)}><FolderIcon /></button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      )}
      <InspectorToast message={feedback} />
    </section>
  )
}
