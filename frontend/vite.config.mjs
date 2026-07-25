import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react({
      include: '**/*.{jsx,js}'
    }),
    tailwindcss()
  ],
  esbuild: {
    loader: 'jsx',
    include: /src\/.*\.[jt]sx?$/,
    exclude: []
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        '.js': 'jsx',
        '.jsx': 'jsx'
      }
    }
  },
  server: {
    host: true,
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        ws: true,
        timeout: 0,
        proxyTimeout: 0,
      }
    }
  },
  // Vitest config (read by `npm test`). Logic/util tests run in plain Node;
  // a component test can opt into a DOM with `// @vitest-environment jsdom`.
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  }
})
