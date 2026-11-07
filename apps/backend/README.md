# @universal-flow/backend

Backend UNIVERSAL FLOW AI: HTTP API, penyimpanan PostgreSQL, antrean job, worker, dan scheduler. Logika bisnis ada di `@universal-flow/core-engine`; paket ini menyambungkannya ke database dan HTTP.

## Menjalankan secara lokal

Butuh Node.js 20.6 atau lebih baru (untuk `--env-file`). Dari folder `apps/backend`:

```bash
docker compose up -d postgres          # dari root repo; atau PostgreSQL 16 milikmu sendiri
pnpm install && pnpm build              # dari root repo
cp .env.example .env
node dist/src/cli.js generate-master-key          # salin hasilnya ke MASTER_KEY di .env
node --env-file=.env dist/src/cli.js migrate
PASSWORD='kata sandi panjang' node --env-file=.env dist/src/cli.js create-user saya@contoh.com "Nama Saya" "Workspace saya" --platform-admin
node --env-file=.env dist/src/main.js             # buka PUBLIC_BASE_URL di browser
```

Program tidak membaca `.env` sendiri; `--env-file=.env` yang memuatnya. Di server, isi variabel lingkungan langsung.

Satu program menjalankan tiga peran lewat `ROLE`:

| ROLE | Isi | Jumlah instance |
| --- | --- | --- |
| `api` | Server HTTP | Sebanyak perlu, di belakang load balancer |
| `worker` | Menjalankan job workflow | Sebanyak perlu |
| `scheduler` | Mengubah jadwal cron menjadi job | Satu atau lebih (aman dijalankan ganda) |
| `all` | Ketiganya dalam satu proses | Untuk development |

## Konfigurasi

| Variabel | Wajib | Keterangan |
| --- | --- | --- |
| `DATABASE_URL` | ya | `postgres://user:pass@host:5432/db` |
| `PUBLIC_BASE_URL` | ya, kecuali di Render | Origin publik API, dipakai untuk URL webhook dan callback OAuth. Di Render otomatis diambil dari `RENDER_EXTERNAL_URL` |
| `MASTER_KEY` | ya | 32 byte base64; membungkus kunci enkripsi setiap kredensial |
| `MASTER_KEY_ID` | tidak | Label kunci, default `local-1` (untuk rotasi) |
| `ROLE` | tidak | `all` (default), `api`, `worker`, `scheduler` |
| `PORT`, `HOST` | tidak | Default `8080`, `0.0.0.0` |
| `CORS_ORIGINS` | tidak | Daftar origin web app, dipisah koma |
| `AUTO_MIGRATE` | tidak | `true` untuk menjalankan migrasi saat start |
| `DATABASE_SSL` | tidak | `true` untuk koneksi TLS ke database |
| `WORKER_BATCH_SIZE` | tidak | Job per putaran worker, default 5 |
| `WEB_DIST_DIR` | tidak | Folder hasil build `apps/web`; kalau diisi, web app disajikan di `/` |
| `ALLOW_SIGNUP` | tidak | `false` untuk menutup pendaftaran mandiri (default `true`) |
| `SESSION_TTL_HOURS` | tidak | Umur sesi login, default 336 (14 hari) |
| `TRUST_PROXY` | tidak | `true` bila di belakang proxy tepercaya, agar alamat klien dibaca dari `X-Forwarded-For` |

Untuk produksi, ganti `createLocalKeyProvider` di `src/main.ts` dengan `KeyProvider` yang memakai KMS (AWS KMS, GCP KMS, Vault). Kunci utama tidak pernah boleh ada di database.

## Autentikasi

Dua cara, keduanya memakai peran berjenjang `viewer` < `editor` < `admin` < `owner`:

- **Pengguna (web app):** `POST /v1/auth/signup` atau `/v1/auth/login` memasang cookie `uf_session` (`HttpOnly; SameSite=Lax`, `Secure` di HTTPS). Setiap perubahan wajib membawa header `x-csrf-token` (dari `GET /v1/auth/session`), dan origin asing ditolak. Password di-hash dengan scrypt. Lima kali gagal masuk dalam 15 menit mengunci email dan alamat klien selama 15 menit; jawaban untuk email tak dikenal dan password salah sama.
- **Token API (skrip dan integrasi):** `Authorization: Bearer uf_...`, disimpan sebagai hash SHA-256.

Endpoint `/v1/admin/*` dan pengelolaan kategori hanya untuk platform admin. Sesi: `GET /v1/auth/session`, `POST /v1/auth/logout`, `POST /v1/auth/workspace` (ganti workspace), `POST /v1/auth/workspaces` (buat workspace).

## Endpoint

