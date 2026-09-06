import { useCallback, useMemo, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import type { ConversationEntry } from '../../domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../../domain/workspace-review'
import type { LiveProcessState } from '../../shared/desktop-api'
import { ActivityPanel } from './inspector/ActivityPanel'
import { projectActivity } from './inspector/activity-view'
import { ArtifactsPanel } from './inspector/ArtifactsPanel'
import { projectArtifacts } from './inspector/artifacts-view'
import { ActivityIcon, ArtifactIcon, DiffIcon, PlanIcon } from './inspector/InspectorIcons'
import { InspectorPanel, InspectorShell, readStoredInspectorTab, type InspectorTabId, type InspectorTabSpec } from './inspector/InspectorShell'
import { currentCursorTodos, PlanPanel, todoTone } from './inspector/PlanPanel'
import { ReviewPanel } from './inspector/ReviewPanel'
import { turnMutatedPaths } from './inspector/review-scope'

export type WorkspaceInspectorTab = InspectorTabId
export type { CursorTodoItem } from './inspector/PlanPanel'

interface WorkspaceInspectorProps {
  session: AgentSession
  entries: ConversationEntry[]
  liveProcess?: LiveProcessState
  workspaceId?: string
  workspaceName?: string
  /** 工作区绝对路径：用于把过程块里的绝对路径归一为仓库相对路径。 */
  workspacePath?: string
  /** 把引用文本追加到该会话的输入框（「反馈给 Agent」）。 */
  onQuoteToComposer?: (text: string) => void
  /** 右栏已收起但仍挂载：面板保留状态，暂停轮询等后台工作，重新展开时补拉一次。 */
  hidden?: boolean
  onClose: () => void
}

/**
 * 会话右侧工作区（Codex 式右栏）：变更 / 计划 / 活动 / 产物 四个面板共用一个壳。
 * 变更是工作区级（切会话不换），其余三个随会话切换；所有数据都是快照的纯投影，
 * 面板不推进任何工作流状态，Git 动作由用户显式发起并经主进程校验。
 * 徽章统一表示「该面板顶层列出的条目数」，实时活动另以状态点表示。
 */
export function WorkspaceInspector({
  session,
  entries,
  liveProcess,
  workspaceId,
  workspaceName,
  workspacePath,
  onQuoteToComposer,
  hidden = false,
  onClose
}: WorkspaceInspectorProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<InspectorTabId>(readStoredInspectorTab)
  const [reviewSummary, setReviewSummary] = useState<WorkspaceReviewSummary>()
  const workspaceKey = workspaceId || workspaceName || session.id
  const todos = useMemo(() => currentCursorTodos(entries, liveProcess), [entries, liveProcess])
  const activity = useMemo(() => projectActivity(entries, liveProcess, workspacePath), [entries, liveProcess, workspacePath])
  const artifacts = useMemo(() => projectArtifacts(entries, reviewSummary, workspacePath), [entries, reviewSummary, workspacePath])
  const turnPaths = useMemo(() => turnMutatedPaths(entries, liveProcess, workspacePath), [entries, liveProcess, workspacePath])
  const onSummary = useCallback((summary: WorkspaceReviewSummary | undefined) => setReviewSummary(summary), [])

  const liveActivity = Boolean(liveProcess?.generating || liveProcess?.blocks.some((block) => block.status === 'running'))
  const runningTodos = todos.items.some((todo) => todoTone(todo.status) === 'running')
  const activityItems = activity.totals.files + activity.totals.commands + activity.totals.sources + activity.totals.tools
  const tabs: InspectorTabSpec[] = [
    { id: 'review', label: '变更', icon: <DiffIcon />, badge: reviewSummary?.state === 'ready' ? reviewSummary.files.length : undefined, title: '工作区 Git 变更审查' },
    { id: 'plan', label: '计划', icon: <PlanIcon />, badge: todos.items.length || undefined, live: runningTodos, title: 'Cursor 原生任务清单' },
    { id: 'activity', label: '活动', icon: <ActivityIcon />, badge: activityItems || undefined, live: liveActivity, title: '本会话的文件、命令、来源与工具调用' },
    { id: 'artifacts', label: '产物', icon: <ArtifactIcon />, badge: artifacts.images.length + artifacts.files.length || undefined, title: '截图、图片与新增文件' }
  ]

  return (
    <InspectorShell tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} onClose={onClose}>
      <InspectorPanel tab="review">
        <ReviewPanel workspaceKey={workspaceKey} turnPaths={turnPaths} paused={hidden} onQuote={onQuoteToComposer} onSummary={onSummary} />
      </InspectorPanel>
      <InspectorPanel tab="plan">
        <PlanPanel todos={todos} onOpenTab={setActiveTab} />
      </InspectorPanel>
      <InspectorPanel tab="activity">
        <ActivityPanel view={activity} onOpenTab={setActiveTab} />
      </InspectorPanel>
      <InspectorPanel tab="artifacts">
        <ArtifactsPanel view={artifacts} onOpenTab={setActiveTab} />
      </InspectorPanel>
    </InspectorShell>
  )
}
