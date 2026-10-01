/* ENNERA — analitik energi (PRD ENNERA §5 & §7). Fungsi murni tanpa DOM supaya mudah dites.
   Dipakai app.js lewat window.EnneraAnalytics. */
(function (root) {
  const SAMPLE_MS = 30000;      // interval pencatatan sampel
  const BASELINE_MAX = 120;     // sampel daya "menyala" terakhir per channel (≈1 jam)
  const BASELINE_MIN = 12;      // minimum sampel sebelum deteksi anomali aktif
  const HOURLY_MAX = 24 * 190;  // simpan ± 6 bulan agregat per jam
  const NIGHT_HOURS = [0, 1, 2, 3, 4];

  // Struktur data sesuai PRD §7. `source`: "pzem" (terukur) atau "estimasi" (watt isian user).
  function makeReading(o) {
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
    return {
      deviceId: o.deviceId || "ENNERA",
      channelId: o.channelId,
      timestamp: o.timestamp,
      voltage: num(o.voltage),
      current: num(o.current),
      power: num(o.power) ?? 0,
      energyKwh: num(o.energyKwh),
      status: o.status ? "ON" : "OFF",
      source: o.source || "estimasi"
    };
  }

  function stats(values) {
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    return { n, mean, sd };
  }

  // Bandingkan daya sekarang dengan pola normal channel itu sendiri (mean ± simpangan baku).
  function detectAnomaly(baseline, power) {
    const base = baseline.filter((p) => p > 0);
    if (base.length < BASELINE_MIN) return { level: "learning", n: base.length };
    if (!(power > 0)) return { level: "normal", n: base.length };
    const { mean, sd } = stats(base);
    const ratio = power / mean;
    const z = (power - mean) / Math.max(sd, mean * 0.05); // lantai 5% agar beban stabil tak hipersensitif
    const level = z >= 3 && ratio >= 1.5 ? "high" : z >= 3 && ratio >= 1.25 ? "warn" : "normal";
    return { level, ratio, mean, n: base.length };
  }

  function hourKey(ts) {
    const d = new Date(ts), p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
  }

  function trimHourly(hourly) {
    const keys = Object.keys(hourly).sort();
    keys.slice(0, Math.max(0, keys.length - HOURLY_MAX)).forEach((k) => delete hourly[k]);
  }

  // period: "day" (7 hari), "week" (4 minggu), "month" (6 bulan). Hasil: bucket tertua → terbaru.
  function aggregate(hourly, period, channels, now = Date.now()) {
    const spec = { day: [7, 1], week: [4, 7], month: [6, 0] }[period] || [7, 1];
    const buckets = [];
    for (let b = spec[0] - 1; b >= 0; b--) {
      const d = new Date(now);
      let label;
      if (period === "month") {
        d.setDate(1); d.setMonth(d.getMonth() - b);
        label = d.toLocaleDateString("id-ID", { month: "short", year: "2-digit" });
        buckets.push({ label, test: (k) => k.slice(0, 7) === hourKey(d).slice(0, 7), kwh: Array(channels).fill(0) });
      } else {
        const days = spec[1];
        const end = new Date(now); end.setHours(23, 59, 59, 999); end.setDate(end.getDate() - b * days);
        const start = new Date(end); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
        const sk = hourKey(start), ek = hourKey(end);
        label = days === 1 ? start.toLocaleDateString("id-ID", { weekday: "short", day: "numeric" })
          : `${start.getDate()}/${start.getMonth() + 1}–${end.getDate()}/${end.getMonth() + 1}`;
        buckets.push({ label, test: (k) => k >= sk && k <= ek, kwh: Array(channels).fill(0) });
      }
    }
    Object.entries(hourly).forEach(([k, v]) => {
      const bucket = buckets.find((x) => x.test(k));
      if (bucket) v.e.forEach((e, i) => { if (i < channels) bucket.kwh[i] += e; });
    });
    return buckets.map(({ label, kwh }) => ({ label, kwh, total: kwh.reduce((a, b) => a + b, 0) }));
  }

  // Aturan rekomendasi sederhana (PRD §5 Recommendation System). names: nama channel.
  function recommend({ anomalies, hourly, names, now = Date.now() }) {
    const out = [];
    anomalies.forEach((a, i) => {
      if (a.level === "high" || a.level === "warn") {
        out.push({ level: a.level, text: `${names[i]} memakai daya ${a.ratio.toFixed(1)}× di atas pola normalnya. Periksa perangkat yang tercolok (kerusakan, beban tambahan, atau lupa dimatikan).` });
      }
    });
    const week = aggregate(hourly, "day", names.length, now).reduce((acc, d) => {
      d.kwh.forEach((e, i) => { acc[i] += e; });
      return acc;
    }, Array(names.length).fill(0));
    const total = week.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const top = week.indexOf(Math.max(...week));
      const share = week[top] / total;
      if (names.length > 1 && share >= 0.5) {
        out.push({ level: "info", text: `${names[top]} menyumbang ${(share * 100).toFixed(0)}% energi 7 hari terakhir. Evaluasi apakah pemakaiannya perlu seluruhnya.` });
      }
    }
    // Beban menyala dini hari: jadwalkan timer / optimasi waktu operasi.
    const nightKwh = Array(names.length).fill(0);
    Object.entries(hourly).forEach(([k, v]) => {
      if (NIGHT_HOURS.includes(Number(k.slice(11)))) v.e.forEach((e, i) => { nightKwh[i] += e; });
    });
    nightKwh.forEach((e, i) => {
      if (e > 0.05) out.push({ level: "info", text: `${names[i]} tercatat menyala dini hari (00–05). Pertimbangkan timer agar mati otomatis di luar jam operasi.` });
    });
    return out;
  }

  root.EnneraAnalytics = { SAMPLE_MS, BASELINE_MAX, makeReading, detectAnomaly, hourKey, trimHourly, aggregate, recommend };
  if (typeof module !== "undefined") module.exports = root.EnneraAnalytics;
})(typeof window !== "undefined" ? window : globalThis);
