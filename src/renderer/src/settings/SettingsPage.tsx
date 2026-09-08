import { useEffect, useState } from 'react'
import type { SettingsPageProps } from './settings-view'
import { isActiveAutomationPhase } from './settings-view'
import { SettingsAccounts } from './SettingsAccounts'
import { SettingsImportSource } from './SettingsImportSource'
import { SettingsAutomation } from './SettingsAutomation'
import { SettingsAozai } from './SettingsAozai'
import { SettingsMaintenance } from './SettingsMaintenance'
import {
  SettingsAccountsIcon,
  SettingsAozaiIcon,
  SettingsAutomationIcon,
  SettingsImportIcon,
  SettingsMaintenanceIcon
} from './icons'

export type SettingsGroupId = 'accounts' | 'import' | 'automation' | 'aozai' | 'maintenance'

interface SettingsGroupDef {
  id: SettingsGroupId
  label: string
  description: string
  icon: (props: { className?: string }) => React.JSX.Element
}

const GROUPS = [
  { id: 'accounts', label: '账号', description: '已保存的 Cursor 账号与当前活跃选择', icon: SettingsAccountsIcon },
  { id: 'import', label: '导入来源', description: 'Token 的获取方式与执行浏览器', icon: SettingsImportIcon },
  { id: 'automation', label: '自动化', description: '会话创建后的账号自动处理流程', icon: SettingsAutomationIcon },
  { id: 'aozai', label: '奥仔服务', description: '自助处理的卡密与次数', icon: SettingsAozaiIcon },
  { id: 'maintenance', label: 'Cursor 维护', description: '本机 Cursor 的更新与数据政策', icon: SettingsMaintenanceIcon }
] as const satisfies readonly SettingsGroupDef[]

function initialGroup(): SettingsGroupId {
  if (typeof window === 'undefined') return 'accounts'
  const [module, group] = window.location.hash.slice(1).split(':')
  if (module !== 'account') return 'accounts'
  return GROUPS.some((def) => def.id === group) ? group as SettingsGroupId : 'accounts'
}

/**
 * 设置页（方案 A）：左侧分组导航 + 右侧内容面板。
 * 整包接收 accountPanel props（App.tsx 组装逻辑零变更），组内自取所需字段。
 * 运行态只在两处留下痕迹：自动化导航项的状态圆点、自动化组顶部的实时横幅。
 */
export function SettingsPage(props: SettingsPageProps): React.JSX.Element {
  const [group, setGroup] = useState<SettingsGroupId>(initialGroup)
  useEffect(() => {
    const sync = (): void => { if (window.location.hash.startsWith('#account')) setGroup(initialGroup()) }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  const phase = props.automationRun?.phase ?? 'idle'
  const automationActive = isActiveAutomationPhase(phase)
  const automationFailed = phase === 'failed'
  const accountMismatch = props.runtimeMatch?.status === 'mismatch'
    || props.membership?.state === 'auth_expired'

  const selectGroup = (id: SettingsGroupId): void => {
    setGroup(id)
    try {
      // 深链仅用于直达与刷新恢复；不写历史栈，避免干扰会话页 hash 语义。
      window.history.replaceState(null, '', `#account:${id}`)
    } catch { /* SSR / 受限环境省略 */ }
  }

  const active = GROUPS.find((def) => def.id === group) ?? GROUPS[0]

  return (
    <div className="settings-page" role="region" aria-label="账号与 Cursor 配置">
      <nav className="settings-nav" aria-label="设置分组">
        <p className="settings-nav__caption">设置</p>
        {GROUPS.map((def) => {
          const Icon = def.icon
          const selected = def.id === group
          return (
            <button
              key={def.id}
              type="button"
              className={`settings-nav__item${selected ? ' is-active' : ''}`}
              aria-current={selected ? 'page' : undefined}
              onClick={() => selectGroup(def.id)}
            >
              <Icon className="settings-nav__icon" />
              <span>{def.label}</span>
              {def.id === 'accounts' && accountMismatch ? (
                <i className="settings-nav__dot is-alert" aria-label="账号状态需要处理" />
              ) : null}
              {def.id === 'automation' && automationActive ? (
                <i className="settings-nav__dot is-running" aria-label="自动化进行中" />
              ) : null}
              {def.id === 'automation' && automationFailed ? (
                <i className="settings-nav__dot is-attention" aria-label="上次自动化失败" />
              ) : null}
            </button>
          )
        })}
      </nav>

      <div className="settings-content">
        {props.error ? <p className="account-dialog-error settings-error" role="alert">{props.error}</p> : null}
        <header className="settings-content__head" key={`head-${active.id}`}>
          <h1>{active.label}</h1>
          <p>{active.description}</p>
        </header>
        <div className="settings-groups">
          <div hidden={group !== 'accounts'}><SettingsAccounts {...props} active={group === 'accounts'} onNavigateToImport={() => selectGroup('import')} /></div>
          <div hidden={group !== 'import'}><SettingsImportSource {...props} phase={phase} /></div>
          <div hidden={group !== 'automation'}><SettingsAutomation {...props} /></div>
          <div hidden={group !== 'aozai'}><SettingsAozai {...props} /></div>
          <div hidden={group !== 'maintenance'}><SettingsMaintenance {...props} /></div>
        </div>
      </div>
    </div>
  )
}
