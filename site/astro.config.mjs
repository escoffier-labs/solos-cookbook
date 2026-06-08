import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://escoffierlabs.dev',
  base: '/cookbook',
  output: 'static',
  vite: { plugins: [tailwindcss()] },
});
