import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3737',
      '/auth': 'http://localhost:3737',
      // OAuth + discovery moved into Express with the Netlify cut; the
      // consent screen calls /oauth/issue-code same-origin.
      '/oauth': 'http://localhost:3737',
      '/.netlify': 'http://localhost:3737',
      '/.well-known': 'http://localhost:3737',
      '/mcp': 'http://localhost:3737',
    }
  }
})
