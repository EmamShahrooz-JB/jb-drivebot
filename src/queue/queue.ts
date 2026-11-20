import { EventEmitter } from 'node:events';
import type { JobsRepo } from '../database/jobs.repo.js';
import type { JobRow } from '../database/types.js';
import type { Logger } from '../utils/logger.js';
import { backoffDelay, sleep } from '../utils/backoff.js';
import { errorMessage, isRetryable } from '../utils/errors.js';

export interface JobContext {
  job: JobRow;
  payload: Record<string, unknown>;
  /** best effort progress update; writes are throttled by the queue */
  updateProgress: (percent: number, message?: string) => Promise<void>;
  setSession: (sessionUri: string | null, resumeOffset: number | null) => Promise<void>;
  shouldCancel: () => Promise<boolean>;
  log: Logger;
}

export interface JobHandler {
  concurrency: number;
  handle: (ctx: JobContext) => Promise<Record<string, unknown> | void>;
}

export type QueueEvent =
  | { type: 'started'; job: JobRow }
  | { type: 'progress'; job: JobRow; percent: number; message?: string }
  | { type: 'succeeded'; job: JobRow; result: Record<string, unknown> | null }
  | { type: 'requeued'; job: JobRow; error: string; retryInMs: number }
  | { type: 'failed'; job: JobRow; error: string }
  | { type: 'canceled'; job: JobRow };

export interface QueueOptions {
  pollIntervalMs: number;
  jobTimeoutMs: number;
  onEvent?: (event: QueueEvent) => void;
}

/**
 * Persistent background job queue.
 *
 * State lives in the database, so a container restart (a routine event on
 * Altare) resumes work instead of losing it: `start()` requeues anything that
 * was `running` when the process died, and resumable uploads continue from the
 * stored session URI.
 */
export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly running = new Map<string, { type: string; startedAt: number }>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  private readonly events = new EventEmitter();

  constructor(
    private readonly jobs: JobsRepo,
    private readonly logger: Logger,
    private readonly opts: QueueOptions
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  onEvent(listener: (e: QueueEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  private emit(event: QueueEvent): void {
    try {
      this.opts.onEvent?.(event);
      this.events.emit('event', event);
    } catch (err) {
      this.logger.warn('queue event listener threw', { err: errorMessage(err) });
    }
  }

  async start(): Promise<{ requeued: number; canceled: number }> {
    const recovery = await this.jobs.recoverOrphans();
    // Anything queued for a type this build cannot run (e.g. after a rollback)
    // would otherwise sit in the queue forever: fail it loudly instead.
    let unhandled = 0;
    for (const job of await this.jobs.list({ status: 'queued', limit: 100 })) {
      if (!this.handlers.has(job.type)) {
        await this.jobs.fail(job.id, `no handler registered for job type ${job.type}`, { retryAt: null });
        unhandled++;
      }
    }
    if (unhandled > 0) this.logger.warn('failed jobs with no registered handler', { unhandled });
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.pollIntervalMs);
    this.timer.unref?.();
    this.logger.info('job queue started', { ...recovery, types: [...this.handlers.keys()] });
    void this.tick();
    return recovery;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // let in-flight jobs observe the cancel flag; jobs stay `running` in the DB
    // and will be requeued on the next boot.
    const deadline = Date.now() + 15_000;
    while (this.running.size > 0 && Date.now() < deadline) await sleep(200);
  }

  private runningCount(type: string): number {
    let n = 0;
    for (const entry of this.running.values()) if (entry.type === type) n++;
    return n;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      // Reap jobs that exceeded their timeout.
      const now = Date.now();
      for (const [id, info] of [...this.running.entries()]) {
        if (now - info.startedAt > this.opts.jobTimeoutMs) {
          this.logger.warn('job exceeded timeout, requesting cancel', { jobId: id });
          await this.jobs.requestCancel(id);
        }
      }

      for (;;) {
        const available = [...this.handlers.entries()].filter(([type, h]) => this.runningCount(type) < h.concurrency);
        if (available.length === 0) break;
        const job = await this.jobs.claimNext(Date.now(), available.map(([t]) => t));
        if (!job) break;
        void this.execute(job);
      }
    } catch (err) {
      this.logger.error('queue tick failed', { err: errorMessage(err) });
    } finally {
      this.ticking = false;
    }
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.logger.error('no handler registered for job type', { type: job.type, jobId: job.id });
      await this.jobs.fail(job.id, `no handler for job type ${job.type}`, { retryAt: null });
      return;
    }
    this.running.set(job.id, { type: job.type, startedAt: Date.now() });
    this.emit({ type: 'started', job });
    const log = this.logger.child({ jobId: job.id, jobType: job.type });

    let lastProgressWrite = 0;
    const pending: { value: { percent: number; message?: string } | null } = { value: null };

    const ctx: JobContext = {
      job,
      payload: safeParse(job.payload),
      log,
      updateProgress: async (percent, message) => {
        const now = Date.now();
        pending.value = { percent, ...(message !== undefined ? { message } : {}) };
        if (now - lastProgressWrite < 900) return; // throttle DB writes
        lastProgressWrite = now;
        await this.jobs.setProgress(job.id, percent, message);
        this.emit({ type: 'progress', job: { ...job, progress: percent }, percent, ...(message ? { message } : {}) });
      },
      setSession: async (uri, offset) => {
        await this.jobs.setSession(job.id, uri, offset);
      },
      shouldCancel: () => this.jobs.isCancelRequested(job.id),
    };

    try {
      const result = (await handler.handle(ctx)) ?? {};
      if (pending.value) {
        await this.jobs.setProgress(job.id, 100, pending.value.message);
      }
      await this.jobs.complete(job.id, result);
      this.emit({ type: 'succeeded', job, result });
      log.info('job succeeded');
    } catch (err) {
      const message = errorMessage(err);
      const canceled = /canceled/i.test(message);
      if (canceled) {
        await this.jobs.fail(job.id, 'canceled by user', { retryAt: null });
        this.emit({ type: 'canceled', job });
        log.info('job canceled');
      } else {
        const retryable = isRetryable(err);
        const retryAt = retryable && job.attempts < job.max_attempts ? Date.now() + backoffDelay(job.attempts) : null;
        const status = await this.jobs.fail(job.id, message, { retryAt });
        if (status === 'queued') {
          this.emit({ type: 'requeued', job, error: message, retryInMs: (retryAt ?? Date.now()) - Date.now() });
          log.warn('job failed, will retry', { attempt: job.attempts, retryInMs: (retryAt ?? Date.now()) - Date.now(), err: message });
        } else {
          this.emit({ type: 'failed', job, error: message });
          log.error('job failed permanently', { err: message });
        }
      }
    } finally {
      this.running.delete(job.id);
      setTimeout(() => void this.tick(), 10).unref?.();
    }
  }

  stats(): { running: number; registered: string[] } {
    return { running: this.running.size, registered: [...this.handlers.keys()] };
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
