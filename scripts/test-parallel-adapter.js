// Exercise the real adapter through its browser/CDP boundary. No browser or network.
const assert = require('assert');
const { EventEmitter } = require('events');
const { createProgress, HEALTH_STUCK_MS } = require('../src/progress');

process.env.READ_VIA_BACKEND_API = '1';
process.env.DISABLE_CHATGPT_MEMORY = '0';
process.env.CONVERSATION_TRIM_LIMIT = '0';
process.env.CHATGPT_EMAIL = 'adapter-test@example.invalid';
process.env.CHATGPT_PASSWORD = 'fake-password';
process.env.BROWSER_MODE = 'default';
process.env.CHATGPT_TEXT_HARD_RESET = 'true';
process.env.SESSION_PROBE_ATTEMPTS = '1';

const tests = [];
const add = (name, fn) => tests.push([name, fn]);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const stop = () => Object.assign(new Error('stop before sending'), { code: 'test_stop' });

class Page extends EventEmitter {
  constructor(name, events = []) {
    super();
    this.name = name;
    this.events = events;
    this.closed = false;
    this.address = 'https://chatgpt.com/';
    this.bindings = {};
    this.pill = 'instant';
  }
  isClosed() { return this.closed; }
  async close() { this.closed = true; this.events.push(`${this.name}:close`); }
  url() { return this.address; }
  async goto(url) { this.address = url; return { status: () => 200, headers: () => ({}) }; }
  async title() { return 'ChatGPT'; }
  async $(selector) { return /prompt-textarea|contenteditable|textarea/.test(selector) ? {} : null; }
  async exposeFunction(name, fn) { this.bindings[name] = fn; }
  async addInitScript() {}
  async waitForTimeout() {}
  locator() {
    const chain = {
      first() { return chain; },
      async waitFor() { throw new Error('no logged-out DOM marker'); },
      async count() { return 0; },
      async isVisible() { return false; },
    };
    return chain;
  }
  async evaluate(fn, arg) {
    const code = String(fn);
    if (code.includes("fetch('/api/auth/session'")) return { v: true };
    if (code.includes('captionSrc') && arg && arg.matchers) {
      this.events.push(`${this.name}:thinking`);
      return { level: this.pill, pillText: this.pill };
    }
    if (code.includes('assistantCount: assistantMessages.length')) {
      this.events.push(`${this.name}:capture-state`);
      return { assistantCount: 0, lastAssistantText: '', bodyTail: '' };
    }
    if (code.includes('const batch = buf.splice')) {
      this.events.push(`${this.name}:prime`);
      return { flushed: 0, dropped: 0 };
    }
    if (code.includes('content failed to load')) return false;
    return undefined;
  }
}

