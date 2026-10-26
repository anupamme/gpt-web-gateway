// Offline browser regression: a hidden workspace can retain its Stop button.
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, CONVERSATION } = require('./test-stall-diagnostics');

const answer = '<div data-message-author-role="assistant"><div class="markdown">finished answer</div></div>';
const hidden = '<div style="display:none!important"><button aria-label="Stop">Stop</button></div>';
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); });

async function withDom(html, fn) {
  const real = await browser.newPage();
  await real.route('**/*', route => route.abort());
  try {
    await real.setContent(html);
    await fixture({}, async ({ chat, page, queue }) => {
      const p = page(); queue.push(p);
      await chat.getPage(chat.getSlot(0));
      p.address = `https://chatgpt.com/c/${CONVERSATION}`;
      p.$ = selector => real.$(selector);
      p.evaluate = (fn, arg) => real.evaluate(fn, arg);
      p.reload = async () => { p.actions.push('reload'); await real.setContent(hidden + answer); };
      await fn(chat, p);
    });
  } finally { await real.close(); }
}

test('completed answer ignores a Stop button inside a hidden workspace', async () => {
  await withDom(hidden + answer, async (chat, p) => {
    const result = await chat._test.waitAndExtractText(p);
    assert.equal(result.text, 'finished answer');
    assert.deepEqual(p.actions, []);
  });
});

test('hidden Stop allows one reload to recover the existing answer', async () => {
  await withDom(hidden, async (chat, p) => {
    const result = await chat._test.waitAndExtractText(p);
    assert.equal(result.text, 'finished answer');
    assert.deepEqual(p.actions, ['reload']);
    assert.equal(p.sends, 0, 'rescue must never submit a new prompt');
  });
});

for (const attribute of ['data-testid="stop-button"', 'aria-label="Stop generating"', 'aria-label="Stop"', 'aria-label="Остановить"']) {
  test(`visible ${attribute} after a hidden Stop prevents reload and early completion`, async () => {
    await withDom(hidden + `<button ${attribute}>Stop</button>`, async (chat, p) => {
      await assert.rejects(chat._test.waitAndExtractText(p), e => e.code === 'timeout');
      assert.deepEqual(p.actions, []);
      assert.equal(p.sends, 0);
    });
  });
}
