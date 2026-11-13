import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Where `/api` is proxied in dev. With VITE_MOCK=1 the site never calls it. */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:5590'

export default defineConfig({
  plugins: [react()],
  server: { port: 5595, strictPort: true, proxy: { '/api': { target: API_ORIGIN, changeOrigin: false } } },
  preview: { port: 5596, strictPort: true, proxy: { '/api': { target: API_ORIGIN, changeOrigin: false } } },
})
