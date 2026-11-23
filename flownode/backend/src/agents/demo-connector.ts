import { sleep, type AgentConnector, type AgentTask, type ArtifactDraft, type DiscussInput } from './connector.js';
import * as c from './demo-content.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

export class DemoConnector implements AgentConnector {
  readonly mode = 'demo' as const;
  constructor(private readonly delayMs = Number(process.env.FLOWNODE_TASK_MS ?? 900)) {}

  status() {
    return { state: 'demo' as const, note: 'Mode DEMO: konten dibuat oleh template lokal, bukan oleh akun Claude.' };
  }

  async run(task: AgentTask, signal: AbortSignal): Promise<ArtifactDraft[]> {
    await sleep(this.delayMs, signal);
    const i = task.instruction;
    switch (task.kind) {
      case 'plan': {
        const rev = task.context?.startsWith('rev:') ? Number(task.context.slice(4)) : 0;
        return [{ name: rev ? `rencana-proyek-rev${rev}.md` : 'rencana-proyek.md', kind: 'document', mime: 'text/markdown', data: buf(c.planDoc(i, rev)) }];
      }
      case 'visuals':
        return [
          { name: 'konsep-visual.svg', kind: 'image', mime: 'image/svg+xml', data: buf(c.imageSvg(i)) },
          { name: 'storyboard-klip.svg', kind: 'video', mime: 'image/svg+xml', data: buf(c.videoSvg(i)) },
          { name: 'model-kubus.obj', kind: 'model3d', mime: 'text/plain', data: buf(c.modelObj()) },
          { name: 'nada-demo.wav', kind: 'audio', mime: 'audio/wav', data: c.toneWav() },
        ];
      case 'engineering':
        return [
          { name: 'prototipe.html', kind: 'code', mime: 'text/html', data: buf(c.appHtml(i)) },
          { name: 'data.json', kind: 'dataset', mime: 'application/json', data: buf(c.dataJson(i)) },
          { name: 'build.log', kind: 'code', mime: 'text/plain', data: buf(c.buildLog()) },
        ];
      case 'review':
        return [{ name: 'laporan-review.md', kind: 'document', mime: 'text/markdown', data: buf(c.reviewReport(i)) }];
      case 'revision':
        return [{ name: `catatan-revisi-${task.context ?? '1'}.md`, kind: 'document', mime: 'text/markdown', data: buf(c.revisionNotes(Number(task.context ?? 1))) }];
    }
  }

  async discuss(input: DiscussInput, signal: AbortSignal): Promise<string> {
    await sleep(Math.round(this.delayMs / 2), signal);
    const { agent, phase, round, disagree } = input;
    const t = (s: string) => `[DEMO] ${s}`;
    switch (phase) {
      case 'proposal':
        return t('Usulan: ikuti rencana proyek terlampir. Tugas dibagi sesuai peran masing-masing.');
      case 'review':
        return agent === 'claude-02'
          ? t('Review visual: arah gaya jelas, mohon tambahkan acuan palet warna.')
          : t('Review teknis: kebutuhan dapat dibangun, mohon tambahkan kriteria penerimaan.');
      case 'critique':
        return t(`Kritik ronde ${round}: ${agent === 'claude-02' ? 'kontras aset perlu dijaga' : 'batas waktu per aset belum jelas'}.`);
      case 'revision':
        return t(`Revisi ronde ${round}: rencana diperbarui dengan kriteria penerimaan dan batas waktu.`);
      case 'reeval':
        return disagree
          ? t(`Evaluasi ulang ronde ${round}: belum setuju, perubahan belum memadai.`)
          : t(`Evaluasi ulang ronde ${round}: setuju dengan revisi.`);
      case 'consensus':
        return t('Konsensus tercapai. Lanjut ke tahap Building.');
      default:
        return t('Catatan sistem.');
    }
  }
}
