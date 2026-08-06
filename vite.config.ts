import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('src/renderer'),
  publicDir: resolve('resources'),
  build: {
    outDir: resolve('dist'),
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
      '@web': resolve('src/web')
    }
  },
  plugins: [svelte({ configFile: resolve('svelte.config.js') }), tailwindcss()]
})
