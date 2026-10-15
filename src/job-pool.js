// Parallel job slots with maintenance that runs only between jobs.
//
// A job that needs the browser restarted must not wait for that restart while
// it still holds a slot: the restart cannot start until the slot is free, so
// waiting would deadlock. The job throws { retryAfterMaintenance: true } and
// goes back to the head of the queue. The first such failure is requeued; the
// second is a real rejection, so a marker that never clears cannot spin.

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 5;

function parseConcurrency(env = process.env) {
  const raw = String(env.MAX_CONCURRENT_JOBS ?? '').trim();
  if (!raw) return DEFAULT_CONCURRENCY;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_CONCURRENCY) return parsed;
  console.warn(
    `[job-pool] MAX_CONCURRENT_JOBS="${raw}" is not an integer 1..${MAX_CONCURRENCY} — using ${DEFAULT_CONCURRENCY}`,
  );
  return DEFAULT_CONCURRENCY;
}

function requireInt(name, value, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new TypeError(`${name} must be an integer >= ${min}`);
  }
}

function createJobPool({ concurrency, maxWaiting }) {
  requireInt('concurrency', concurrency, 1);
  requireInt('maxWaiting', maxWaiting, 0);

  let running = 0;
  let limitedWaiting = 0;
  let epoch = 0;
  let jobSeq = 0;
  const waiting = [];
  const slots = Array.from({ length: concurrency }, (_, slotId) => ({
    slotId, busy: false, jobId: null, key: null,
  }));
  const maintenanceQueue = [];
  let activeMaintenance = null;
  // Epoch value after the latest completion of this name. A request whose
  // sinceEpoch is older than that already missed a finished pass.
  const nameDoneEpoch = new Map();

  function keyIsBusy(key) {
    return slots.some((slot) => slot.busy && slot.key === key);
  }

  function takeNextEligible() {
    for (let i = 0; i < waiting.length; i += 1) {
      const job = waiting[i];
      if (job.key != null && keyIsBusy(job.key)) continue;
      waiting.splice(i, 1);
      return job;
    }
    return null;
  }

  function startQueuedJobs() {
    while (running < concurrency) {
      const job = takeNextEligible();
      if (!job) return;
      startJob(job);
    }
  }

  function pump() {
    if (activeMaintenance) return;
    if (maintenanceQueue.length > 0) {
      if (running === 0) beginMaintenance();
      return;
    }
    startQueuedJobs();
  }

  function finishMaintenance(entry) {
    epoch += 1;
    nameDoneEpoch.set(entry.name, epoch);
    activeMaintenance = null;
    pump();
  }

  function beginMaintenance() {
    const entry = maintenanceQueue.shift();
    activeMaintenance = entry;
    if (entry.kind === 'exclusive') {
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        finishMaintenance(entry);
      });
      return;
    }
    Promise.resolve()
      .then(() => entry.fn())
      .then(
        (value) => {
          finishMaintenance(entry);
          entry.resolve({ skipped: false, value });
        },
        (error) => {
          finishMaintenance(entry);
          entry.reject(error);
        },
      );
  }

  function enqueueMaintenance(name, kind, fn) {
    const pending = maintenanceQueue.find((entry) => entry.name === name && entry.kind === kind);
    if (pending) return pending.promise;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    maintenanceQueue.push({ name, kind, fn, resolve, reject, promise });
    pump();
    return promise;
  }

  function requestMaintenance(name, fn, opts = {}) {
    if (Object.prototype.hasOwnProperty.call(opts, 'sinceEpoch') && nameDoneEpoch.has(name) && nameDoneEpoch.get(name) > opts.sinceEpoch) {
      return Promise.resolve({ skipped: true });
    }
    return enqueueMaintenance(name, 'fn', fn);
  }

  function acquireExclusive(name) {
    return enqueueMaintenance(name, 'exclusive', null);
  }

  function settle(job, slot, outcome) {
    slot.busy = false;
    slot.jobId = null;
    slot.key = null;
    running -= 1;
    const error = outcome.ok ? null : outcome.error;
    if (error && error.retryAfterMaintenance === true && job.returned !== true) {
      job.returned = true;
      waiting.unshift(job);
    } else if (outcome.ok) {
      job.resolve(outcome.value);
    } else {
      job.reject(error);
    }
    pump();
  }

  function startJob(job) {
    const slot = slots.find((item) => !item.busy);
    if (!slot) throw new Error('no free slot');
    const jobId = `j${jobSeq += 1}`;
    slot.busy = true;
    slot.jobId = jobId;
    slot.key = job.key;
    running += 1;
    if (job.limited) {
      job.limited = false;
      limitedWaiting -= 1;
    }
    const ctx = { slotId: slot.slotId, jobId, epoch };
    let settled = false;
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      settle(job, slot, { ok: true, value });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      settle(job, slot, { ok: false, error });
    };
    const attempt = Promise.resolve().then(() => job.fn(ctx));
    attempt.then(succeed, fail);
  }

  function submit(fn, { key } = {}) {
    if (limitedWaiting >= maxWaiting) {
      const err = new Error('queue full');
      err.code = 'queue_full';
      throw err;
    }
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    limitedWaiting += 1;
    waiting.push({
      fn,
      key: key == null ? null : key,
      limited: true,
      returned: false,
      resolve,
      reject,
    });
    pump();
    return promise;
  }

  function isFull() {
    return limitedWaiting >= maxWaiting;
  }

  function status() {
    return {
      concurrency,
      running,
      waiting: waiting.length,
      slots: slots.map((slot) => ({
        slotId: slot.slotId,
        busy: slot.busy,
        jobId: slot.jobId,
        key: slot.key,
      })),
      maintenance: {
        active: activeMaintenance ? activeMaintenance.name : null,
        pending: maintenanceQueue.map((entry) => entry.name),
      },
      epoch,
    };
  }

  return { submit, requestMaintenance, acquireExclusive, isFull, status };
}

module.exports = {
  createJobPool, parseConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY,
};
