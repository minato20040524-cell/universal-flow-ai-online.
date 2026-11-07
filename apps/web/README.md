# @universal-flow/web

Web app UNIVERSAL FLOW AI: login, Applications & Integrations, builder Custom API, Marketplace, daftar Workflows, dan **Spatial Studio** (editor 3D untuk menyusun workflow). React 19 sebagai SPA, di-bundle esbuild, disajikan langsung oleh backend dari origin yang sama (cookie sesi tidak perlu CORS).

## Menjalankan

```bash
pnpm install
pnpm --filter @universal-flow/web build      # menghasilkan apps/web/dist
WEB_DIST_DIR=apps/web/dist node apps/backend/dist/src/main.js
```

Buka `PUBLIC_BASE_URL` di browser. Selama mengembangkan, `pnpm --filter @universal-flow/web dev` mem-bundle ulang setiap file berubah.

## Halaman

| Rute | Isi |
| --- | --- |
| `/login`, `/signup` | Masuk dan daftar; daftar langsung membuat workspace pertama |
| `/integrations` | Applications & Integrations: daftar modul terpasang, status, cari, filter kategori dan status, Import manifest |
| `/integrations/new` | Builder Custom API lima langkah dengan pratinjau modul yang langsung berubah |
| `/integrations/:id` | Connect account (API key, bearer, basic, OAuth 2.0), Test API, izin, node workflow, update, disable, uninstall |
| `/marketplace` | Featured, Popular, New, AI applications, Community, Built in this workspace; cari dan filter; Install dengan persetujuan izin; Publish a plugin |
| `/marketplace/:id` | Detail modul: aksi, izin, batasan, versi |
| `/workflows` | Daftar workflow: versi, status live, run terakhir; buat baru (kosong atau template content pipeline), hapus |
| `/workflows/:id` | Spatial Studio |

## Spatial Studio

Lantai berperspektif tempat setiap langkah workflow menjadi papan modul yang punya tebal, bayangan dan jack. Kabel patch menghubungkan jack.

- **Kamera**: geser lantai untuk berpindah, klik kanan (atau Alt) lalu geser untuk memutar dan memiringkan, scroll atau pinch untuk zoom. Tombol 3D/Top, putar, miring, zoom dan "Show all steps".
- **Menambah langkah**: seret modul dari palette ke lantai, atau klik modul. Jika ada langkah terpilih, modul baru dipasang di sebelahnya dan langsung tersambung.
- **Kabel alur** (tebal): dari jack keluaran (Out, Error, True/False, Approved/Rejected) ke jack In. Studio menolak kabel yang membuat lingkaran, masuk ke trigger, atau ganda, dengan alasan yang jelas.
- **Kabel data** (titik-titik, warna modul asal): dari output sebuah langkah ke input langkah lain. Hasilnya referensi `{{nodes.claude.output.text}}` di input tersebut. Kabel data samar sampai langkahnya dipilih.
- **Keyboard**: Tab berpindah antar langkah, panah memindahkan (Shift untuk langkah besar), Delete menghapus, Enter pada jack keluaran lalu Enter pada jack masukan untuk memasang kabel, Escape membatalkan. Ctrl+Z/Ctrl+Shift+Z untuk undo/redo, Ctrl+S untuk menyimpan.
- **Inspector**: nama langkah, akun yang dipakai (hanya `credentialId`; secret tetap di server), input dari skema modul dengan tombol *Insert data* yang menampilkan output langkah sebelumnya, retry dan lanjut-saat-gagal, sambungan per port. Ada editor khusus untuk trigger (manual, webhook, cron dengan zona waktu), condition, loop, delay, approval dan transform.
- **Loop**: tombol *Open the loop* masuk ke isi loop (breadcrumb di kiri atas); di dalamnya tersedia `{{item}}` dan `{{index}}`.
- **Masalah**: merah (aturan engine, menghalangi simpan) dan kuning (akan gagal saat jalan, misalnya input wajib kosong atau modul belum terpasang). Daftar lengkap ada di panel Workflow; klik untuk melompat ke langkahnya.
- **Simpan, jalankan, live**: setiap simpan membuat versi baru (dengan `expectedVersion`; jika orang lain menyimpan lebih dulu, Studio menawarkan pilihan dan tidak menimpa apa pun). Run memakai versi tersimpan dengan payload contoh yang dibentuk dari apa yang dibaca workflow. Go live mematok versi, membuka webhook dan menjadwalkan cron.
- **Run di papan**: lampu tiap papan (berjalan, selesai, gagal, dilewati, menunggu), kabel yang menyala hijau atau padam, input/output tiap langkah, dan tombol Approve/Reject dengan pesan approval yang sudah dirender. Riwayat run ada di tab Runs.
- **Draft**: perubahan yang belum disimpan disimpan di browser per workspace, jadi reload atau pergi menghubungkan akun tidak menghilangkan apa pun.

### Kenapa CSS 3D, bukan WebGL

