import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  publicDir: 'public',
  build: {
    outDir: 'out',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2020'
  }
})
