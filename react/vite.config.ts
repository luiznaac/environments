import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A generated project is served under a sub-path behind the unified dashboard reverse proxy
// (e.g. "/portfolio/"), but runs at "/" in local dev and in the combined Docker image. Override
// with VITE_BASE. See sibling repos' vite.config.ts for the exact same pattern.
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE ?? (mode === "production" ? "/template/" : "/"),
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: {
      // Dev-only: forward API calls to the backend to dodge CORS.
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:8080",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
}));
