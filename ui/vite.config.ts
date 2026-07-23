import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolveLabUiDevServerConfig } from "./vite-dev-config";

export default defineConfig(() => {
  const devConfig = resolveLabUiDevServerConfig();

  return {
    // EN: Use relative asset URLs so Electron can load the built UI via `file://`.
    base: "./",
    plugins: [react()],
    server: {
      port: devConfig.port,
      proxy: {
        "/api": {
          target: devConfig.apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
