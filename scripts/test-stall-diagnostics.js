// Real ChatGPT adapter; only the external browser and clock are replaced.
const test = require.main === module ? require('node:test') : () => {};
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const flush = () => new Promise(resolve => setImmediate(resolve));
const CONVERSATION = '11111111-2222-4333-8444-555555555555';
const empty = () => ({ assistantCount: 0, lastAssistantText: '', bodyTail: '' });
function response({ method = 'POST', url = '/backend-api/f/conversation', status = 200,
                    ct = 'text/event-stream', text = async () => '', data } = {}) {
  return { url: () => `https://chatgpt.com${url}`, request: () => ({ method: () => method }),
    status: () => status, ok: () => status >= 200 && status < 300,
    headers: () => ({ 'content-type': ct }), text, json: async () => data };
}

class Page extends EventEmitter {
  constructor(clock, scenario = {}) {
    super();
    this.clock = clock;
    this.scenario = scenario;
    this.address = 'https://chatgpt.com/';
    this.closed = false;
    this.bindings = {};
    this.composer = '';
    this.sends = 0;
    this.users = 0;
    this.sentAt = [];
    this.actions = [];
    this.keyboard = { press: async key => { if (key === 'Enter') await this.send(); } };
  }
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
  url() { return this.address; }
  async goto(url) { this.address = url; return response(); }
  async reload() { this.actions.push('reload'); return response(); }
  async title() { return 'ChatGPT'; }
  async $(selector) { return /prompt-textarea|contenteditable|textarea/.test(selector) ? {} : null; }
  async exposeFunction(name, fn) { this.bindings[name] = fn; }
  async addInitScript() {}
  async waitForTimeout(ms) { this.clock.now += ms; }
  async screenshot({ path: file }) {
    this.actions.push('snapshot');
    const png = Buffer.from('png');
    if (file) fs.writeFileSync(file, png);
    return png;
  }
  async content() { return '<html>snapshot</html>'; }
  async send() {
    this.sends++;
    this.sentAt.push(this.clock.now);
    if (!this.scenario.unconfirmed) { this.users++; this.composer = ''; }
    await this.scenario.onSend?.(this);
  }
  locator(selector) {
    const p = this;
    const composer = /prompt-textarea|contenteditable|textarea/.test(selector);
    const send = /send-button|Send|Отправить/.test(selector);
    const chain = {
      first: () => chain,
      filter: () => chain,
      async waitFor() { if (!composer && !send) throw new Error('no overlay'); },
      async count() { return 0; },
      async isVisible() { return false; },
      async fill(text) { p.composer = text; },
      async click() { if (send) await p.send(); },
      async evaluate() { return p.composer; },
      async textContent() { return p.composer; },
    };
    return chain;
  }
  async evaluate(fn, arg) {
    const code = String(fn);
    if (code.includes("fetch('/api/auth/session'")) return { v: true };
    if (code.includes('captionSrc') && arg?.matchers) return { level: 'instant', pillText: 'instant' };
    if (code.includes('assistantCount: assistantMessages.length')) {
      if (this.sends && this.scenario.answer) return { assistantCount: 1, lastAssistantText: 'answer', bodyTail: 'answer' };
      return empty();
    }
    if (code.includes('querySelectorAll') && code.includes('data-message-author-role="user"')) return this.users;
    if (code.includes('const batch = buf.splice')) return { flushed: 0, dropped: 0 };
    if (code.includes('content failed to load')) return false;
    return undefined;
  }
}

