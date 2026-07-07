import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          // Syntax highlighting + markdown rendering pipeline — large and only
          // needed on chat/markdown views.
          markdown: [
            'highlight.js',
            'react-markdown',
            'rehype-highlight',
            'remark-gfm',
          ],
        },
      },
    },
  },
})
