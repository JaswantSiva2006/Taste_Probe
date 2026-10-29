#!/usr/bin/env node
/**
 * Live Gemini agent smoke (npm run smoke:gemini).
 *
 * Runs tests/live/gemini-smoke.live.test.ts with RUN_GEMINI_SMOKE=1 so the agent
 * code is exercised through the same module graph as the app (path aliases,
 * server-only). At most 2 real Gemini requests; no Qloo or Redis requests
 * (enforced by a fetch host guard in the test). Credentials are read from
 * .env.local/.env by @next/env and never printed.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

const result = spawnSync(
  process.execPath,
  [vitest, "run", "tests/live/gemini-smoke.live.test.ts", "--reporter=verbose"],
  { stdio: "inherit", env: { ...process.env, RUN_GEMINI_SMOKE: "1" } },
);
process.exit(result.status ?? 1);