async function fixture(env, fn) {
  const defaults = { READ_VIA_BACKEND_API: '1', STALL_SNAPSHOTS: '0', DEBUG_SNAPSHOTS: '0',
    CHAT_STALL_WINDOW_SEC: '3', CHAT_STREAM_RESCUE_SEC: '1', CHATGPT_TEXT_RETRY_ATTEMPTS: '1',
    TEXT_STALL_RETRIES: '1', PAGE_RECYCLE_AFTER_JOBS: '50', DISABLE_CHATGPT_MEMORY: '0',
    CONVERSATION_TRIM_LIMIT: '0', SESSION_PROBE_ATTEMPTS: '1' };
  const saved = {};
  for (const [key, value] of Object.entries({ ...defaults, ...env })) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = String(value);
  }
  const originalNow = Date.now;
  const clock = { now: 100000 };
  Date.now = () => clock.now;
  const pages = [];
  const queue = [];
  const browserId = require.resolve('../src/browser');
  const oldBrowser = require.cache[browserId];
  const browser = { getContext: async () => ({ newPage: async () => {
    const page = queue.shift() || new Page(clock, { answer: true }); pages.push(page); return page;
  } }), saveSession: async () => {}, closeBrowser: async () => {},
  maybeHideWebdriverOnPage: async () => {}, browserFingerprint: {} };
  require.cache[browserId] = { id: browserId, filename: browserId, loaded: true, exports: browser };
  const chatId = require.resolve('../src/chatgpt');
  delete require.cache[chatId];
  const chat = require(chatId);
  try { return await fn({ chat, clock, queue, pages, page: scenario => new Page(clock, scenario) }); }
  finally {
    Date.now = originalNow;
    if (oldBrowser) require.cache[browserId] = oldBrowser; else delete require.cache[browserId];
    delete require.cache[chatId];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function logs(fn) {
  const original = process.stdout.write;
  const lines = [];
  process.stdout.write = function(chunk, ...args) { lines.push(String(chunk)); return true; };
  try { return { result: await fn(), output: lines.join('') }; }
  finally { process.stdout.write = original; }
}

test('POST failure is published before reading the body and rejects immediately', async () => {
  await fixture({}, async ({ chat, page, queue, clock }) => {
    const p = page(); queue.push(p);
    const slot = chat.getSlot(1); await chat.getPage(slot);
    const cap = chat._test.beginBackendCapture(slot);
    let bodyStarted = false;
    let finish;
    const body = new Promise(resolve => { finish = resolve; });
    p.emit('response', response({ status: 429, ct: 'application/json', text: () => {
      bodyStarted = true;
      assert.equal(cap.postFailure.status, 429, 'publish before awaiting text()');
      return body;
    } }));
    assert.equal(bodyStarted, true);
    assert.equal(cap.postStatus.status, 429);
    assert.equal(cap.postStatus.contentType, 'application/json');
    assert.equal(cap.postStatus.at, clock.now);
    const started = clock.now;
    try {
      await assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture: cap }), e =>
        e.code === 'rate_limit' && /rate limit/.test(e.message) && e.modelMessage === '');
      assert.equal(clock.now, started, 'no stall polling for a known rejection');
    } finally { finish('  Too \n many requests  '); await flush(); }
    assert.equal(cap.postFailure.snippet, 'Too many requests');
  });
});

test('unread POST body has a bounded single diagnostic and cannot contaminate a new capture', async (t) => {
  await fixture({}, async ({ chat, page, queue }) => {
    const p = page(); queue.push(p); const slot = chat.getSlot(2); await chat.getPage(slot);
    const cap = chat._test.beginBackendCapture(slot);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { output } = await logs(async () => {
        p.emit('response', response({ status: 429, ct: 'application/json', text: () => new Promise(() => {}) }));
        assert.equal(cap.postFailure.status, 429);
        await assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture: cap }), e => e.code === 'rate_limit');
        const next = chat._test.beginBackendCapture(slot);
        t.mock.timers.tick(5000); await flush();
        assert.equal(next.postFailure, undefined);
      });
      assert.match(output, /\[backend-read\] slot=2 conversation POST status=429 ct=application\/json body=<unread>/);
      assert.equal(output.split('conversation POST').length - 1, 1);
    } finally { t.mock.timers.reset(); }
  });
});

