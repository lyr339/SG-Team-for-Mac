import { defineConfig } from 'vitest/config'

/**
 * 测试只收 tests/ 目录：仓库根下的 .handoff/（交接暂存：salvage 源码 +
 * 待重放 patch）内含同名测试文件，其源码尚未集成进 src/，混入会恒定失败。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}']
  }
})
