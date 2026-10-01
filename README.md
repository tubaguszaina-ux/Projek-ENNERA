# ENNERA

PWA untuk mengontrol stopkontak pintar ENNERA (ESP32, 4 relay) lewat Bluetooth LE — tanpa internet.

## Menjalankan

Web Bluetooth dan service worker **hanya aktif di konteks aman**: `https://` atau `http://localhost`.

```bash
npx serve .          # lalu buka http://localhost:3000 di Chrome/Edge
```

Safari (iPhone/iPad) tidak mendukung Web Bluetooth. Untuk iOS perlu aplikasi native.

## Tes

```bash
npm install
npm test
```

Tes memakai jsdom dengan Web Bluetooth palsu, jadi tidak butuh perangkat. Mengubah UUID atau
format paket di `app.js` tanpa mengubah firmware akan memutus komunikasi; tes tidak menangkap hal itu.

## Kontrak BLE yang diharapkan aplikasi

> Diturunkan dari kode klien. Firmware tidak termasuk dalam repo ini — cocokkan dengan sketch ESP32 Anda.

Service `5f524c4e-0001-4a5b-9c1e-6f2b1a8d3c00`

| Characteristic | UUID akhiran | Arah | Isi |
|---|---|---|---|
| Status  | `-0002-…` | read + notify | JSON status |
| Control | `-0003-…` | write (with response) | JSON perintah |

**Perintah** (aplikasi → ESP32), JSON UTF-8:

| Payload | Arti |
|---|---|
| `{"relay":1,"state":true}` | Nyala/mati satu relay (1–4) |
| `{"command":"ALL_ON"}` / `"ALL_OFF"` | Semua relay |
| `{"command":"GET_STATUS"}` | Minta status ulang |
| `{"timer":{"relay":1,"seconds":900}}` | Nyalakan lalu matikan otomatis; `seconds:0` membatalkan |
| `{"settings":{"disconnect_delay":5,"connect_mode":"STAY_OFF"}}` | `connect_mode`: `ALL_ON` \| `RESTORE_LAST` \| `STAY_OFF` |

**Status** (ESP32 → aplikasi):

| Kunci | Arti |
|---|---|
| `r` | Array 0/1 status relay (format lama: `relay1`…`relay4`) |
| `t` | Array sisa detik timer per relay (0 = tidak aktif) |
| `ad` | Auto-OFF saat terputus, detik |
| `cm` | Mode connect: 0 = `ALL_ON`, 1 = `RESTORE_LAST`, 2 = `STAY_OFF` |
| `su` | Mode satu pengguna |

Paket status harus muat dalam MTU notifikasi (default 20 byte, sampai 244 setelah negosiasi MTU).
Jika terpotong, aplikasi membaca ulang lewat `readValue`. Sebaiknya firmware menegosiasikan MTU.

## Keselarasan dengan PRD ENNERA Industrial

| PRD | Status di repo ini |
|---|---|
| Real-time monitoring (V, A, W, kWh) | Daya & proporsi per channel ada; V/A/kWh tampil bila firmware mengirim data PZEM (lihat bawah). Tanpa itu, daya diestimasi dari watt isian. |
| Energy history harian/mingguan/bulanan | Tab **Analisis** (agregat kWh per jam, disimpan di HP, ± 6 bulan) |
| Channel monitoring (perbandingan) | Tab **Analisis** → Perbandingan channel |
| Anomaly detection | `analytics.js` `detectAnomaly`: daya vs pola normal channel (mean + 3σ, ≥1,25×) |
| Recommendation system | `analytics.js` `recommend` (anomali, dominasi channel, menyala dini hari) |
| Struktur data §7 | `makeReading()`: deviceId, channelId, timestamp, voltage, current, power, energyKwh, status |
| Backend, database, REST/MQTT, login | **Belum ada.** Repo ini masih BLE-only/offline; "Masuk" hanya label nama. |

