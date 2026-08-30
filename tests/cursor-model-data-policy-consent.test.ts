import { describe, expect, it } from 'vitest'
import {
  REQUIRED_CURSOR_MODEL_DATA_POLICIES,
  buildEnsureCursorModelDataPolicyScript,
  cursorModelDataPolicyFailureMessage,
  parseCursorModelDataPolicyConsentResult
} from '../src/infrastructure/cursor/cursor-model-data-policy-consent'

describe('Cursor 模型数据政策确认', () => {
  const policy = REQUIRED_CURSOR_MODEL_DATA_POLICIES[0]!

  it('脚本使用官网状态查询与用户级确认接口，包含精确模型和政策版本', () => {
    const script = buildEnsureCursorModelDataPolicyScript(policy)
    expect(script).toContain('/api/dashboard/get-no-zdr-model-consent-status')
    expect(script).toContain('/api/dashboard/set-user-no-zdr-model-consent')
    expect(script).toContain("scope:'SCOPE_USER'")
    expect(script).toContain('claude-fable-5')
    expect(script).toContain('fable-data-retention-v1')
    expect(script).toContain('acknowledged:true')
    expect(script).toContain('credentials:\'include\'')
    expect(script).toContain('AbortController')
  })

  it('只接受模型与版本完全匹配的成功结果', () => {
    expect(parseCursorModelDataPolicyConsentResult({
      kind: 'already_acknowledged', modelId: policy.modelId, consentVersion: policy.consentVersion
    }, policy)).toEqual({
      kind: 'already_acknowledged', modelId: policy.modelId, consentVersion: policy.consentVersion
    })
    const drifted = parseCursorModelDataPolicyConsentResult({
      kind: 'acknowledged', modelId: policy.modelId, consentVersion: 'future-v2'
    }, policy)
    expect(drifted.kind).toBe('failed')
  })

  it('失败消息保留阶段与 HTTP 状态但限制服务端正文长度', () => {
    const result = parseCursorModelDataPolicyConsentResult({
      kind: 'failed', modelId: policy.modelId, stage: 'write', status: 409, detail: 'x'.repeat(500)
    }, policy)
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.detail).toHaveLength(160)
      expect(cursorModelDataPolicyFailureMessage(result)).toContain('提交失败（claude-fable-5，HTTP 409）')
    }
  })
})
