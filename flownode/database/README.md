# Database FLOWNODE

Data disimpan lokal di SQLite (`node:sqlite` bawaan Node 22+) pada `backend/data/flownode.sqlite`
(ubah dengan `FLOWNODE_DATA`). Berkas hasil agen ada di `backend/data/projects/<id>/files/`.
Folder `backend/data` tidak masuk git. Skema dibuat otomatis oleh `backend/src/storage/store.ts`.

Tabel: `projects`, `runs`, `artifacts`, `activity`, `transfers`, `messages`, `approvals`, `skills`, `connectors`, `settings`.
Cadangan: salin folder `backend/data` saat server berhenti.
