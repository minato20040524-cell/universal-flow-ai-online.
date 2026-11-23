# FLOWNODE V1 — Visual AI Collaboration Studio

Studio visual tempat tiga agen (Claude 01 Director, Claude 02 Creator, Claude 03 Engineer) mengerjakan satu proyek lewat
node, Collaboration Hub, dan jalur kabel yang memperlihatkan perpindahan file secara nyata. Pengguna adalah Project
Owner dan memegang keputusan akhir.

> **Status jujur V1:** seluruh studio (dashboard, node editor, kabel hidup, kolaborasi, approval, penyimpanan) berfungsi
> dan teruji. Konten yang dihasilkan agen masih **mode DEMO** (template lokal, ditandai badge `DEMO` di mana pun).
> Koneksi nyata ke tiga akun Claude (Tahap C/D) **belum diimplementasikan**: hanya kerangka antarmukanya (Tahap A–B).

## Menjalankan

### Termux (Android)
```bash
pkg update -y && pkg install -y nodejs git
cd flownode
bash termux-setup.sh        # cek Node (>= 22.13), npm install, build, lalu menjalankan server
```
Buka `http://localhost:8787` di browser Android. Tidak butuh Docker, Chromium, maupun kompilasi native
(SQLite memakai `node:sqlite` bawaan Node 22+).

### Komputer / VPS
```bash
cd flownode
npm install
npm run build
npm start                   # http://localhost:8787
```
Pengembangan frontend dengan hot reload: jalankan `npm start`, lalu di terminal lain `npm run dev:frontend`
(Vite di port 5173, proxy ke 8787).

Variabel lingkungan: `PORT` (8787), `HOST` (0.0.0.0), `FLOWNODE_DATA` (folder data, default `backend/data`),
`FLOWNODE_HOP_MS` (durasi animasi per kabel, 1500), `FLOWNODE_TASK_MS` (durasi tugas demo, 900).

> Tidak ada autentikasi di V1. Jalankan hanya di jaringan tepercaya atau di belakang reverse proxy dengan login.

## Cara memakai
1. **Start Project** → tulis instruksi → Mulai. Sebelum itu semua agen **IDLE**: tidak ada polling, tidak ada pekerjaan otomatis.
2. Alur: Input → Processing → Collaboration → Building → Review → Complete. Status tahap diturunkan dari langkah
   yang benar-benar berjalan.
3. Setiap berkas yang dibuat agen keluar dari port output, **bergerak sepanjang kabel** (satu hop per kabel), tiba di
   node tujuan, dan tercatat di Transfer Monitor dan Activity Log. Tanpa transfer nyata, kabel diam.
4. Di Collaboration Hub: PROPOSAL → REVIEW → CRITIQUE → REVISION → RE-EVALUATION → CONSENSUS → USER APPROVAL.
   Bila tidak sepakat setelah N ronde (Settings, default 3), keputusan diminta dari Anda.
5. Persetujuan akhir: **Setujui** atau **Tolak/Revisi** (maks. 2 revisi). Setelah selesai semua agen kembali IDLE.
6. Kontrol: Start, Pause/Resume (berlaku di antara langkah/transfer), Stop, **Retry Failed**, Manual Approval.

Kabel adalah data, bukan hiasan: jalur transfer dicari (BFS) mengikuti kabel pada Node Editor. Hapus kabel
`Hub → Image Builder` lalu jalankan workflow: transfer gagal dengan pesan jelas; sambungkan lagi, tekan **Retry Failed**,
dan workflow lanjut tanpa membuat berkas ganda.