test('a POST body resolved after capture B opens writes its snippet only to capture A', async () => {
  await fixture({}, async ({ chat, page, queue }) => {
    const p = page(); queue.push(p); const slot = chat.getSlot(2); await chat.getPage(slot);
    const first = chat._test.beginBackendCapture(slot);
    let finish;
    const body = new Promise(resolve => { finish = resolve; });
    p.emit('response', response({ status: 429, ct: 'application/json', text: () => body }));
    assert.equal(first.postFailure.status, 429);
    const next = chat._test.beginBackendCapture(slot);
    finish('  delayed\n rejection  ');
    await flush();
    assert.equal(first.postFailure.snippet, 'delayed rejection');
    assert.equal(next.postFailure, undefined);
  });
});

test('non-SSE diagnostics normalize and truncate body, 5xx rejects, 2xx keeps waiting', async () => {
  await fixture({}, async ({ chat, page, queue, clock }) => {
    const p = page(); queue.push(p); const slot = chat.getSlot(0); await chat.getPage(slot);
    for (const status of [503, 200]) {
      const cap = chat._test.beginBackendCapture(slot);
      const { output } = await logs(async () => {
        p.emit('response', response({ status, ct: 'application/json', text: async () => 'x  \n'.repeat(400) }));
        await flush();
      });
      assert.equal(cap.postFailure.snippet.length, 300);
      assert.ok(!cap.postFailure.snippet.includes('\n'));
      assert.equal(output.split('conversation POST').length - 1, 1);
      const start = clock.now;
      await assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture: cap }), e => {
        if (status === 503) return e.code === 'server_error' && /503/.test(e.message) && e.message.includes(cap.postFailure.snippet);
        return e.code === 'timeout' && e.stallNoAnswer !== true;
      });
      assert.equal(clock.now > start, status === 200);
    }
  });
});

test('429 during submit confirmation is rate_limit with no pre-submit retry', async () => {
  await fixture({ CHATGPT_TEXT_RETRY_ATTEMPTS: '4' }, async ({ chat, page, queue, clock }) => {
    const p = page({ unconfirmed: true, onSend: p => p.emit('response', response({ status: 429, ct: 'application/json' })) });
    queue.push(p);
    const start = clock.now;
    await assert.rejects(chat.completeText('hello', { thinkingMode: 'instant' }), e => e.code === 'rate_limit');
    assert.equal(p.sends, 1);
    assert.ok(clock.now - start < 12000);
    assert.equal(chat.getSlot(0).pendingReset, null);
  });
});

test('backend ring is per slot, bounded, redacts ids and includes pre-wait responses at rescue and abort', async () => {
  await fixture({}, async ({ chat, page, queue, clock }) => {
    const p = page(); p.address += `c/${CONVERSATION}`; queue.push(p);
    const slot = chat.getSlot(1); await chat.getPage(slot);
    // getPage navigates a new page; set conversation URL after boot.
    p.address = `https://chatgpt.com/c/${CONVERSATION}`;
    for (let i = 0; i < 35; i++) p.emit('response', response({ method: 'GET', url: `/backend-api/old/${i}` }));
    clock.now++;
    const cap = chat._test.beginBackendCapture(slot);
    p.emit('response', response({ method: 'GET', url: `/backend-api/files/${CONVERSATION}/abcdef0123456789` }));
    p.emit('response', response({ status: 204, ct: 'text/event-stream' }));
    clock.now += 2000;
    const { output } = await logs(async () => {
      await assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture: cap }), e => e.code === 'timeout');
    });
    assert.equal(slot.backendResponses.length, 30);
    assert.equal(chat.getSlot(0).backendResponses.length, 0);
    const diagnostics = output.split('\n').filter(line => line.includes('[stall-diag]'));
    assert.equal(diagnostics.length, 2, 'both rescue and stall abort log the ring');
    for (const line of diagnostics) {
      assert.match(line, /slot=1 backend-api since submit: GET \/backend-api\/files\/<id>\/<id> 200, POST \/backend-api\/f\/conversation 204/);
      assert.ok(!line.includes('/old/'));
    }
  });
});

