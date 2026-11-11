import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the admin UI into admin-ui/dist; the bridge serves this folder on port 2401.
// Dev: npm run dev:admin (proxies /api to a bridge running on 2401).
export default defineConfig({
    root: import.meta.dirname,
    base: "/",
    plugins: [react()],
    build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
    server: { proxy: { "/api": "http://127.0.0.1:2401" } },
});
