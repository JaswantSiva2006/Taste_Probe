import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "server-only": fileURLToPath(new URL("../tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Live probes; each npm script names exactly one file so no run spends another probe's budget.
    include: ["scripts/probe-pivot.test.ts", "scripts/probe-cross-domain.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
