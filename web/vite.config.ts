import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the API is a separate process; in production both are served from
    // one origin, so the app always calls relative /api paths and never needs
    // to know which environment it is in.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split the vendor bundle so a change to app code does not invalidate
        // the cached copy of React for every returning user.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query', '@tanstack/react-virtual'],
        },
      },
    },
  },
});
