// Semua konten di sini adalah DEMO: dibuat secara lokal oleh template, bukan oleh model AI.
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const short = (s: string, n = 48): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export const planDoc = (instruction: string, revision = 0): string => `# Rencana Proyek ${revision ? `(revisi ${revision})` : ''}

> DEMO — dibuat oleh template lokal FLOWNODE, bukan oleh Claude.

## Instruksi pengguna
${instruction}

## Pembagian tugas
- **Claude 01 (Director):** riset, rencana, storyboard, review akhir.
- **Claude 02 (Creator):** gambar, model 3D, audio, aset video.
- **Claude 03 (Engineer):** kode, data, pengujian, build log.

## Tahapan
1. Input → Processing → Collaboration → Building → Review → Complete.
${revision ? `\n## Catatan revisi\nDitambahkan kriteria penerimaan dan batas waktu per aset (revisi ${revision}).\n` : ''}`;

export const imageSvg = (instruction: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#A855F7"/><stop offset="1" stop-color="#2196F3"/></linearGradient></defs>
  <rect width="640" height="400" fill="#0B1120"/>
  <rect x="24" y="24" width="592" height="352" rx="24" fill="url(#g)" opacity=".85"/>
  <circle cx="470" cy="130" r="64" fill="#fff" opacity=".25"/>
  <path d="M24 300 Q 200 190 340 280 T 616 250 V376 H24Z" fill="#0B1120" opacity=".55"/>
  <text x="48" y="80" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff">Konsep Visual (DEMO)</text>
  <text x="48" y="112" font-family="sans-serif" font-size="16" fill="#fff" opacity=".9">${esc(short(instruction, 58))}</text>
</svg>`;

export const videoSvg = (instruction: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#0B1120"/>
  <rect x="20" y="20" width="600" height="320" rx="18" fill="#111827" stroke="#263449"/>
  <circle r="26" fill="#A855F7"><animate attributeName="cx" values="90;550;90" dur="4s" repeatCount="indefinite"/><animate attributeName="cy" values="200;130;200" dur="4s" repeatCount="indefinite"/></circle>
  <text x="40" y="60" font-family="sans-serif" font-size="20" font-weight="700" fill="#fff">Storyboard Klip (DEMO)</text>
  <text x="40" y="88" font-family="sans-serif" font-size="14" fill="#9ca3af">${esc(short(instruction, 62))}</text>
  <text x="40" y="326" font-family="sans-serif" font-size="12" fill="#6b7280">Placeholder animasi — bukan video hasil render.</text>
</svg>`;

export const modelObj = (): string => {
  const v: [number, number, number][] = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
  const f = [[1,2,3,4],[5,8,7,6],[1,5,6,2],[2,6,7,3],[3,7,8,4],[4,8,5,1]];
  return `# Kubus DEMO\no Cube\n${v.map((p) => `v ${p.join(' ')}`).join('\n')}\n${f.map((q) => `f ${q.join(' ')}`).join('\n')}\n`;
};

export const toneWav = (): Buffer => {
  const rate = 8000, secs = 0.6, n = Math.floor(rate * secs);
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 400, (n - i) / 400);
    data[i] = 128 + Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 90 * env);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, data]);
};

export const appHtml = (instruction: string): string => `<!doctype html>
<html lang="id"><meta charset="utf-8"><title>Prototipe DEMO</title>
<body style="font-family:sans-serif;background:#0B1120;color:#e5e7eb;padding:24px">
<h1>Prototipe (DEMO)</h1>
<p>${esc(short(instruction, 120))}</p>
<button id="b" style="padding:8px 16px">Klik saya</button> <span id="o"></span>
<script>let n=0;b.onclick=()=>{o.textContent='Diklik '+(++n)+'x'}</script>
</body></html>
`;

export const dataJson = (instruction: string): string =>
  JSON.stringify({ demo: true, instruction, items: [{ id: 1, label: 'Contoh A' }, { id: 2, label: 'Contoh B' }] }, null, 2);

export const buildLog = (): string =>
  ['[DEMO] build log', 'tsc --noEmit ........ ok', 'lint ................ ok', 'test (3 kasus) ...... 3 lulus', 'bundle .............. 1 berkas'].join('\n') + '\n';

export const reviewReport = (instruction: string): string => `# Laporan Review (DEMO)

Instruksi: ${instruction}

| Aset | Pemeriksaan | Hasil |
| --- | --- | --- |
| Gambar | Sesuai rencana | Lulus |
| Model 3D | Dapat dibuka | Lulus |
| Kode | Build log bersih | Lulus |

Keputusan akhir ada pada Project Owner.
`;

export const revisionNotes = (n: number): string => `# Catatan Revisi ${n} (DEMO)

Revisi dilakukan atas permintaan pengguna. Perubahan: penyesuaian kontras warna dan penambahan keterangan pada aset.\n`;
