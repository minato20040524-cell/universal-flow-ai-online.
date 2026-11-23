#!/data/data/com.termux/files/usr/bin/bash
# FLOWNODE V1 — setup & jalankan di Termux (Android). Aman dijalankan berulang kali.
#   bash termux-setup.sh          -> pasang, build, lalu jalankan server
#   bash termux-setup.sh --no-run -> hanya pasang dan build
set -e
cd "$(dirname "$0")"

echo "==> [1/4] Memeriksa Node.js"
if ! command -v node >/dev/null 2>&1; then
  pkg update -y && pkg install -y nodejs
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
echo "    Node $(node -v), npm $(npm -v)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "!!  FLOWNODE butuh Node.js >= 22.13 (memakai node:sqlite bawaan, tanpa kompilasi native)."
  echo "    Jalankan: pkg upgrade -y && pkg install -y nodejs   (paket 'nodejs', bukan 'nodejs-lts')"
  exit 1
fi

echo "==> [2/4] Penyimpanan tersedia"
df -h "$HOME" | tail -1

echo "==> [3/4] Memasang dependency (npm install)"
npm install --no-audit --no-fund

echo "==> [4/4] Build backend + frontend"
npm run build

if [ "$1" = "--no-run" ]; then
  echo "Selesai. Jalankan: npm start"
  exit 0
fi

PORT="${PORT:-8787}"
echo
echo "FLOWNODE berjalan. Buka di browser Android:  http://localhost:${PORT}"
echo "Hentikan dengan Ctrl+C."
PORT="$PORT" exec npm start
