import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 设计走查专用：纯浏览器渲染 src/renderer/preview.html（mock preload API，不连接任何端口）。
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: { port: 5174 }
})
