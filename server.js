// Hive Mind local server: the same game code as the Vercel functions, with rooms kept in memory.
// Run `node server.js`, then open http://127.0.0.1:4173
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handle = require('./lib/handler');

const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';
const ALLOWED_HOSTS = new Set(['127.0.0.1:' + PORT, 'localhost:' + PORT, '[::1]:' + PORT]);
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

http.createServer((req, res) => {
  // Only answer requests addressed to this machine (blocks DNS rebinding).
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) { res.writeHead(421, HEADERS); res.end('Misdirected request'); return; }
  let url;
  try { url = new URL(req.url, 'http://' + HOST + ':' + PORT); } catch (_) { res.writeHead(400, HEADERS); res.end('Bad request'); return; }
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length <= 4) {
    let raw = '';
    let tooBig = false;
    req.on('data', chunk => { raw += chunk; if (raw.length > 8000) tooBig = true; });
    req.on('end', () => {
      req.query = { code: parts[2] || '', action: parts[3] || '' };
      req.body = tooBig ? { tooLarge: 'x'.repeat(5000) } : raw;
      handle(req, res, req.query.code, req.query.action);
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (error, contents) => {
      if (error) { res.writeHead(500, HEADERS); res.end('Could not load the game'); return; }
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(contents);
    });
    return;
  }
  res.writeHead(404, HEADERS);
  res.end('Not found');
}).listen(PORT, HOST, () => {
  console.log('Hive Mind is running at http://' + HOST + ':' + PORT);
});
