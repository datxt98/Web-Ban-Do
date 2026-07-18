import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_API_URL || "http://localhost:5001",
        changeOrigin: true,
      },
      "/health": {
        target: process.env.VITE_PROXY_API_URL || "http://localhost:5001",
        changeOrigin: true,
      },
    },
  },
});
