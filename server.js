const http = require('http'), fs = require('fs'), path = require('path');
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#') || !s.includes('=')) continue;
      const i = s.indexOf('=');
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}
loadEnv(path.join(__dirname, '.env.local'));
const ROOT = __dirname + '/site', PORT = process.env.PORT || 8849;
const MIME = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp4':'video/mp4','.webm':'video/webm','.jpg':'image/jpeg','.png':'image/png','.json':'application/json'};
async function runApi(name, req, res) {
  let handler; try { handler = require('./api/' + name + '.js'); } catch { res.writeHead(404); return res.end('404'); }
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  try { req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { req.body = {}; }
  try { await handler(req, res); } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error && error.message)); }
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  if (p.startsWith('/api/')) return runApi(p.slice(5).replace(/[^a-z0-9_-]/gi, ''), req, res);
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('404'); }
  const stat = fs.statSync(fp), total = stat.size, type = MIME[path.extname(fp)] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range); const s = parseInt(m[1]); const e = m[2] ? parseInt(m[2]) : total - 1;
    res.writeHead(206, {'Content-Range': `bytes ${s}-${e}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, 'Content-Type': type});
    fs.createReadStream(fp, {start: s, end: e}).pipe(res);
  } else {
    res.writeHead(200, {'Content-Length': total, 'Content-Type': type, 'Accept-Ranges': 'bytes'});
    fs.createReadStream(fp).pipe(res);
  }
}).listen(PORT, () => console.log('serving ' + ROOT + ' on http://localhost:' + PORT));
