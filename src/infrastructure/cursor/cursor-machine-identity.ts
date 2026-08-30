import { randomBytes, randomUUID } from 'node:crypto'

/**
 * Cursor 机器码身份（逆向 FlyCursor「一键换号」实证格式，2026-08-29 本机交叉验证）：
 * - telemetry.machineId：64 位 hex = hex("auth0|user_" + 21 随机字节)（本机 storage.json 实值同格式）
 * - telemetry.macMachineId / devDeviceId：UUID
 * - telemetry.sqmId：{大写 GUID}（Windows sqm 格式）
 * - machineGuid：UUID，写入 machineid 文件与 state.vscdb 的 storage.serviceMachineId（两处实值恒同）
 *
 * 策略：账号绑定——每账号首次切换时生成一套并持久化到拾光账号库，
 * 之后切换到该账号始终回放同一套（同账号 = 同设备，跨账号互不相同）。
 */
export interface CursorMachineIdentity {
  machineId: string
  macMachineId: string
  devDeviceId: string
  machineGuid: string
  sqmId: string
}

/** hex("auth0|user_")：FlyCursor bytecode 中的机器码前缀常量（61757468307c757365725f）。 */
const MACHINE_ID_PREFIX_HEX = '61757468307c757365725f'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SQM_ID_PATTERN = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/
const MACHINE_ID_PATTERN = new RegExp(`^${MACHINE_ID_PREFIX_HEX}[0-9a-f]{42}$`)

export function generateCursorMachineIdentity(): CursorMachineIdentity {
  return {
    machineId: MACHINE_ID_PREFIX_HEX + randomBytes(21).toString('hex'),
    macMachineId: randomUUID(),
    devDeviceId: randomUUID(),
    machineGuid: randomUUID(),
    sqmId: `{${randomUUID().toUpperCase()}}`
  }
}

/** 账号库反序列化守卫：字段缺失或格式漂移时视为无绑定身份（重新生成）。 */
export function isCursorMachineIdentity(value: unknown): value is CursorMachineIdentity {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CursorMachineIdentity>
  return typeof candidate.machineId === 'string' && MACHINE_ID_PATTERN.test(candidate.machineId)
    && typeof candidate.macMachineId === 'string' && UUID_PATTERN.test(candidate.macMachineId)
    && typeof candidate.devDeviceId === 'string' && UUID_PATTERN.test(candidate.devDeviceId)
    && typeof candidate.machineGuid === 'string' && UUID_PATTERN.test(candidate.machineGuid)
    && typeof candidate.sqmId === 'string' && SQM_ID_PATTERN.test(candidate.sqmId)
}
