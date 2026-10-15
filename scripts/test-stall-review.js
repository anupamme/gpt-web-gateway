const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, response, logs, flush, CONVERSATION } = require('./test-stall-diagnostics');

const empty = () => ({ assistantCount: 0, lastAssistantText: '', bodyTail: '' });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const answer of [true, false]) {
  test(`D1: accepted POST without DOM confirmation sends once (answer=${answer})`, async () => {
    await fixture({ CHATGPT_TEXT_RETRY_ATTEMPTS: '4' }, async ({ chat, page, queue, pages }) => {
      const p = page({ unconfirmed: true, answer,
        onSend: p => p.emit('response', response()) });
      queue.push(p);
      const { output } = await logs(async () => {
        const turn = chat.completeText('hello', { thinkingMode: 'instant' });
        if (answer) assert.equal((await turn).text, 'answer');
        else await assert.rejects(turn, e => e.code === 'timeout' && !e.stallNoAnswer);
      });
      assert.equal(p.sends, 1);
      assert.equal(pages.length, 1, 'accepted POST must bypass pre-submit retries');
      assert.match(output, /Prompt submitted \(confirmed\).*backend/i);
    });
  });
}

test('D1: one stall retry followed by an accepted POST never causes a third send', async () => {
  await fixture({ TEXT_STALL_RETRIES: '1', CHATGPT_TEXT_RETRY_ATTEMPTS: '4' }, async ({ chat, page, queue, pages }) => {
    queue.push(page(), page({ unconfirmed: true, onSend: p => p.emit('response', response()) }));
    await logs(() => assert.rejects(chat.completeText('hello', { thinkingMode: 'instant' }),
      e => e.code === 'timeout' && !e.stallNoAnswer));
    assert.equal(pages.length, 2);
    assert.equal(pages.reduce((n, p) => n + p.sends, 0), 2);
  });
});

test('D1: acceptance arriving at the submit deadline still calls onSubmitted', async () => {
  await fixture({}, async ({ chat, page, queue }) => {
    const p = page({ unconfirmed: true }); queue.push(p);
    const slot = chat.getSlot(0); await chat.getPage(slot);
    const cap = chat._test.beginBackendCapture(slot);
    const wait = p.waitForTimeout.bind(p);
    let confirmationWait = 0;
    p.waitForTimeout = async ms => {
      await wait(ms);
      if (p.sends && ms === 500 && (confirmationWait += ms) === 12000) {
        p.emit('response', response());
      }
    };
    let submitted = 0;
    await chat._test.typeAndSubmit(p, 'hello', false, () => submitted++, null, cap);
    assert.equal(submitted, 1);
    assert.equal(p.sends, 1);
  });
});

