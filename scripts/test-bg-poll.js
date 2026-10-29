// Background-answer poll (2.16.4): when ChatGPT closes the response stream before the answer
// and finishes the turn server-side, the gateway reads the conversation from inside the page
// instead of reloading it (2026-10-29: reload → stall → 504 on extra_high). Real adapter; only
// browser, clock and the page's fetch are replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, logs, CONVERSATION } = require('./test-stall-diagnostics');

const empty = () => ({ assistantCount: 0, lastAssistantText: '', bodyTail: '' });
const NOW = 1_800_000_000_000;
const ENV = { CHAT_BG_POLL_INTERVAL_SEC: '15', CHAT_BG_POLL_HEAVY_SEC: '120', CHAT_BG_POLL_THINKING_SEC: '90',
  CHAT_BG_POLL_SEC: '60', CHAT_STALL_WINDOW_SEC: '3', CHAT_STREAM_RESCUE_SEC: '1' };

function node(id, parent, role, text, { at = NOW / 1000, status = 'finished_successfully', channel } = {}) {
  return { id, parent, children: [], message: { id, author: { role }, create_time: at,
    content: { content_type: 'text', parts: [text] }, status, channel, metadata: {} } };
}
// previous turn (old) → this turn's prompt → optional answer.
function conversation({ answer = null, complete = false, promptAt = NOW / 1000, withPrompt = true } = {}) {
  const mapping = {
    root: { id: 'root', parent: null, children: [], message: null },
    u0: node('u0', 'root', 'user', 'old question', { at: NOW / 1000 - 3600 }),
    a0: node('a0', 'u0', 'assistant', 'old answer', { at: NOW / 1000 - 3590 }),
  };
  let current = 'a0';
  if (withPrompt) { mapping.u1 = node('u1', 'a0', 'user', 'new question', { at: promptAt }); current = 'u1'; }
  if (answer !== null) {
    mapping.a1 = node('a1', current, 'assistant', answer, { status: complete ? 'finished_successfully' : 'in_progress' });
    current = 'a1';
  }
  return { conversation_id: CONVERSATION, current_node: current, mapping };
}
const ok = data => ({ ok: true, path: '/backend-api/conversation/{id}', token: true, streamStatus: '200 {}', data });

async function setup(chat, page, queue, clock, polls) {
  const p = page({}); queue.push(p);
  const slot = chat.getSlot(0); await chat.getPage(slot);
  p.address = `https://chatgpt.com/c/${CONVERSATION}`;
  clock.now = NOW;
  const capture = chat._test.beginBackendCapture(slot);
  const base = p.evaluate.bind(p);
  p.pollTimes = [];
  p.pollArgs = [];
  p.evaluate = async (fn, arg) => {
    if (fn.name !== 'conversationPollInPage') return base(fn, arg);
    p.pollTimes.push(clock.now);
    p.pollArgs.push(arg);
    const next = polls.length > 1 ? polls.shift() : polls[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { p, slot, capture };
}

test('a closed stream is answered from the conversation poll, without a reload', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const polls = [ok(conversation()), ok(conversation({ answer: 'part' })),
      ok(conversation({ answer: 'full answer', complete: true }))];
    const { p, capture } = await setup(chat, page, queue, clock, polls);
    const deltas = [];
    const { result, output } = await logs(() => chat._test.waitAndExtractText(p, empty(),
      { capture, thinkingMode: 'extra_high', onDelta: t => deltas.push(t) }));
    assert.equal(result.text, 'full answer');
    assert.equal(result.conversationId, CONVERSATION);
    assert.deepEqual(p.actions.filter(a => a === 'reload'), [], 'no reload');
    assert.equal(p.pollTimes.length, 3);
    assert.deepEqual(p.pollTimes.slice(1).map((t, i) => t - p.pollTimes[i]), [15000, 15000], 'one poll per interval');
    assert.equal(p.pollArgs[0].id, CONVERSATION);
    assert.deepEqual(deltas, ['full answer'], 'only the finished text reaches the client');
    assert.doesNotMatch(output, /session degraded/);
    assert.match(output, /\[bg-poll\] answer taken from conversation poll \(11 chars/);
  });
});

