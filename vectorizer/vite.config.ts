import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built as a self-contained app served at /apps/stained-glass-vectorizer/
// alongside the Eleventy blog (see ../eleventy.config.js and
// src/_includes/base.njk for the nav link). The root package.json's build
// script runs `eleventy` first, then this project's build, straight into
// the same _site output directory.
export default defineConfig({
  base: '/apps/stained-glass-vectorizer/',
  build: {
    outDir: '../_site/apps/stained-glass-vectorizer',
    emptyOutDir: true,
  },
  plugins: [react()],
})
