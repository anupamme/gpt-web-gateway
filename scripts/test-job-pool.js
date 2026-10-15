// Behavioral tests for src/job-pool.js — concurrency, keys, maintenance, retry.
const assert = require('assert');
const { createJobPool, parseConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } = require('../src/job-pool');

let passed = 0;
const tests = [];
const add = (name, fn) => tests.push([name, fn]);

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

add('createJobPool rejects a bad concurrency or maxWaiting', () => {
  assert.throws(() => createJobPool({ concurrency: 0, maxWaiting: 1 }), TypeError);
  assert.throws(() => createJobPool({ concurrency: 1.5, maxWaiting: 1 }), TypeError);
  assert.throws(() => createJobPool({ concurrency: -1, maxWaiting: 1 }), TypeError);
  assert.throws(() => createJobPool({ concurrency: '2', maxWaiting: 1 }), TypeError);
  assert.throws(() => createJobPool({ concurrency: 1, maxWaiting: -1 }), TypeError);
  assert.throws(() => createJobPool({ concurrency: 1, maxWaiting: 1.5 }), TypeError);
  assert.doesNotThrow(() => createJobPool({ concurrency: 1, maxWaiting: 0 }));
});

add('parseConcurrency reads MAX_CONCURRENT_JOBS', () => {
  assert.strictEqual(DEFAULT_CONCURRENCY, 3);
  assert.strictEqual(MAX_CONCURRENCY, 5);
  assert.strictEqual(parseConcurrency({}), 3);
  assert.strictEqual(parseConcurrency({ MAX_CONCURRENT_JOBS: '' }), 3);
  assert.strictEqual(parseConcurrency({ MAX_CONCURRENT_JOBS: '1' }), 1);
  assert.strictEqual(parseConcurrency({ MAX_CONCURRENT_JOBS: '5' }), 5);
  const warned = [];
  const real = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    assert.strictEqual(parseConcurrency({ MAX_CONCURRENT_JOBS: '0' }), 3);
    assert.strictEqual(parseConcurrency({ MAX_CONCURRENT_JOBS: '6' }), 3);
    assert.strictEqual(parseConcurrency({ MAX_CONCURRENT_JOBS: 'soon' }), 3);
    assert.strictEqual(parseConcurrency({ MAX_CONCURRENT_JOBS: '2.5' }), 3);
  } finally {
    console.warn = real;
  }
  assert.strictEqual(warned.length, 4);
});

add('the fourth job waits until one of three running jobs settles', async () => {
  const pool = createJobPool({ concurrency: 3, maxWaiting: 10 });
  const releases = [];
  let started = 0;
  const slotIds = [];
  const jobs = [];
  for (let i = 0; i < 4; i++) {
    jobs.push(pool.submit(async ({ slotId }) => {
      started += 1;
      slotIds.push(slotId);
      await new Promise((resolve) => releases.push(resolve));
    }));
  }
  await flush();
  assert.strictEqual(started, 3);
  assert.strictEqual(pool.status().running, 3);
  assert.strictEqual(pool.status().waiting, 1);
  assert.strictEqual(new Set(slotIds).size, 3);
  for (const slotId of slotIds) assert.ok(slotId >= 0 && slotId < 3, `slot ${slotId}`);
  releases[0]();
  await flush();
  assert.strictEqual(started, 4);
  assert.strictEqual(pool.status().running, 3);
  assert.strictEqual(pool.status().waiting, 0);
  releases.slice(1).forEach((release) => release());
  await Promise.all(jobs);
});

add('jobs start in submission order', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 10 });
  const order = [];
  const releases = [];
  const jobs = ['a', 'b', 'c'].map((id) => pool.submit(async () => {
    order.push(id);
    await new Promise((resolve) => releases.push(resolve));
  }));
  await flush();
  assert.deepStrictEqual(order, ['a']);
  releases[0]();
  await flush();
  assert.deepStrictEqual(order, ['a', 'b']);
  releases[1]();
  await flush();
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
  releases[2]();
  await Promise.all(jobs);
});

add('a key runs one at a time and does not block other keys', async () => {
  const pool = createJobPool({ concurrency: 2, maxWaiting: 10 });
  const events = [];
  let releaseA1;
  const a1 = pool.submit(async () => {
    events.push('a1');
    await new Promise((resolve) => { releaseA1 = resolve; });
  }, { key: 'a' });
  await flush();
  const a2 = pool.submit(async () => { events.push('a2'); }, { key: 'a' });
  const b = pool.submit(async () => { events.push('b'); }, { key: 'b' });
  await flush();
  assert.deepStrictEqual(events, ['a1', 'b']);
  assert.strictEqual(pool.status().waiting, 1);
  releaseA1();
  await Promise.all([a1, a2, b]);
  assert.deepStrictEqual(events, ['a1', 'b', 'a2']);
});

