import { describe, expect, it } from 'vitest'
import { userFacingErrorMessage } from '../src/renderer/src/error-message'

describe('userFacingErrorMessage', () => {
  it('removes Electron remote invocation noise', () => {
    expect(userFacingErrorMessage(
      new Error("Error invoking remote method 'aozai:refresh-balance': Error: 网络错误，请确认服务可达后重试")
    )).toBe('网络错误，请确认服务可达后重试')
  })

  it('keeps plain local errors readable', () => {
    expect(userFacingErrorMessage(new Error('卡密验证失败'))).toBe('卡密验证失败')
  })
})
