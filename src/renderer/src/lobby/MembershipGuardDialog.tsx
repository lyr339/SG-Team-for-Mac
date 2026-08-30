import type { CursorMembershipStatus } from '../../../domain/cursor-membership'
import { cursorMembershipTierLabel } from '../../../domain/cursor-membership'

export interface MembershipGuardDialogProps {
  status: CursorMembershipStatus
  /** 闸门产出的拦截原因文案（含引导动作）。 */
  message: string
  busy: boolean
  error: string
  onClose: () => void
  /** 重新在线抓取档位；非 free 时调用方自动续跑暂存的发起请求。 */
  onRefresh: () => void
}

/**
 * 批量发起会话前的会员档位闸门弹窗：Free 档位 / 无法确认档位时硬阻断
 * （无「仍要发起」——产品约定 free 不能发起批量会话；断网时批量会话本也跑不动）。
 * 「刷新档位并继续」：在账号管线处理账号后回此刷新，非 free 即自动续跑发起。
 */
export function MembershipGuardDialog({
  status,
  message,
  busy,
  error,
  onClose,
  onRefresh
}: MembershipGuardDialogProps): React.JSX.Element {
  const profile = status.state === 'ok' ? status.profile : undefined
  return (
    <div className="handoff-dialog-backdrop" role="presentation">
      <section className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="membership-guard-title">
        <header>
          <div>
            <strong id="membership-guard-title">{profile?.tier === 'free' ? '账号档位不足' : '无法确认账号档位'}</strong>
            <span>发起批量会话前需要处理</span>
          </div>
          <button disabled={busy} aria-label="关闭确认窗口" onClick={onClose}>×</button>
        </header>
        <div className="runtime-guard-body">
          {profile ? (
            <dl className="runtime-guard-accounts">
              <div><dt>当前档位</dt><dd>{cursorMembershipTierLabel(profile.tier, profile.raw)}</dd></div>
              {profile.isTeamMember ? <div><dt>团队状态</dt><dd>在某团队中（删除前需等待退团生效）</dd></div> : null}
            </dl>
          ) : (
            <p className="runtime-guard-accounts">{status.detail ?? '未能获取档位信息'}</p>
          )}
          <p className="runtime-guard-hint">{message}</p>
          {error ? <p className="handoff-dialog-error">{error}</p> : null}
        </div>
        <footer>
          <button disabled={busy} onClick={onClose}>取消</button>
          <button disabled={busy} onClick={onRefresh}>{busy ? '刷新中…' : '刷新档位并继续'}</button>
        </footer>
      </section>
    </div>
  )
}
