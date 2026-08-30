/**
 * Electron safeStorage 的后端按平台自动选择：macOS = Keychain（服务名由
 * app.getName() 派生）；Windows = DPAPI（绑定当前用户，无命名空间概念，
 * app.setName 无副作用）。品牌切换到「拾光」后凭据允许重录（token / 卡密），
 * Keychain 直接使用拾光命名空间；旧「群枢 Safe Storage」条目成为孤儿，
 * 无引用方，可在钥匙串访问中手动清理。
 */
export const SAFE_STORAGE_NAMESPACE_APP_NAME = '拾光'

interface SafeStorageProbe {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

const SAFE_STORAGE_PROBE = 'shiguang-safe-storage-namespace-v1'

/** Must run before Electron initializes safeStorage. */
export function selectSafeStorageNamespace(app: { setName(name: string): void }): void {
  app.setName(SAFE_STORAGE_NAMESPACE_APP_NAME)
}

/**
 * Verifies the system credential round-trip with a throwaway probe ciphertext
 * before any real credential is written. No probe ciphertext is persisted.
 * platform 注入点：测试在任意宿主上锁定两个平台的报错文案。
 */
export function initializeSafeStorageNamespace(
  safeStorage: SafeStorageProbe,
  platform: NodeJS.Platform = process.platform
): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(SAFE_STORAGE_PROBE)
    if (safeStorage.decryptString(encrypted) !== SAFE_STORAGE_PROBE) {
      throw new Error(platform === 'win32'
        ? 'Windows 凭据加密自检失败（DPAPI）'
        : 'macOS 系统凭据加密自检失败')
    }
  }
}
