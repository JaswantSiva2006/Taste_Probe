import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

/**
 * S9.8 prototype server: serves the isolated player page over a real HTTP origin
 * (never file://). `?policy=` overrides the Referrer-Policy header so the
 * verification can compare the default with a stripped Referer.
 */
const PAGE = new URL("./index.html", import.meta.url);
const ALLOWED = new Set(["strict-origin-when-cross-origin", "no-referrer"]);

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      res.writeHead(404).end();
      return;
    }
    const policy = ALLOWED.has(url.searchParams.get("policy") ?? "") ? url.searchParams.get("policy") : "strict-origin-when-cross-origin";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "referrer-policy": policy, "cache-control": "no-store" });
    res.end(await readFile(PAGE));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}`) {
  const server = await startServer(Number(process.env.PORT) || 4178);
  console.log(`prototype on http://localhost:${server.address().port}/`);
}
