import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// VITE_API_PROXY points the dev server at another API — e.g. the deployed one,
// to click through a web-only change against real (encrypted) data the local
// API cannot decrypt. Default: the local API.
const API = process.env.VITE_API_PROXY || 'http://localhost:3737'
const proxy = (target: string) => ({ target, changeOrigin: target.startsWith('https:') })

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
      '/api': proxy(API),
      '/auth': proxy(API),
      // OAuth + discovery moved into Express with the Netlify cut; the
      // consent screen calls /oauth/issue-code same-origin.
      '/oauth': proxy(API),
      '/.netlify': proxy(API),
      '/.well-known': proxy(API),
      '/mcp': proxy(API),
    }
  }
})