add('a job without a key is not blocked by a keyed job', async () => {
  const pool = createJobPool({ concurrency: 2, maxWaiting: 5 });
  let release;
  const events = [];
  const keyed = pool.submit(async () => {
    events.push('k');
    await new Promise((resolve) => { release = resolve; });
  }, { key: 'a' });
  await flush();
  const free = pool.submit(async () => { events.push('f'); });
  await flush();
  assert.deepStrictEqual(events, ['k', 'f']);
  release();
  await Promise.all([keyed, free]);
});

add('submit throws queue_full synchronously when maxWaiting is reached', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 1 });
  let release;
  const running = pool.submit(() => new Promise((resolve) => { release = resolve; }));
  await flush();
  const queued = pool.submit(async () => 'queued');
  assert.strictEqual(pool.isFull(), true);
  let thrown = null;
  try {
    const extra = pool.submit(async () => 'overflow');
    extra.catch(() => {});
    thrown = 'no-throw';
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, 'queue_full must be thrown, not returned');
  assert.strictEqual(thrown.code, 'queue_full');
  release();
  await running;
  await queued;
});

add('a slot stays busy until fn resolves', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 2 });
  let release;
  let sawRunning = null;
  const job = pool.submit(() => new Promise((resolve) => {
    sawRunning = pool.status().running;
    release = resolve;
  }));
  await flush();
  assert.strictEqual(sawRunning, 1);
  assert.strictEqual(pool.status().running, 1);
  assert.strictEqual(pool.status().slots[0].busy, true);
  let settled = false;
  job.then(() => { settled = true; });
  await flush();
  assert.strictEqual(settled, false);
  release('ok');
  assert.strictEqual(await job, 'ok');
  assert.strictEqual(pool.status().running, 0);
  assert.strictEqual(pool.status().slots[0].busy, false);
  assert.strictEqual(pool.status().slots[0].jobId, null);
});

add('a slot stays busy until fn rejects', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 2 });
  let rejectJob;
  const job = pool.submit(() => new Promise((_, reject) => { rejectJob = reject; }));
  await flush();
  assert.strictEqual(pool.status().running, 1);
  assert.strictEqual(pool.status().slots[0].busy, true);
  const err = new Error('nope');
  rejectJob(err);
  const caught = await job.then(() => null, (error) => error);
  assert.strictEqual(caught, err);
  assert.strictEqual(pool.status().running, 0);
  assert.strictEqual(pool.status().slots[0].busy, false);
});

add('maintenance waits until running jobs drain and blocks new starts', async () => {
  const pool = createJobPool({ concurrency: 2, maxWaiting: 10 });
  let releaseA;
  let maintStarted = false;
  let bStarted = false;
  const a = pool.submit(async () => {
    await new Promise((resolve) => { releaseA = resolve; });
  });
  await flush();
  const maint = pool.requestMaintenance('reset', async () => { maintStarted = true; return 'done'; });
  const b = pool.submit(async () => { bStarted = true; });
  await flush();
  assert.strictEqual(maintStarted, false);
  assert.strictEqual(bStarted, false);
  assert.strictEqual(pool.status().running, 1);
  assert.deepStrictEqual(pool.status().maintenance.pending, ['reset']);
  assert.strictEqual(pool.status().maintenance.active, null);
  releaseA();
  assert.deepStrictEqual(await maint, { skipped: false, value: 'done' });
  await b;
  await a;
  assert.strictEqual(maintStarted, true);
  assert.strictEqual(bStarted, true);
  assert.strictEqual(pool.status().maintenance.active, null);
});

add('same-name maintenance merges only while it is waiting to start', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 5 });
  let release;
  const blocker = pool.submit(() => new Promise((resolve) => { release = resolve; }));
  await flush();
  let calls = 0;
  const first = pool.requestMaintenance('reset', async () => {
    calls += 1;
    return 'one';
  });
  const second = pool.requestMaintenance('reset', async () => {
    calls += 1;
    return 'two';
  });
  assert.strictEqual(first, second);
  release();
  await blocker;
  assert.deepStrictEqual(await first, { skipped: false, value: 'one' });
  assert.strictEqual(calls, 1);
  const third = pool.requestMaintenance('reset', async () => {
    calls += 1;
    return 'three';
  });
  assert.notStrictEqual(third, first);
  assert.deepStrictEqual(await third, { skipped: false, value: 'three' });
  assert.strictEqual(calls, 2);
});

