import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  publicDir: 'public',
  worker: { format: 'es' },
  build: {
    outDir: 'out',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2020'
  }
})