Three.js dan React Three Fiber tidak bisa dipasang di lingkungan build ini, jadi adegan dirender dengan transform CSS 3D (perspective, `preserve-3d`, papan dengan sisi). Keuntungannya: teks tajam dan bisa dibaca screen reader, setiap jack adalah tombol yang bisa difokus, dan semuanya diuji di Chromium. Matematika kamera (`src/lib/studio/camera.ts`) menghitung proyeksi yang sama dengan browser (dicek sampai 0,003 px) sehingga drag, drop dan kabel jatuh tepat. Semua logika (graf, kamera, layout, validasi) terpisah dari komponen React, jadi renderer WebGL bisa ditambahkan kemudian tanpa mengubah editor.

Setiap kabel punya SVG kecil sendiri: Chromium hanya me-rasterisasi sebagian dari satu layer 3D yang sangat besar.

## Aplikasi terpasang (PWA)

- `public/manifest.webmanifest`: nama, ikon (termasuk *maskable* untuk Android), mode layar penuh, pintasan ke Workflows, Applications dan Marketplace.
- `src/sw-source.js` menjadi `dist/sw.js` saat build, berisi daftar file build itu. Halaman selalu diambil dari jaringan dulu; tanpa jaringan tampil `offline.html`. Aset dan ikon diambil dari cache. Permintaan `/v1`, `/hooks` dan `/oauth` tidak pernah disentuh, jadi data akun tidak pernah tersimpan di cache.
- Tombol **Install app** muncul ketika Chrome menawarkan pemasangan (`src/state/install.ts`).
- Ikon dibuat dari `public/icons/*.svg` dengan `node scripts/make-icons.mjs`.

## Struktur

```
src/
  lib/            logika tanpa React (typecheck + unit test)
    studio/       graf, data, validasi, layout papan, kamera, eksekusi, template, undo, draft
  state/          sesi, toast, navigasi, hook pemuat data
  components/     UI dasar dan komponen modul (faceplate, jack, tile)
  features/       auth, integrations, custom-api, marketplace, studio
  styles.css      token desain dan semua gaya
typecheck/        tipe React minimal untuk typecheck offline
e2e/              uji browser end-to-end + screenshot
```

## Arah desain

Sebuah *patch bay*: setiap aplikasi adalah modul dengan jack (input di kiri, output di kanan), dan di Studio modul itu menjadi papan di atas lantai. Sidebar adalah rak gelap yang menyusut menjadi titik-titik patch saat Studio terbuka, panel berwarna aluminium, faceplate hampir putih. Warna kabel hanya dipakai untuk makna: hijau siap atau sudah mengalir, kuning perlu tindakan, merah gagal, biru menunggu keputusan. Huruf label memakai keluarga DIN (Bahnschrift di Windows, DIN Alternate di macOS) dengan cadangan sistem, tanpa font web.

## Keamanan

- Sesi di cookie `HttpOnly; SameSite=Lax` (dan `Secure` di HTTPS); token tidak pernah bisa dibaca JavaScript.
- Setiap perubahan mengirim header `x-csrf-token`; server juga menolak origin asing.
- CSP ketat dari backend: hanya skrip dan gaya milik sendiri, tanpa inline, tanpa iframe.
- Secret kredensial hanya dikirim sekali ke server; workflow dan draft hanya menyimpan id akun.
- Secret penandatangan webhook hanya bisa dilihat admin, atas permintaan, dan tidak disimpan di browser.

## Pengujian

```bash
pnpm --filter @universal-flow/web test              # 33 unit test logika (termasuk validasi silang dengan core)
pnpm --filter @universal-flow/web typecheck         # dengan @types/react terpasang
pnpm --filter @universal-flow/web typecheck:offline # tanpa internet: memakai typecheck/react-shim.d.ts
# uji browser: jalankan server demo, lalu Playwright
node apps/backend/dist/test/support/demo-server.js &
pnpm --filter @universal-flow/web e2e
```

Unit test memeriksa bahwa Studio memakai port, ukuran papan dan aturan validasi yang sama persis dengan core engine, dan bahwa template content pipeline diterima engine (juga ketika sebagian modul tidak terpasang).

`e2e/pwa.e2e.mjs` meniru HP Android (Pixel 7): manifest dan ikon, service worker, pemeriksaan installability milik Chrome (tanpa error), tombol Install app, menyetujui approval dari HP, dan halaman offline.

`e2e/ui.e2e.mjs` melewati alur tahap 3 (daftar, marketplace, MY CUSTOM AI, akun, Test API, OAuth, disable/uninstall, layar sempit, mode gelap). `e2e/studio.e2e.mjs` membangun workflow dengan mouse dan keyboard, memasang kabel alur dan data, undo/redo, menolak loop kosong, menyimpan, menjalankan, menyetujui approval dari papan, go live, memulihkan draft setelah reload, membuka content pipeline, memutar kamera, lalu memeriksa layout ponsel dan mode gelap. Keduanya menyimpan screenshot di `e2e/screenshots/` dan gagal bila ada error JavaScript atau pelanggaran CSP.
