// Real HTTP disconnects must discard work that no caller can receive.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { once } = require('events');
const chatgpt = require('../src/chatgpt');
let started = [];
let release;
let releaseCleanup;
chatgpt.completeText = async (prompt, { signal }) => {
  started.push(prompt);
  if (prompt.includes('blocked')) await new Promise((resolve) => { release = resolve; });
  if (prompt.includes('abort-running') || prompt.includes('slow-cleanup')) {
    assert.ok(signal, 'active browser work must receive the request signal');
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    if (prompt.includes('slow-cleanup')) await new Promise((resolve) => { releaseCleanup = resolve; });
    signal.throwIfAborted();
  }
  return { text: 'OK', applied: { thinking_mode: 'instant' } };
};
const router = require('../src/routes/images');
const app = express();
app.use(express.json());
app.use(router);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(10); }
  assert.fail('condition never became true');
}
async function main() {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  function request(prompt, headers = {}) {
    const body = JSON.stringify({ messages: [{ role: 'user', content: prompt }], thinking_mode: 'instant' });
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', ...headers } });
    const response = new Promise((resolve, reject) => {
      req.on('response', (res) => { let data = ''; res.on('data', (b) => { data += b; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) })); });
      req.on('error', reject);
    });
    response.catch(() => {});
    req.end(body);
    return { req, response };
  }
  try {
    const active = request('blocked');
    await until(() => started.length === 1);
    const queued = request('abandoned');
    await sleep(30);
    queued.req.destroy();
    await sleep(30);
    release();
    await active.response;
    await sleep(30);
    assert.strictEqual(started.length, 1, 'a disconnected pending request must never reach ChatGPT');
    console.log('PASS: disconnected queued request is skipped');

    const blockedAgain = request('blocked again');
    await until(() => started.some((p) => p.includes('blocked again')));
    const queuedDeadline = await request('expired in queue', { 'X-Request-Timeout-Ms': '40' }).response;
    assert.strictEqual(queuedDeadline.status, 504);
    release();
    await blockedAgain.response;
    await sleep(30);
    assert.ok(!started.some((p) => p.includes('expired in queue')));
    console.log('PASS: deadline includes queue wait and expired work never starts');

    const running = request('abort-running');
    await until(() => started.some((p) => p.includes('abort-running')));
    running.req.destroy();
    await sleep(30);
    const next = await request('next').response;
    assert.strictEqual(next.status, 200);
    console.log('PASS: active work is cancelled and next request proceeds');

    const deadline = await request('abort-running deadline', { 'X-Request-Timeout-Ms': '40' }).response;
    assert.strictEqual(deadline.status, 504);
    assert.strictEqual(deadline.body.error_kind, 'request_timeout');
    assert.strictEqual(deadline.body.should_retry, true);
    assert.strictEqual((await request('after deadline').response).status, 200);
    console.log('PASS: request deadline cancels running work');

    const cleanup = await request('slow-cleanup', { 'X-Request-Timeout-Ms': '40' }).response;
    assert.strictEqual(cleanup.status, 504);
    const waiting = request('wait for browser cleanup');
    await sleep(30);
    assert.ok(!started.some((p) => p.includes('wait for browser cleanup')), 'next job must not overlap cancelled browser work');
    releaseCleanup();
    assert.strictEqual((await waiting.response).status, 200);
    console.log('PASS: deadline responds immediately while browser cleanup retains exclusive ownership');

    for (const invalid of ['0', '-1', '1.2', 'garbage']) {
      assert.strictEqual((await request('invalid', { 'X-Request-Timeout-Ms': invalid }).response).status, 400);
    }
    console.log('PASS: invalid request deadlines are rejected before browser use');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
