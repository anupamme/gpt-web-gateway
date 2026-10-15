// Shared health/progress state — breaks the require-cycle between the Express layer
// (server.js /health, routes queue) and the Playwright layer (chatgpt.js polling loops).
//
// Two independent stuck detectors feed /health/live (k8s liveness → automatic pod
// restart instead of the manual restarts that cured the 2026-07-10 incidents):
//   1. Event-loop / browser hang: nothing touched progress for HEALTH_STUCK_SEC while
//      work is queued. Polling loops touch on every successful page poll, so this only
//      fires when a Playwright call is wedged for the whole window.
//   2. Failure streak: N consecutive jobs finished with an INFRA error (timeout /
//      page_load_failed / upload_failed) — the degraded-session signature (stuck pill,
//      hidden send button). Refusals / rate limits / policy are healthy failures and
//      reset the streak like successes do.
//
// `now` is injectable for fake-clock tests.

const HEALTH_STUCK_MS = (parseInt(process.env.HEALTH_STUCK_SEC, 10) || 900) * 1000;
const HEALTH_FAILURE_STREAK = parseInt(process.env.HEALTH_FAILURE_STREAK, 10) || 3;

// Error kinds that indicate a broken browser session rather than a "healthy" failure.
const INFRA_ERROR_KINDS = new Set(['timeout', 'page_load_failed', 'upload_failed', 'server_error']);

function createProgress(now = Date.now) {
  const state = {
    queueSize: 0,
    lastProgressAt: now(),
    consecutiveInfraFailures: 0,
    // Separate streak for PARTIAL batches whose tail turns died with infra errors: the
    // job itself resolves successfully (jobFinished(null) resets the main streak), so
    // these are tracked independently and cleared only by an explicitly-full success.
    partialInfraStreak: 0,
  };
  // Per running job. The shared lastProgressAt stays fresh when a neighbor polls,
  // which would hide one wedged slot. Each job keeps its own stamp.
  const runningJobs = new Map();

  function oldestJobMs() {
    let oldest = null;
    for (const at of runningJobs.values()) {
      const ms = now() - at;
      if (oldest === null || ms > oldest) oldest = ms;
    }
    return oldest;
  }

  return {
    // Any observable liveness: job start/finish, successful page poll, per-image turn.
    // With a jobId, also refreshes that running job. Unknown ids do not create one.
    touch(jobId) {
      state.lastProgressAt = now();
      if (jobId !== undefined && runningJobs.has(jobId)) runningJobs.set(jobId, now());
    },
    jobStarted() { state.queueSize++; state.lastProgressAt = now(); },
    // The job actually holds a slot now, as opposed to merely sitting in the queue.
    jobRunning(jobId) {
      runningJobs.set(jobId, now());
      state.lastProgressAt = now();
    },
    // Head-of-queue return: the job is no longer running, but it is not done.
    // queueSize and the infra streaks stay as they were.
    jobRequeued(jobId) {
      runningJobs.delete(jobId);
    },
    jobFinished(errorKind = null, jobId) {
      state.queueSize = Math.max(0, state.queueSize - 1);
      state.lastProgressAt = now();
      if (jobId !== undefined) runningJobs.delete(jobId);
      if (errorKind === null) {
        state.consecutiveInfraFailures = 0;
      } else if (INFRA_ERROR_KINDS.has(errorKind)) {
        state.consecutiveInfraFailures++;
      } else {
        state.consecutiveInfraFailures = 0; // refused / rate_limit / policy — session is alive
      }
    },
    // Partial-batch hooks (Codex result-review): a batch that returned SOME images
    // resolves as a successful job (main streak reset by jobFinished(null)), but its
    // failed tail turns still carry the degradation signature — tracked separately.
    // clearPartialInfra() is called by routes on any FULL success.
    recordInfraFailure(kind) {
      if (INFRA_ERROR_KINDS.has(kind)) state.partialInfraStreak++;
    },
    clearPartialInfra() { state.partialInfraStreak = 0; },
    snapshot() {
      return {
        queue_size: state.queueSize,
        ms_since_progress: now() - state.lastProgressAt,
        consecutive_infra_failures: state.consecutiveInfraFailures,
        partial_infra_streak: state.partialInfraStreak,
        running_jobs: runningJobs.size,
        oldest_job_ms_since_progress: oldestJobMs(),
      };
    },
    // Liveness verdict. { alive, reason }
    liveness() {
      const msSince = now() - state.lastProgressAt;
      // One wedged tab must fail before the shared queue does. A neighbor's
      // poll keeps lastProgressAt fresh, and a finish without an id refreshes
      // it too — neither of those clears a stuck job.
      for (const [id, at] of runningJobs) {
        const jobMs = now() - at;
        if (jobMs > HEALTH_STUCK_MS) {
          return { alive: false, reason: `job ${id} no progress for ${Math.round(jobMs / 1000)}s` };
        }
      }
      if (state.queueSize > 0 && msSince > HEALTH_STUCK_MS) {
        return { alive: false, reason: `queued work but no progress for ${Math.round(msSince / 1000)}s` };
      }
      if (state.consecutiveInfraFailures >= HEALTH_FAILURE_STREAK) {
        return { alive: false, reason: `${state.consecutiveInfraFailures} consecutive infra failures` };
      }
      if (state.partialInfraStreak >= HEALTH_FAILURE_STREAK) {
        return { alive: false, reason: `${state.partialInfraStreak} consecutive partial batches with infra failures` };
      }
      return { alive: true, reason: 'ok' };
    },
  };
}

// Process-wide singleton used by server.js / routes / chatgpt.js.
const progress = createProgress();

module.exports = { progress, createProgress, INFRA_ERROR_KINDS, HEALTH_STUCK_MS, HEALTH_FAILURE_STREAK };
