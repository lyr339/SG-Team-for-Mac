import { useState } from 'react'
import { CrownIcon } from './UiIcons'

interface AgentAvatarProps {
  avatarId?: string
  name: string
  crowned?: boolean
  online?: boolean
  size?: 'sm' | 'md' | 'lg'
}

export function AgentAvatar({
  avatarId,
  name,
  crowned = false,
  online,
  size = 'md'
}: AgentAvatarProps): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const safeAvatarId = avatarId?.replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <span className={`agent-avatar agent-avatar--${size}`} aria-label={`${name}${crowned ? '，主控' : ''}`}>
      {safeAvatarId && !failed
        ? <img src={`./avatars/${safeAvatarId}.png`} alt="" onError={() => setFailed(true)} />
        : <strong>{name.trim().slice(0, 1) || 'A'}</strong>}
      {crowned ? <i className="agent-avatar__crown" aria-label="主控"><CrownIcon /></i> : null}
      {online !== undefined ? <em className={online ? 'is-online' : ''} /> : null}
    </span>
  )
}
