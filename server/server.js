// ENNERA backend (PRD §8): terima data ESP32 → validasi → simpan → API dashboard.
// Tanpa dependensi: Node ≥ 22 (node:sqlite). Jalankan: node server/server.js
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const EA = require("../analytics.js");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DEVICE_API_KEY || "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";
const USER = process.env.ADMIN_USER || "ENNERA", PASS = process.env.ADMIN_PASS || "12345678";
const SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, "ennera.db"));
db.exec(`CREATE TABLE IF NOT EXISTS readings(
  id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, channel_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  voltage REAL, current REAL, power REAL NOT NULL, energy_kwh REAL, delta_kwh REAL NOT NULL DEFAULT 0, status TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_ch_ts ON readings(device_id, channel_id, ts);`);

const q = {
  last: db.prepare("SELECT * FROM readings WHERE device_id=? AND channel_id=? ORDER BY ts DESC LIMIT 1"),
  ins: db.prepare("INSERT INTO readings(device_id,channel_id,ts,voltage,current,power,energy_kwh,delta_kwh,status) VALUES(?,?,?,?,?,?,?,?,?)"),
  chans: db.prepare("SELECT DISTINCT device_id, channel_id FROM readings ORDER BY device_id, channel_id"),
  base: db.prepare("SELECT power FROM readings WHERE device_id=? AND channel_id=? AND power>0 ORDER BY ts DESC LIMIT ?"),
  hourly: db.prepare("SELECT strftime('%Y-%m-%dT%H', ts/1000, 'unixepoch', 'localtime') h, device_id d, channel_id c, SUM(delta_kwh) e FROM readings WHERE ts>=? GROUP BY h,d,c"),
  series: db.prepare("SELECT ts, voltage, current, power FROM readings WHERE device_id=? AND channel_id=? AND ts>=? ORDER BY ts")
};

// ---- validasi & simpan ----
const inRange = (v, lo, hi) => v === null || v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);
function ingest(r) {
  const n = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
  const rec = { device: String(r.deviceId || ""), ch: Number(r.channelId), ts: n(r.timestamp) ?? Date.now(),
    v: n(r.voltage), i: n(r.current), p: n(r.power), e: n(r.energyKwh), status: r.status === "ON" || r.status === true ? "ON" : "OFF" };
  if (!/^[\w.-]{1,32}$/.test(rec.device) || !Number.isInteger(rec.ch) || rec.ch < 1 || rec.ch > 16) throw new Error("deviceId/channelId tidak valid");
  if (rec.p === null || !inRange(rec.p, 0, 25000) || !inRange(rec.v, 0, 500) || !inRange(rec.i, 0, 100) || !inRange(rec.e, 0, 1e7))
    throw new Error("nilai sensor di luar rentang");
  if (Math.abs(rec.ts - Date.now()) > 7 * 864e5) rec.ts = Date.now(); // jam ESP32 ngawur → pakai jam server
  const prev = q.last.get(rec.device, rec.ch);
  let delta = 0;
  if (prev && rec.ts > prev.ts) {
    if (rec.e !== null && prev.energy_kwh !== null && rec.e >= prev.energy_kwh) delta = rec.e - prev.energy_kwh; // PZEM kumulatif
    else delta = (rec.p * Math.min(rec.ts - prev.ts, 120000)) / 3.6e9;                                        // fallback W×dt
  }
  q.ins.run(rec.device, rec.ch, rec.ts, rec.v, rec.i, rec.p, rec.e, delta, rec.status);
}

// ---- auth dashboard (token HMAC, 12 jam) ----
const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const mkToken = () => { const b = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 36e5 })).toString("base64url"); return `${b}.${sign(b)}`; };
function okToken(h) {
  const [b, s] = (h || "").replace(/^Bearer /, "").split(".");
  if (!b || !s || s.length !== sign(b).length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sign(b)))) return false;
  try { return JSON.parse(Buffer.from(b, "base64url")).exp > Date.now(); } catch { return false; }
}
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---- analitik dari DB (memakai analytics.js yang sama dengan PWA) ----
function analysis() {
  const channels = q.chans.all();
  const names = channels.map((c) => `${c.device_id} · CH${c.channel_id}`);
  const anomalies = channels.map((c) => {
    const rows = q.base.all(c.device_id, c.channel_id, EA.BASELINE_MAX + 1); // [0] = terbaru
    return rows.length ? EA.detectAnomaly(rows.slice(1).map((r) => r.power), rows[0].power) : { level: "learning", n: 0 };
  });
  const hourly = {};
  q.hourly.all(Date.now() - 190 * 864e5).forEach((r) => {
    const i = channels.findIndex((c) => c.device_id === r.d && c.channel_id === r.c);
    (hourly[r.h] ||= { e: Array(channels.length).fill(0) }).e[i] += r.e;
  });
  return { channels, names, anomalies, hourly };
}
function latest() {
  const a = analysis();
  return a.channels.map((c, i) => ({ ...q.last.get(c.device_id, c.channel_id), name: a.names[i], anomaly: a.anomalies[i] }));
}

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, no) => {
  let d = ""; req.on("data", (c) => { d += c; if (d.length > 1e6) { no(new Error("terlalu besar")); req.destroy(); } });
  req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new Error("JSON tidak valid")); } });
});
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "POST" && url.pathname === "/api/ingest") { // dari ESP32
      if (!same(String(req.headers["x-api-key"] || ""), API_KEY)) return json(res, 401, { error: "API key salah" });
      const body = await readBody(req), list = Array.isArray(body.readings) ? body.readings : [body];
      if (list.length > 100) return json(res, 400, { error: "maks 100 pembacaan per request" });
      list.forEach(ingest);
      return json(res, 201, { saved: list.length });
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const b = await readBody(req);
      return same(String(b.username || ""), USER) && same(String(b.password || ""), PASS)
        ? json(res, 200, { token: mkToken() }) : json(res, 401, { error: "Username/password salah" });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!okToken(req.headers.authorization)) return json(res, 401, { error: "Belum login" });
      if (url.pathname === "/api/latest") return json(res, 200, latest());
      if (url.pathname === "/api/history") {
        const period = ["day", "week", "month"].includes(url.searchParams.get("period")) ? url.searchParams.get("period") : "day";
        const a = analysis();
        return json(res, 200, { names: a.names, rows: EA.aggregate(a.hourly, period, a.names.length) });
      }
      if (url.pathname === "/api/channel") {
        const ch = a_ch(url); if (!ch) return json(res, 400, { error: "device/channel diperlukan" });
        return json(res, 200, q.series.all(ch[0], ch[1], Date.now() - 24 * 36e5));
      }
      if (url.pathname === "/api/analysis") {
        const a = analysis();
        return json(res, 200, { anomalies: a.anomalies.map((x, i) => ({ name: a.names[i], ...x })),
          recommendations: EA.recommend({ anomalies: a.anomalies, hourly: a.hourly, names: a.names }) });
      }
      return json(res, 404, { error: "tidak ditemukan" });
    }
    // statis: dashboard di "/" , analytics.js dibagi
    const file = url.pathname === "/analytics.js" ? path.join(__dirname, "..", "analytics.js")
      : path.join(__dirname, "..", "dashboard", url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^(\.\.[\\/])+/, ""));
    if (!file.startsWith(path.join(__dirname, "..")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("404"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, 400, { error: e.message }); }
});
function a_ch(url) { const d = url.searchParams.get("device"), c = Number(url.searchParams.get("channel")); return d && c ? [d, c] : null; }

if (require.main === module) server.listen(PORT, () => console.log(`ENNERA server http://localhost:${PORT}`));
module.exports = { server, db };
