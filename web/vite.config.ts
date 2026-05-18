import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const localNoProxyHosts = ['localhost', '127.0.0.1', '::1']
const noProxy = `${process.env.NO_PROXY ?? ''},${process.env.no_proxy ?? ''}`
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

process.env.NO_PROXY = [...new Set([...noProxy, ...localNoProxyHosts])].join(',')
process.env.no_proxy = process.env.NO_PROXY

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3210',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('error', (err) => {
            console.error('[vite proxy] /api -> http://127.0.0.1:3210 failed:', err.message)
          })
        },
      },
    },
  },
})
