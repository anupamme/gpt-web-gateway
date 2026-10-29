// Offline browser check of the composer-overlay probe and dismiss click (2026-10-28 promo
// beacon intercepted every click on the editor). Needs a Playwright Chromium, like
// scripts/test-visible-stop.js; the Node-side flow is covered in test-rescue-gate.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { COMPOSER_SEL } = require('../src/composer-dom');
const { _test: { composerCoverProbe, clickOverlayDismiss } } = require('../src/chatgpt');

const composer = '<form data-chatgpt-composer style="position:fixed;bottom:20px;left:20px;width:600px;height:60px">'
  + '<div contenteditable="true" role="textbox" style="width:100%;height:100%"><p style="margin:0;height:100%">placeholder</p></div></form>';
const promo = (buttons) => '<div class="contents"><div role="dialog" style="position:fixed;inset:0;background:#fff8">'
  + '<img class="w-full object-contain" src="https://example.invalid/beacons/chat-work-merge/thinking-effort.png" style="position:absolute;inset:0;width:100%;height:100%">'
  + `<div style="position:absolute;top:10px;left:10px;z-index:2">${buttons}</div></div></div>`;

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); });

async function withDom(html, fn) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  try { await page.setContent(html); await fn(page); } finally { await page.close(); }
}

test('a free composer is not covered, even with a child under the click point', async () => {
  await withDom(composer, async page => {
    assert.deepEqual(await page.evaluate(composerCoverProbe, COMPOSER_SEL), { covered: false });
  });
});

test('a pointer-transparent overlay does not count as covering', async () => {
  await withDom(composer + '<div style="position:fixed;inset:0;pointer-events:none"></div>', async page => {
    assert.equal((await page.evaluate(composerCoverProbe, COMPOSER_SEL)).covered, false);
  });
});

test('the promo image is reported as covering, and its Close button is clicked', async () => {
  const buttons = '<button onclick="this.closest(\'.contents\').remove()">Close</button>'
    + '<button onclick="window.cta = 1">Try thinking effort</button>';
  await withDom(composer + promo(buttons), async page => {
    const probe = await page.evaluate(composerCoverProbe, COMPOSER_SEL);
    assert.equal(probe.covered, true);
    assert.match(probe.by, /^img\.w-full.*thinking-effort\.png/);
    assert.equal(await page.evaluate(clickOverlayDismiss, COMPOSER_SEL), true);
    assert.equal((await page.evaluate(composerCoverProbe, COMPOSER_SEL)).covered, false);
    assert.equal(await page.evaluate(() => window.cta), undefined, 'the call to action was not clicked');
  });
});

test('an overlay with only a call to action is not clicked', async () => {
  await withDom(composer + promo('<button onclick="window.cta = 1">Try it now</button>'), async page => {
    assert.equal(await page.evaluate(clickOverlayDismiss, COMPOSER_SEL), false);
    assert.equal(await page.evaluate(() => window.cta), undefined);
  });
});

test('an icon-only close button is found by its aria-label', async () => {
  const buttons = '<button aria-label="Закрыть" onclick="this.closest(\'.contents\').remove()">×</button>';
  await withDom(composer + promo(buttons), async page => {
    assert.equal(await page.evaluate(clickOverlayDismiss, COMPOSER_SEL), true);
    assert.equal((await page.evaluate(composerCoverProbe, COMPOSER_SEL)).covered, false);
  });
});

test('a visibility:hidden duplicate composer is skipped for the real one', async () => {
  const hiddenDup = '<div contenteditable="true" data-composer-markdown role="textbox" style="position:fixed;top:0;left:0;width:300px;height:40px;visibility:hidden"></div>';
  await withDom(hiddenDup + composer + promo('<button>Close</button>'), async page => {
    const probe = await page.evaluate(composerCoverProbe, COMPOSER_SEL);
    assert.equal(probe.covered, true, 'probe must look at the visible composer under the promo');
  });
  await withDom(hiddenDup.replace('top:0', 'top:500px') + composer, async page => {
    assert.equal((await page.evaluate(composerCoverProbe, COMPOSER_SEL)).covered, false);
  });
});

test('a visibility:hidden close button is passed over for the visible one', async () => {
  const buttons = '<button style="visibility:hidden" onclick="window.hidden = 1">Close</button>'
    + '<button onclick="this.closest(\'.contents\').remove()">Not now</button>';
  await withDom(composer + promo(buttons), async page => {
    assert.equal(await page.evaluate(clickOverlayDismiss, COMPOSER_SEL), true);
    assert.equal(await page.evaluate(() => window.hidden), undefined);
    assert.equal((await page.evaluate(composerCoverProbe, COMPOSER_SEL)).covered, false);
  });
});

test('a bare OK in a confirmation dialog is never clicked', async () => {
  for (const label of ['OK', 'Okay', 'ОК']) {
    await withDom(composer + promo(`<button onclick="window.confirmed = 1">${label}</button>`), async page => {
      assert.equal(await page.evaluate(clickOverlayDismiss, COMPOSER_SEL), false, label);
      assert.equal(await page.evaluate(() => window.confirmed), undefined, label);
    });
  }
});