test('GET diagnostics include mapping size and current message metadata, with status only on rejection', async () => {
  await fixture({}, async ({ chat, page, queue }) => {
    const p = page(); queue.push(p); const slot = chat.getSlot(1); await chat.getPage(slot);
    chat._test.beginBackendCapture(slot);
    const data = { conversation_id: CONVERSATION, current_node: 'last', mapping: {
      last: { message: { author: { role: 'assistant' }, status: 'finished_successfully', content: { content_type: 'text', parts: ['answer'] } } },
      root: { message: null },
    } };
    const { output } = await logs(async () => {
      p.emit('response', response({ method: 'GET', url: `/backend-api/conversation/${CONVERSATION}`, data }));
      await flush();
      p.emit('response', response({ method: 'GET', url: `/backend-api/conversation/${CONVERSATION}`, status: 403 }));
      await flush();
    });
    assert.match(output, /slot=1 conversation GET status=200 messages=2 last_role=assistant last_status=finished_successfully/);
    assert.match(output, /slot=1 conversation GET status=403\n/);
    assert.equal(slot.lastConversationFetch.lastAssistantText, 'answer');
  });
});

test('stall snapshot defaults, opt-out and retention leave ordinary debug files alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-snapshots-'));
  try {
    await fixture({ STALL_SNAPSHOTS: undefined, STALL_SNAPSHOT_KEEP: '2', DEBUG_SNAPSHOT_DIR: dir }, async ({ chat, page, clock }) => {
      const p = page();
      fs.writeFileSync(path.join(dir, 'ordinary.html'), 'keep');
      await chat._test.saveDebugSnapshot(p, 'text_timeout');
      assert.equal(fs.readdirSync(dir).length, 1);
      for (let i = 0; i < 4; i++) {
        clock.now += 1000;
        await chat._test.saveDebugSnapshot(p, i % 2 ? 'text_stalled' : 'text_rescue');
      }
      const files = fs.readdirSync(dir);
      assert.equal(files.filter(f => f.endsWith('.png')).length, 2);
      assert.equal(files.filter(f => f.endsWith('.html')).length, 3);
      assert.ok(files.includes('ordinary.html'));
      assert.ok(files.some(f => f.includes('00-01-43-000Z') && f.endsWith('.png')), 'third snapshot was not retained');
      assert.ok(files.some(f => f.includes('00-01-44-000Z') && f.endsWith('.png')), 'newest snapshot was not retained');
    });
    await fixture({ STALL_SNAPSHOTS: '0', DEBUG_SNAPSHOTS: '1', DEBUG_SNAPSHOT_DIR: dir }, async ({ chat, page }) => {
      const p = page(); const before = fs.readdirSync(dir);
      await chat._test.saveDebugSnapshot(p, 'text_stalled');
      assert.deepEqual(fs.readdirSync(dir), before);
      await chat._test.saveDebugSnapshot(p, 'text_timeout');
      assert.equal(fs.readdirSync(dir).length, before.length + 2);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rescue snapshot precedes reload and abort snapshot is written with debug off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-rescue-'));
  try {
    await fixture({ STALL_SNAPSHOTS: '1', DEBUG_SNAPSHOT_DIR: dir }, async ({ chat, page, queue }) => {
      const p = page(); queue.push(p); const slot = chat.getSlot(0); await chat.getPage(slot);
      p.address = `https://chatgpt.com/c/${CONVERSATION}`;
      const capture = chat._test.beginBackendCapture(slot);
      const { output } = await logs(async () => {
        await assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture }), e => e.stallNoAnswer === true);
      });
      assert.deepEqual(p.actions, ['snapshot', 'reload', 'snapshot']);
      assert.match(output, /backend-api since submit: none/);
      const files = fs.readdirSync(dir);
      for (const label of ['text_rescue', 'text_stalled']) {
        assert.ok(files.some(f => f.includes(label) && f.endsWith('.png')));
        assert.ok(files.some(f => f.includes(label) && f.endsWith('.html')));
      }
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stall retries once on a fresh page even with one normal attempt and leaves neighbour untouched', async () => {
  await fixture({ TEXT_STALL_RETRIES: undefined }, async ({ chat, page, queue, pages }) => {
    const stalled = page(); const fresh = page({ answer: true }); queue.push(stalled, fresh);
    const peer = page(); chat._test.bindPage(chat.getSlot(1), peer);
    const order = [];
    const { result, output } = await logs(() => chat.completeText('hello', {
      thinkingMode: 'instant', beforeSubmit: () => { order.push('submit'); }, onAttemptFinished: () => { order.push('finished'); },
    }));
    assert.equal(result.text, 'answer');
    assert.deepEqual(order, ['submit', 'finished', 'submit']);
    assert.equal(stalled.sends, 1); assert.equal(fresh.sends, 1);
    assert.equal(stalled.closed, true); assert.equal(peer.closed, false);
    assert.equal(chat.getSlot(1).page, peer);
    assert.equal(pages.length, 2);
    assert.match(output, /stall retry 1\/1/);
  });
});

test('visible partial text times out without authorizing a stall resend', async () => {
  await fixture({}, async ({ chat, page, queue, pages }) => {
    const p = page({ answer: true });
    const query = p.$.bind(p);
    p.$ = async selector => selector.includes('stop-button') && p.sends ? {} : query(selector);
    queue.push(p);
    await assert.rejects(chat.completeText('hello', { thinkingMode: 'instant' }), e => e.code === 'timeout' && !e.stallNoAnswer);
    assert.equal(pages.length, 1);
    assert.equal(p.sends, 1);
  });
});

test('a used stall budget follows the job to a different slot after maintenance', async () => {
  await fixture({}, async ({ chat, page, queue, pages }) => {
    const stallRetryState = { used: 0 };
    queue.push(page(), page(), page());
    let preparations = 0;
    await assert.rejects(chat.completeText('hello', { thinkingMode: 'instant', stallRetryState,
      beforeSubmit: () => {
        if (++preparations === 2) throw Object.assign(new Error('maintenance'), { retryAfterMaintenance: true });
      },
    }), e => e.retryAfterMaintenance);
    assert.equal(stallRetryState.used, 1);
    await assert.rejects(chat.completeText('hello', { thinkingMode: 'instant', stallRetryState, job: { slotId: 1 } }), e => e.code === 'timeout');
    assert.equal(pages.length, 3);
    assert.equal(pages.reduce((n, p) => n + p.sends, 0), 2);
    assert.equal(chat.getSlot(1).pendingReset, 'page', 'different slot must keep its own recovery state');
  });
});

for (const scenario of ['conversation', 'delta', 'bound', 'accepted', 'failure', 'hard', 'disabled', 'backend-text']) {
  test(`stall resend is forbidden: ${scenario}`, async () => {
    await fixture({ TEXT_STALL_RETRIES: scenario === 'disabled' ? '0' : '1' }, async ({ chat, page, queue, pages }) => {
      const slot = chat.getSlot(0);
      if (scenario === 'hard') slot.recoveryState = 'probation';
      const p = page({ onSend: p => {
        const cap = slot.capture;
        if (scenario === 'bound') cap.boundStream = 'empty-stream';
        if (scenario === 'backend-text') cap.text = 'partial';
        if (scenario === 'accepted') p.emit('response', response({ status: 200 }));
        if (scenario === 'failure') p.emit('response', response({ status: 200, ct: 'application/json' }));
        if (scenario === 'delta') {
          // Emit a prefix, then replace the snapshot with an empty result; the
          // independent anyDeltaEmitted guard must still prohibit another send.
          const snapshot = cap.snapshot.bind(cap);
          let calls = 0;
          cap.snapshot = () => ++calls === 1 ? { ...snapshot(), lastAssistantText: 'prefix' } : snapshot();
        }
      } }); queue.push(p);
      const deltas = [];
      await assert.rejects(chat.completeText('hello', { thinkingMode: 'instant',
        conversationId: scenario === 'conversation' ? CONVERSATION : undefined,
        onDelta: text => deltas.push(text),
      }), e => e.code === 'timeout');
      assert.equal(p.sends, 1); assert.equal(pages.length, 1);
      if (scenario === 'delta') assert.deepEqual(deltas, ['prefix']);
      if (scenario === 'hard') assert.equal(slot.pendingReset, 'hard');
    });
  });
}

test('second stall on probation escalates without a third send', async () => {
  await fixture({ TEXT_STALL_RETRIES: '4' }, async ({ chat, page, queue, pages }) => {
    queue.push(page(), page());
    await assert.rejects(chat.completeText('hello', { thinkingMode: 'instant' }), e => e.code === 'timeout');
    assert.equal(pages.length, 2);
    assert.equal(chat.getSlot(0).pendingReset, 'hard');
  });
});

test('recycle threshold counts jobs, preserves recovery and resets only its own page counter', async () => {
  await fixture({ PAGE_RECYCLE_AFTER_JOBS: '2' }, async ({ chat, page }) => {
    const slot = chat.getSlot(1); const peer = chat.getSlot(0);
    const p = page(); chat._test.bindPage(slot, p); chat._test.bindPage(peer, page());
    chat.recordSlotJobFinished(1);
    assert.equal(slot.pendingReset, null);
    const { output } = await logs(async () => chat.recordSlotJobFinished(1));
    assert.equal(slot.pendingReset, 'recycle');
    assert.match(output, /\[recycle\] slot 1: page served 2 jobs — fresh page on next job/);
    await chat._test.maybeRecoverSession(slot);
    assert.equal(slot.recoveryState, 'healthy');
    assert.equal(slot.pendingReset, null); assert.equal(slot.completedJobs, 0);
    assert.equal(p.closed, true); assert.equal(peer.page.closed, false);
    for (const pending of ['page', 'hard']) {
      chat._test.bindPage(slot, page()); slot.pendingReset = pending;
      chat.recordSlotJobFinished(1); chat.recordSlotJobFinished(1);
      assert.equal(slot.pendingReset, pending);
      chat.resetPage(slot); assert.equal(slot.completedJobs, 0);
    }
    slot.recoveryState = 'probation'; slot.pendingReset = 'recycle';
    await chat._test.maybeRecoverSession(slot);
    assert.equal(slot.recoveryState, 'probation');
  });
});

test('recycle is disabled by zero and defaults to fifty completed jobs', async () => {
  for (const value of ['0', undefined]) {
    await fixture({ PAGE_RECYCLE_AFTER_JOBS: value }, async ({ chat, page }) => {
      const slot = chat.getSlot(0); chat._test.bindPage(slot, page());
      for (let i = 0; i < 49; i++) chat.recordSlotJobFinished(0);
      assert.equal(slot.pendingReset, null);
      chat.recordSlotJobFinished(0);
      assert.equal(slot.pendingReset, value === '0' ? null : 'recycle');
    });
  }
});

test('watchdog probes a usable page even when recycle is pending', async () => {
  await fixture({}, async ({ chat, page }) => {
    const slot = chat.getSlot(0); chat._test.bindPage(slot, page()); slot.pendingReset = 'recycle';
    assert.equal(await chat.checkSessionOnce({ force: true }), 'in');
    assert.equal(slot.pendingReset, 'recycle');
    for (const pending of ['page', 'hard']) {
      slot.pendingReset = pending;
      assert.equal(await chat.checkSessionOnce({ force: true }), 'skipped');
    }
  });
});

// Shared browser boundary for route tests; adapter cases run only when this
// file is executed directly (as registered in npm test).
module.exports = { fixture, response, logs, flush, CONVERSATION };
