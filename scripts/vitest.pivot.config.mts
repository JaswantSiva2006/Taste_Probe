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
    // S9.16R supplier campaign is explicitly opt-in and has a separate durable six-request allowance.
    environment: "node",
    // Live probes; each npm script names exactly one file so no run spends another probe's budget.
    include: ["scripts/probe-discovery-listening.test.ts", "scripts/probe-discovery-supply.test.ts", "scripts/probe-adaptive-listening.test.ts", "scripts/inspect-pritam.test.ts", "scripts/diagnose-book-release.test.ts", "scripts/probe-six-domain.test.ts", "scripts/probe-pivot.test.ts", "scripts/probe-cross-domain.test.ts", "scripts/probe-adaptive-retrieval.test.ts", "scripts/probe-youtube-dynamic.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
