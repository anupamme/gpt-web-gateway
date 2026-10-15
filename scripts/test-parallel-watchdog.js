// Maintenance and watchdog contracts, with fake browser boundaries only.
const assert = require('assert');
const { createJobPool } = require('../src/job-pool');
const tests = [];
const add = (name, fn) => tests.push([name, fn]);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));

function load({ autoLogin = async () => {}, browser = {} } = {}) {
  process.env.CHATGPT_EMAIL = 'test@example.invalid';
  process.env.CHATGPT_PASSWORD = 'fixture';
  process.env.SESSION_LEASE_WAIT_MS = '20';
  process.env.SESSION_PROBE_TIMEOUT_SEC = '1';
  process.env.SESSION_PROBE_DEADLINE_SLACK_MS = '10';
  process.env.SESSION_PROBE_RETRY_DELAY_MS = '1';
  process.env.DISABLE_CHATGPT_MEMORY = '0';
  for (const rel of ['../src/chatgpt', '../src/session-health']) delete require.cache[require.resolve(rel)];
  const dependencies = {
    '../src/browser': { getContext: async () => ({}), saveSession: async () => {}, closeBrowser: async () => {}, ...browser },
    '../src/auto-login': { autoLogin },
  };
  const saved = [];
  for (const [rel, exports] of Object.entries(dependencies)) {
    const key = require.resolve(rel);
    saved.push([key, require.cache[key]]);
    require.cache[key] = { id: key, filename: key, loaded: true, exports };
  }
  try { return { chat: require('../src/chatgpt'), health: require('../src/session-health') }; }
  finally { for (const [key, mod] of saved) { if (mod) require.cache[key] = mod; else delete require.cache[key]; } }
}

function page({ auth = false, probe } = {}) {
  let closed = false;
  const abandoned = deferred();
  return {
    isClosed: () => closed,
    url: () => auth ? 'https://chatgpt.com/auth/login' : 'https://chatgpt.com/',
    close: async () => { closed = true; abandoned.resolve(null); },
    async evaluate(fn) {
      if (fn.toString().includes('fetch(')) return { v: probe ? await Promise.race([probe(), abandoned.promise]) : true };
      return false;
    },
    locator: () => ({ first: () => ({ waitFor: async () => { throw new Error('no logout marker'); } }) }),
  };
}

add('diagnosed auto-login failures are wrapped, counted and throttled', async () => {
  for (const message of ['form changed', 'not authenticated on login screen']) {
    const cause = Object.assign(new Error(message), { code: 'login_failed', loginBlocker: 'login_form_changed', loginStep: 'password', modelMessage: 'Inspect the login form' });
    let calls = 0;
    const { chat, health } = load({ autoLogin: async () => { calls++; throw cause; } });
    const slot = chat.getSlot(0);
    chat._test.bindPage(slot, page({ auth: true }));
    const peer = page();
    chat._test.bindPage(chat.getSlot(1), peer);
    const caught = await chat.ensureLoggedIn(slot, { exclusive: true }).catch((e) => e);
    assert.strictEqual(caught.message, 'auto-login failed: ' + message, 'D4: diagnosed failure must be wrapped');
    assert.strictEqual(caught.cause, cause);
    assert.strictEqual(caught.loginBlocker, 'login_form_changed');
    assert.strictEqual(caught.loginStep, 'password');
    assert.strictEqual(caught.modelMessage, 'Inspect the login form');
    assert.strictEqual(health.loginFailures.login_form_changed, 1, 'D4: failure counter');
    assert.strictEqual(health.sessionHealth.snapshot().last_reason, 'login_failed:login_form_changed');
    assert.strictEqual(peer.isClosed(), true);
    chat._test.bindPage(slot, page({ auth: true }));
    await assert.rejects(chat.ensureLoggedIn(slot, { exclusive: true }), /auto-login on cooldown/);
    assert.strictEqual(calls, 1, 'D4: the next job must not retry login');
    assert.strictEqual(health.loginFailures.login_form_changed, 1);
  }
});

add('post-login failure is recorded exactly once', async () => {
  let chat;
  const loaded = load({ autoLogin: async () => { chat._test.bindPage(chat.getSlot(0), page({ auth: true })); } });
  chat = loaded.chat;
  chat._test.bindPage(chat.getSlot(0), page({ auth: true }));
  const err = await chat.ensureLoggedIn(chat.getSlot(0), { exclusive: true }).catch((e) => e);
  assert.match(err.message, /auto-login completed but session is still not authenticated/);
  assert.strictEqual(loaded.health.loginFailures.unknown, 1, 'D4: post-check must not double count');
  assert.strictEqual(loaded.health.sessionHealth.snapshot().last_reason, 'post_login:out');
});

add('watchdog holds the pool while probing and releases it afterwards', async () => {
  const { chat } = load();
  const probe = deferred();
  const started = deferred();
  const p = page({ probe: () => { started.resolve(); return probe.promise; } });
  chat._test.bindPage(chat.getSlot(0), p);
  const pool = createJobPool({ concurrency: 2, maxWaiting: 8 });
  chat.setPoolHooks(pool);
  const checked = chat.checkSessionOnce({ force: true });
  await started.promise;
  let jobStarted = false;
  const job = pool.submit(async () => { jobStarted = true; return 'done'; });
  await tick();
  assert.strictEqual(jobStarted, false, 'D6: a job must wait for watchdog exclusive');
  assert.strictEqual(await chat.checkSessionOnce({ force: true }), 'skipped');
  probe.resolve(true);
  assert.strictEqual(await checked, 'in');
  assert.strictEqual(pool.status().maintenance.active, null, 'D6: completed watchdog must release exclusive');
  assert.strictEqual(await job, 'done');
  assert.strictEqual(jobStarted, true);
  assert.strictEqual(pool.status().maintenance.active, null);
});

