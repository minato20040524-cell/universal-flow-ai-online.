import { EventEmitter } from 'node:events';

/**
 * Bus perubahan state. Semua perubahan nyata (transfer, status agen, pesan, dsb.)
 * memanggil `changed()`; WebSocket menyiarkan snapshot baru ke browser.
 */
export class Bus extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;

  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit('change');
    }, 30);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit('change');
  }
}
