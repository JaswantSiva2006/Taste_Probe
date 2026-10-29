#!/usr/bin/env node
/**
 * npm run qa — FREE browser QA. Starts its own `next dev` in QLOO_MODE=mock
 * (synthetic fixtures; mock mode never constructs the Qloo or Gemini clients),
 * runs scripts/ui-qa.mjs against it, then stops the server. Never spends paid
 * API calls; the live run is the separate, opt-in `npm run qa:live`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
const passthrough = process.argv.slice(2);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// Provider keys are blanked so a misconfiguration can never reach a paid API.
const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
  env: { ...process.env, QLOO_MODE: "mock", QLOO_API_KEY: "", GOOGLE_API_KEY: "", NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
  detached: process.platform !== "win32",
});
const stop = () => {
  if (server.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop(); process.exit(130); });

try {
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`mock server exited with ${server.exitCode}`);
    try {
      const r = await fetch(`${base}/api/health`);
      const j = await r.json();
      if (r.ok && j.data?.mode === "mock") ready = true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) throw new Error("mock server did not become ready (must report mode=mock)");
  console.log(`qa: mock server ready at ${base}`);
  const run = spawnSync(process.execPath, ["scripts/ui-qa.mjs", "--url", base, ...passthrough], { stdio: "inherit" });
  // S9.7: multi-round journeys against the same mock server.
  const rounds = spawnSync(process.execPath, ["scripts/ui-qa-rounds.mjs", "--url", base], { stdio: "inherit" });
  process.exitCode = (run.status ?? 1) || (rounds.status ?? 1);
} catch (error) {
  console.error(`qa failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  stop();
}