add('sinceEpoch skips a maintenance that already completed after that epoch', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 5 });
  assert.deepStrictEqual(await pool.requestMaintenance('reset', async () => 'first'), {
    skipped: false, value: 'first',
  });
  assert.strictEqual(pool.status().epoch, 1);
  let calls = 0;
  const skipped = await pool.requestMaintenance('reset', async () => {
    calls += 1;
    return 'second';
  }, { sinceEpoch: 0 });
  assert.deepStrictEqual(skipped, { skipped: true });
  assert.strictEqual(calls, 0);
  assert.strictEqual(pool.status().epoch, 1);
  const again = await pool.requestMaintenance('reset', async () => {
    calls += 1;
    return 'third';
  }, { sinceEpoch: 1 });
  assert.deepStrictEqual(again, { skipped: false, value: 'third' });
  assert.strictEqual(calls, 1);
  const other = await pool.requestMaintenance('login', async () => 'in', { sinceEpoch: 0 });
  assert.deepStrictEqual(other, { skipped: false, value: 'in' });
});

add('a maintenance failure rejects only that call and the pool keeps running', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 5 });
  const failed = pool.requestMaintenance('reset', async () => { throw new Error('boom'); });
  const caught = await failed.then(() => null, (error) => error);
  assert.strictEqual(caught.message, 'boom');
  assert.strictEqual(pool.status().epoch, 1);
  assert.strictEqual(await withTimeout(pool.submit(async () => 'ok'), 1000, 'after failed maintenance'), 'ok');
  assert.deepStrictEqual(
    await pool.requestMaintenance('next', async () => 'after'),
    { skipped: false, value: 'after' },
  );
});

add('retryAfterMaintenance returns the job to the head exactly once', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 10 });
  const order = [];
  const a = pool.submit(async ({ epoch }) => {
    order.push(`a-${epoch}`);
    if (epoch === 0) {
      pool.requestMaintenance('reset', async () => { order.push('maint'); });
      const err = new Error('once');
      err.retryAfterMaintenance = true;
      throw err;
    }
    return 'a';
  });
  const b = pool.submit(async ({ epoch }) => {
    order.push(`b-${epoch}`);
    return 'b';
  });
  assert.deepStrictEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepStrictEqual(order, ['a-0', 'maint', 'a-1', 'b-1']);
});

add('a second retryAfterMaintenance rejects the job', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 10 });
  let starts = 0;
  const job = pool.submit(async () => {
    starts += 1;
    if (starts > 2) return 'kept-going';
    pool.requestMaintenance('reset', async () => {});
    const err = new Error(`try-${starts}`);
    err.retryAfterMaintenance = true;
    throw err;
  });
  const outcome = await job.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.error.message, 'try-2');
  assert.strictEqual(starts, 2);
});

add('a requeued job does not count against maxWaiting', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 1 });
  let releaseJob;
  let releaseMaint;
  const a = pool.submit(async () => {
    if (!releaseJob) {
      await new Promise((resolve) => { releaseJob = resolve; });
      pool.requestMaintenance('reset', () => new Promise((resolve) => { releaseMaint = resolve; }));
      const err = new Error('again');
      err.retryAfterMaintenance = true;
      throw err;
    }
    return 'a';
  });
  await flush();
  releaseJob();
  await flush();
  assert.strictEqual(pool.status().maintenance.active, 'reset');
  assert.strictEqual(pool.status().waiting, 1);
  assert.strictEqual(pool.isFull(), false);
  const b = pool.submit(async () => 'b');
  assert.strictEqual(pool.isFull(), true);
  releaseMaint();
  assert.deepStrictEqual(await Promise.all([a, b]), ['a', 'b']);
});

add('a retry marker without maintenance does not wait forever', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 2 });
  const seen = [];
  const job = pool.submit(async ({ epoch }) => {
    seen.push(epoch);
    if (seen.length === 1) {
      const err = new Error('again');
      err.retryAfterMaintenance = true;
      throw err;
    }
    return 'done';
  });
  const other = pool.submit(async () => 'other');
  assert.strictEqual(await withTimeout(job, 1000, 'unheld retry'), 'done');
  assert.strictEqual(await withTimeout(other, 1000, 'after unheld retry'), 'other');
  assert.deepStrictEqual(seen, [0, 0]);
});

