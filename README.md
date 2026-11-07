# UNIVERSAL FLOW AI

Platform otomasi modular: setiap aplikasi adalah plugin, setiap plugin otomatis menjadi node 3D, dan semua node bisa disambung dalam satu workflow.

Repo ini adalah monorepo (Turborepo + pnpm):

| Paket | Isi | Status |
| --- | --- | --- |
| `packages/core-engine` | Plugin system, API connector, secret vault, node generator, workflow engine | Tahap 1, 69 tes |
| `apps/backend` | HTTP API, PostgreSQL, antrean job, worker, scheduler, OAuth, webhook, login pengguna | Tahap 2–4, 28 tes (termasuk end-to-end di PostgreSQL) |
| `apps/web` | Web app: login, Applications & Integrations, builder Custom API, Marketplace, Workflows, Spatial Studio (editor 3D), aplikasi terpasang (PWA) | Tahap 3–4, 33 unit tes + 3 uji browser end-to-end |

Panduan: [`apps/backend/README.md`](apps/backend/README.md), [`apps/web/README.md`](apps/web/README.md).

## Isi core-engine

| Modul | Lokasi | Fungsi |
| --- | --- | --- |
| Plugin manifest | `src/manifest/` | Skema manifest, validasi lengkap (semua error dilaporkan sekaligus) |
| Kategori | `src/registry/category-registry.ts` | 30 kategori bawaan, admin bisa menambah/mengubah |
| Plugin registry | `src/registry/plugin-registry.ts` | Register, review, install, update (dengan diff izin), disable, uninstall, revoke, search, versi terkunci |
| Secret vault | `src/security/secret-store.ts` | Envelope encryption AES-256-GCM, kunci utama di KMS, terikat ke workspace |
| Pengaman | `src/security/` | Anti-SSRF (https saja, blokir IP privat/metadata, allowlist host), penyensoran secret |
| Universal API Connector | `src/connector/` | Auth (API key, Bearer, Basic, OAuth 2.0 + refresh), template request, response mapping, Test API |
| Node Generator | `src/nodes/node-generator.ts` | Manifest → definisi node 3D: port, panel konfigurasi, status koneksi, geometri; node kontrol bawaan dengan output datanya |
| Workflow Engine | `src/workflow/` | DAG, paralel, kondisi, loop, delay, approval, retry + backoff, error port, history, webhook signature |

## Menjalankan

Butuh Node.js 20.6+, pnpm, dan PostgreSQL 16 (atau Docker).

```bash
pnpm install
pnpm build
pnpm test
```

Aplikasi lengkap (API + web app + Spatial Studio) di satu alamat: ikuti [`apps/backend/README.md`](apps/backend/README.md#menjalankan-secara-lokal), lalu buka `http://localhost:8080`.

## Online dan di HP Android

UNIVERSAL FLOW AI bisa dipasang sebagai aplikasi (PWA): ikon di layar utama, layar penuh, halaman offline, dan tombol Install di Chrome. `Dockerfile` membangun satu container (API, worker, scheduler, web app), dan `render.yaml` menjalankannya di Render, region Singapura, selalu menyala. Langkah lengkap dari HP: [`PANDUAN-ANDROID.md`](PANDUAN-ANDROID.md).

Di server publik, akun pertama yang mendaftar menjadi administrator dan pendaftaran lalu tertutup (`ALLOW_SIGNUP=false`).

Atau hanya paket inti:

```bash
cd packages/core-engine
npx tsc -p tsconfig.json
npm test
```

## Contoh singkat

```ts
import {
  ENGINE_VERSION, createCategoryRegistry, createPluginRegistry, createSecretStore,
  createLocalKeyProvider, createInMemorySecretRepository, createApiConnector,
  createFetchHttpClient, createOAuthRefresher, generateNodeDefinitions,
} from '@universal-flow/core-engine';

const registry = createPluginRegistry({ categories: createCategoryRegistry(), engineVersion: ENGINE_VERSION });
const record = registry.register(myCustomAiManifest, { source: 'custom', ownerWorkspaceId: 'ws_1' });

const secrets = createSecretStore({
  keyProvider: createLocalKeyProvider(Buffer.from(process.env.MASTER_KEY_BASE64 ?? '', 'base64')),
  repository: createInMemorySecretRepository(),
});
const credential = await secrets.put({ workspaceId: 'ws_1', pluginId: record.manifest.id, authType: 'bearer', values: { token: '...' } });

const http = createFetchHttpClient();
const connector = createApiConnector({ http, secrets, refreshOAuth: createOAuthRefresher(http) });
const report = await connector.test({ manifest: record.manifest, actionKey: 'generate', input: { prompt: 'Halo' }, workspaceId: 'ws_1', credentialId: credential.id });
if (report.ok) registry.markTested(record.manifest.id, record.manifest.version);

const nodes = generateNodeDefinitions(record.manifest); // siap dirender di Spatial Studio
```

## Keputusan desain

- **Manifest adalah satu-satunya sumber kebenaran.** Node 3D, form konfigurasi, dan eksekusi dibaca dari manifest, jadi integrasi baru tidak perlu build ulang.
- **Versi plugin dikunci di workflow** (`pluginId@1.0.0`). Update plugin tidak mengubah workflow lama.
- **Kredensial hanya di backend.** Browser dan node 3D hanya melihat `credentialId`, nama field, dan status.
- **Ekspresi hanya path data** (`{{nodes.claude.output.text}}`), tanpa `eval` dan tanpa pemanggilan fungsi.
- **Runtime `native`** (kode handler) hanya untuk plugin resmi. Plugin komunitas bersifat deklaratif (HTTP) dan wajib lolos review.
- **Integrasi tanpa API resmi tidak diklaim penuh:** keterbatasan ditulis di `limitations` dan tampil di node serta Marketplace.

## Spatial Studio

Editor 3D di `/workflows/:id`. Setiap langkah adalah papan modul di atas lantai berperspektif, dibuat otomatis dari `NodeDefinition` (`GET /v1/nodes`). Kabel alur menghubungkan Out/Error/True/False/Approved/Rejected ke In; kabel data menulis referensi seperti `{{nodes.claude.output.text}}`. Kamera bisa diputar, dimiringkan, di-zoom dan dilihat dari atas; semua bisa dikerjakan dengan keyboard. Studio menyimpan versi, menjalankan, menampilkan run langsung di papan (termasuk Approve/Reject), dan membuat workflow live. Detail di [`apps/web/README.md`](apps/web/README.md#spatial-studio).

Adegan dirender dengan CSS 3D karena Three.js tidak bisa dipasang di lingkungan build ini; logika kamera, graf dan layout terpisah dari renderer sehingga renderer WebGL bisa ditambahkan kemudian.

## Tahap berikutnya

1. Plugin resmi sungguhan untuk Telegram, Claude, OpenAI, Google Drive, Google Sheets, YouTube, Facebook dan Instagram (di demo masih tiruan lokal), termasuk trigger "pesan masuk" Telegram.
2. Marketplace komunitas: sandbox kode kustom dan pemindaian keamanan otomatis.
3. Undangan anggota tim dan pengelolaan peran dari web app.
4. Renderer WebGL opsional untuk workflow sangat besar, memakai logika Studio yang sama.
