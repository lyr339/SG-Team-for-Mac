import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { CursorWorkspaceDetection } from '../../domain/cursor-workspace'
import {
  GridIcon,
  SettingsIcon,
  SessionsIcon,
  WorkspaceIcon
} from './UiIcons'
import { BrandMark } from './BrandMark'
import { ResizableColumns } from './ResizableColumns'
import { AppearanceSettings } from './AppearanceSettings'

export type AppModule = 'lobby' | 'sessions'

interface DesktopShellProps {
  snapshot: DesktopSnapshot
  activeModule: AppModule
  sidebar: ReactNode
  cursorWorkspace?: CursorWorkspaceDetection
  displayedWorkspaceId?: string
  wideContent?: boolean
  teamChannelIds?: string[]
  cardOpacity: number
  colorMode: 'system' | 'light' | 'dark'
  onModuleChange: (module: AppModule) => void
  onDetectedWorkspaceClick: () => void
  onCardOpacityChange: (value: number) => void
  onColorModeChange: (value: 'system' | 'light' | 'dark') => void
  children: ReactNode
}

const CONNECTION_LABELS: Record<DesktopSnapshot['connection']['state'], string> = {
  disconnected: '通信未连接',
  connecting: '通信连接中',
  connected: '通信已连接',
  reconnecting: '通信重连中',
  error: '通道异常'
}

/**
 * 顶栏连接指示的真实语义：本地桥在进程内恒为 connected（无信息量），
 * 真正反映「拾光 ↔ Cursor」连通性的是过程观察器（CDP）健康度。
 * 有 observer 状态时按它判定；桥级 error 仍优先；都没有时回落旧标签。
 */
function cursorLinkState(snapshot: DesktopSnapshot): {
  tone: string
  label: string
  detail?: string
} {
  if (snapshot.connection.state === 'error') {
    return { tone: 'error', label: '通道异常', detail: snapshot.connection.lastError }
  }
  const stream = snapshot.nativeProcessStream
  if (stream?.state === 'connected') return { tone: 'connected', label: 'Cursor 已连接', detail: stream.detail }
  if (stream?.state === 'reconnecting') return { tone: 'reconnecting', label: 'Cursor 重连中', detail: stream.detail }
  if (stream?.state === 'unavailable') return { tone: 'offline', label: '过程流未连接', detail: stream.detail }
  return { tone: snapshot.connection.state, label: CONNECTION_LABELS[snapshot.connection.state] }
}

const MODULE_LABELS: Record<AppModule, string> = {
  lobby: '配置',
  sessions: 'Cursor 会话'
}

const MODULE_ORDER: AppModule[] = ['sessions', 'lobby']
const CONTEXT_SIDEBAR_SPECS = [{ defaultSize: 270, minSize: 220, maxSize: 500 }] as const
const SESSION_SIDEBAR_SPECS = [{ defaultSize: 326, minSize: 286, maxSize: 420 }] as const
// 快捷键提示平台化：mac 显示 ⌘，其余平台（Windows）显示 Ctrl+；事件侧已兼容两键。
const MODULE_SWITCH_MODIFIER = typeof document !== 'undefined'
  && document.documentElement.dataset.platform === 'darwin'
  ? '⌘'
  : 'Ctrl+'