add('a retry marker with maintenance waits until the epoch grows', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 5 });
  const seen = [];
  let releaseJob;
  let releaseMaint;
  const job = pool.submit(async ({ epoch }) => {
    seen.push(epoch);
    if (seen.length === 1) {
      await new Promise((resolve) => { releaseJob = resolve; });
      pool.requestMaintenance('reset', () => new Promise((resolve) => { releaseMaint = resolve; }));
      const err = new Error('later');
      err.retryAfterMaintenance = true;
      throw err;
    }
    return 'done';
  });
  const other = pool.submit(async () => 'other');
  await flush();
  releaseJob();
  await flush();
  assert.deepStrictEqual(seen, [0]);
  assert.strictEqual(pool.status().maintenance.active, 'reset');
  let otherDone = false;
  other.then(() => { otherDone = true; });
  await flush();
  assert.strictEqual(otherDone, false);
  assert.deepStrictEqual(seen, [0]);
  releaseMaint();
  assert.deepStrictEqual(
    await withTimeout(Promise.all([job, other]), 1000, 'held retry'),
    ['done', 'other'],
  );
  assert.deepStrictEqual(seen, [0, 1]);
});

add('a later job of the same conversation does not pass a retry', async () => {
  const pool = createJobPool({ concurrency: 2, maxWaiting: 5 });
  const order = [];
  let release;
  const a1 = pool.submit(async () => {
    if (!order.includes('a1')) {
      order.push('a1');
      await new Promise((resolve) => { release = resolve; });
      const err = new Error('again');
      err.retryAfterMaintenance = true;
      throw err;
    }
    order.push('a1-retry');
  }, { key: 'conv' });
  await flush();
  const a2 = pool.submit(async () => { order.push('a2'); }, { key: 'conv' });
  const b = pool.submit(async () => { order.push('b'); });
  await flush();
  assert.deepStrictEqual(order, ['a1', 'b']);
  release();
  await withTimeout(Promise.all([a1, a2, b]), 1000, 'same key');
  assert.deepStrictEqual(order, ['a1', 'b', 'a1-retry', 'a2']);
});

add('maxWaiting 0 admits a job that can start immediately', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 0 });
  assert.strictEqual(pool.isFull(), false);
  let release;
  const first = pool.submit(() => new Promise((resolve) => { release = resolve; }));
  await flush();
  assert.strictEqual(pool.status().running, 1);
  assert.strictEqual(pool.isFull(), true);
  assert.throws(() => pool.submit(async () => 'no'), (err) => err && err.code === 'queue_full');
  release();
  await first;
  assert.strictEqual(pool.isFull(), false);
  assert.strictEqual(await pool.submit(async () => 'yes'), 'yes');
});

add('maxWaiting 0 refuses while maintenance is active', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 0 });
  const hold = pool.acquireExclusive('login');
  await flush();
  const releaseHold = await hold;
  assert.strictEqual(pool.isFull(), true);
  assert.throws(() => pool.submit(async () => 'no'), (err) => err && err.code === 'queue_full');
  releaseHold();
  await flush();
  assert.strictEqual(pool.isFull(), false);
});

add('two pending exclusives behind a job do not merge', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 5 });
  let release;
  const blocker = pool.submit(() => new Promise((resolve) => { release = resolve; }));
  await flush();
  const first = pool.acquireExclusive('login');
  const second = pool.acquireExclusive('login');
  assert.notStrictEqual(first, second);
  assert.deepStrictEqual(pool.status().maintenance.pending, ['login', 'login']);
  release();
  await blocker;
  const release1 = await first;
  release1();
  const release2 = await second;
  release2();
  assert.strictEqual(pool.status().epoch, 2);
});

add('two waiters of a busy key stay in submission order', async () => {
  const pool = createJobPool({ concurrency: 2, maxWaiting: 5 });
  const order = [];
  let release;
  const a1 = pool.submit(async () => {
    order.push('a1');
    await new Promise((resolve) => { release = resolve; });
  }, { key: 'a' });
  await flush();
  const a2 = pool.submit(async () => { order.push('a2'); }, { key: 'a' });
  const a3 = pool.submit(async () => { order.push('a3'); }, { key: 'a' });
  release();
  await Promise.all([a1, a2, a3]);
  assert.deepStrictEqual(order, ['a1', 'a2', 'a3']);
});

add('issued slotId is the slot status reports as busy', async () => {
  const pool = createJobPool({ concurrency: 2, maxWaiting: 5 });
  const seen = [];
  const releases = [];
  const jobs = [0, 1].map(() => pool.submit(async (ctx) => {
    seen.push(ctx);
    await new Promise((resolve) => releases.push(resolve));
  }));
  await flush();
  assert.strictEqual(seen.length, 2);
  for (const ctx of seen) {
    const slot = pool.status().slots.find((item) => item.jobId === ctx.jobId);
    assert.ok(slot, ctx.jobId);
    assert.strictEqual(ctx.slotId, slot.slotId);
  }
  releases.forEach((release) => release());
  await Promise.all(jobs);
});

