# Memasang UNIVERSAL FLOW AI online dan di HP Android

Hasil akhirnya: UNIVERSAL FLOW AI berjalan 24 jam di server Render (region Singapura), punya alamat `https://….onrender.com`, dan terpasang di HP Android seperti aplikasi biasa: ikon di layar utama, terbuka tanpa bilah browser.

Semua langkah bisa dikerjakan dari HP.

## Yang dibutuhkan

| Kebutuhan | Keterangan |
| --- | --- |
| Akun GitHub | Gratis, untuk menyimpan kode. Daftar di github.com |
| Akun Render | Untuk menjalankan server. Masuk dengan akun GitHub |
| Kartu pembayaran | Render menagih sekitar $7 (server) + $6 (database) per bulan, cek harga terbaru di render.com/pricing |
| HP Android dengan Chrome | Untuk memasang aplikasinya |

Kenapa tidak memakai paket gratis Render: server gratis tidur setelah 15 menit tanpa pengunjung, jadi jadwal (cron) berhenti dan webhook terlambat sekitar satu menit. Database gratis dihapus setelah 30 hari (plus 14 hari masa tenggang).

## 1. Simpan kode di GitHub

1. Buka github.com di Chrome, masuk, lalu ketuk **+** dan **New repository**.
2. Nama: `universal-flow-ai`. Pilih **Private**. Jangan centang README. Ketuk **Create repository**.
3. Unggah isi proyek ke repository itu, dengan salah satu cara:
   - **Lewat Claude (tanpa komputer):** hubungkan GitHub di pengaturan Connectors claude.ai, lalu kirim ke Claude nama repository-nya (misalnya `namaanda/universal-flow-ai`). Claude mengunggah semua file.
   - **Dari komputer:** ekstrak `universal-flow-ai-tahap4.zip`, lalu di folder itu:
     ```bash
     git init && git add . && git commit -m "UNIVERSAL FLOW AI"
     git branch -M main
     git remote add origin https://github.com/NAMAANDA/universal-flow-ai.git
     git push -u origin main
     ```

File `render.yaml` dan `Dockerfile` di dalam proyek sudah berisi seluruh konfigurasi server.

## 2. Jalankan di Render

1. Buka render.com, ketuk **Get Started**, masuk dengan **GitHub**, dan izinkan Render membaca repository `universal-flow-ai`.
2. Di Dashboard ketuk **New**, pilih **Blueprint**, lalu pilih repository `universal-flow-ai`.
3. Render membaca `render.yaml` dan menampilkan dua bagian: web service `universal-flow-ai` dan database `universal-flow-db`, keduanya di Singapura. Ketuk **Apply** (Render meminta kartu pembayaran di sini).
4. Tunggu sampai web service berstatus **Live**. Build pertama biasanya 5 sampai 10 menit.
5. Alamat aplikasi tertulis di bagian atas halaman web service, misalnya `https://universal-flow-ai.onrender.com`.

Yang sudah diatur otomatis oleh `render.yaml`:

- `DATABASE_URL`: disambungkan ke database Render.
- `MASTER_KEY`: kunci acak 256-bit yang mengenkripsi semua kunci API yang Anda simpan. **Jangan pernah mengubah atau menghapusnya**: tanpa kunci ini, akun-akun yang tersambung harus dihubungkan ulang.
- `ALLOW_SIGNUP=false`: hanya akun pertama yang bisa mendaftar sendiri.
- Alamat publik diambil otomatis dari Render. Kalau nanti memakai domain sendiri, isi `PUBLIC_BASE_URL` dengan domain itu.
- Tabel database dibuat otomatis saat server menyala.

## 3. Buat akun pertama

Segera setelah status **Live**, buka alamat aplikasi. Halaman masuk menampilkan **Create the first account**. Akun ini menjadi administrator server. Setelah itu pendaftaran tertutup, jadi orang lain yang menemukan alamatnya tidak bisa membuat akun.

## 4. Pasang di HP Android

1. Buka alamat aplikasi di **Chrome**.
2. Ketuk tombol **Install app** (di halaman masuk, atau di bilah gelap bagian atas setelah masuk), atau menu **⋮** lalu **Install app** (di beberapa versi: **Add to Home screen**).
3. Ikon UNIVERSAL FLOW muncul di layar utama. Aplikasi terbuka layar penuh, dan menekan lama ikonnya memberi pintasan ke Workflows, Applications dan Marketplace.

Yang bisa dilakukan dari HP: memantau run, menyetujui atau menolak approval, menjalankan workflow, menghubungkan akun, dan mengedit workflow di Spatial Studio (tombol **Modules** dan **Details** membuka panelnya). Untuk menyusun workflow besar, layar komputer lebih nyaman.

Tanpa internet, aplikasi menampilkan halaman "No connection". Workflow tetap berjalan di server.

## 5. Pembaruan

Setiap kali kode baru masuk ke GitHub (cabang `main`), Render membangun dan memasang ulang secara otomatis. Aplikasi di HP memakai versi baru saat dibuka berikutnya, tanpa pasang ulang.

## Webhook dari bot Telegram

Setelah workflow dengan trigger **Webhook** dibuat **live**, Studio menampilkan alamat webhook. Admin bisa membuka secret-nya di trigger tersebut. Daftarkan ke Telegram dengan membuka alamat ini di browser (ganti tiga bagiannya):

```
https://api.telegram.org/bot<TOKEN_BOT>/setWebhook?url=<ALAMAT_WEBHOOK>&secret_token=<SECRET>
```

## Kalau ada masalah

| Gejala | Penyebab dan solusi |
| --- | --- |
| Deploy gagal di langkah build | Buka tab **Logs** web service; kirim baris error terakhir ke Claude |
| Aplikasi menampilkan error konfigurasi | Periksa tab **Environment**: `DATABASE_URL` dan `MASTER_KEY` harus terisi |
| Tidak ada tombol Install app | Pastikan membuka alamat `https://` di Chrome; tunggu beberapa detik setelah halaman terbuka, atau pakai menu **⋮** |
| Lupa kata sandi admin | Di Render buka **Shell** web service (paket berbayar) lalu buat akun baru: `PASSWORD='…' node apps/backend/dist/src/cli.js create-user email@anda.com "Nama" "Workspace" --platform-admin` |
