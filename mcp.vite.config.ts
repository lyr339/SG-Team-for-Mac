import { defineConfig } from 'vite'

export default defineConfig({
  ssr: {
    noExternal: true
  },
  build: {
    target: 'node24',
    outDir: 'out/mcp',
    emptyOutDir: true,
    sourcemap: true,
    ssr: 'src/mcp/index.ts',
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'index.mjs'
      }
    }
  }
})
