import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Share the single root .env file across the monorepo.
  envDir: "../..",
  test: {
    environment: "node",
    include: ["tests/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
