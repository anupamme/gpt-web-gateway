// Stream-rescue must not reload a page that is still generating (2026-10-29: extra_high
// turns were reloaded at ~61 s while ChatGPT was thinking, then stalled into a 504), and
// a promo overlay over the composer must be dismissed before the editor is clicked.
// Real adapter; only browser and clock are replaced (fixture from test-stall-diagnostics).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, response, logs, flush, CONVERSATION } = require('./test-stall-diagnostics');

const empty = () => ({ assistantCount: 0, lastAssistantText: '', bodyTail: '' });
const STOP_RE = /aria-label="Stop"/;

async function setup(chat, page, queue, scenario = {}) {
  const p = page(scenario); queue.push(p);
  const slot = chat.getSlot(0); await chat.getPage(slot);
  p.address = `https://chatgpt.com/c/${CONVERSATION}`;
  return { p, slot, capture: chat._test.beginBackendCapture(slot) };
}

test('an open response stream defers the reload rescue until the stall guard', async () => {
  await fixture({}, async ({ chat, page, queue }) => {
    const { p, capture } = await setup(chat, page, queue);
    let finish;
    p.emit('response', response({ text: () => new Promise(resolve => { finish = resolve; }) }));
    await flush();
    assert.equal(capture.openStreams, 1);
    try {
      const { output } = await logs(() => assert.rejects(
        chat._test.waitAndExtractText(p, empty(), { capture }), e => e.code === 'timeout'));
      assert.deepEqual(p.actions.filter(a => a === 'reload'), [], 'no reload while the stream is open');
      assert.match(output, /response stream still open — reload deferred/);
      assert.equal(output.split('reload deferred').length - 1, 1, 'deferral is logged once');
    } finally { finish(''); await flush(); }
    assert.equal(capture.openStreams, 0, 'the stream closes when the body ends');
  });
});

test('closing one of two overlapping streams keeps the rescue deferred', async () => {
  await fixture({}, async ({ chat, page, queue }) => {
    const { p, capture } = await setup(chat, page, queue);
    let finishLate;
    p.emit('response', response({ text: () => new Promise(resolve => { finishLate = resolve; }) }));
    p.emit('response', response({ text: async () => '' }));
    await flush();
    assert.equal(capture.openStreams, 1);
    try {
      await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
      assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
    } finally { finishLate(''); await flush(); }
  });
});

test('a stream that closed without an answer re-enables the rescue', async () => {
  await fixture({}, async ({ chat, page, queue }) => {
    const { p, capture } = await setup(chat, page, queue);
    p.emit('response', response({ text: async () => '' }));
    await flush();
    assert.equal(capture.openStreams, 0);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
    assert.deepEqual(p.actions.filter(a => a === 'reload'), ['reload']);
  });
});

test('a Stop button seen once in the recent window still blocks the rescue', async () => {
  await fixture({}, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue);
    const t0 = clock.now;
    const base = p.$.bind(p);
    // Visible on the first poll only, then missed by every later probe.
    p.$ = async selector => STOP_RE.test(selector) ? (clock.now === t0 ? {} : null) : base(selector);
    const { output } = await logs(() => assert.rejects(
      chat._test.waitAndExtractText(p, empty(), { capture }), e => e.code === 'timeout'));
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
    assert.match(output, /Stop button seen \d+s ago — reload deferred/);
  });
});

test('a Stop button seen longer ago than the recent window no longer blocks it', async () => {
  await fixture({ CHAT_RESCUE_STOP_RECENT_SEC: '1', CHAT_STREAM_RESCUE_SEC: '2', CHAT_STALL_WINDOW_SEC: '5' },
    async ({ chat, page, queue, clock }) => {
      const { p, capture } = await setup(chat, page, queue);
      const t0 = clock.now;
      const base = p.$.bind(p);
      p.$ = async selector => STOP_RE.test(selector) ? (clock.now === t0 ? {} : null) : base(selector);
      await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
      assert.deepEqual(p.actions.filter(a => a === 'reload'), ['reload']);
    });
});

test('raw SSE chunks (reasoning, no answer text) count as progress', async () => {
  await fixture({}, async ({ chat, page, queue, clock }) => {
    const { p, slot, capture } = await setup(chat, page, queue);
    const t0 = clock.now;
    const wait = p.waitForTimeout.bind(p);
    p.waitForTimeout = async ms => {
      await wait(ms);
      if (clock.now - t0 < 6000) chat._test.acceptSseChunk(slot, 'gwg-reasoning', ': keep-alive\n\n');
      else { p.sends = 1; p.scenario.answer = true; }
    };
    const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture }));
    assert.equal(result.text, 'answer');
    assert.ok(capture.lastChunkAt > t0);
    assert.deepEqual(p.actions.filter(a => a === 'reload'), [], 'chunks keep the rescue away too');
  });
});