test('the poll outlives the stall window and the base deadline', async () => {
  await fixture({ ...ENV, CHAT_COMPLETION_TIMEOUT_SEC: '10', CHAT_COMPLETION_RETRY_TIMEOUT_SEC: '5' },
    async ({ chat, page, queue, clock }) => {
      const { p, capture } = await setup(chat, page, queue, clock,
        [() => ok(conversation(clock.now - NOW > 100000 ? { answer: 'late', complete: true } : {}))]);
      const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'extra_high' }));
      assert.equal(result.text, 'late');
      assert.ok(clock.now - NOW > 100000, 'waited past stall window (9s) and deadline (10s)');
    });
});

test('the previous turn of a continuation is never returned as this answer', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    // The new prompt is not on the active branch yet: current_node is the old, complete answer.
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation({ withPrompt: false }))]);
    const { output } = await logs(() => assert.rejects(
      chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'instant' }),
      e => e.code === 'timeout' && /within 60s after submit \(background poll/.test(e.message)));
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
    assert.match(output, /turn=no chars=0/);
  });
});

test('a user message older than this turn does not count as the prompt', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const old = conversation({ answer: 'stale', complete: true, promptAt: NOW / 1000 - 600 });
    const { p, capture } = await setup(chat, page, queue, clock, [ok(old)]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture }), e => e.code === 'timeout'));
    assert.ok(p.pollTimes.length > 1);
  });
});

for (const [mode, sec] of [['extra_high', 120], ['pro', 120], ['high', 90], ['instant', 60]]) {
  test(`poll budget for ${mode} is ${sec}s after submit`, async () => {
    await fixture(ENV, async ({ chat, page, queue, clock }) => {
      const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation())]);
      await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: mode }),
        e => e.code === 'timeout' && e.message.includes(`within ${sec}s after submit`)));
      assert.ok(clock.now - NOW >= sec * 1000 && clock.now - NOW < sec * 1000 + 2000);
    });
  });
}

test('a refused poll (401/404) falls back to the reload rescue', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const refused = { ok: false, token: true, tried: [{ path: 'a', status: 404 }, { path: 'b', status: 401 }] };
    const { p, capture } = await setup(chat, page, queue, clock, [refused]);
    const { output } = await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
    assert.equal(p.pollTimes.length, 1, 'no second poll after a refusal');
    assert.deepEqual(p.actions.filter(a => a === 'reload'), ['reload']);
    assert.match(output, /falling back to the reload rescue/);
  });
});

test('an unknown payload shape falls back to the reload rescue', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const shape = { ok: false, token: true, tried: [{ path: 'a', status: 200, shape: 'items,total' }] };
    const { p, capture } = await setup(chat, page, queue, clock, [shape]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
    assert.deepEqual(p.actions.filter(a => a === 'reload'), ['reload']);
  });
});

test('transient poll errors are retried, then fall back to reload after three', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const flaky = { ok: false, token: true, tried: [{ path: 'a', status: 502 }] };
    const { p, capture } = await setup(chat, page, queue, clock, [new Error('Execution context was destroyed'), flaky, flaky]);
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
    assert.equal(p.pollTimes.length, 3);
    assert.deepEqual(p.actions.filter(a => a === 'reload'), ['reload']);
  });
});

test('one transient error does not stop the poll', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock,
      [new Error('net'), new Error('net'), ok(conversation({ answer: 'done', complete: true }))]);
    const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture }));
    assert.equal(result.text, 'done');
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
  });
});

test('an open response stream still defers everything: no poll, no reload', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation({ answer: 'x', complete: true }))]);
    capture.openStreams = 1;
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture, thinkingMode: 'instant' })));
    assert.equal(p.pollTimes.length, 0);
    assert.deepEqual(p.actions.filter(a => a === 'reload'), []);
  });
});

test('without a conversation id the poll is not attempted', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation({ answer: 'x', complete: true }))]);
    p.address = 'https://chatgpt.com/';
    await logs(() => assert.rejects(chat._test.waitAndExtractText(p, empty(), { capture })));
    assert.equal(p.pollTimes.length, 0);
  });
});

