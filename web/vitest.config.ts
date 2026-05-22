import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: true,
    deps: {
      optimizer: {
        web: {
          include: ['react-aria', 'react-aria-components', '@heroui/react', '@heroui/styles'],
        },
      },
    },
  },
})
