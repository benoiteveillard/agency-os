import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Backend (apps/web/src) and frontend (apps/web/client) are one deployable
// unit — see docs/decisions.md — but Vite needs its own root, kept separate
// from the Node server's src/ so `tsc --noEmit` (root tsconfig) and the
// server's esbuild bundle never see browser-only source.
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    // changeOrigin stays off so the browser's Host reaches the server: its
    // same-origin check compares Origin against Host, and a rewritten Host
    // (127.0.0.1:3000) turns every dev request into a 403.
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
});
