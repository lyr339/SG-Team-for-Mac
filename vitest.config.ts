import { defineConfig } from 'vitest/config'

/** 测试只收 tests/ 目录；.handoff/ 只放交接文档，不含可执行代码。 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}']
  }
})