**Data PZEM (opsional) di paket status BLE:** `v`, `i`, `p`, `e` = array per channel (volt, ampere, watt, kWh).
Paket ini melebihi MTU default 20 byte; negosiasikan MTU di firmware atau kirim terpisah.

## Backend & Dashboard web (PRD ENNERA)

```bash
export DEVICE_API_KEY=... ADMIN_USER=admin ADMIN_PASS=... TOKEN_SECRET=...   # wajib diganti
npm run seed     # opsional: data demo 7 hari
npm start        # http://localhost:3000  (Node >= 22, tanpa dependensi)
```

| Endpoint | Auth | Fungsi |
|---|---|---|
| `POST /api/ingest` | header `x-api-key` | ESP32 kirim `{deviceId, channelId, timestamp?, voltage, current, power, energyKwh, status}` atau `{readings:[...]}` (maks 100) |
| `POST /api/login` | - | `{username,password}` → token 12 jam |
| `GET /api/latest` `/api/history?period=day\|week\|month` `/api/channel?device=&channel=` `/api/analysis` | Bearer | Data dashboard |

Data disimpan di SQLite (`server/ennera.db`). kWh dihitung dari selisih `energyKwh` PZEM; jika tidak ada, dari daya × selang waktu.
ESP32 harus memakai HTTPS di produksi (api key & token tidak dienkripsi lewat HTTP biasa).

## Bungkus Android (WebView)

Aplikasi memakai `window.AndroidBLE` bila ada: `connect()`, `disconnect()`, `write(json)`.
Native memanggil balik `window.EnneraApp`: `onConnected(nama)`, `onDisconnected()`,
`onStatus(jsonString)`, `onError(pesan)`.

- `write()` dianggap berhasil bila tidak melempar exception; lapor kegagalan tulis asinkron lewat `onError`.
- Service worker tidak berjalan dari `file:///android_asset/`; tidak masalah, file sudah lokal.

## Palet warna

| Token | Nilai | Dipakai untuk |
|---|---|---|
| `--blue` | `#003F88` | tab aktif, kartu relay menyala, logo |
| `--accent` / `--on` | `#FFD500` | tombol utama, status menyala/terhubung, fokus |
| `--bg` `--panel` `--well` | turunan gelap hue 212° | latar, panel, input |
| `--red` | `#E0625D` | mati, terputus, keluar, error |

Semua warna ada di blok `:root` paling atas `styles.css`. Status "menyala" memakai `--on`; ubah satu baris itu
bila ingin warna status yang berbeda dari aksen. `npm test` memeriksa kontras (WCAG AA) semua pasangan teks/latar.

## Ikon aplikasi

Semua ikon (`icons/*.png`, `icons/favicon.ico`) dibuat dari desain logo bolt yang sama dengan logo di layar login.
Untuk mengubah warna/proporsi, edit `tools/generate-icons.py` lalu jalankan:

```bash
pip install cairosvg pillow
python3 tools/generate-icons.py
```

Setelah mengganti ikon, naikkan `CACHE_NAME` di `service-worker.js` (ikon dilayani cache-first, jadi tanpa itu
HP yang sudah pernah membuka aplikasi tetap menampilkan ikon lama). Ikon di layar utama HP hasil "Install/Add to Home
screen" baru berganti setelah shortcut dihapus dan dipasang ulang. Untuk versi APK, ikon diambil dari resource proyek
Android (`mipmap-*`); gunakan `icon-maskable-512.png` sebagai sumber ikon adaptif.

## Keamanan

"Masuk" dengan nama hanyalah label tampilan, **bukan autentikasi**. Siapa pun yang berada dalam jangkauan BLE
dapat terhubung selama firmware tidak mewajibkan pairing. Untuk beban listrik nyata, aktifkan
pairing/bonding dengan passkey di firmware (atau tantangan-respons di tingkat aplikasi).
