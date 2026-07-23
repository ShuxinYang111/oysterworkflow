import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
    include: ["test/**/*.test.ts?(x)"],
    testTimeout: 20_000,
  },
});
