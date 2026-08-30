import { describe, expect, it } from 'vitest'
import {
  generateCursorMachineIdentity,
  isCursorMachineIdentity
} from '../src/infrastructure/cursor/cursor-machine-identity'

describe('CursorMachineIdentity', () => {
  it('generates the FlyCursor-verified formats for every field', () => {
    const identity = generateCursorMachineIdentity()

    // telemetry.machineId：hex("auth0|user_" + 21 随机字节) = 64 hex 字符
    expect(identity.machineId).toMatch(/^61757468307c757365725f[0-9a-f]{42}$/)
    expect(Buffer.from(identity.machineId.slice(0, 22), 'hex').toString()).toBe('auth0|user_')

    expect(identity.macMachineId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(identity.devDeviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(identity.machineGuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // sqmId：{大写 GUID}
    expect(identity.sqmId).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/)
  })

  it('generates a distinct identity per call', () => {
    const first = generateCursorMachineIdentity()
    const second = generateCursorMachineIdentity()
    expect(first.machineId).not.toBe(second.machineId)
    expect(first.machineGuid).not.toBe(second.machineGuid)
  })

  it('round-trips through the persistence guard and rejects drift', () => {
    const identity = generateCursorMachineIdentity()
    expect(isCursorMachineIdentity(identity)).toBe(true)
    expect(isCursorMachineIdentity(JSON.parse(JSON.stringify(identity)))).toBe(true)

    expect(isCursorMachineIdentity(undefined)).toBe(false)
    expect(isCursorMachineIdentity(null)).toBe(false)
    expect(isCursorMachineIdentity({ ...identity, machineId: 'not-hex' })).toBe(false)
    expect(isCursorMachineIdentity({ ...identity, machineId: identity.machineId.slice(0, 40) })).toBe(false)
    expect(isCursorMachineIdentity({ ...identity, machineGuid: 'upside-down-uuid' })).toBe(false)
    expect(isCursorMachineIdentity({ ...identity, sqmId: identity.machineGuid })).toBe(false)
    expect(isCursorMachineIdentity({ ...identity, macMachineId: undefined })).toBe(false)
  })
})
