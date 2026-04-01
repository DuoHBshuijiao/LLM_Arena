import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 9300,
    proxy: {
      "/api": {
        target: "http://localhost:9400",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
        /** 流式 chat 可能较长；0 表示不限制，避免反代提前断开触发误 abort */
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
