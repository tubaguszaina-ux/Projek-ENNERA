
// Data demo: node server/seed.js  (mengisi 7 hari, 3 channel, channel 2 melonjak hari ini)
process.env.DB_FILE ||= require("node:path").join(__dirname, "ennera.db");
const { db } = require("./server.js");
const ins = db.prepare("INSERT INTO readings(device_id,channel_id,ts,voltage,current,power,energy_kwh,delta_kwh,status) VALUES(?,?,?,?,?,?,?,?,?)");
const base = [150, 400, 80], kwh = [0, 0, 0], now = Date.now(), step = 5 * 60000;
db.exec("BEGIN");
for (let t = now - 7 * 864e5; t <= now; t += step) {
  const hr = new Date(t).getHours();
  base.forEach((b, i) => {
    const on = hr >= 7 && hr < 18 || (i === 2);
    let p = on ? b * (0.95 + Math.random() * 0.1) : 0;
    if (i === 1 && t > now - 3 * 36e5 && on) p *= 1.9; // anomali CH2
    const d = (p * step) / 3.6e9; kwh[i] += d;
    ins.run("ENNERA-01", i + 1, t, p ? 220 + Math.random() * 4 : 0, p / 220, p, kwh[i], d, p ? "ON" : "OFF");
  });
}
db.exec("COMMIT"); console.log("Seed selesai");
