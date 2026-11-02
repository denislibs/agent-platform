import { preact } from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { themeBootScript } from '../src/theme.ts';

// Витрина ui-kit: `bun run ui:dev` (http://localhost:5174), сборка — `bun run ui:build` в showcase/dist.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    preact(),
    {
      name: 'theme-boot',
      // Тема применяется до первой отрисовки, как будет в веб-приложении.
      transformIndexHtml: () => [{ tag: 'script', children: themeBootScript, injectTo: 'head-prepend' }],
    },
  ],
  server: { port: 5174 },
  build: { outDir: 'dist', emptyOutDir: true },
});