for (const [mode, windows] of [['extra_high', 3], ['pro', 3], ['extended', 2], ['instant', 1]]) {
  test(`stall window for ${mode} is ${windows} x CHAT_STALL_WINDOW_SEC`, async () => {
    await fixture({}, async ({ chat, page, queue }) => {
      const { p, capture } = await setup(chat, page, queue);
      await logs(() => assert.rejects(
        chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: mode }),
        e => e.code === 'timeout' && e.message.includes(`no progress for ${3 * windows}s`)));
    });
  });
}

test('an open stream extends the deadline even when the Stop probe misses', async () => {
  await fixture({ CHAT_COMPLETION_TIMEOUT_SEC: '5', CHAT_COMPLETION_RETRY_TIMEOUT_SEC: '6' },
    async ({ chat, page, queue, clock }) => {
      const { p, slot, capture } = await setup(chat, page, queue);
      let finish;
      p.emit('response', response({ text: () => new Promise(resolve => { finish = resolve; }) }));
      await flush();
      const t0 = clock.now;
      const wait = p.waitForTimeout.bind(p);
      p.waitForTimeout = async ms => {
        await wait(ms);
        if (clock.now - t0 < 7000) chat._test.acceptSseChunk(slot, 'gwg-live', ': tick\n\n');
        else { p.sends = 1; p.scenario.answer = true; }
      };
      try {
        const { result, output } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture }));
        assert.equal(result.text, 'answer');
        assert.match(output, /still generating — extending/);
      } finally { finish(''); await flush(); }
    });
});

// ---- composer overlay ----
function overlayPage(probes, { closeWorks = true } = {}) {
  const calls = [];
  return {
    calls,
    keyboard: { press: async key => { calls.push(`key:${key}`); } },
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      if (fn.name !== 'composerCoverProbe' && fn.name !== 'clickOverlayDismiss') return undefined;
      calls.push(`eval:${fn.name}`);
      assert.equal(typeof arg, 'string', 'browser functions receive the composer selector');
      return fn.name === 'composerCoverProbe' ? probes.shift() : closeWorks;
    },
  };
}
const covered = { covered: true, by: 'img.w-full src=https://example/thinking-effort.png' };

test('an uncovered composer is left alone (no Escape)', async () => {
  const chat = require('../src/chatgpt');
  const p = overlayPage([{ covered: false }]);
  assert.equal(await chat._test.dismissBlockingOverlay(p), false);
  assert.deepEqual(p.calls, ['eval:composerCoverProbe']);
});

test('a covering overlay is closed with Escape first', async () => {
  const chat = require('../src/chatgpt');
  const p = overlayPage([covered, { covered: false }]);
  const { result, output } = await logs(() => chat._test.dismissBlockingOverlay(p));
  assert.equal(result, true);
  assert.deepEqual(p.calls, ['eval:composerCoverProbe', 'key:Escape', 'eval:composerCoverProbe']);
  assert.match(output, /composer covered by img\.w-full .*thinking-effort/);
  assert.match(output, /overlay dismissed \(Escape\)/);
});

test('when Escape does not help, the overlay dismiss button is clicked', async () => {
  const chat = require('../src/chatgpt');
  const p = overlayPage([covered, covered, { covered: false }]);
  const { result, output } = await logs(() => chat._test.dismissBlockingOverlay(p));
  assert.equal(result, true);
  assert.deepEqual(p.calls, ['eval:composerCoverProbe', 'key:Escape', 'eval:composerCoverProbe',
    'eval:clickOverlayDismiss', 'eval:composerCoverProbe']);
  assert.match(output, /overlay dismissed \(close button\)/);
});

test('an overlay that will not go away is reported, never thrown', async () => {
  const chat = require('../src/chatgpt');
  const p = overlayPage([covered, covered], { closeWorks: false });
  const { result, output } = await logs(() => chat._test.dismissBlockingOverlay(p));
  assert.equal(result, false);
  assert.match(output, /composer still covered by img\.w-full/);
});

test('dismissModals runs the overlay check', async () => {
  const chat = require('../src/chatgpt');
  const p = overlayPage([covered, { covered: false }]);
  await logs(() => chat._test.dismissModals(p));
  assert.ok(p.calls.includes('key:Escape'));
});
