const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../analytics.js");

test("makeReading mengikuti struktur data PRD", () => {
  const r = A.makeReading({ channelId: 2, timestamp: 1, status: true, power: 120 });
  assert.deepEqual(Object.keys(r).sort(),
    ["channelId", "current", "deviceId", "energyKwh", "power", "source", "status", "timestamp", "voltage"]);
  assert.equal(r.status, "ON");
  assert.equal(r.voltage, null);
});

test("anomali: belajar dulu, lalu menandai lonjakan", () => {
  assert.equal(A.detectAnomaly([100, 100], 300).level, "learning");
  const base = Array(20).fill(100);
  assert.equal(A.detectAnomaly(base, 105).level, "normal");
  assert.equal(A.detectAnomaly(base, 130).level, "warn");
  assert.equal(A.detectAnomaly(base, 200).level, "high");
});

test("agregat harian menjumlahkan kWh per channel", () => {
  const now = new Date(2026, 9, 1, 12).getTime();
  const hourly = { [A.hourKey(now)]: { e: [0.5, 0.25] } };
  const days = A.aggregate(hourly, "day", 2, now);
  assert.equal(days.length, 7);
  assert.equal(days[6].total, 0.75);
});

test("rekomendasi memuat peringatan anomali dan dominasi channel", () => {
  const now = new Date(2026, 9, 1, 12).getTime();
  const hourly = { [A.hourKey(now)]: { e: [0.9, 0.1] } };
  const recs = A.recommend({
    anomalies: [{ level: "high", ratio: 2 }, { level: "normal" }], hourly, names: ["A", "B"], now
  });
  assert.ok(recs.some(r => r.level === "high"));
  assert.ok(recs.some(r => /90%/.test(r.text)));
});
