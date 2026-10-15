// Per-slot pages, capture, recovery and tier strikes. No browser: fake pages only.
const assert = require('assert');
const chatgpt = require('../src/chatgpt');
const { tierAvailability } = require('../src/chatgpt-tiers');

const { getSlot, getPage, resetPage, hardResetBrowser, ensureLoggedIn, setPoolHooks, getPoolHooks } = chatgpt;
const { acceptSseChunk, noteConversation, bindPage, markHealthyCompletion, closeWedgedPage, slotOf } = chatgpt._test;

const tests = [];
const add = (name, fn) => tests.push([name, fn]);

function fakePage(url) {
  const page = {
    closed: false,
    isClosed() { return page.closed; },
    close() { page.closed = true; return Promise.resolve(); },
    url() { return url; },
    evaluate() { return Promise.resolve(false); },
  };
  return page;
}

function slotCapture() {
  return { boundStream: null, text: '', feed(chunk) { this.text += chunk; } };
}

add('an SSE chunk on one slot does not land in the other capture', () => {
  const slot0 = getSlot(0);
  const slot1 = getSlot(1);
  slot0.capture = slotCapture();
  slot1.capture = slotCapture();
  slot0.staleStreams = new Set();
  slot1.staleStreams = new Set();
  acceptSseChunk(slot0, 'stream-a', 'alpha');
  acceptSseChunk(slot1, 'stream-b', 'beta');
  assert.strictEqual(slot0.capture.text, 'alpha');
  assert.strictEqual(slot1.capture.text, 'beta');
  assert.strictEqual(slot0.capture.boundStream, 'stream-a');
  assert.strictEqual(slot1.capture.boundStream, 'stream-b');
});

add('a conversation snapshot stays on the slot that fetched it', () => {
  const slot0 = getSlot(0);
  const slot1 = getSlot(1);
  slot0.lastConversationFetch = null;
  slot1.lastConversationFetch = null;
  noteConversation(slot1, { conversationId: 'slot-1-only' });
  assert.strictEqual(slot0.lastConversationFetch, null);
  assert.strictEqual(slot1.lastConversationFetch.conversationId, 'slot-1-only');
  noteConversation(slot0, { conversationId: 'slot-0-only' });
  assert.strictEqual(slot0.lastConversationFetch.conversationId, 'slot-0-only');
  assert.strictEqual(slot1.lastConversationFetch.conversationId, 'slot-1-only');
});

add('getPage returns the page bound to that slot', async () => {
  const slot0 = getSlot(0);
  const slot1 = getSlot(1);
  const page0 = fakePage('https://chatgpt.com/');
  const page1 = fakePage('https://chatgpt.com/c/11111111-2222-4333-8444-555555555555');
  bindPage(slot0, page0);
  bindPage(slot1, page1);
  assert.strictEqual(await getPage(slot0), page0);
  assert.strictEqual(await getPage(slot1), page1);
});

add('resetPage closes only the page of the slot it was given', () => {
  const slot0 = getSlot(0);
  const slot1 = getSlot(1);
  const page0 = fakePage('https://chatgpt.com/');
  const page1 = fakePage('https://chatgpt.com/');
  bindPage(slot0, page0);
  bindPage(slot1, page1);
  resetPage(slot1);
  assert.strictEqual(page1.closed, true);
  assert.strictEqual(page0.closed, false);
  assert.strictEqual(slot0.page, page0);
  const page1b = fakePage('https://chatgpt.com/');
  bindPage(slot1, page1b);
  resetPage(slot0);
  assert.strictEqual(page0.closed, true);
  assert.strictEqual(page1b.closed, false);
  assert.strictEqual(slot1.page, page1b);
});

add('markHealthyCompletion of one slot leaves the other on probation', () => {
  const slot0 = getSlot(0);
  const slot1 = getSlot(1);
  slot0.recoveryState = 'probation';
  slot1.recoveryState = 'probation';
  slot0.menuFailures = 4;
  slot1.menuFailures = 4;
  markHealthyCompletion(slot1);
  assert.strictEqual(slot0.recoveryState, 'probation');
  assert.strictEqual(slot0.menuFailures, 4);
  assert.strictEqual(slot1.recoveryState, 'healthy');
  assert.strictEqual(slot1.menuFailures, 0);
});