function adapter({ autoLogin = async () => { throw new Error('fake login unavailable'); }, progress } = {}) {
  const events = [];
  const queuedPages = [];
  const calls = { clearSession: 0, closeBrowser: 0, autoLogin: 0 };
  const browser = {
    getContext: async () => ({ newPage: async () => queuedPages.shift() || new Page('fresh', events) }),
    saveSession: async () => {},
    closeBrowser: async () => { calls.closeBrowser++; },
    clearSession: async () => { calls.clearSession++; },
    maybeHideWebdriverOnPage: async () => {},
    browserFingerprint: {},
  };
  for (const [path, exports] of [
    ['../src/browser', browser],
    ['../src/auto-login', { autoLogin: async (...args) => { calls.autoLogin++; return autoLogin(...args); } }],
    ...(progress ? [['../src/progress', { ...require('../src/progress'), progress }]] : []),
  ]) {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  delete require.cache[require.resolve('../src/chatgpt')];
  const chat = require('../src/chatgpt');
  const slots = [chat.getSlot(0), chat.getSlot(1)];
  function bindPair() {
    const pages = [new Page('A', events), new Page('B', events)];
    pages.forEach((p, id) => chat._test.bindPage(slots[id], p));
    return pages;
  }
  return { chat, slots, bindPair, queuedPages, events, calls };
}
function capture() { return { text: '', boundStream: null, feed(chunk) { this.text += chunk; } }; }
function conversation(id, text) {
  return {
    url: () => `https://chatgpt.com/backend-api/conversation/${id}`,
    request: () => ({ method: () => 'GET' }),
    ok: () => true,
    json: async () => ({ conversation_id: id, current_node: 'last', mapping: {
      last: { message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully' } },
    } }),
  };
}

add('page SSE bindings deliver chunks to both owning slots', async () => {
  const { chat, slots, queuedPages } = adapter();
  const pages = [new Page('A'), new Page('B')];
  queuedPages.push(...pages);
  await chat.getPage(slots[0]);
  await chat.getPage(slots[1]);
  assert.strictEqual(slots[0].page, pages[0]);
  assert.strictEqual(slots[1].page, pages[1]);
  slots.forEach((slot) => { slot.capture = capture(); });
  await pages[0].bindings.__gwgSseChunk('stream-A', 'alpha');
  assert.strictEqual(slots[0].capture.text, 'alpha', 'slot 0 must receive its page binding chunk');
  assert.strictEqual(slots[1].capture.text, '', 'slot 1 must stay unchanged by slot 0 binding');
  await pages[1].bindings.__gwgSseChunk('stream-B', 'beta');
  assert.strictEqual(slots[0].capture.text, 'alpha');
  assert.strictEqual(slots[1].capture.text, 'beta');
  assert.strictEqual(slots[0].capture.boundStream, 'stream-A');
  assert.strictEqual(slots[1].capture.boundStream, 'stream-B');
});

add('page response listeners keep conversation GETs on both owning slots', async () => {
  const { chat, slots, queuedPages } = adapter();
  const pages = [new Page('A'), new Page('B')];
  queuedPages.push(...pages);
  await chat.getPage(slots[0]);
  await chat.getPage(slots[1]);
  const ids = ['11111111-2222-4333-8444-555555555555', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'];
  pages[0].emit('response', conversation(ids[0], 'alpha'));
  await flush();
  assert.strictEqual(slots[0].lastConversationFetch?.conversationId, ids[0], 'slot 0 must own its GET response');
  assert.strictEqual(slots[1].lastConversationFetch, null);
  pages[1].emit('response', conversation(ids[1], 'beta'));
  await flush();
  assert.strictEqual(slots[0].lastConversationFetch.lastAssistantText, 'alpha');
  assert.strictEqual(slots[1].lastConversationFetch.conversationId, ids[1]);
  assert.strictEqual(slots[1].lastConversationFetch.lastAssistantText, 'beta');
});

add('recreating either bound page preserves the neighbouring page and recovery state', async () => {
  for (const id of [0, 1]) {
    const { chat, slots, bindPair, queuedPages } = adapter();
    const pages = bindPair();
    const other = 1 - id;
    slots[other].recoveryState = 'probation';
    slots[other].pendingReset = 'hard';
    slots[other].capture = capture();
    const neighbourCapture = slots[other].capture;
    const fresh = new Page('replacement');
    queuedPages.push(fresh);
    const result = await chat.probeSessionWithRecovery(pages[id], { probe: async (p) => p === pages[id] ? 'unknown' : 'in' });
    assert.strictEqual(result.page, fresh);
    assert.strictEqual(slots[id].page, fresh);
    assert.strictEqual(pages[id].closed, true);
    assert.strictEqual(pages[other].closed, false, 'recreate must leave neighbouring bound page open');
    assert.strictEqual(slots[other].page, pages[other]);
    assert.strictEqual(slots[other].capture, neighbourCapture);
    assert.strictEqual(slots[other].pendingReset, 'hard');
    assert.strictEqual(slots[other].recoveryState, 'probation');
  }
});

add('hard recovery inside a job requests maintenance before destroying either page', async () => {
  const { chat, slots, bindPair, calls } = adapter();
  const pages = bindPair();
  slots[1].pendingReset = 'hard';
  slots[1].recoveryState = 'probation';
  const requests = [];
  chat.setPoolHooks({ requestMaintenance: (name, fn, options) => { requests.push({ name, fn, options }); return Promise.resolve(); } });
  const err = await chat.generateImage('never sent', { job: { slotId: 1, jobId: 'hard-job', epoch: 41 }, reuseChat: true, thinkingMode: 'instant', beforeSubmit: async () => { throw stop(); } }).catch(e => e);
  assert.strictEqual(err.retryAfterMaintenance, true, 'job must hand hard reset back to maintenance');
  assert.strictEqual(err.code, 'page_load_failed');
  assert.deepStrictEqual(requests.map(r => r.name), ['hard-reset']);
  assert.strictEqual(requests[0].options.sinceEpoch, 41);
  assert.strictEqual(calls.closeBrowser, 0);
  assert.strictEqual(slots[0].page, pages[0]);
  assert.strictEqual(slots[1].page, pages[1]);
  assert.strictEqual(pages[0].closed, false);
  assert.strictEqual(pages[1].closed, false);
});

add('deferred auto-login leaves the shared cookie jar and both pages intact', async () => {
  const { chat, slots, bindPair, calls } = adapter();
  const pages = bindPair();
  pages[1].address = 'https://chatgpt.com/auth/login';
  const requests = [];
  chat.setPoolHooks({ requestMaintenance: (name, fn) => { requests.push({ name, fn }); return Promise.resolve(); } });
  const err = await chat.ensureLoggedIn(slots[1]).catch(e => e);
  assert.strictEqual(err.retryAfterMaintenance, true);
  assert.strictEqual(calls.clearSession, 0, 'deferred login must not clear shared cookies while jobs run');
  assert.strictEqual(calls.autoLogin, 0);
  assert.deepStrictEqual(requests.map(r => r.name), ['auto-login']);
  assert.strictEqual(slots[0].page, pages[0]);
  assert.strictEqual(slots[1].page, pages[1]);
  assert.strictEqual(pages[0].closed, false);
  assert.strictEqual(pages[1].closed, false);
});

add('completeText returns a maintenance marker without consuming its retry flag', async () => {
  const { chat, slots, bindPair, calls } = adapter();
  const pages = bindPair();
  slots[0].pendingReset = 'hard';
  const requests = [];
  chat.setPoolHooks({ requestMaintenance: name => { requests.push(name); return Promise.resolve(); } });
  const err = await chat.completeText('never sent', { beforeSubmit: async () => { throw stop(); } }).catch(e => e);
  assert.strictEqual(err.retryAfterMaintenance, true, 'completeText must preserve retryAfterMaintenance for the pool');
  assert.strictEqual(err.code, 'page_load_failed');
  assert.deepStrictEqual(requests, ['hard-reset']);
  assert.strictEqual(calls.closeBrowser, 0);
  assert.strictEqual(pages[0].closed, false);
  assert.strictEqual(pages[1].closed, false);
});

add('rejected background maintenance is observed without unhandled rejection', async () => {
  const { chat, slots, bindPair } = adapter();
  bindPair()[0].address = 'https://chatgpt.com/auth/login';
  const unhandled = [];
  const onUnhandled = err => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    chat.setPoolHooks({ requestMaintenance: () => Promise.reject(new Error('maintenance deliberately rejected')) });
    const err = await chat.ensureLoggedIn(slots[0]).catch(e => e);
    assert.strictEqual(err.retryAfterMaintenance, true);
    await flush();
    await flush();
    assert.deepStrictEqual(unhandled, [], 'background maintenance rejection must have an attached rejection handler');
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});

add('failed auto-login maintenance discards both bound slot pages', async () => {
  const { chat, slots, bindPair, calls } = adapter();
  const pages = bindPair();
  pages[0].address = 'https://chatgpt.com/auth/login';
  let maintenance;
  chat.setPoolHooks({ requestMaintenance: (_name, fn) => { maintenance = fn; return Promise.resolve(); } });
  await assert.rejects(chat.ensureLoggedIn(slots[0]), e => e.retryAfterMaintenance === true);
  await assert.rejects(maintenance(), /auto-login failed: fake login unavailable/);
  assert.strictEqual(calls.autoLogin, 1);
  assert.strictEqual(slots[0].page, null);
  assert.strictEqual(slots[1].page, null, 'failed auto-login must discard neighbouring slot page');
  assert.strictEqual(pages[0].closed, true);
  assert.strictEqual(pages[1].closed, true);
});

function deadMenuDeps() {
  return { env: {}, settle: async () => {}, readPill: async () => ({ level: 'medium', pillText: 'Medium' }), applyLevel: async () => ({ menuOpened: false, clicked: false }) };
}
add('degradation uses each bound slot own probation state in both directions', async () => {
  for (const id of [0, 1]) {
    const { chat, slots, bindPair } = adapter();
    const pages = bindPair();
    slots[id].recoveryState = 'probation';
    slots[1 - id].recoveryState = 'healthy';
    await chat._test.setThinkingMode(pages[id], 'extended', deadMenuDeps());
    await chat._test.setThinkingMode(pages[id], 'extended', deadMenuDeps());
    assert.strictEqual(slots[id].pendingReset, 'hard', 'probation slot must escalate using its own state');
    assert.strictEqual(slots[1 - id].pendingReset, null);
    await chat._test.setThinkingMode(pages[1 - id], 'extended', deadMenuDeps());
    await chat._test.setThinkingMode(pages[1 - id], 'extended', deadMenuDeps());
    assert.strictEqual(slots[1 - id].pendingReset, 'page', 'healthy neighbour must use its own page reset');
    assert.strictEqual(slots[id].pendingReset, 'hard');
    assert.strictEqual(slots[id].recoveryState, 'probation');
    assert.strictEqual(slots[1 - id].recoveryState, 'healthy');
    assert.strictEqual(pages[0].closed, false);
    assert.strictEqual(pages[1].closed, false);
  }
});

add('completeText calls beforeSubmit once after thinking capture and main-world preparation', async () => {
  const { chat, bindPair, events } = adapter();
  bindPair();
  let hooks = 0;
  const sentinel = stop();
  const err = await chat.completeText('never sent', { job: { slotId: 1, jobId: 'paced' }, reuseChat: true, thinkingMode: 'instant', beforeSubmit: async () => { hooks++; events.push('hook'); throw sentinel; } }).catch(e => e);
  assert.strictEqual(hooks, 1, 'completeText must call its beforeSubmit hook exactly once');
  assert.strictEqual(err, sentinel);
  assert.deepStrictEqual(events.slice(-4), ['B:thinking', 'B:capture-state', 'B:prime', 'hook'], 'beforeSubmit must run after thinking capture and main-world preparation');
});

add('tier adapter accumulates unavailable evidence separately for both bound slots', async () => {
  const { chat, bindPair } = adapter();
  const { tierAvailability } = require('../src/chatgpt-tiers');
  tierAvailability._reset();
  const pages = bindPair();
  const deps = {
    env: {}, settle: async () => {},
    readPill: async () => ({ level: 'veryhigh', pillText: 'Extra High' }),
    applyLevel: async () => ({ menuOpened: true, clicked: false, unsupported: true, disabled: false }),
  };
  await chat._test.setThinkingMode(pages[0], 'pro', deps);
  await chat._test.setThinkingMode(pages[1], 'pro', deps);
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), false, 'one miss on each page must not combine into global cooldown');
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 0 }), 1);
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 1 }), 1);
  await chat._test.setThinkingMode(pages[1], 'pro', deps);
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), true);
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 0 }), 1);
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 1 }), 2);
  tierAvailability._reset();
});