add('forced watchdog skips a busy pool before acquiring', async () => {
  const { chat, health } = load();
  const finish = deferred();
  const entered = deferred();
  const pool = createJobPool({ concurrency: 1, maxWaiting: 8 });
  chat.setPoolHooks(pool);
  chat._test.bindPage(chat.getSlot(0), page());
  const job = pool.submit(async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  const checked = chat.checkSessionOnce({ force: true });
  await tick();
  try {
    assert.strictEqual(pool.status().maintenance.pending.length, 0, 'D6: busy watchdog must not queue an exclusive');
    assert.strictEqual(await checked, 'skipped', 'D6: force does not override queue_busy');
    assert.strictEqual(health.sessionHealth.snapshot().last_reason, 'skipped:queue_busy');
    assert.strictEqual(pool.status().maintenance.pending.length, 0);
  } finally { finish.resolve(); await job; await checked; }
});

add('watchdog skips reset, fresh traffic and absent pages before acquiring', async () => {
  const { chat, health } = load();
  let acquires = 0;
  chat.setPoolHooks({ status: () => ({ running: 0, waiting: 0, maintenance: {} }), acquireExclusive: async () => { acquires++; return () => {}; } });
  const slot = chat.getSlot(0);
  chat._test.bindPage(slot, page());
  slot.pendingReset = 'page';
  assert.strictEqual(await chat.checkSessionOnce(), 'skipped');
  assert.strictEqual(health.sessionHealth.snapshot().last_reason, 'skipped:reset_pending');
  slot.pendingReset = null;
  health.sessionHealth.recordProbe('in', 'traffic');
  assert.strictEqual(await chat.checkSessionOnce(), 'skipped');
  assert.strictEqual(health.sessionHealth.snapshot().last_reason, 'skipped:recent_traffic');
  chat.resetPage(slot);
  assert.strictEqual(await chat.checkSessionOnce({ force: true }), 'unknown');
  assert.strictEqual(health.sessionHealth.snapshot().last_reason, 'no_page');
  assert.strictEqual(acquires, 0);
});

add('watchdog publishes the lease while exclusive acquisition is pending', async () => {
  const { chat } = load();
  const acquired = deferred();
  let acquires = 0;
  let releases = 0;
  chat._test.bindPage(chat.getSlot(0), page());
  chat.setPoolHooks({ status: () => ({ running: 0, waiting: 0, maintenance: {} }), acquireExclusive: () => { acquires++; return acquired.promise; } });
  const first = chat.checkSessionOnce({ force: true });
  assert.strictEqual(await chat.checkSessionOnce({ force: true }), 'skipped', 'D6: pending acquire is single-flight');
  acquired.resolve(() => { releases++; });
  assert.strictEqual(await first, 'in');
  assert.strictEqual(acquires, 1);
  assert.strictEqual(releases, 1);
});

add('watchdog releases exclusive after an inconclusive or rejected probe', async () => {
  const { chat } = load();
  let held = false;
  let releases = 0;
  chat.setPoolHooks({ status: () => ({ running: 0, waiting: 0, maintenance: {} }), acquireExclusive: async () => { held = true; return () => { held = false; releases++; }; } });
  chat._test.bindPage(chat.getSlot(0), page({ probe: () => { assert.strictEqual(held, true); return Promise.reject(new Error('renderer error')); } }));
  assert.strictEqual(await chat.checkSessionOnce({ force: true }), 'unknown');
  assert.strictEqual(held, false);
  assert.strictEqual(releases, 1);
});

add('expired watchdog lease closes and degrades its page, preserving the requesting slot', async () => {
  const { chat } = load();
  const started = deferred();
  const stuck = page({ probe: () => { started.resolve(); return new Promise(() => {}); } });
  const own = page();
  const watchdogSlot = chat.getSlot(0);
  const requestSlot = chat.getSlot(1);
  chat._test.bindPage(watchdogSlot, stuck);
  chat._test.bindPage(requestSlot, own);
  const checked = chat.checkSessionOnce({ force: true });
  await started.promise;
  const result = await chat.ensureLoggedIn(requestSlot).catch((e) => e);
  assert.strictEqual(stuck.isClosed(), true, 'D7: close the page leased by watchdog');
  assert.strictEqual(watchdogSlot.pendingReset, 'page', 'D7: mark watchdog slot degraded');
  assert.strictEqual(own.isClosed(), false, 'D7: preserve request page');
  assert.strictEqual(requestSlot.pendingReset, null, 'D7: preserve request recovery state');
  assert.strictEqual(requestSlot.page, own);
  assert.strictEqual(result, own);
  await checked;
});

let finished = false;
let currentTest = '';
process.on('beforeExit', () => { if (!finished) { console.error('watchdog runner stopped early'); process.exitCode = 1; } });
(async () => {
  for (const [name, fn] of tests) {
    if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) continue;
    currentTest = name;
    await fn();
    console.log('PASS: ' + name);
  }
  finished = true;
})().catch((e) => { finished = true; console.error('FAIL: ' + currentTest, e); process.exitCode = 1; });
