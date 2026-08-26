import { useMemo, useState } from 'react'
import type { AgentSkillCatalogEntry } from '../../../domain/agent-skill'
import type { TeamRoleTemplate } from '../../../domain/team-control'
import type {
  CreateTeamInput,
  CreateTeamMemberInput,
  TeamSetupChannel,
  TeamSetupDraft
} from '../../../shared/desktop-api'
import { AgentAvatar } from '../AgentAvatar'
import { ResizableColumns } from '../ResizableColumns'
import { defaultSkillIdsForRole } from './team-skill-defaults'

interface TeamSetupPageProps {
  draft: TeamSetupDraft
  onCreate: (input: CreateTeamInput) => Promise<void>
  onCancel: () => void
}

const TEAM_SETUP_PANE_SPECS = [
  { defaultSize: 260, minSize: 210, maxSize: 420 },
  { defaultSize: 520, minSize: 390, maxSize: 820 }
] as const

function templateOf(draft: TeamSetupDraft, key: string): TeamRoleTemplate {
  return draft.roleTemplates.find((template) => template.key === key) ?? draft.roleTemplates[0]!
}

function defaultRole(index: number): string {
  if (index === 0) return 'lead'
  if (index === 1) return 'builder'
  if (index === 2) return 'reviewer'
  return 'specialist'
}

function initialMembers(draft: TeamSetupDraft): CreateTeamMemberInput[] {
  if (draft.initialMembers?.length) return structuredClone(draft.initialMembers)
  return draft.channels.slice(0, Math.min(3, draft.channels.length)).map((channel, index) => {
    const roleTemplateKey = defaultRole(index)
    const template = templateOf(draft, roleTemplateKey)
    return {
      channelId: channel.channelId,
      roleTemplateKey,
      avatarId: draft.avatarIds[index % draft.avatarIds.length] ?? template.avatarId,
      skillIds: defaultSkillIdsForRole(draft.skills, template)
    }
  })
}

const MAX_TEAM_MEMBERS = 16

function nextRoleKey(members: CreateTeamMemberInput[]): string {
  const usedRoles = new Set(members.map((member) => member.roleTemplateKey))
  return !usedRoles.has('lead')
    ? 'lead'
    : !usedRoles.has('builder')
      ? 'builder'
      : !usedRoles.has('reviewer')
        ? 'reviewer'
        : 'specialist'
}

function synthesizeChannel(channelId: string): TeamSetupChannel {
  return {
    channelId,
    displayName: `Qunshu CH-${channelId}`,
    status: 'offline',
    online: false,
    waiting: false,
    queueDepth: 0
  }
}

function channelStatus(channel: TeamSetupChannel): string {
  if (!channel.online) return '离线'
  if (channel.waiting) return '在线待命'
  return '在线执行中'
}

function skillScope(skill: AgentSkillCatalogEntry): string {
  if (!skill.installed) return skill.source === 'vercel' ? 'Vercel 推荐' : 'Anthropic 推荐'
  if (skill.scope === 'builtin') return 'Cursor 内置'
  if (skill.scope === 'project') return '项目技能'
  return '用户技能'
}

