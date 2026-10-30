import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const values = ["QLOO_API_KEY", "GOOGLE_API_KEY", "YOUTUBE_API_KEY", "YOUTUBE_API_KEY_2", "YOUTUBE_API_KEY_3", "SESSION_SIGNING_SECRET", "UPSTASH_REDIS_REST_TOKEN"].map((key) => ({ key, value: process.env[key] })).filter((item) => item.value?.length >= 12);
const objects = execFileSync("git", ["rev-list", "--objects", "--all"], { encoding: "utf8" }).trim().split("\n");
const findings = [];
for (const row of objects) {
  const [id, ...name] = row.split(" ");
  if (!name.length) continue;
  const result = spawnSync("git", ["cat-file", "blob", id], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) continue;
  for (const item of values) if (result.stdout.includes(item.value)) findings.push({ object: id, path: name.join(" "), keyName: item.key });
}
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
const envFiles = tracked.filter((path) => /(^|\/)\.env($|\.)/.test(path) && !path.endsWith(".example"));
let clientFiles = 0;
async function scanClient(directory) {
  let files;
  try { files = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of files) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scanClient(path);
    else {
      clientFiles += 1;
      const contents = await readFile(path);
      for (const item of values) if (contents.includes(Buffer.from(item.value))) findings.push({ path, keyName: item.key, location: "client-build" });
    }
  }
}
await scanClient(".next/static");
console.log(JSON.stringify({ checkedKnownSecretValues: values.length, gitObjects: objects.length, clientFiles, findings, trackedEnvironmentFiles: envFiles }));
process.exitCode = findings.length || envFiles.length ? 1 : 0;