add('tier strikes do not add across slots or break a neighbour series', () => {
  tierAvailability._reset();
  tierAvailability.noteUnavailable('pro', 'not-offered', { stickyAfter: 2, slotId: 0 });
  tierAvailability.noteUnavailable('pro', 'not-offered', { stickyAfter: 2, slotId: 1 });
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), false);
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 0 }), 1);
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 1 }), 1);
  tierAvailability.noteUnavailable('pro', 'quota', { stickyAfter: 2, slotId: 1 });
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 0 }), 1);
  assert.strictEqual(tierAvailability.strikesFor('pro', 0), 1);
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), false);
  tierAvailability.noteUnavailable('pro', 'not-offered', { stickyAfter: 2, slotId: 0 });
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), true);
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 0 }), 2);
  tierAvailability.markAvailable('pro', { slotId: 1 });
  assert.strictEqual(tierAvailability.isCoolingDown('pro'), false);
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 0 }), 2, 'slot 1 success cleared slot 0');
  assert.strictEqual(tierAvailability.strikesFor('pro', { slotId: 1 }), 0);
});

add('closing a wedged page keeps it bound to its own slot', () => {
  const page0 = fakePage('https://chatgpt.com/');
  const page1 = fakePage('https://chatgpt.com/');
  bindPage(getSlot(0), page0);
  bindPage(getSlot(1), page1);
  closeWedgedPage(page1);
  assert.strictEqual(slotOf(page1).id, 1);
  assert.strictEqual(getSlot(1).page, null);
  assert.strictEqual(getSlot(0).page, page0);
  assert.strictEqual(slotOf(page0).id, 0);
  assert.strictEqual(page0.closed, false);
});

add('a logged-out slot requests auto-login maintenance and does not run it', async () => {
  const slot0 = getSlot(0);
  const page = fakePage('https://chatgpt.com/auth/login');
  bindPage(slot0, page);
  const saved = {
    email: process.env.CHATGPT_EMAIL,
    password: process.env.CHATGPT_PASSWORD,
    mode: process.env.BROWSER_MODE,
    cdp: process.env.CDP_URL,
    hooks: getPoolHooks(),
  };
  let invoked = false;
  const names = [];
  process.env.CHATGPT_EMAIL = 'tester@example.com';
  process.env.CHATGPT_PASSWORD = 'not-a-real-password';
  process.env.BROWSER_MODE = 'cdp';
  process.env.CDP_URL = 'http://127.0.0.1:1';
  setPoolHooks({
    requestMaintenance(name, fn) {
      names.push(name);
      return Promise.resolve({ skipped: false, fn });
    },
  });
  try {
    let caught = null;
    try {
      await Promise.race([
        ensureLoggedIn(slot0),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('ensureLoggedIn hung')), 3000);
        }),
      ]);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'logged-out ensureLoggedIn must throw');
    assert.strictEqual(caught.retryAfterMaintenance, true);
    assert.strictEqual(caught.code, 'login_failed');
    assert.deepStrictEqual(names, ['auto-login']);
    assert.strictEqual(invoked, false);
    assert.strictEqual(page.closed, false);
  } finally {
    setPoolHooks(saved.hooks);
    if (saved.email === undefined) delete process.env.CHATGPT_EMAIL;
    else process.env.CHATGPT_EMAIL = saved.email;
    if (saved.password === undefined) delete process.env.CHATGPT_PASSWORD;
    else process.env.CHATGPT_PASSWORD = saved.password;
    if (saved.mode === undefined) delete process.env.BROWSER_MODE;
    else process.env.BROWSER_MODE = saved.mode;
    if (saved.cdp === undefined) delete process.env.CDP_URL;
    else process.env.CDP_URL = saved.cdp;
  }
});

add('hardResetBrowser closes every slot page', async () => {
  const slot0 = getSlot(0);
  const slot1 = getSlot(1);
  const page0 = fakePage('https://chatgpt.com/');
  const page1 = fakePage('https://chatgpt.com/');
  bindPage(slot0, page0);
  bindPage(slot1, page1);
  slot0.pendingReset = 'page';
  slot0.capture = slotCapture();
  await hardResetBrowser();
  assert.strictEqual(page0.closed, true);
  assert.strictEqual(page1.closed, true);
  assert.strictEqual(slot0.page, null);
  assert.strictEqual(slot1.page, null);
  assert.strictEqual(slot0.pendingReset, null);
  assert.strictEqual(slot0.capture, null);
});

let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.error('runner stopped before every test finished');
    process.exit(1);
  }
});

(async () => {
  let passed = 0;
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
