import { describe, expect, it, vi } from 'vitest'
import {
  SAFE_STORAGE_NAMESPACE_APP_NAME,
  initializeSafeStorageNamespace,
  selectSafeStorageNamespace
} from '../src/main/safe-storage-namespace'

describe('safeStorage namespace', () => {
  it('binds the Keychain namespace to the 拾光 brand name', () => {
    const app = { setName: vi.fn() }
    selectSafeStorageNamespace(app)
    expect(app.setName).toHaveBeenCalledWith(SAFE_STORAGE_NAMESPACE_APP_NAME)
    expect(SAFE_STORAGE_NAMESPACE_APP_NAME).toBe('拾光')
  })

  it('verifies a Keychain round-trip before any real credential is written', () => {
    const events: string[] = []
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => {
        events.push('encrypt')
        return Buffer.from(value)
      }),
      decryptString: vi.fn((value: Buffer) => {
        events.push('decrypt')
        return value.toString()
      })
    }

    initializeSafeStorageNamespace(safeStorage)

    expect(events).toEqual(['encrypt', 'decrypt'])
  })

  it('throws when the Keychain round-trip is broken', () => {
    expect(() => initializeSafeStorageNamespace({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: () => 'mismatch'
    }, 'darwin')).toThrow('macOS 系统凭据加密自检失败')
  })

  it('throws with the DPAPI wording on Windows', () => {
    expect(() => initializeSafeStorageNamespace({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: () => 'mismatch'
    }, 'win32')).toThrow('Windows 凭据加密自检失败（DPAPI）')
  })

  it('skips the probe when encryption is unavailable', () => {
    const encryptString = vi.fn()
    initializeSafeStorageNamespace({
      isEncryptionAvailable: () => false,
      encryptString,
      decryptString: () => ''
    })
    expect(encryptString).not.toHaveBeenCalled()
  })
})