for (const hung of ['content', 'screenshot']) {
  test(`D2: hung ${hung} cannot hold stall-abort beyond its snapshot deadline`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-deadline-'));
    try {
      await fixture({ STALL_SNAPSHOTS: '1', DEBUG_SNAPSHOT_DIR: dir }, async ({ chat, page, queue }) => {
        const p = page(); queue.push(p);
        const slot = chat.getSlot(0); await chat.getPage(slot);
        const cap = chat._test.beginBackendCapture(slot);
        const started = deferred(); const body = deferred();
        p[hung] = () => { started.resolve(); return body.promise; };
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let settled = false;
        const waiting = chat._test.waitAndExtractText(p, empty(), { capture: cap })
          .then(() => { throw new Error('expected stall-abort'); }, e => { settled = true; return e; });
        try {
          await started.promise; await flush();
          t.mock.timers.tick(10000); await flush();
          assert.equal(settled, true, 'snapshot deadline must release the stalled turn within 10s');
          assert.equal((await waiting).code, 'timeout');
        } finally {
          body.resolve(''); await waiting;
          t.mock.timers.reset();
        }
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('D3: replaced-page POST, SSE and GET responses cannot affect the current turn', async () => {
  await fixture({}, async ({ chat, page, queue }) => {
    const old = page(); queue.push(old);
    const slot = chat.getSlot(0); await chat.getPage(slot);
    chat.resetPage(slot);
    const current = page(); queue.push(current); await chat.getPage(slot);
    const cap = chat._test.beginBackendCapture(slot);
    const { output } = await logs(async () => {
      old.emit('response', response({ status: 429, ct: 'application/json', text: async () => 'late rejection' }));
      old.emit('response', response({ text: async () => 'data: {"conversation_id":"' + CONVERSATION
        + '","message":{"id":"late","author":{"role":"assistant"},"content":{"content_type":"text","parts":["old answer"]},"status":"finished_successfully"}}\n\n' }));
      old.emit('response', response({ method: 'GET', url: `/backend-api/conversation/${CONVERSATION}`,
        data: { current_node: 'last', mapping: { last: { message: { author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['old GET answer'] } } } } } }));
      await flush();
    });
    assert.equal(cap.postFailure, undefined);
    assert.equal(cap.postStatus, undefined);
    assert.equal(cap.postAccepted, undefined);
    assert.equal(cap.text, '');
    assert.equal(slot.lastConversationFetch, null);
    assert.doesNotMatch(output, /conversation GET/);
    current.scenario.answer = true; current.sends = 1;
    assert.equal((await chat._test.waitAndExtractText(current, empty(), { capture: cap })).text, 'answer');
  });
});

test('D3: replacing the page while GET/SSE bodies are pending ignores their late data', async () => {
  await fixture({}, async ({ chat, page, queue }) => {
    const old = page(); queue.push(old);
    const slot = chat.getSlot(0); await chat.getPage(slot);
    const cap = chat._test.beginBackendCapture(slot);
    const get = deferred(); const sse = deferred();
    const pendingGet = response({ method: 'GET', url: `/backend-api/conversation/${CONVERSATION}` });
    pendingGet.json = () => get.promise;
    old.emit('response', pendingGet);
    old.emit('response', response({ text: () => sse.promise }));
    chat.resetPage(slot);
    const current = page(); queue.push(current); await chat.getPage(slot);
    const next = chat._test.beginBackendCapture(slot);
    const { output } = await logs(async () => {
      get.resolve({ current_node: 'last', mapping: { last: { message: { author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['stale'] } } } } });
      sse.resolve('data: {"message":{"id":"old","author":{"role":"assistant"},"content":{"content_type":"text","parts":["stale"]}}}\n\n');
      await flush();
    });
    assert.equal(cap.text, '');
    assert.equal(next.text, '');
    assert.equal(slot.lastConversationFetch, null);
    assert.doesNotMatch(output, /conversation GET/);
  });
});

test('D4: concurrent snapshots retain only the newer complete pair', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-rotation-'));
  try {
    await fixture({ STALL_SNAPSHOTS: '1', STALL_SNAPSHOT_KEEP: '1', DEBUG_SNAPSHOT_DIR: dir }, async ({ chat, page, clock }) => {
      const old = page(); const newer = page();
      const started = deferred(); const content = deferred();
      old.content = () => { started.resolve(); return content.promise; };
      const write = fs.writeFileSync;
      let writes = 0;
      t.mock.method(fs, 'writeFileSync', function(file, ...args) {
        const result = write.call(this, file, ...args);
        // Preserve write order even on filesystems with coarse mtime resolution.
        const at = ++writes * 10;
        fs.utimesSync(file, at, at);
        return result;
      });
      const first = chat._test.saveDebugSnapshot(old, 'text_rescue');
      await started.promise;
      clock.now += 1000;
      const second = chat._test.saveDebugSnapshot(newer, 'text_stalled');
      try { await flush(); } finally { content.resolve('<html>old</html>'); }
      await Promise.all([first, second]);
      const files = fs.readdirSync(dir).sort();
      assert.equal(files.length, 2);
      assert.ok(files.every(f => f.includes('text_stalled')), 'retain the newer snapshot, including both files');
      assert.equal(files[0].replace(/\.(html|png)$/, ''), files[1].replace(/\.(html|png)$/, ''));
      assert.ok(files[0].endsWith('.html')); assert.ok(files[1].endsWith('.png'));
    });
  } finally { t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('D4: a failed snapshot does not poison the save queue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-queue-error-'));
  try {
    await fixture({ STALL_SNAPSHOTS: '1', STALL_SNAPSHOT_KEEP: '1', DEBUG_SNAPSHOT_DIR: dir }, async ({ chat, page }) => {
      const broken = page(); broken.screenshot = () => { throw new Error('closed page'); };
      await chat._test.saveDebugSnapshot(broken, 'text_rescue');
      await chat._test.saveDebugSnapshot(page(), 'text_stalled');
      assert.equal(fs.readdirSync(dir).filter(f => f.includes('text_stalled')).length, 2);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
