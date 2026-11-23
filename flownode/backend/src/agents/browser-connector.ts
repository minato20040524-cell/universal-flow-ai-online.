import type { AgentConnector, AgentTask, ArtifactDraft, DiscussInput } from './connector.js';

/**
 * Kerangka Browser Connector (Tahap C/D).
 *
 * Rancangan: setiap akun Claude memakai profil browser terpisah (`sessions/<agent>`),
 * login dilakukan MANUAL oleh pengguna di jendela yang terlihat, dan pengguna dapat
 * mengambil alih (manual takeover) kapan saja. Tidak memakai API key, API privat,
 * atau pembobolan autentikasi.
 *
 * Di lingkungan ini (Termux/cloud) controller browser belum diimplementasikan, jadi
 * connector ini JUJUR melaporkan "not_connected" dan menolak menjalankan tugas.
 */
export class BrowserConnector implements AgentConnector {
  readonly mode = 'browser' as const;

  constructor(private readonly profileDir: string) {}

  status() {
    return {
      state: 'not_connected' as const,
      note: `Controller browser belum tersedia (Tahap C/D). Profil terisolasi dicadangkan di "${this.profileDir}". Login manual diperlukan setelah controller aktif.`,
    };
  }

  async run(_task: AgentTask, _signal: AbortSignal): Promise<ArtifactDraft[]> {
    throw new Error('Browser Connector belum terhubung: akun Claude belum login. Gunakan mode DEMO atau selesaikan Tahap C/D.');
  }

  async discuss(_input: DiscussInput, _signal: AbortSignal): Promise<string> {
    throw new Error('Browser Connector belum terhubung: diskusi tidak dapat dijalankan.');
  }
}