add('two acquireExclusive calls do not share a release', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 5 });
  const firstP = pool.acquireExclusive('login');
  const secondP = pool.acquireExclusive('login');
  assert.notStrictEqual(firstP, secondP);
  const release1 = await firstP;
  let secondStarted = false;
  const secondWait = secondP.then((release) => {
    secondStarted = true;
    return release;
  });
  await flush();
  assert.strictEqual(secondStarted, false);
  assert.strictEqual(pool.status().maintenance.active, 'login');
  release1();
  const release2 = await secondWait;
  assert.notStrictEqual(release1, release2);
  let started = false;
  const job = pool.submit(async () => { started = true; return 'job'; });
  await flush();
  assert.strictEqual(started, false);
  assert.strictEqual(pool.status().epoch, 1);
  release2();
  assert.strictEqual(await job, 'job');
  assert.strictEqual(pool.status().epoch, 2);
});

add('acquireExclusive holds the pool until release and a second release is a no-op', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 5 });
  const order = [];
  const first = pool.requestMaintenance('a', async () => { order.push('a'); });
  const hold = pool.acquireExclusive('login');
  const third = pool.requestMaintenance('c', async () => { order.push('c'); });
  await first;
  const release = await hold;
  assert.deepStrictEqual(order, ['a']);
  assert.strictEqual(pool.status().maintenance.active, 'login');
  assert.strictEqual(pool.status().epoch, 1);
  let started = false;
  const job = pool.submit(async () => { started = true; return 'job'; });
  await flush();
  assert.strictEqual(started, false);
  release();
  release();
  assert.strictEqual(await third.then(() => pool.status().epoch), 3);
  assert.strictEqual(await job, 'job');
  assert.strictEqual(started, true);
  assert.strictEqual(pool.status().epoch, 3);
  assert.strictEqual(pool.status().maintenance.active, null);
});

add('requestMaintenance from a running job does not deadlock', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 5 });
  let release;
  let maintRan = false;
  let maintPromise;
  const job = pool.submit(async () => {
    maintPromise = pool.requestMaintenance('reset', async () => {
      maintRan = true;
      return 'fixed';
    });
    await new Promise((resolve) => { release = resolve; });
    return 'done';
  });
  await flush();
  assert.strictEqual(maintRan, false);
  assert.strictEqual(pool.status().running, 1);
  const result = await withTimeout((async () => {
    release();
    return {
      value: await job,
      maint: await maintPromise,
      maintRan,
    };
  })(), 1000, 'maintenance from job');
  assert.strictEqual(result.value, 'done');
  assert.deepStrictEqual(result.maint, { skipped: false, value: 'fixed' });
  assert.strictEqual(result.maintRan, true);
});

add('status reports slots, the job id and the epoch seen by the job', async () => {
  const pool = createJobPool({ concurrency: 1, maxWaiting: 1 });
  let release;
  let seen = null;
  const job = pool.submit(async ({ slotId, jobId, epoch }) => {
    seen = { slotId, jobId, epoch };
    await new Promise((resolve) => { release = resolve; });
    return jobId;
  }, { key: 'k' });
  await flush();
  const status = pool.status();
  assert.strictEqual(status.concurrency, 1);
  assert.strictEqual(status.running, 1);
  assert.strictEqual(status.waiting, 0);
  assert.strictEqual(status.epoch, 0);
  assert.strictEqual(status.maintenance.active, null);
  assert.deepStrictEqual(status.maintenance.pending, []);
  assert.strictEqual(status.slots.length, 1);
  assert.strictEqual(status.slots[0].slotId, 0);
  assert.strictEqual(status.slots[0].busy, true);
  assert.strictEqual(status.slots[0].key, 'k');
  assert.strictEqual(status.slots[0].jobId, seen.jobId);
  assert.strictEqual(seen.slotId, 0);
  assert.strictEqual(seen.epoch, 0);
  assert.strictEqual(typeof seen.jobId, 'string');
  release();
  assert.strictEqual(await job, seen.jobId);
  await pool.requestMaintenance('reset', async () => {});
  let nextEpoch = null;
  let nextId = null;
  await pool.submit(async ({ jobId, epoch }) => {
    nextEpoch = epoch;
    nextId = jobId;
  });
  assert.strictEqual(nextEpoch, 1);
  assert.notStrictEqual(nextId, seen.jobId);
});

let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.error('runner stopped before every test finished');
    process.exit(1);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`FAIL: ${name} — ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  finished = true;
  process.exit(passed === tests.length ? 0 : 1);
})();