test('the conversation id from the stream is enough when the URL has none', async () => {
  await fixture(ENV, async ({ chat, page, queue, clock }) => {
    const { p, capture } = await setup(chat, page, queue, clock, [ok(conversation({ answer: 'y', complete: true }))]);
    p.address = 'https://chatgpt.com/';
    capture.conversationId = CONVERSATION;
    const { result } = await logs(() => chat._test.waitAndExtractText(p, empty(), { capture }));
    assert.equal(result.text, 'y');
  });
});

// ---- the in-page function, against a stubbed fetch ----
function stubFetch(routes) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, auth: init.headers && init.headers.Authorization, credentials: init.credentials });
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { calls, restore: () => { global.fetch = original; } };
}
const args = { id: CONVERSATION, paths: ['/backend-api/conversation/{id}', '/backend-api/conversations/{id}'], timeoutMs: 1000 };

test('in-page poll: bearer token, fallback path, branch trimmed to this turn, stream status', async () => {
  const chat = require('../src/chatgpt');
  const data = conversation({ answer: 'a', complete: true });
  data.mapping.side = node('side', 'a0', 'user', 'abandoned');
  const f = stubFetch({
    '/api/auth/session': { status: 200, body: { accessToken: 'tok' } },
    [`/backend-api/conversations/${CONVERSATION}`]: { status: 200, body: data },
    [`/backend-api/conversation/${CONVERSATION}/stream_status`]: { status: 200, body: { status: 'done' } },
  });
  try {
    const r = await chat._test.conversationPollInPage(args);
    assert.equal(r.ok, true);
    assert.equal(r.path, '/backend-api/conversations/{id}');
    assert.deepEqual(Object.keys(r.data.mapping).sort(), ['a1', 'u1'], 'only the active branch down to the prompt');
    assert.equal(r.streamStatus, '200 {"status":"done"}');
    const backend = f.calls.filter(c => c.url.startsWith('/backend-api/'));
    assert.ok(backend.every(c => c.auth === 'Bearer tok' && c.credentials === 'include'));
    assert.equal(f.calls[1].url, `/backend-api/conversation/${CONVERSATION}`, 'classic path tried first');
  } finally { f.restore(); }
});

test('in-page poll: refusals and unknown shapes are reported, not thrown', async () => {
  const chat = require('../src/chatgpt');
  const f = stubFetch({
    '/api/auth/session': new Error('offline'),
    [`/backend-api/conversation/${CONVERSATION}`]: { status: 401, body: {} },
    [`/backend-api/conversations/${CONVERSATION}`]: { status: 200, body: { items: [] } },
  });
  try {
    const r = await chat._test.conversationPollInPage(args);
    assert.equal(r.ok, false);
    assert.equal(r.token, false);
    assert.deepEqual(r.tried, [{ path: args.paths[0], status: 401 }, { path: args.paths[1], status: 200, shape: 'items' }]);
    assert.equal(f.calls[1].auth, undefined, 'no token, no Authorization header');
  } finally { f.restore(); }
});

test('pollConversation classifies refusal, transient failure and a missing page result', async () => {
  const chat = require('../src/chatgpt');
  const pageWith = result => ({ evaluate: async () => (result instanceof Error ? Promise.reject(result) : result) });
  const kind = async r => (await chat._test.pollConversation(pageWith(r), CONVERSATION, NOW)).kind;
  assert.equal(await kind({ ok: false, tried: [{ status: 403 }, { status: 404 }] }), 'unsupported');
  assert.equal(await kind({ ok: false, tried: [{ status: 404 }, { status: 500 }] }), 'error');
  assert.equal(await kind({ ok: false, tried: [{ error: 'aborted' }] }), 'error');
  assert.equal(await kind({ ok: false, tried: [] }), 'error');
  assert.equal(await kind(new Error('closed')), 'error');
  assert.equal(await kind(undefined), 'unsupported');
  assert.equal(await kind(ok({ mapping: {} })), 'unsupported');
  const r = await chat._test.pollConversation(pageWith(ok(conversation({ answer: 'z', complete: true }))), CONVERSATION, NOW);
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.snap, { conversationId: CONVERSATION, turnFound: true, lastAssistantText: 'z', isComplete: true });
});