export function DesktopShell({
  snapshot,
  activeModule,
  sidebar,
  cursorWorkspace,
  displayedWorkspaceId,
  wideContent = false,
  teamChannelIds,
  cardOpacity,
  colorMode,
  onModuleChange,
  onDetectedWorkspaceClick,
  onCardOpacityChange,
  onColorModeChange,
  children
}: DesktopShellProps): React.JSX.Element {
  const [showConnection, setShowConnection] = useState(false)
  const [showAppearance, setShowAppearance] = useState(false)
  const popoverRef = useRef<HTMLElement>(null)
  const appearanceRef = useRef<HTMLDivElement>(null)
  // 顶栏在线统计只按团队成员口径（备用/未编入通道不计入，避免 1/4 式困惑）
  const teamSessions = teamChannelIds?.length
    ? snapshot.sessions.filter((session) => teamChannelIds.includes(session.channelId))
    : snapshot.sessions
  const onlineCount = teamSessions.filter((session) => session.online).length
  const link = cursorLinkState(snapshot)
  const issues = snapshot.protocolIssues
  const detectedWorkspace = cursorWorkspace?.workspace
  const workspaceMatches = Boolean(detectedWorkspace && detectedWorkspace.id === displayedWorkspaceId)
  const showWorkspaceDetection = cursorWorkspace?.state === 'detected' || cursorWorkspace?.state === 'ambiguous'
  const workspaceLabel = cursorWorkspace?.state === 'ambiguous'
    ? `${cursorWorkspace.candidates.length || '多'} 个 Cursor 工程`
    : detectedWorkspace ? `Cursor · ${detectedWorkspace.name}` : ''

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setShowConnection(false)
        setShowAppearance(false)
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const index = Number.parseInt(event.key, 10) - 1
      const module = MODULE_ORDER[index]
      if (index < 0 || !module) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      event.preventDefault()
      onModuleChange(module)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onModuleChange])

  useEffect(() => {
    if (!showConnection && !showAppearance) return
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (popoverRef.current?.contains(target)) return
      if (appearanceRef.current?.contains(target)) return
      if ((target as HTMLElement).closest?.('.connection-chip')) return
      if ((target as HTMLElement).closest?.('.appearance-button')) return
      setShowConnection(false)
      setShowAppearance(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAppearance, showConnection])

  const navButton = (module: AppModule, icon: ReactNode, label: string): ReactNode => (
    <button
      className={activeModule === module ? 'is-active' : ''}
      aria-current={activeModule === module ? 'page' : undefined}
      title={`${MODULE_LABELS[module]} ${MODULE_SWITCH_MODIFIER}${MODULE_ORDER.indexOf(module) + 1}`}
      onClick={() => onModuleChange(module)}
    >
      {icon}
      <span>{label}</span>
    </button>
  )

  return (
    <div className="desktop-shell">
      <header className="topbar">
        <div className="topbar__context">
          <button className="brand" onClick={() => onModuleChange('sessions')} aria-label="返回拾光会话">
            <span className="brand__mark"><BrandMark /></span>
            <strong>拾光</strong>
          </button>
          {showWorkspaceDetection ? (
            <button
              className={`workspace-detection-chip ${workspaceMatches ? 'is-current' : 'is-different'} ${cursorWorkspace?.state === 'ambiguous' ? 'is-ambiguous' : ''}`}
              onClick={onDetectedWorkspaceClick}
              title={cursorWorkspace?.detail}
            >
              <WorkspaceIcon />
              <span>{workspaceLabel}</span>
              <b>{workspaceMatches ? '当前' : cursorWorkspace?.state === 'ambiguous' ? '选择' : '切换'}</b>
            </button>
          ) : null}
        </div>

        <nav className="topbar-nav" aria-label="主要功能">
          {navButton('sessions', <SessionsIcon />, '会话')}
          {navButton('lobby', <GridIcon />, '配置')}
        </nav>

        <div className="topbar__actions">
          <div className="appearance-control" ref={appearanceRef}>
            <button
              className={`appearance-button ${showAppearance ? 'is-active' : ''}`}
              onClick={() => {
                setShowConnection(false)
                setShowAppearance((value) => !value)
              }}
              title="外观设置"
              aria-label="外观设置"
              aria-expanded={showAppearance}
            >
              <SettingsIcon />
            </button>
            {showAppearance ? (
              <AppearanceSettings
                cardOpacity={cardOpacity}
                colorMode={colorMode}
                onCardOpacityChange={onCardOpacityChange}
                onColorModeChange={onColorModeChange}
                onClose={() => setShowAppearance(false)}
              />
            ) : null}
          </div>
          <button
            className={`connection-chip connection-chip--${link.tone}`}
            onClick={() => {
              setShowAppearance(false)
              setShowConnection((value) => !value)
            }}
            title={issues.length
              ? `${issues.length} 条协议异常，点击查看`
              : link.detail || `${link.label}；Agent 在线状态单独核验`}
            aria-expanded={showConnection}
            aria-controls="connection-popover"
          >
            <i />
            <span className="connection-chip__label">{link.label}</span>
            {teamSessions.length > 0 && <span className="connection-chip__online">{onlineCount}/{teamSessions.length} Agent 在线</span>}
            {issues.length > 0 && <b className="connection-chip__issues">{issues.length}</b>}
          </button>
        </div>

        {showConnection && (
          <section className="connection-popover" id="connection-popover" ref={popoverRef}>
            <header>
              <div>
                <strong>拾光本地通道</strong>
                <span>消息与活性经 SG Team MCP 直达 Cursor；Agent 在线状态单独核验</span>
              </div>
              <button onClick={() => setShowConnection(false)}>×</button>
            </header>
            {issues.length > 0 && (
              <div className="connection-popover__issues">
                <strong>协议异常 · 最近 {Math.min(issues.length, 5)} / {issues.length} 条</strong>
                <ul>
                  {issues.slice(-5).reverse().map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}
                </ul>
              </div>
            )}
          </section>
        )}
      </header>

      <div className={`desktop-body desktop-body--${activeModule} ${wideContent ? 'desktop-body--wide' : ''}`}>
        {wideContent ? (
          <div className="shell-columns shell-columns--wide">
            <main className="content-stage">{children}</main>
          </div>
        ) : (
          <ResizableColumns
            className="shell-columns"
            dividerLabels={[activeModule === 'sessions' ? '调整会话列表宽度' : '调整团队侧栏宽度']}
            finalPaneMinSize={420}
            key={activeModule === 'sessions' ? 'shell.sessions' : 'shell.context'}
            paneSpecs={activeModule === 'sessions' ? SESSION_SIDEBAR_SPECS : CONTEXT_SIDEBAR_SPECS}
            storageKey={activeModule === 'sessions' ? 'shell.sessions.v2' : 'shell.context'}
          >
            {sidebar}
            <main className="content-stage">{children}</main>
          </ResizableColumns>
        )}
      </div>
    </div>
  )
}