export function TeamSetupPage({ draft, onCreate, onCancel }: TeamSetupPageProps): React.JSX.Element {
  const [members, setMembers] = useState(() => initialMembers(draft))
  const [extraChannels, setExtraChannels] = useState<TeamSetupChannel[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState(members[0]?.channelId ?? '')
  const [skillQuery, setSkillQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const allChannels = useMemo(() => {
    const known = new Set(draft.channels.map((channel) => channel.channelId))
    return [...draft.channels, ...extraChannels.filter((channel) => !known.has(channel.channelId))]
  }, [draft.channels, extraChannels])
  const selected = members.find((member) => member.channelId === selectedChannelId) ?? members[0]
  const selectedTemplate = selected ? templateOf(draft, selected.roleTemplateKey) : undefined
  const leadCount = members.filter((member) => member.roleTemplateKey === 'lead').length
  const reviewerCount = members.filter((member) => member.roleTemplateKey === 'reviewer').length
  const memberValidation = members.length === 0
    ? '请至少选择一个通道'
    : members.length > MAX_TEAM_MEMBERS
      ? `团队人数不能超过 ${MAX_TEAM_MEMBERS}`
      : leadCount !== 1
        ? '必须且只能有 1 名主控'
        : ''
  const channelById = useMemo(
    () => new Map(allChannels.map((channel) => [channel.channelId, channel])),
    [allChannels]
  )
  const validation = memberValidation
  const visibleInstalledSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase('zh-CN')
    return draft.skills.filter((skill) => skill.installed).filter((skill) => (
      !query || `${skill.name}\n${skill.description}`.toLocaleLowerCase('zh-CN').includes(query)
    ))
  }, [draft.skills, skillQuery])
  const recommendedSkills = useMemo(() => {
    if (!selectedTemplate) return []
    const recommended = new Set(selectedTemplate.recommendedSkills)
    return draft.skills.filter((skill) => !skill.installed && recommended.has(skill.name))
  }, [draft.skills, selectedTemplate])

  const updateMember = (channelId: string, update: (member: CreateTeamMemberInput) => CreateTeamMemberInput): void => {
    setMembers((current) => current.map((member) => member.channelId === channelId ? update(member) : member))
  }

  const buildSeat = (channelId: string, current: CreateTeamMemberInput[]): CreateTeamMemberInput => {
    const roleTemplateKey = nextRoleKey(current)
    const template = templateOf(draft, roleTemplateKey)
    const usedAvatars = new Set(current.map((member) => member.avatarId))
    const avatarId = draft.avatarIds.find((id) => !usedAvatars.has(id)) ?? template.avatarId
    return {
      channelId,
      roleTemplateKey,
      avatarId,
      skillIds: defaultSkillIdsForRole(draft.skills, template)
    }
  }

  const toggleChannel = (channel: TeamSetupChannel): void => {
    const exists = members.some((member) => member.channelId === channel.channelId)
    if (exists) {
      const remaining = members.filter((member) => member.channelId !== channel.channelId)
      setMembers(remaining)
      if (selectedChannelId === channel.channelId) setSelectedChannelId(remaining[0]?.channelId ?? '')
      return
    }
    if (members.length >= MAX_TEAM_MEMBERS) return
    setMembers((current) => [...current, buildSeat(channel.channelId, current)])
    setSelectedChannelId(channel.channelId)
  }

  const setMemberCount = (count: number): void => {
    if (!Number.isInteger(count) || count < 0 || count > MAX_TEAM_MEMBERS) return
    if (count <= members.length) {
      const remaining = members.slice(0, count)
      setMembers(remaining)
      if (!remaining.some((member) => member.channelId === selectedChannelId)) {
        setSelectedChannelId(remaining[0]?.channelId ?? '')
      }
      return
    }
    // 增加席位：优先占用尚未上岗的已有通道；不足时合成新的通道号（统一服务器按 channel_id 识别）。
    const additions: CreateTeamMemberInput[] = []
    const synthesized: TeamSetupChannel[] = []
    const occupied = new Set(members.map((member) => member.channelId))
    const knownIds = new Set(allChannels.map((channel) => channel.channelId))
    const working = [...members]
    for (const channel of allChannels) {
      if (working.length + additions.length >= count) break
      if (occupied.has(channel.channelId)) continue
      occupied.add(channel.channelId)
      additions.push(buildSeat(channel.channelId, working.concat(additions)))
    }
    let nextId = Math.max(0, ...[...knownIds].map((id) => Number(id)).filter(Number.isFinite)) + 1
    while (working.length + additions.length < count) {
      const channelId = String(nextId++)
      if (occupied.has(channelId) || knownIds.has(channelId)) continue
      occupied.add(channelId)
      synthesized.push(synthesizeChannel(channelId))
      additions.push(buildSeat(channelId, working.concat(additions)))
    }
    if (synthesized.length) setExtraChannels((current) => [...current, ...synthesized])
    const next = [...members, ...additions]
    setMembers(next)
    if (additions.length) setSelectedChannelId(additions[additions.length - 1]!.channelId)
  }

  const changeRole = (channelId: string, roleTemplateKey: string): void => {
    const template = templateOf(draft, roleTemplateKey)
    updateMember(channelId, (member) => ({
      ...member,
      roleTemplateKey,
      avatarId: template.avatarId,
      skillIds: defaultSkillIdsForRole(draft.skills, template)
    }))
  }

  const create = async (): Promise<void> => {
    if (validation || busy) return
    setBusy(true)
    setError('')
    try {
      await onCreate({ draftId: draft.draftId, members })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="team-setup-page">
      <header className="team-setup-header">
        <div><h1>组建团队</h1><span>{draft.workspaceName}</span><small>{draft.workspacePath}</small></div>
        <ol><li className="is-active">选择通道</li><li>分配角色</li><li>确认团队</li></ol>
      </header>

      <ResizableColumns
        className="team-setup-workspace"
        dividerLabels={['调整可用通道宽度', '调整团队席位宽度']}
        finalPaneMinSize={290}
        paneSpecs={TEAM_SETUP_PANE_SPECS}
        storageKey="team.setup"
      >
        <aside className="team-setup-channels">
          <header><strong>可用通道</strong><span>{allChannels.length}</span></header>
          <div>{allChannels.map((channel) => {
            const member = members.find((candidate) => candidate.channelId === channel.channelId)
            const template = member ? templateOf(draft, member.roleTemplateKey) : undefined
            return (
              <label className={member ? 'is-selected' : ''} key={channel.channelId}>
                <input type="checkbox" checked={Boolean(member)} onChange={() => toggleChannel(channel)} />
                <span><strong>CH-{channel.channelId}{template ? ` · ${template.name}` : ''}</strong><small><i className={channel.online ? 'is-online' : ''} />{channelStatus(channel)} · 队列 {channel.queueDepth}</small></span>
                {member
                  ? <AgentAvatar avatarId={member.avatarId} name={template?.name ?? channel.displayName} crowned={member.roleTemplateKey === 'lead'} online={channel.online} size="sm" />
                  : <em className="team-setup-channel__idle">未选择</em>}
              </label>
            )
          })}</div>
        </aside>

        <main className="team-setup-seats">
          <header>
            <strong>团队席位</strong>
            <span className="team-setup-count">
              <button
                aria-label="减少团队人数"
                disabled={members.length <= 1}
                onClick={() => setMemberCount(members.length - 1)}
              >−</button>
              <input
                aria-label="团队人数"
                inputMode="numeric"
                value={members.length}
                onChange={(event) => {
                  const count = Number(event.target.value)
                  if (Number.isInteger(count)) setMemberCount(count)
                }}
              />
              <button
                aria-label="增加团队人数"
                disabled={members.length >= MAX_TEAM_MEMBERS}
                onClick={() => setMemberCount(members.length + 1)}
              >+</button>
            </span>
            <span>{members.length} 个 Agent · 点击席位配置技能与头像</span>
          </header>
          <div>{members.map((member, index) => {
            const channel = channelById.get(member.channelId)!
            const template = templateOf(draft, member.roleTemplateKey)
            return (
              <article className={member.channelId === selected?.channelId ? 'is-active' : ''} key={member.channelId} onClick={() => setSelectedChannelId(member.channelId)}>
                <b>{index + 1}</b>
                <AgentAvatar avatarId={member.avatarId} name={template.name} crowned={template.key === 'lead'} online={channel.online} size="lg" />
                <div className="team-setup-seat__identity"><strong>CH-{member.channelId}</strong><span>{template.slotName}</span></div>
                <label onClick={(event) => event.stopPropagation()}>
                  <span>角色</span>
                  <select value={member.roleTemplateKey} onChange={(event) => changeRole(member.channelId, event.target.value)}>
                    {draft.roleTemplates.map((option) => <option key={option.key} value={option.key}>{option.name}</option>)}
                  </select>
                </label>
              </article>
            )
          })}{!members.length ? <div className="team-setup-seats__empty">从左侧选择至少一个通道</div> : null}</div>
        </main>

        <aside className="team-setup-inspector">
          <header><strong>角色与技能</strong><span>{selected ? `CH-${selected.channelId}` : '未选择席位'}</span></header>
          {selected && selectedTemplate ? (
            <div className="team-setup-inspector__scroll">
              <section className="team-role-summary">
                <div><AgentAvatar avatarId={selected.avatarId} name={selectedTemplate.name} crowned={selectedTemplate.key === 'lead'} size="lg" /><span><strong>{selectedTemplate.name}</strong><small>{selectedTemplate.slotName}</small></span></div>
                <p>{selectedTemplate.mission}</p>
                <div className="team-role-capabilities">{selectedTemplate.capabilities.map((capability) => <i key={capability}>{capability}</i>)}</div>
              </section>

              <section className="team-avatar-picker">
                <header><strong>人物头像</strong><span>稳定身份，与通道解耦</span></header>
                <div>{draft.avatarIds.map((avatarId) => (
                  <button className={avatarId === selected.avatarId ? 'is-active' : ''} key={avatarId} onClick={() => updateMember(selected.channelId, (member) => ({ ...member, avatarId }))} aria-label={`选择头像 ${avatarId}`}>
                    <AgentAvatar avatarId={avatarId} name={selectedTemplate.name} crowned={selectedTemplate.key === 'lead' && avatarId === selected.avatarId} size="md" />
                  </button>
                ))}</div>
              </section>

              <section className="team-skill-picker">
                <header>
                  <strong>已安装技能</strong>
                  <span>{selected.skillIds.length}/{visibleInstalledSkills.length}</span>
                  <div className="team-skill-picker__actions">
                    <button
                      type="button"
                      onClick={() => updateMember(selected.channelId, (member) => ({
                        ...member,
                        skillIds: defaultSkillIdsForRole(draft.skills, selectedTemplate)
                      }))}
                    >按角色推荐</button>
                    <button
                      type="button"
                      disabled={!selected.skillIds.length}
                      onClick={() => updateMember(selected.channelId, (member) => ({ ...member, skillIds: [] }))}
                    >清空</button>
                  </div>
                </header>
                <input value={skillQuery} placeholder="搜索技能名称或用途" aria-label="搜索技能" onChange={(event) => setSkillQuery(event.target.value)} />
                <div>{visibleInstalledSkills.map((skill) => (
                  <label key={skill.id}>
                    <input
                      type="checkbox"
                      checked={selected.skillIds.includes(skill.id)}
                      onChange={(event) => updateMember(selected.channelId, (member) => ({
                        ...member,
                        skillIds: event.target.checked
                          ? [...member.skillIds, skill.id]
                          : member.skillIds.filter((id) => id !== skill.id)
                      }))}
                    />
                    <span><strong>/{skill.name}</strong><small>{skill.description}</small></span>
                    <em>{skillScope(skill)}</em>
                  </label>
                ))}{!visibleInstalledSkills.length ? <p>没有匹配的已安装技能</p> : null}</div>
              </section>

              {recommendedSkills.length ? (
                <section className="team-skill-recommendations">
                  <header><strong>推荐技能</strong><span>仅收录，安装后才能分配</span></header>
                  <div>{recommendedSkills.map((skill) => <span key={skill.id} title={skill.repository}>{skill.name}<em>{skillScope(skill)}</em></span>)}</div>
                </section>
              ) : null}
            </div>
          ) : <div className="team-setup-inspector__empty">选择一个团队席位后配置角色、头像与技能</div>}
        </aside>
      </ResizableColumns>

      <footer className="team-setup-footer">
        <div><strong>已选 <b>{members.length}</b> / 可用 {allChannels.length}</strong><span className={validation ? 'is-error' : ''}>{validation || (reviewerCount ? '只会创建已选席位；Cursor 会话由你手动发起，群枢自动接管' : '只会创建已选席位；未配置质量角色时，验收异常交给你')}</span></div>
        {error ? <em>{error}</em> : null}
        <button onClick={onCancel}>取消</button>
        <button disabled={Boolean(validation) || busy} onClick={() => void create()}>
          {busy ? '创建中…' : '创建团队'}
        </button>
      </footer>
    </div>
  )
}
