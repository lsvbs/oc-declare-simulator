import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        // Use 127.0.0.1 (not "localhost"): on macOS "localhost" resolves to IPv6
        // ::1 first, where the AirPlay Receiver squats on port 5000 and returns
        // 403. Flask listens on IPv4 127.0.0.1:5000, so target that explicitly.
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      }
    }
  }
})