## Arsitektur
```
flownode/
  backend/                    Node.js + Express + WebSocket + SQLite (node:sqlite)
    src/server/               app.ts (REST), index.ts (WS + static), state.ts (snapshot)
    src/orchestration/        engine.ts (workflow on-demand, kabel, approval), graph.ts (graf + routing)
    src/collaboration/        collab.ts (proposal → … → consensus → keputusan pengguna)
    src/agents/               connector.ts (antarmuka), demo-connector.ts, browser-connector.ts (kerangka)
    src/storage/              store.ts (SQLite + berkas), zip.ts
    tests/                    18 tes (node:test)
  frontend/                   React + TypeScript + Vite + Tailwind 3 + React Flow + Framer Motion
    src/components/{dashboard,nodes,collaboration,builders,agents,files,approvals,views}
  tests/e2e.cjs               uji browser end-to-end (Playwright)
  database/                   lokasi data SQLite = backend/data (lihat README di dalamnya)
  termux-setup.sh
```
Server adalah sumber kebenaran: setiap perubahan state disiarkan lewat WebSocket sebagai snapshot; frontend hanya
menampilkan. Bila WebSocket putus, frontend memakai polling cadangan.

### API ringkas
| Endpoint | Fungsi |
| --- | --- |
| `GET /api/state` | Snapshot lengkap |
| `POST /api/run/start` `{instruction, options}` · `pause` · `resume` · `stop` · `retry` | Kontrol workflow |
| `POST /api/approvals/:id` `{decision, note}` | Setujui/tolak |
| `POST /api/projects` · `PATCH /:id` · `POST /:id/open` · `DELETE /:id` · `PUT /:id/graph` | Proyek dan node editor |
| `GET /api/projects/:id/export` · `POST /api/projects/import` · `GET /:id/bundle.zip` | Ekspor/impor/unduh |
| `GET /api/artifacts/:id/raw\|download` | Berkas (dengan CSP sandbox) |
| `/api/skills`, `/api/agents/:id/connector`, `/api/agents/:id/takeover`, `/api/settings` | Skill, connector, pengaturan |

## Tiga akun Claude tanpa API key — tahapan
| Tahap | Isi | Status |
| --- | --- | --- |
| A | Studio lengkap dengan data lokal berlabel DEMO | Selesai |
| B | `AgentConnector` (antarmuka), `DemoConnector`, `BrowserConnector` (kerangka), pengaturan connector dan profil sesi per agen, manual takeover | Selesai (kerangka) |
| C | Controller browser pada lingkungan yang kompatibel (komputer/VPS), profil terisolasi per akun | **Belum** |
| D | Tiga sesi Claude nyata yang terlihat dan dapat dikendalikan | **Belum** |

Prinsip yang sudah ditegakkan di kode: tidak meminta API key; Browser Connector melapor `not_connected` dan menolak
menjalankan tugas (tidak pernah mengklaim terhubung); login harus manual oleh pengguna; manual takeover menghentikan
tugas otomatis agen terkait. Sebelum mengerjakan Tahap C/D, tinjau dulu syarat penggunaan layanan Claude untuk otomasi
browser dan pemakaian beberapa akun.

## Pengujian
```bash
npm test                                  # 18 tes backend (engine, kabel, kolaborasi, approval, retry, penyimpanan)
npm run build                             # type-check + build kedua paket
node tests/e2e.cjs ./tests/out            # e2e browser (butuh Playwright + Chromium, mis. di komputer/CI)
```
Cakupan e2e: IDLE tanpa animasi, kabel menyala saat transfer nyata, pause/resume, tolak → revisi → setujui → selesai,
kabel putus → gagal → Retry Failed, Stop, 10 halaman, tanpa scroll horizontal di 390px, tanpa error konsol.

## Batasan yang diketahui
- Konten agen DEMO; belum ada Claude nyata (Tahap C/D).
- Satu workflow aktif pada satu waktu; run yang terputus karena server restart ditandai berhenti (tidak dilanjutkan).
- Tanpa autentikasi pengguna; Pause berlaku setelah langkah/transfer yang sedang berjalan selesai.
- Di layar ponsel kanvas ditampilkan "fit to view" sehingga node kecil; gunakan cubit-zoom atau halaman Node Editor.
- Pratinjau 3D hanya menampilkan jumlah vertex/face; video adalah placeholder SVG animasi.
