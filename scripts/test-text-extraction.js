// The current Chat UI streams behind button[aria-label="Stop"] and adds a
// screen-reader speaker heading outside the assistant markdown. No browser/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { waitAndExtractText, CHAT_COMPLETION_TIMEOUT_MS } } = require('../src/chatgpt');

async function withPage({ partial = '{"criteria":', complete = '{"criteria":[]}', finishAt = 12,
                          legacy = false }, fn) {
  const originalNow = Date.now;
  const originalDocument = global.document;
  let tick = 0;
  Date.now = () => 100000 + tick * 1000;
  const text = () => tick < finishAt ? partial : complete;
  const content = { get innerText() { return text(); } };
  const message = {
    get innerText() { return legacy ? text() : 'ChatGPT said:\n\n' + text(); },
    querySelector: (selector) => selector.includes('assistant-message') || selector.includes('.markdown')
      ? content : null,
  };
  global.document = {
    body: { get innerText() { return text(); } },
    querySelectorAll: (selector) => selector.includes('data-message-author-role') ? [message] : [],
  };
  const page = {
    evaluate: async (fn) => fn(),
    $: async (selector) => tick < finishAt && selector.includes('button[aria-label="Stop"]') ? {} : null,
    url: () => 'https://chatgpt.com/c/01234567-89ab-4cde-8f01-23456789abcd',
    waitForTimeout: async () => { tick++; },
  };
  try { return await fn(page, () => tick); }
  finally { Date.now = originalNow; global.document = originalDocument; }
}

test('waits through a quiet prefix while the current UI Stop button is present', async () => {
  await withPage({}, async (page, tick) => {
    const r = await waitAndExtractText(page, undefined, { thinkingMode: 'standard' });
    assert.equal(r.text, '{"criteria":[]}');
    assert.ok(tick() >= 12, 'response returned while the answer was still generating');
  });
});

test('extracts assistant markdown without the screen-reader speaker heading', async () => {
  await withPage({ finishAt: 0, complete: '{"status":"OK"}' }, async (page) => {
    const r = await waitAndExtractText(page, undefined, { thinkingMode: 'instant' });
    assert.deepEqual(JSON.parse(r.text), { status: 'OK' });
  });
});

test('preserves literal speaker text in actual assistant content and legacy messages', async () => {
  await withPage({ finishAt: 0, complete: 'ChatGPT said: this is a literal example', legacy: true }, async (page) => {
    const r = await waitAndExtractText(page, undefined, { thinkingMode: 'instant' });
    assert.equal(r.text, 'ChatGPT said: this is a literal example');
  });
});

test('an expired budget cannot return an answer while the UI is still generating', async () => {
  await withPage({ finishAt: Infinity }, async (page) => {
    await assert.rejects(waitAndExtractText(page, undefined, {
      thinkingMode: 'instant', inputMs: CHAT_COMPLETION_TIMEOUT_MS,
    }), (e) => e.code === 'timeout');
  });
});

for (const complete of [true, false]) {
  test(`a hidden workspace Stop does not block ${complete ? 'completion' : 'reload rescue'}`, async () => {
    await withPage({ finishAt: 0, complete: complete ? 'finished answer' : '' }, async page => {
      // Model DOM presence separately from visibility, like a retained workspace.
      page.$ = async selector => selector.split(',').some(s =>
        s.includes('aria-label="Stop"') && !s.trim().endsWith(':visible')) ? {} : null;
      let reloads = 0;
      page.reload = async () => {
        reloads++;
        global.document.querySelectorAll = () => [{ innerText: 'finished answer', querySelector: () => ({ innerText: 'finished answer' }) }];
      };
      const result = await waitAndExtractText(page);
      assert.equal(result.text, 'finished answer');
      assert.equal(reloads, complete ? 0 : 1);
    });
  });
}
