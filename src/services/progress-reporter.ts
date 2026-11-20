import type { Notifier } from './notifier.js';
import { progressBar, formatSpeed, formatDuration, formatBytes } from '../utils/bytes.js';
import { escapeHtml, truncate } from '../security/sanitize.js';

export interface ProgressState {
  title: string;
  phase?: string;
  percent: number;
  bytesDone?: number;
  bytesTotal?: number;
  startedAt?: number;
}

/**
 * Edits a single Telegram status message instead of spamming chat.
 * Telegram is rate limited to roughly one edit per second per chat, so updates
 * are throttled and failures are swallowed (a status message is not critical).
 */
export class ProgressReporter {
  private lastEdit = 0;
  private messageId: number | null = null;
  private latest: ProgressState | null = null;
  private readonly minIntervalMs: number;

  constructor(
    private readonly notifier: Notifier,
    private readonly chatId: number,
    private readonly opts: { minIntervalMs?: number; initialMessageId?: number | null; header?: string } = {}
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? 2500;
    this.messageId = opts.initialMessageId ?? null;
  }

  render(state: ProgressState): string {
    const pct = Math.max(0, Math.min(100, state.percent));
    const lines: string[] = [`<b>${escapeHtml(this.opts.header ?? state.title)}</b>`, ''];
    lines.push(`${progressBar(pct)} <b>${pct.toFixed(0)}%</b>`);
    if (state.phase) lines.push(`وضعیت: ${escapeHtml(state.phase)}`);
    if (state.bytesTotal && state.bytesDone !== undefined) {
      lines.push(`حجم: ${formatBytes(state.bytesDone)} از ${formatBytes(state.bytesTotal)}`);
      if (state.startedAt && state.bytesDone > 0) {
        const elapsed = (Date.now() - state.startedAt) / 1000;
        const speed = state.bytesDone / elapsed;
        lines.push(`سرعت: ${formatSpeed(speed)}`);
        if (speed > 0 && state.bytesTotal) {
          const remaining = (state.bytesTotal - state.bytesDone) / speed;
          lines.push(`زمان باقی‌مانده: ~${formatDuration(remaining * 1000)}`);
        }
      }
    }
    return truncate(lines.join('\n'), 4000);
  }

  async update(state: ProgressState): Promise<void> {
    this.latest = state;
    const now = Date.now();
    if (now - this.lastEdit < this.minIntervalMs && state.percent < 100) return;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.latest) return;
    this.lastEdit = Date.now();
    const text = this.render(this.latest);
    if (this.messageId !== null) {
      const ok = await this.notifier.edit(this.chatId, this.messageId, text, { parseMode: 'HTML' });
      if (!ok) this.messageId = await this.notifier.send(this.chatId, text, { parseMode: 'HTML' });
    } else {
      this.messageId = await this.notifier.send(this.chatId, text, { parseMode: 'HTML' });
    }
  }

  async finish(text: string): Promise<void> {
    const body = truncate(text, 4000);
    if (this.messageId !== null) {
      const ok = await this.notifier.edit(this.chatId, this.messageId, body, { parseMode: 'HTML' });
      if (!ok) await this.notifier.send(this.chatId, body, { parseMode: 'HTML' });
    } else {
      this.messageId = await this.notifier.send(this.chatId, body, { parseMode: 'HTML' });
    }
  }

  get messageIdValue(): number | null {
    return this.messageId;
  }
}
