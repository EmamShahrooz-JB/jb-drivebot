import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createSqliteDb } from '../../src/database/sqlite.js';
import { migrate } from '../../src/database/index.js';
import { JobsRepo } from '../../src/database/jobs.repo.js';
import { JobQueue, type QueueEvent } from '../../src/queue/queue.js';
import { createLogger } from '../../src/utils/logger.js';
import { tempDir } from '../helpers/config.js';
import type { Db } from '../../src/database/types.js';

const logger = createLogger('error');

describe('JobQueue', () => {
  let db: Db;
  let jobs: JobsRepo;
  let dir: string;
  let queue: JobQueue;
  const events: QueueEvent[] = [];

  beforeEach(async () => {
    dir = tempDir('jbd-queue-');
    db = createSqliteDb(path.join(dir, 'q.sqlite'));
    await migrate(db);
    jobs = new JobsRepo(db);
    events.length = 0;
  });

  afterEach(async () => {
    await queue?.stop();
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeQueue = () => {
    queue = new JobQueue(jobs, logger, { pollIntervalMs: 40, jobTimeoutMs: 5000 });
    queue.onEvent((e) => events.push(e));
    return queue;
  };

  const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('condition not met in time');
  };

  it('executes a registered job and records the result', async () => {
    makeQueue();
    const seen: string[] = [];
    queue.register('echo', {
      concurrency: 1,
      async handle({ payload, updateProgress }) {
        await updateProgress(50, 'half');
        seen.push(String(payload.value));
        return { ok: true, value: payload.value };
      },
    });
    const job = await jobs.create({ type: 'echo', payload: { value: 'hello' } });
    await queue.start();
    await waitFor(() => events.some((e) => e.type === 'succeeded'));
    const finished = await jobs.get(job.id);
    expect(seen).toEqual(['hello']);
    expect(finished?.status).toBe('succeeded');
    expect(JSON.parse(finished!.result!)).toEqual({ ok: true, value: 'hello' });
    expect(finished?.progress).toBe(100);
  });

  it('respects per-type concurrency', async () => {
    makeQueue();
    let concurrent = 0;
    let peak = 0;
    queue.register('slow', {
      concurrency: 2,
      async handle() {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 60));
        concurrent--;
      },
    });
    for (let i = 0; i < 6; i++) await jobs.create({ type: 'slow', payload: {} });
    await queue.start();
    await waitFor(() => events.filter((e) => e.type === 'succeeded').length === 6, 10_000);
    expect(peak).toBe(2);
  });

  it('runs higher priority jobs first', async () => {
    makeQueue();
    const order: string[] = [];
    queue.register('p', {
      concurrency: 1,
      async handle({ payload }) {
        order.push(String(payload.name));
      },
    });
    await jobs.create({ type: 'p', payload: { name: 'low' }, priority: 1 });
    await jobs.create({ type: 'p', payload: { name: 'high' }, priority: 100 });
    await queue.start();
    await waitFor(() => order.length === 2);
    expect(order).toEqual(['high', 'low']);
  });

  it('retries a retryable failure with backoff, then succeeds', async () => {
    makeQueue();
    let attempts = 0;
    queue.register('flaky', {
      concurrency: 1,
      async handle() {
        attempts++;
        if (attempts < 2) {
          const err = new Error('ECONNRESET while talking to drive');
          throw err;
        }
        return { attempts };
      },
    });
    const job = await jobs.create({ type: 'flaky', payload: {}, maxAttempts: 3 });
    await queue.start();
    await waitFor(() => events.some((e) => e.type === 'requeued'), 5000);
    await waitFor(() => events.some((e) => e.type === 'succeeded'), 15_000);
    expect(attempts).toBe(2);
    expect((await jobs.get(job.id))?.status).toBe('succeeded');
  });

  it('does not retry a non-retryable failure', async () => {
    makeQueue();
    queue.register('bad', {
      concurrency: 1,
      async handle() {
        throw new Error('validation failed: filename is invalid');
      },
    });
    const job = await jobs.create({ type: 'bad', payload: {} });
    await queue.start();
    await waitFor(() => events.some((e) => e.type === 'failed'));
    const finished = await jobs.get(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.attempts).toBe(1);
  });

  it('honours cancellation requested while a job runs', async () => {
    makeQueue();
    let started = false;
    queue.register('long', {
      concurrency: 1,
      async handle({ shouldCancel }) {
        started = true;
        for (let i = 0; i < 100; i++) {
          if (await shouldCancel()) throw new Error('canceled by user');
          await new Promise((r) => setTimeout(r, 20));
        }
      },
    });
    const job = await jobs.create({ type: 'long', payload: {} });
    await queue.start();
    await waitFor(() => started);
    await jobs.requestCancel(job.id);
    await waitFor(() => events.some((e) => e.type === 'canceled'), 8000);
    expect((await jobs.get(job.id))?.status).toBe('canceled');
  });

  it('recovers jobs left running by a previous process', async () => {
    // simulate a crash: a job stuck in `running`
    const orphan = await jobs.create({ type: 'work', payload: { n: 1 } });
    await jobs.claimNext();
    expect((await jobs.get(orphan.id))?.status).toBe('running');

    makeQueue();
    const done: string[] = [];
    queue.register('work', {
      concurrency: 1,
      async handle({ payload }) {
        done.push(String(payload.n));
      },
    });
    const recovery = await queue.start();
    expect(recovery.requeued).toBe(1);
    await waitFor(() => done.length === 1);
    expect((await jobs.get(orphan.id))?.status).toBe('succeeded');
  });

  it('does not start a job whose type has no handler', async () => {
    makeQueue();
    const job = await jobs.create({ type: 'unknown', payload: {} });
    await queue.start();
    await waitFor(async () => true);
    await new Promise((r) => setTimeout(r, 150));
    const stored = await jobs.get(job.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.last_error).toContain('no handler');
  });
});