add('adaptive image chunk heartbeat refreshes only the job on its bound slot', async () => {
  let now = 0;
  const progress = createProgress(() => now);
  const { chat, slots, bindPair } = adapter({ progress });
  const pages = bindPair();
  slots[0].jobId = 'image-A';
  slots[1].jobId = 'image-B';
  progress.jobStarted();
  progress.jobRunning('image-A');
  progress.jobStarted();
  progress.jobRunning('image-B');
  now = HEALTH_STUCK_MS + 1;
  let waits = 0;
  let ownJobAlive;
  let neighbourAge;
  pages[0].evaluate = async () => ({ refusalLikely: false, activeGeneration: true, stopBtn: true, activeText: false });
  pages[0].waitForFunction = async () => {
    waits++;
    if (waits === 1) throw Object.assign(new Error('initial image budget elapsed'), { name: 'TimeoutError' });
    neighbourAge = progress.snapshot().oldest_job_ms_since_progress;
    // Release the neighbour so the remaining liveness verdict measures only A.
    progress.jobFinished(null, 'image-B');
    ownJobAlive = progress.liveness().alive;
    throw stop();
  };
  await assert.rejects(chat._test.waitAndExtractImage(pages[0]), e => e.code === 'test_stop');
  assert.strictEqual(waits, 2);
  assert.strictEqual(ownJobAlive, true, 'adaptive chunk must refresh its own running job heartbeat');
  assert.strictEqual(neighbourAge, HEALTH_STUCK_MS + 1, 'adaptive chunk must leave neighbouring job heartbeat stale');
  assert.strictEqual(progress.snapshot().oldest_job_ms_since_progress, 0);
  assert.strictEqual(slots[0].page, pages[0]);
  assert.strictEqual(slots[1].page, pages[1]);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS: ${name}`); }
    catch (err) { console.error(`FAIL: ${name} — ${err.stack || err}`); process.exitCode = 1; return; }
  }
  console.log(`\n${tests.length}/${tests.length} adapter tests passed`);
})().catch(err => { console.error(err); process.exitCode = 1; });
