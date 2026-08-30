import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentAvatar } from '../src/renderer/src/AgentAvatar'
import { BrandMark } from '../src/renderer/src/BrandMark'

describe('AgentAvatar', () => {
  it('uses a relative asset URL so packaged file:// pages can load generated portraits', () => {
    const markup = renderToStaticMarkup(
      <AgentAvatar avatarId="lead" name="主控协调" crowned />
    )

    expect(markup).toContain('src="./avatars/lead.png"')
    expect(markup).not.toContain('src="/avatars/lead.png"')
  })

  it('uses the same packaged-safe brand asset inside the application', () => {
    expect(renderToStaticMarkup(<BrandMark />)).toContain('src="./brand-shiguang.png"')
  })
})
