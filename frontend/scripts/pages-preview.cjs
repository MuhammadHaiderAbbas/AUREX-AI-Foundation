// Local GitHub Pages simulator: serves dist/ under /<repo>/ and 404.html for misses.
// Usage: node scripts/pages-preview.cjs dist /AUREX-AI-Foundation/ 4173
const http = require("http"), fs = require("fs"), path = require("path");
const [root, prefix, port] = [process.argv[2], process.argv[3], +process.argv[4]];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (!url.startsWith(prefix)) { res.writeHead(404); return res.end("not found"); }
  let file = path.join(root, url.slice(prefix.length));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/html" }); return fs.createReadStream(path.join(root, "404.html")).pipe(res); }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(port);
