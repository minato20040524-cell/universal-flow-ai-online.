import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Snapshot } from './types';

export type View =
  | 'dashboard' | 'nodes' | 'collab' | 'agents' | 'skills' | 'builders' | 'files' | 'approvals' | 'analytics' | 'settings';

type Toast = { id: number; text: string; tone: 'ok' | 'error' | 'info' };

type Ctx = {
  s: Snapshot | null;
  connected: boolean;
  view: View;
  setView: (v: View) => void;
  draft: string;
  setDraft: (v: string) => void;
  startOpen: boolean;
  setStartOpen: (v: boolean) => void;
  loadOpen: boolean;
  setLoadOpen: (v: boolean) => void;
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  previewId: string | null;
  setPreviewId: (id: string | null) => void;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone']) => void;
  /** Jalankan aksi API; error ditampilkan sebagai toast. */
  act: <T>(fn: () => Promise<T>, okText?: string) => Promise<T | undefined>;
};

const AppCtx = createContext<Ctx | null>(null);
export const useApp = (): Ctx => {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp di luar AppProvider');
  return c;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<View>('dashboard');
  const [draft, setDraft] = useState('');
  const [startOpen, setStartOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const act = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (okText) toast(okText, 'ok');
        return r;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      }
    },
    [toast],
  );

  // WebSocket realtime + polling cadangan saat WS putus.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 500;
    let poll: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (poll) return;
      poll = setInterval(() => api.get<Snapshot>('/api/state').then(setS).catch(() => undefined), 3000);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        retry = 500;
        setConnected(true);
        stopPolling();
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data));
          if (m.type === 'state') setS(m.state as Snapshot);
        } catch {
          /* abaikan pesan rusak */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        startPolling();
        if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
      };
      ws.onerror = () => ws?.close();
    };
    api.get<Snapshot>('/api/state').then(setS).catch(() => undefined);
    connect();
    return () => {
      closed = true;
      stopPolling();
      ws?.close();
    };
  }, []);

  const value = useMemo<Ctx>(
    () => ({ s, connected, view, setView, draft, setDraft, startOpen, setStartOpen, loadOpen, setLoadOpen, expanded, setExpanded, previewId, setPreviewId, toasts, toast, act }),
    [s, connected, view, draft, startOpen, loadOpen, expanded, previewId, toasts, toast, act],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
