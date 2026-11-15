import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@openedits/source"],
  },
  ssr: {
    resolve: {
      conditions: ["@openedits/source"],
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
