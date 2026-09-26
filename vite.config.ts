import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// Runtime deps of the main process stay in node_modules instead of being bundled.
const mainExternals = ['playwright-core', 'ws', '@google/genai', 'bufferutil', 'utf-8-validate']

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rolldownOptions: { external: mainExternals },
          },
        },
      },
      preload: {
        input: path.join(import.meta.dirname, 'electron/preload.ts'),
        vite: {
          build: {
            rolldownOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs', inlineDynamicImports: true } },
          },
        },
      },
    }),
  ],
  test: {
    include: ['electron/**/*.test.ts'],
    environment: 'node',
  },
} as never)
