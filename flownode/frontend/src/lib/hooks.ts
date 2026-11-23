import { useEffect, useState } from 'react';
import { rawUrl } from '../api';

export const bytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
};

export const clock = (ms: number): string => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
};

export const hhmmss = (ts: number): string => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });

/** Jam yang berdetak hanya bila `enabled` (tidak ada timer saat IDLE). */
export function useNow(enabled: boolean, interval = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [enabled, interval]);
  return now;
}

const cache = new Map<string, string>();
/** Ambil isi teks sebuah artefak (untuk pratinjau layar mini). */
export function useArtifactText(id: string | undefined): string | null {
  const [text, setText] = useState<string | null>(id ? cache.get(id) ?? null : null);
  useEffect(() => {
    if (!id) return setText(null);
    const hit = cache.get(id);
    if (hit !== undefined) return setText(hit);
    let alive = true;
    fetch(rawUrl(id))
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => {
        cache.set(id, t);
        if (alive) setText(t);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);
  return text;
}
