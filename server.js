// Servidor do Poker & Beer Confraria para hospedagem própria (Coolify, Docker).
// Node 22+, sem dependências: usa o SQLite embutido (node:sqlite).
// Guarda tudo em DATA_DIR/poker.sqlite e avisa os aparelhos abertos por
// Server-Sent Events, para TV e celular verem a mesma partida.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PIN = (process.env.ADMIN_PIN || '').trim(); // vazio = qualquer um pode alterar
const INDEX = path.join(__dirname, 'index.html');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_LOGO = 4 * 1024 * 1024;
const COLS = { tournaments: 'tournaments', players: 'players', games: 'games' };

fs.mkdirSync(DATA_DIR, { recursive: true });
// DATA_DIR é um volume de verdade? (device diferente da raiz do container). Sem
// volume, o banco some a cada deploy: a página avisa o usuário.
let persistent = true;
try { persistent = process.env.ASSUME_PERSISTENT === '1' || fs.statSync(DATA_DIR).dev !== fs.statSync('/').dev; } catch (e) { persistent = false; }
if (!persistent) console.warn('AVISO: ' + DATA_DIR + ' não parece ser um volume persistente. Configure um volume em ' + DATA_DIR + ' ou os dados somem no próximo deploy.');
const db = new DatabaseSync(path.join(DATA_DIR, 'poker.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS tournaments (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS players     (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS games       (id TEXT PRIMARY KEY, date TEXT, tournament_id TEXT, tournament_name TEXT, dealer TEXT, entries INTEGER, total INTEGER, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS game_results (game_id TEXT NOT NULL, player_id TEXT, name TEXT NOT NULL, pos INTEGER, ko_by TEXT, hand_rank TEXT, cards TEXT, prize REAL, points REAL, PRIMARY KEY (game_id, name));
  CREATE TABLE IF NOT EXISTS live     (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS meta     (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_games_date ON games(date);
  CREATE INDEX IF NOT EXISTS idx_results_player ON game_results(player_id);
`);
const q = {
  rev: db.prepare("SELECT value FROM meta WHERE key='rev'"),
  setRev: db.prepare("INSERT INTO meta(key,value) VALUES('rev',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  allT: db.prepare('SELECT data FROM tournaments ORDER BY created_at, id'),
  allP: db.prepare('SELECT data FROM players ORDER BY name'),
  allG: db.prepare('SELECT data FROM games ORDER BY date, updated_at'),
  live: db.prepare("SELECT data FROM live WHERE id='current'"),
  settings: db.prepare("SELECT data FROM settings WHERE id='app'"),
  putT: db.prepare('INSERT INTO tournaments(id,name,data,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=excluded.updated_at'),
  putP: db.prepare('INSERT INTO players(id,name,data,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=excluded.updated_at'),
  putG: db.prepare('INSERT INTO games(id,date,tournament_id,tournament_name,dealer,entries,total,data,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET date=excluded.date,tournament_id=excluded.tournament_id,tournament_name=excluded.tournament_name,dealer=excluded.dealer,entries=excluded.entries,total=excluded.total,data=excluded.data,updated_at=excluded.updated_at'),
  delResults: db.prepare('DELETE FROM game_results WHERE game_id=?'),
  putResult: db.prepare('INSERT INTO game_results(game_id,player_id,name,pos,ko_by,hand_rank,cards,prize,points) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(game_id,name) DO UPDATE SET player_id=excluded.player_id,pos=excluded.pos,ko_by=excluded.ko_by,hand_rank=excluded.hand_rank,cards=excluded.cards,prize=excluded.prize,points=excluded.points'),
  putLive: db.prepare("INSERT INTO live(id,data,updated_at) VALUES('current',?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at"),
  delLive: db.prepare("DELETE FROM live WHERE id='current'"),
  putSettings: db.prepare("INSERT INTO settings(id,data,updated_at) VALUES('app',?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at"),
  del: { tournaments: db.prepare('DELETE FROM tournaments WHERE id=?'), players: db.prepare('DELETE FROM players WHERE id=?'), games: db.prepare('DELETE FROM games WHERE id=?') },
  ranking: db.prepare(`SELECT COALESCE(p.name, r.name) AS name, SUM(r.points) AS points, COUNT(*) AS games, SUM(r.pos=1) AS wins, SUM(r.pos BETWEEN 1 AND 3) AS podiums, SUM(r.prize) AS prize,
    (SELECT COUNT(*) FROM game_results k WHERE k.ko_by=r.player_id AND r.player_id IS NOT NULL) AS kos
    FROM game_results r LEFT JOIN players p ON p.id=r.player_id GROUP BY COALESCE(r.player_id, 'n:'||lower(r.name)) ORDER BY points DESC, wins DESC, prize DESC, name`),
};
const parse = row => row ? JSON.parse(row.data) : null;
const rows = stmt => stmt.all().map(r => JSON.parse(r.data));
let rev = +((q.rev.get() || {}).value || 0);
const bump = () => { rev++; q.setRev.run(String(rev)); return rev; };
const n = v => (v == null || v === '' ? null : +v);
const s = v => (v == null ? null : String(v));

function write(kind, col, id, data) {
  const now = Date.now();
  const tx = () => {
    if (col === 'live') { kind === 'set' ? q.putLive.run(JSON.stringify(data), now) : q.delLive.run(); }
    else if (col === 'settings') { q.putSettings.run(JSON.stringify(data || {}), now); }
    else if (kind === 'del') { q.del[col].run(id); if (col === 'games') q.delResults.run(id); }
    else if (col === 'tournaments') q.putT.run(id, s(data.name) || '', JSON.stringify(data), n(data.createdAt), now);
    else if (col === 'players') q.putP.run(id, s(data.name) || '', JSON.stringify(data), n(data.createdAt), now);
    else if (col === 'games') {
      q.putG.run(id, s(data.date), s(data.tid), s(data.tournamentName), s(data.dealer), n(data.entries), n(data.total), JSON.stringify(data), now);
      q.delResults.run(id);
      const seen = new Set();
      for (const r of (Array.isArray(data.results) ? data.results : [])) {
        const name = s(r.name) || ''; if (!name || seen.has(name)) continue; seen.add(name);
        q.putResult.run(id, s(r.pid), name, n(r.pos), s(r.koBy), s(r.rank), s(r.cards), n(r.prize), n(r.points));
      }
    }
    return bump();
  };
  db.exec('BEGIN'); let r; try { r = tx(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  broadcast({ kind, col, id, data: kind === 'set' ? data : null, rev: r });
  return r;
}
function snapshot() {
  return { tournaments: rows(q.allT), players: rows(q.allP), games: rows(q.allG), live: parse(q.live.get()), settings: parse(q.settings.get()) || {}, rev, pinRequired: !!ADMIN_PIN, persistent };
}

const clients = new Set();
function broadcast(evt) {
  const line = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const res of clients) { try { res.write(line); } catch (e) { clients.delete(res); } }
}
function send(res, code, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json; charset=utf-8'; }
  res.writeHead(code, h); res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authorized(req) { return !ADMIN_PIN || (req.headers['x-admin-pin'] || '') === ADMIN_PIN; }
function validId(id) { return /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id); }
function logoFile() { const f = fs.readdirSync(DATA_DIR).find(x => x.startsWith('logo.')); return f ? path.join(DATA_DIR, f) : null; }
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(INDEX).pipe(res); return;
    }
    if (p === '/healthz') return send(res, 200, 'ok');
    if (req.method === 'GET' && p === '/api/backup') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="poker-backup-' + new Date().toISOString().slice(0, 10) + '.json"' }); const o = snapshot(); delete o.rev; delete o.pinRequired; delete o.persistent; return res.end(JSON.stringify(o)); }
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, snapshot());
    if (req.method === 'GET' && p === '/api/ranking') return send(res, 200, q.ranking.all());
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify({ kind: 'hello', rev }) + '\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (req.method === 'GET' && p === '/api/logo') {
      const f = logoFile(); if (!f) return send(res, 404, 'no logo');
      res.writeHead(200, { 'Content-Type': MIME[f.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      fs.createReadStream(f).pipe(res); return;
    }
    if (req.method === 'POST' && p === '/api/auth') return send(res, authorized(req) ? 200 : 401, { ok: authorized(req) });
    // tudo abaixo altera dados
    if (!authorized(req)) return send(res, 401, { error: 'pin' });
    if (req.method === 'POST' && p === '/api/logo') {
      const ct = (req.headers['content-type'] || '').toLowerCase();
      const ext = ct.includes('svg') ? 'svg' : ct.includes('png') ? 'png' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : null;
      if (!ext) return send(res, 415, { error: 'imagem inválida' });
      const buf = await readBody(req, MAX_LOGO);
      const old = logoFile(); if (old) fs.unlinkSync(old);
      fs.writeFileSync(path.join(DATA_DIR, 'logo.' + ext), buf);
      const logoUrl = '/api/logo?v=' + Date.now();
      write('set', 'settings', 'app', Object.assign({}, parse(q.settings.get()) || {}, { logoUrl, logoId: 'server' }));
      return send(res, 200, { url: logoUrl });
    }
    if (req.method === 'DELETE' && p === '/api/logo') {
      const old = logoFile(); if (old) fs.unlinkSync(old);
      write('set', 'settings', 'app', Object.assign({}, parse(q.settings.get()) || {}, { logoUrl: '', logoId: '' }));
      return send(res, 200, { ok: true });
    }
    const m = /^\/api\/(tournaments|players|games|live|settings)(?:\/([^/]+))?$/.exec(p);
    if (!m) return send(res, 404, { error: 'not found' });
    const col = m[1], id = m[2] || (col === 'live' ? 'current' : col === 'settings' ? 'app' : '');
    if (!validId(id)) return send(res, 400, { error: 'id inválido' });
    if (req.method === 'PUT') {
      const buf = await readBody(req, MAX_BODY);
      let data; try { data = JSON.parse(buf.toString('utf8')); } catch (e) { return send(res, 400, { error: 'json inválido' }); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { error: 'objeto esperado' });
      if (COLS[col] && data.id !== id) data.id = id;
      return send(res, 200, { rev: write('set', col, id, data) });
    }
    if (req.method === 'DELETE') return send(res, 200, { rev: write('del', col, id, null) });
    return send(res, 405, { error: 'method' });
  } catch (e) {
    console.error(e);
    send(res, e.message === 'too large' ? 413 : 500, { error: e.message });
  }
});
server.listen(PORT, () => console.log('Poker & Beer Confraria em http://0.0.0.0:' + PORT + ' (SQLite em ' + DATA_DIR + (ADMIN_PIN ? ', PIN ativo' : ', sem PIN') + ')'));