| Area | Endpoint | Peran minimum |
| --- | --- | --- |
| Sistem | `GET /health`, `GET /v1/me`, `GET /v1/audit` | publik / viewer / admin |
| Kategori | `GET /v1/categories`; `POST`, `PATCH /:slug`, `DELETE /:slug` | viewer / platform admin |
| Marketplace | `GET /v1/marketplace?text=&category=&provider=&source=`, `GET /v1/marketplace/:pluginId` | viewer |
| | `POST /v1/marketplace/submissions` (plugin komunitas, masuk review) | editor |
| | `POST /v1/admin/plugins`, `.../versions/:v/approve`, `.../reject`, `.../:id/revoke` | platform admin |
| Integrasi | `GET /v1/integrations`, `GET /v1/integrations/:pluginId`, `GET /v1/nodes` | viewer |
| | `POST /v1/integrations/custom`, `POST /v1/integrations/import`, `POST /:pluginId/test` | editor |
| | `POST /:pluginId/install`, `GET /:pluginId/update-preview`, `POST /:pluginId/update`, `POST /:pluginId/enable`, `/disable`, `DELETE /:pluginId?force=true` | admin |
| Kredensial | `GET /v1/credentials` | viewer |
| | `POST /v1/credentials`, `DELETE /v1/credentials/:id`, `POST /v1/oauth/:pluginId/start` | admin |
| | `GET /oauth/callback` (dipanggil penyedia OAuth) | publik |
| Workflow | `GET /v1/workflows`, `GET /v1/workflows/:id?version=` | viewer |
| | `POST /v1/workflows`, `PUT /:id` (wajib `expectedVersion`), `POST /:id/activate`, `/deactivate`, `/run` | editor |
| | `GET /:id/triggers` (yang sedang live: URL webhook dan jadwal berikutnya, tanpa secret) | viewer |
| | `GET /:id/webhooks` (URL + secret), `DELETE /:id` | admin |
| Eksekusi | `GET /v1/executions?workflowId=&status=&limit=`, `GET /v1/executions/:id` | viewer |
| | `POST /v1/executions/:id/approvals/:nodeId`, `POST /:id/cancel` | editor |
| Webhook | `POST /hooks/:webhookId` | publik, wajib tanda tangan |

Pendaftaran: selama belum ada pengguna, `GET /v1/auth/session` menjawab `signup: "first"` dan akun pertama menjadi administrator platform. Setelah itu `ALLOW_SIGNUP` menentukan `open` atau `closed`; di server publik pakai `ALLOW_SIGNUP=false`.

Container: `Dockerfile` di root membangun semuanya dan menjalankan `ROLE=all` dengan migrasi otomatis; `render.yaml` memasangnya di Render (lihat `PANDUAN-ANDROID.md`).

User Approval: selama langkah approval menunggu, `execution.nodes.<id>.output.message` berisi pesannya yang sudah dirender (misalnya `Publish https://…/v.mp4?`), sehingga yang memutuskan membaca isi sebenarnya, bukan template.

Webhook masuk diverifikasi dengan salah satu cara:
- **HMAC** (disarankan): header `x-uf-timestamp` (epoch ms) dan `x-uf-signature` = hex HMAC-SHA256 dari `"<timestamp>.<body>"`. Kedaluwarsa setelah 5 menit.
- **Token tetap**: header `x-uf-webhook-token` berisi secret, untuk layanan yang hanya bisa mengirim header tetap. Header Telegram `x-telegram-bot-api-secret-token` juga diterima: daftarkan URL webhook dengan `setWebhook` dan isi `secret_token` dengan secret webhook (43 karakter base64url, sesuai aturan Telegram).

## Keputusan desain

- **Antrean di PostgreSQL**, bukan Redis/BullMQ. Worker mengambil job dengan `FOR UPDATE SKIP LOCKED`; klaim adalah lease yang diperpanjang selama job berjalan, jadi job milik worker yang mati diambil alih otomatis. Status eksekusi dan job ada di database yang sama.
- **Satu eksekusi, satu worker.** Job satu eksekusi berbagi `concurrency_key`, dan tabel `job_locks` (satu upsert atomik) memastikan hanya satu yang berjalan. Penyimpanan eksekusi juga memakai revisi optimistik sebagai pengaman terakhir.
- **Job yang diulang melanjutkan, bukan mengulang.** ID eksekusi dibuat saat job dimasukkan; kalau worker mati di tengah, job berikutnya memanggil `engine.recover`. Node yang sedang berjalan saat crash dijalankan ulang (at-least-once), jadi aksi plugin sebaiknya idempoten.
- **Versi workflow tidak berubah.** Setiap simpan membuat versi baru; aktivasi mengunci satu versi; eksekusi mencatat versi yang dipakai. `PUT` wajib membawa `expectedVersion`, jadi dua orang yang mengedit bersamaan tidak saling menimpa.
- **Kredensial terikat ke plugin.** Node hanya bisa memakai kredensial yang dihubungkan untuk plugin node itu, dicek saat aktivasi dan saat eksekusi.
- **Router tanpa framework** di atas `node:http`. Tabel rute bisa dipasang di Fastify nanti tanpa mengubah handler.

## Pengujian

```bash
pnpm build && pnpm test
```

Tes repository dan end-to-end berjalan di PostgreSQL sungguhan (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`; default `127.0.0.1`, `universal`, `universal`, `universal_test`). Setiap suite membuat schema sendiri dan menghapusnya setelah selesai. Harness tes menjalankan SQL lewat `psql`; produksi memakai driver `pg` (`src/db/pg-client.ts`).

## Belum ada di tahap ini

- Rate limiting per token dan per webhook (pasang di load balancer atau middleware).
- `KeyProvider` berbasis KMS (antarmukanya sudah ada).
- Pembersihan data lama: job selesai, langkah eksekusi, state OAuth yang kedaluwarsa.
- Undangan anggota tim dan reset password lewat email.
