import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import {
  cursorModelParameterLabel,
  cursorModelParameterValue,
  cursorModelAutomaticChanges,
  cursorModelSelectionFromOption,
  fixedCursorModelContext,
  withCursorModelMaxMode,
  withCursorModelParameter
} from '../cursor-model-selection'
import { MenuSelect } from './MenuSelect'
import { ToggleSwitch } from './ToggleSwitch'
import { modelProviderClass } from '../model-provider'

interface CursorModelConfigDialogProps {
  channelId: string
  models: CursorModelOption[]
  selection?: CursorModelSelection
  disabled?: boolean
  onSave: (selection: CursorModelSelection) => Promise<void> | void
  onClose: () => void
}

export function CursorModelConfigDialog({
  channelId,
  models,
  selection,
  disabled = false,
  onSave,
  onClose
}: CursorModelConfigDialogProps): React.JSX.Element {
  const initialOption = models.find((model) => model.modelId === selection?.modelId)
    ?? models.find((model) => model.selected)
    ?? models[0]
  const [draft, setDraft] = useState<CursorModelSelection | undefined>(() => (
    selection ? structuredClone(selection) : cursorModelSelectionFromOption(initialOption)
  ))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [linkNotice, setLinkNotice] = useState('')
  const option = models.find((model) => model.modelId === draft?.modelId)
    ?? initialOption
  const resolvedSelection = draft ?? cursorModelSelectionFromOption(option)
  const fixedContext = fixedCursorModelContext(option, resolvedSelection)

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, saving])

  const save = async (): Promise<void> => {
    if (!resolvedSelection || saving) return
    setSaving(true)
    setSaveError('')
    try {
      await onSave(resolvedSelection)
      onClose()
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="cursor-model-dialog__backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose()
    }}>
      <section
        aria-label={`CH-${channelId} 会话配置`}
        aria-modal="true"
        className="cursor-model-dialog"
        role="dialog"
      >
        <header>
          <span><small>Agent 会话</small><strong>CH-{channelId} · 模型与参数</strong></span>
          <button aria-label="关闭会话配置" disabled={saving} onClick={onClose}>×</button>
        </header>
        <div className="cursor-model-dialog__body">
          <div className="cursor-model-dialog__model">
            <span>Model</span>
            <MenuSelect
              ariaLabel={`CH-${channelId} 弹层模型`}
              disabled={disabled || saving || !models.length}
              value={option?.modelId ?? ''}
              options={models.map((model) => ({
                value: model.modelId,
                label: model.displayName,
                tone: modelProviderClass(model.modelId, model.displayName)
              }))}
              onChange={(modelId) => {
                const next = cursorModelSelectionFromOption(models.find((model) => model.modelId === modelId))
                if (next) {
                  setDraft(next)
                  setLinkNotice('')
                }
              }}
            />
          </div>
          {option?.parameterDefinitions.map((definition) => {
            const label = cursorModelParameterLabel(definition)
            const current = cursorModelParameterValue(resolvedSelection, option, definition)
            return (
              <div className="cursor-model-option" key={definition.id} title={definition.tooltip}>
                <header><span>{label}</span></header>
                <div role="group" aria-label={`CH-${channelId} 弹层${label}`}>
                  {definition.values.map((value) => (
                    <button
                      type="button"
                      key={value.value}
                      className={current === value.value ? 'is-active' : ''}
                      aria-label={`CH-${channelId} 弹层${label} ${value.displayName}`}
                      aria-pressed={current === value.value}
                      disabled={disabled || saving || !resolvedSelection}
                      onClick={() => {
                        if (!resolvedSelection) return
                        const next = withCursorModelParameter(
                          resolvedSelection,
                          option,
                          definition.id,
                          value.value
                        )
                        const linked = cursorModelAutomaticChanges(
                          resolvedSelection,
                          next,
                          option,
                          definition.id
                        )
                        setLinkNotice(linked.length ? `Cursor 联动：${linked.join(' · ')}` : '')
                        setDraft(next)
                      }}
                    >
                      <span>{value.displayName}</span>
                      {value.increasesCost ? <i>High cost</i> : null}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          {option?.supportsMaxMode && resolvedSelection ? (
            <div className="cursor-model-dialog__max-mode">
              <span><b>MAX Mode</b><small>{resolvedSelection.maxMode ? 'Maximum context' : 'Standard context'}</small></span>
              <ToggleSwitch
                checked={resolvedSelection.maxMode === true}
                disabled={disabled || saving}
                label={`CH-${channelId} MAX Mode`}
                onChange={(checked) => {
                  const next = withCursorModelMaxMode(resolvedSelection, option, checked)
                  const linked = cursorModelAutomaticChanges(resolvedSelection, next, option, 'maxMode')
                  setLinkNotice(linked.length ? `Cursor 联动：${linked.join(' · ')}` : '')
                  setDraft(next)
                }}
              />
            </div>
          ) : null}
          {fixedContext ? (
            <div className="cursor-model-dialog__fixed"><span>Context</span><b>{fixedContext}</b></div>
          ) : null}
          {linkNotice ? <p className="cursor-model-dialog__linked" role="status">{linkNotice}</p> : null}
          {saveError ? <em className="cursor-model-dialog__error" role="alert">{saveError}</em> : null}
          <p>保存到 CH-{channelId} 新建 Composer，不改变 Cursor 全局模型。</p>
        </div>
        <footer><button disabled={disabled || saving || !resolvedSelection} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></footer>
      </section>
    </div>,
    document.body
  )
}
