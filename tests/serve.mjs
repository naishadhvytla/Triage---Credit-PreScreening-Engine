// Local static server for app/ that applies netlify.toml's redirects and headers (CSP included),
// so the e2e tests exercise the same rules Netlify will. No dependencies.
//   node tests/serve.mjs [port]
import {createServer} from "node:http";
import {readFileSync, existsSync, statSync} from "node:fs";
import {join, extname, normalize} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLISH = join(ROOT, "app");
const PORT = +(process.argv[2] || process.env.PORT || 4173);
const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain"};

// Minimal reader for the subset of TOML netlify.toml uses: [[redirects]] and [[headers]] + [headers.values]
function readNetlify() {
  const redirects = [], headers = [];
  let cur = null, inValues = false;
  for (const raw of readFileSync(join(ROOT, "netlify.toml"), "utf8").split("\n")) {
    const line = raw.replace(/^\s+|\s+$/g, "");
    if (!line || line.startsWith("#")) continue;
    if (line === "[[redirects]]") { cur = {}; redirects.push(cur); inValues = false; continue; }
    if (line === "[[headers]]") { cur = {values: {}}; headers.push(cur); inValues = false; continue; }
    if (line === "[headers.values]") { inValues = true; continue; }
    if (line.startsWith("[")) { cur = null; continue; }
    const m = line.match(/^("?[\w-]+"?)\s*=\s*(.+)$/);
    if (!m || !cur) continue;
    const key = m[1].replace(/"/g, ""), val = JSON.parse(m[2]);
    if (inValues) cur.values[key] = val; else cur[key] = val;
  }
  return {redirects, headers};
}
const glob = p => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

function fileFor(path) {
  const p = normalize(join(PUBLISH, decodeURIComponent(path)));
  if (!p.startsWith(PUBLISH)) return null;
  if (existsSync(p) && statSync(p).isFile()) return p;
  if (existsSync(join(p, "index.html"))) return join(p, "index.html");
  return null;
}

createServer((req, res) => {
  const {redirects, headers} = readNetlify();
  const url = new URL(req.url, "http://x");
  let path = url.pathname, status = 200, file = fileFor(path);
  for (const r of redirects) {
    if (!glob(r.from).test(path) || (file && !r.force)) continue;
    if (r.status === 301 || r.status === 302) { res.writeHead(r.status, {Location: r.to}); return res.end(); }
    status = r.status || 200; path = r.to.split("?")[0]; file = fileFor(path); break;
  }
  if (!file) { status = 404; file = join(PUBLISH, "404.html"); path = "/404.html"; }
  const h = {"Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store"};
  for (const block of headers) if (glob(block.for).test(url.pathname)) Object.assign(h, block.values);
  delete h["Strict-Transport-Security"];   // meaningless over http://localhost
  res.writeHead(status, h);
  res.end(readFileSync(file));
}).listen(PORT, "127.0.0.1", () => console.log(`Triage on http://127.0.0.1:${PORT}`));
