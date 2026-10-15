// Kills the M2 regressions, independent-review survivors, D1–D7, and all 15 M4 survivors.
// rc=0 only when every fragment is unique, the clean target test is green,
// the mutated tree fails that test, and the original bytes are restored.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

const mutations = [
  {
    id: '1',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'function activeCapture(slot) {\n  return slot.capture;\n}',
    to: 'function activeCapture(slot) {\n  return getSlot(0).capture;\n}',
  },
  {
    id: '2',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'slot.lastConversationFetch = { ...snap, at: Date.now() };',
    to: 'getSlot(0).lastConversationFetch = { ...snap, at: Date.now() };',
  },
  {
    id: '3',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'const victim = slot;',
    to: 'const victim = getSlot(0);',
  },
  {
    id: '4',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'const target = slot;',
    to: 'const target = getSlot(0);',
  },
  {
    id: '5',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: '  if (!opts.exclusive) {',
    to: '  if (false) {',
  },
  {
    id: '6',
    file: 'src/routes/images.js',
    test: 'scripts/test-parallel-routes.js',
    from: 'return submitJob(fn, { key: jobKey });',
    to: 'return submitJob(fn, { key: undefined });',
  },
  {
    id: '7',
    file: 'src/routes/images.js',
    test: 'scripts/test-parallel-routes.js',
    from: '        await turnGate.gate(ctx.slotId);\n        assertNotRateLimited();\n        paced += 1;',
    to: '        await turnGate.gate(ctx.slotId);\n        paced += 1;',
  },
  {
    id: '8',
    file: 'src/chatgpt-tiers.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'const key = strikeKey(mode, slotId);',
    to: 'const key = strikeKey(mode, 0);',
  },
  {
    "id": "I01",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "    acceptSseChunk(slot, streamId, chunk);",
    "to": "    acceptSseChunk(getSlot(1 - slot.id), streamId, chunk);",
    "killedBy": "page SSE bindings deliver chunks to both owning slots"
  },
  {
    "id": "I02",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "        rememberConversation(slot, snap);",
    "to": "        rememberConversation(getSlot(1 - slot.id), snap);",
    "killedBy": "page response listeners keep conversation GETs on both owning slots"
  },
  {
    "id": "I04",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "async function recreatePage(stale) {\n  const slot = slotOf(stale);",
    "to": "async function recreatePage(stale) {\n  const slot = slotOf(stale);\n  resetPage(getSlot(1 - slot.id));",
    "killedBy": "recreating either bound page preserves the neighbouring page and recovery state"
  },
  {
    "id": "I06",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "await runOrDefer('hard-reset', () => hardResetBrowser(), slot, {\n      exclusive: false,",
    "to": "await runOrDefer('hard-reset', () => hardResetBrowser(), slot, {\n      exclusive: true,",
    "killedBy": "hard recovery inside a job requests maintenance before destroying either page"
  },
  {
    "id": "I08",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "    requestMaintenanceNoAwait(name, fn, slot.epoch);\n    const err = new Error(opts.message);",
    "to": "    require('./browser').clearSession();\n    requestMaintenanceNoAwait(name, fn, slot.epoch);\n    const err = new Error(opts.message);",
    "killedBy": "deferred auto-login leaves the shared cookie jar and both pages intact"
  },
  {
    "id": "I09",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "      if (err && err.retryAfterMaintenance) throw err;",
    "to": "      if (err && err.retryAfterMaintenance) delete err.retryAfterMaintenance;",
    "killedBy": "completeText returns a maintenance marker without consuming its retry flag"
  },
  {
    "id": "I10",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "  Promise.resolve(pending).catch((err) => {\n    console.log(`[chatgpt] maintenance ${name} failed: ${err && err.message ? err.message : err}`);\n  });",
    "to": "  Promise.resolve(pending);",
    "killedBy": "rejected background maintenance is observed without unhandled rejection"
  },
  {
    "id": "I11",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "    sessionHealth.invalidate(`login_failed:${err.loginBlocker}`);\n    throw err;\n  } finally {\n    resetAllSlotPages();",
    "to": "    sessionHealth.invalidate(`login_failed:${err.loginBlocker}`);\n    throw err;\n  } finally {\n    resetPage(slot);",
    "killedBy": "failed auto-login maintenance discards both bound slot pages"
  },
  {
    "id": "I14",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "  target.pendingReset = target.recoveryState === 'probation' ? 'hard' : 'page';",
    "to": "  target.pendingReset = getSlot(1 - target.id).recoveryState === 'probation' ? 'hard' : 'page';",
    "killedBy": "degradation uses each bound slot own probation state in both directions"
  },
  {
    "id": "I15",
    "file": "src/routes/images.js",
    "test": "scripts/test-parallel-routes.js",
    "from": "heartbeat: (slotId) => progress.touch(jobIdBySlot.get(slotId)),",
    "to": "heartbeat: (slotId) => progress.touch(),",
    "killedBy": "I15: pacing heartbeats must refresh the job holding the waiting slot"
  },
  {
    "id": "I16",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "liveness.touch(slotOf(p).jobId); // chunk boundary",
    "to": "liveness.touch(); // chunk boundary",
    "killedBy": "adaptive image chunk heartbeat refreshes only the job on its bound slot"
  },
  {
    "id": "I17",
    "file": "src/routes/images.js",
    "test": "scripts/test-parallel-routes.js",
    "from": "        progress.jobRequeued(ctx.jobId);",
    "to": "        void ctx.jobId;",
    "killedBy": "I17: a requeued attempt must not remain a stuck running job"
  },
  {
    "id": "I20",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "      const timing = {};\n      if (typeof options.beforeSubmit === 'function') await options.beforeSubmit();",
    "to": "      const timing = {};",
    "killedBy": "completeText calls beforeSubmit once after thinking capture and main-world preparation"
  },
  {
    "id": "I21",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "      const thinkingMode = normalizeThinkingMode(options.thinkingMode ?? options.thinking);\n      const thinkingState = await setThinkingMode(p, thinkingMode);",
    "to": "      if (typeof options.beforeSubmit === 'function') {\n        await options.beforeSubmit();\n        options = { ...options, beforeSubmit: undefined };\n      }\n      const thinkingMode = normalizeThinkingMode(options.thinkingMode ?? options.thinking);\n      const thinkingState = await setThinkingMode(p, thinkingMode);",
    "killedBy": "completeText calls beforeSubmit once after thinking capture and main-world preparation"
  },
  {
    "id": "I24",
    "file": "src/routes/images.js",
    "test": "scripts/test-parallel-routes.js",
    "from": "    for (let i = 0; i < paced; i += 1) turnGate.finished(ctx.slotId);",
    "to": "    for (let i = 0; i < Math.max(1, paced); i += 1) turnGate.finished(ctx.slotId);",
    "killedBy": "I24: a failed pre-submit turn must not impose a gap on its next slot turn"
  },
  {
    "id": "I27",
    "env": { "LOGIN_TEST_FILTER": "parallel login callers" },
    "file": "src/routes/login.js",
    "test": "scripts/test-parallel-login.js",
    "from": "  if (loginHold) {\n    const attempt = loginHold;",
    "to": "  if (loginHold) {\n    await getPoolHooks().acquireExclusive('manual-login');\n    const attempt = loginHold;",
    "killedBy": "parallel login callers share one pending exclusive and wait before using pages"
  },
  {
    "id": "I28",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "tierAvailability.noteUnavailable(mode, reason, { stickyAfter: strikesNeeded, env, slotId: menuSlot.id });",
    "to": "tierAvailability.noteUnavailable(mode, reason, { stickyAfter: strikesNeeded, env });",
    "killedBy": "tier adapter accumulates unavailable evidence separately for both bound slots"
  },
  {
    "id": "I34",
    "file": "src/routes/login.js",
    "test": "scripts/test-parallel-login.js",
    "from": "    // Session changed: no tab may keep a document from before the login.\n    resetAllSlotPages();",
    "to": "    // Session changed: no tab may keep a document from before the login.\n    void loginPage;",
    "killedBy": "manual login save resets every slot exactly once while the exclusive is held"
  },
  {
    "id": "D1",
    "file": "src/routes/login.js",
    "test": "scripts/test-parallel-login.js",
    "from": "await enterManualLogin({ acquire: false });",
    "to": "await enterManualLogin();",
    "killedBy": "inactive login screenshot returns 409 without acquiring or creating a page"
  },
  {
    "id": "D2",
    "file": "src/routes/login.js",
    "test": "scripts/test-parallel-login.js",
    "from": "    loginHold = attempt;\n    const release = await acquired;",
    "to": "    loginHold = attempt;\n    armLoginIdle();\n    const release = await acquired;",
    "killedBy": "pending login acquisition has no idle deadline and save remains exclusive after ten minutes"
  },
  {
    "id": "D3",
    "file": "src/routes/images.js",
    "test": "scripts/test-parallel-routes.js",
    "from": "if (turnErr && turnErr.retryAfterMaintenance && i === 0 && out.length === 0) throw turnErr;",
    "to": "if (turnErr && turnErr.retryAfterMaintenance) throw turnErr;",
    "killedBy": "D3: a later image maintenance marker must preserve the completed prefix"
  },
  {
    "id": "D4",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-watchdog.js",
    "from": "    if (e && e === recordedLoginError && e.loginRecorded) throw e;",
    "to": "    if (e && e.code === 'login_failed' && e.loginBlocker) throw e;",
    "killedBy": "D4: diagnosed failure must be wrapped"
  },
  {
    "id": "D4-double-record",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-watchdog.js",
    "from": "    if (e && e === recordedLoginError && e.loginRecorded) throw e;",
    "to": "    // Post-login errors are incorrectly recorded a second time.",
    "killedBy": "post-login failure is recorded exactly once"
  },
  {
    "id": "D5",
    "file": "src/routes/images.js",
    "test": "scripts/test-parallel-routes.js",
    "from": "progress.touch(ctx.jobId); // per-image heartbeat",
    "to": "progress.touch(); // per-image heartbeat",
    "killedBy": "D5: completed images must refresh the running batch liveness"
  },
  {
    "id": "D6",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-watchdog.js",
    "from": "      if (hasExclusive) release = await hooks.acquireExclusive('watchdog');",
    "to": "      // Probe without the pool exclusive.",
    "killedBy": "D6: a job must wait for watchdog exclusive"
  },
  {
    "id": "D6-busy",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-watchdog.js",
    "from": "  if ((!force || hasExclusive) && !poolIsIdle()) {",
    "to": "  if (!force && !poolIsIdle()) {",
    "killedBy": "forced watchdog skips a busy pool before acquiring"
  },
  {
    "id": "D6-release",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-watchdog.js",
    "from": "      if (typeof release === 'function') release();",
    "to": "      // Forget to release the watchdog exclusive.",
    "killedBy": "D6: completed watchdog must release exclusive"
  },
  {
    "id": "D7",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-watchdog.js",
    "from": "        markSessionDegraded('session probe lease timeout', slotOf(watchedPage));\n        closeWedgedPage(watchedPage);",
    "to": "        markSessionDegraded('session probe lease timeout', slot);\n        closeWedgedPage(slot.page);",
    "killedBy": "D7: close the page leased by watchdog"
  },
  // Exact N-series replacements from docs/specs/parallel-tabs-m3-mut-report.md.
  {
    "id": "N02",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-slots.js",
    "from": "  victim.lastConversationFetch = null;",
    "to": "  void victim.lastConversationFetch;",
    "killedBy": "N02: reset must discard the old conversation GET"
  },
  {
    "id": "N04",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-slots.js",
    "from": "    slot.staleStreams = new Set();",
    "to": "    void slot.staleStreams;",
    "killedBy": "N04: global reset must forget stale streams"
  },
  {
    "id": "N06",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-slots.js",
    "from": "  victim.pagePromise = null;",
    "to": "  victim.pagePromise = null;\n  getSlot(1 - victim.id).pendingReset = null;",
    "killedBy": "N06: local reset must preserve the neighbour pending reset"
  },
  {
    "id": "N07",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "if (cap && cap.boundStream) slot.staleStreams.add(cap.boundStream);",
    "to": "if (cap && cap.boundStream) getSlot(1 - slot.id).staleStreams.add(cap.boundStream);",
    "killedBy": "N07: completed stream must be stale on its owner"
  },
  {
    "id": "N08",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-slots.js",
    "from": "  for (const slot of slotsById.values()) {\n    discardSlotPage(slot);",
    "to": "  for (const slot of slotsById.values()) {\n    if (!slot.page) continue;\n    discardSlotPage(slot);",
    "killedBy": "N08: global reset must clear recovery on a page-less slot"
  },
  {
    "id": "N09",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "return await autoLoginMaintenance(slot, 'out');\n  } finally {\n    resetAllSlotPages();",
    "to": "return await autoLoginMaintenance(slot, 'out');\n  } finally {\n    void slot;",
    "killedBy": "N09: context rebuild must discard its newly probed page"
  },
  {
    "id": "N10",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-watchdog.js",
    "from": "    throw err;\n  } finally {\n    resetAllSlotPages();\n  }\n}\n\n// ==== Traffic-independent",
    "to": "    throw err;\n  } finally {\n    if (!recordedLoginError) resetAllSlotPages();\n  }\n}\n\n// ==== Traffic-independent",
    "killedBy": "N10: failed post-login check must discard its fresh page"
  },
  {
    "id": "N11",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "  resetAllSlotPages();\n  await closeBrowser().catch(() => {});",
    "to": "  await closeBrowser().catch(() => {});\n  resetAllSlotPages();",
    "killedBy": "N11: pages must be detached while browser close is pending"
  },
  {
    "id": "N15",
    "file": "src/job-pool.js",
    "test": "scripts/test-job-pool.js",
    "from": "entry.name === name && entry.kind === kind",
    "to": "entry.kind === kind",
    "killedBy": "N15: differently named maintenance must not merge"
  },
  {
    "id": "N19",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-watchdog.js",
    "from": "      if (hasExclusive) release = await hooks.acquireExclusive('watchdog');",
    "to": "      if (hasExclusive) { await Promise.resolve(); release = await hooks.acquireExclusive('watchdog'); }",
    "killedBy": "N19: no microtask gap is allowed between idle check and exclusive acquisition"
  },
  {
    "id": "N21",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-watchdog.js",
    "from": "  sessionProbeInFlight = probe;",
    "to": "  sessionProbeInFlight = probe.then(state => state);",
    "killedBy": "N21: completed watchdog lease must be cleared"
  },
  {
    "id": "N32",
    "file": "src/routes/login.js",
    "test": "scripts/test-parallel-login.js",
    "from": "saveChain = run.then(() => {}, () => {});",
    "to": "saveChain = run;",
    "killedBy": "N32: a rejected save chain must allow the next save to acquire"
  },
  {
    "id": "N36",
    "file": "src/chatgpt.js",
    "test": "scripts/test-parallel-adapter.js",
    "from": "      const timing = {};\n      if (typeof options.beforeSubmit === 'function') await options.beforeSubmit();",
    "to": "      const timing = {};\n      if (typeof options.beforeSubmit === 'function') { await options.beforeSubmit(); await options.beforeSubmit(); }",
    "killedBy": "N36: successful beforeSubmit must not reserve pacing twice"
  },
  {
    "id": "N37",
    "file": "src/routes/images.js",
    "test": "scripts/test-parallel-routes.js",
    "from": "for (let i = 0; i < paced; i += 1) turnGate.finished(ctx.slotId);",
    "to": "for (let i = 0; i < paced; i += 1) turnGate.finished((ctx.slotId + 1) % pool.status().concurrency);",
    "killedBy": "N37: a completed turn must pace its own slot, not its neighbour"
  },
  {
    "id": "N43",
    "file": "src/routes/images.js",
    "test": "scripts/test-parallel-routes.js",
    "from": "      progress.jobFinished(classifyError(err && err.message, err && err.code), ctx.jobId);",
    "to": "      progress.jobFinished(null, ctx.jobId);",
    "killedBy": "N43: submitJob must classify infrastructure failures in jobFinished"
  }
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function runTest(rel, env = {}) {
  return spawnSync(process.execPath, [path.join(root, rel)], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
}

let failed = 0;

for (const mutation of mutations) {
  const filePath = path.join(root, mutation.file);
  const original = fs.readFileSync(filePath);
  const hash = sha256(original);
  const restore = () => {
    fs.writeFileSync(filePath, original);
    const after = sha256(fs.readFileSync(filePath));
    if (after !== hash) {
      console.error(`${mutation.id}: sha256 mismatch after rollback: ${after} !== ${hash}`);
      process.exit(1);
    }
  };

  const clean = runTest(mutation.test, mutation.env);
  if (clean.status !== 0) {
    console.error(`${mutation.id}: clean run failed`);
    console.error(clean.stdout);
    console.error(clean.stderr);
    process.exit(1);
  }

  const text = original.toString('utf8');
  const count = text.split(mutation.from).length - 1;
  if (count !== 1) {
    console.error(`${mutation.id}: выжил — fragment occurs ${count} times`);
    failed += 1;
    continue;
  }

  fs.writeFileSync(filePath, text.replace(mutation.from, mutation.to));
  try {
    const result = runTest(mutation.test, mutation.env);
    const timedOut = result.error && result.error.code === 'ETIMEDOUT';
    if (timedOut || result.status === 0) {
      console.error(`${mutation.id}: выжил${timedOut ? ' (timeout)' : ''}`);
      if (result.stdout) console.error(result.stdout);
      if (result.stderr) console.error(result.stderr);
      failed += 1;
    } else if (result.status !== 1 || !/AssertionError|ERR_ASSERTION/.test(result.stderr) ||
        (mutation.killedBy && !result.stderr.includes(mutation.killedBy))) {
      console.error(`${mutation.id}: invalid kill — expected its own behavioral assertion`);
      console.error(result.stdout);
      console.error(result.stderr);
      failed += 1;
    } else {
      console.log(`${mutation.id}: убит (behavioral assertion)`);
    }
  } finally {
    restore();
  }
}

if (failed) {
  console.error(`${failed} mutation(s) survived`);
  process.exit(1);
}
console.log(`all ${mutations.length} mutations killed`);
