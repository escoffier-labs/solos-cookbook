import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://escoffierlabs.dev',
  base: '/cookbook',
  output: 'static',
  markdown: {
    // `cron` and `fstab` aren't built-in Shiki grammars; alias them to a close
    // language so the build stops warning and the fences still highlight.
    shikiConfig: { langAlias: { cron: 'bash', fstab: 'bash' } },
  },
  vite: { plugins: [tailwindcss()] },
});
