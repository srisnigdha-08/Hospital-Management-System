import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The browser-test server launcher passes Vite's InlineConfig envFile: false.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    react(),
    {
      name: 'remove-external-font-links-in-browser-tests',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html.replace(/<link\b(?=[^>]*\bhref=["']https?:\/\/)[^>]*>\s*/gi, '');
        },
      },
    },
  ],
  envPrefix: [],
  optimizeDeps: {
    noDiscovery: true,
    include: [
      'axios',
      'chart.js',
      'react',
      'react-chartjs-2',
      'react-dom/client',
      'react-hook-form',
      'react-hot-toast',
      'react-router-dom',
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5194,
    strictPort: true,
    proxy: {},
    hmr: false,
  },
});
