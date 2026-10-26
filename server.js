const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname);
const PORT = process.env.PORT || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/' || urlPath === '\\') urlPath = '/index.html';
  const rawUrl = req.url.split('?')[0];
  const rawDots = rawUrl.includes('/../') || rawUrl.endsWith('/..') || rawUrl.startsWith('/..');
  if (
    (urlPath !== rawUrl && rawDots) ||
    !urlPath.startsWith('/') ||
    urlPath.split('/').some((seg) => seg === '..')
  ) {
    res.writeHead(403).end();
    return;
  }
  const filePath = path.resolve(ROOT, '.' + urlPath.replaceAll('/', path.sep));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size <= 10 * 1024 * 1024) { chunks.push(c); return; }
    req.destroy();
    res.writeHead(413).end();
  });
  req.on('end', () => cb(Buffer.concat(chunks)));
}

function handleChat(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  readBody(req, res, (body) => {
    const key = process.env.REFLECTION_API_KEY;
    if (!key) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'REFLECTION_API_KEY not set on server' } }));
      return;
    }
    const base = process.env.REFLECTION_API_BASE || 'https://api.reflection.ai';
    const url = new URL('/openai/v1/chat/completions', base);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: url.host };
    delete headers.transfer_encoding;
    delete headers['transfer-encoding'];
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    delete headers.te;
    headers.authorization = 'Bearer ' + key;
    headers['content-type'] = 'application/json';
    headers['content-length'] = body.length;
    const upstream = mod.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: req.method, headers },
      (up) => {
        const h = { ...up.headers };
        for (const k of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']) delete h[k];
        res.writeHead(up.statusCode, h);
        up.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream request failed: ' + err.message } }));
      }
    });
    upstream.end(body);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/chat') handleChat(req, res);
  else serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('echo proxy on http://localhost:' + PORT);
});