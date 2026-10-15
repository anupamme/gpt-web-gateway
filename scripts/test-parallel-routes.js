// Router over HTTP with chatgpt replaced by a stub. No browser.
const assert = require('assert');
const http = require('http');
const Module = require('module');
const express = require('express');

const chatgptPath = require.resolve('../src/chatgpt');
const bridge = {
  async completeText(prompt, options) {
    if (options && typeof options.beforeSubmit === 'function') await options.beforeSubmit();
    return {
      text: 'ok',
      conversation_id: null,
      applied: { thinking: false, thinking_mode: 'instant' },
    };
  },
};
const stub = {
  READ_VIA_BACKEND_API: true,
  setPoolHooks() {},
  getPoolHooks() { return null; },
  generateImage: async () => ({ contentType: 'image/png', url: 'http://example.invalid/img' }),
  editImage: async () => ({ contentType: 'image/png', url: 'http://example.invalid/img' }),
  completeText: (prompt, options) => bridge.completeText(prompt, options),
  probeCapabilities: async () => ({
    thinking: false, thinking_mode: false, web_search: false, reference_images: false,
  }),
  resetPage() {},
  resetAllSlotPages() {},
};
const cached = new Module(chatgptPath);
cached.filename = chatgptPath;
cached.loaded = true;
cached.exports = stub;
require.cache[chatgptPath] = cached;

const ENV_KEYS = ['MAX_CONCURRENT_JOBS', 'MAX_QUEUE_SIZE', 'MIN_TURN_STAGGER_SEC', 'MIN_JOB_GAP_SEC'];
const tests = [];
const add = (name, fn) => tests.push([name, fn]);

function loadRouter(env) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = String(env[key]);
  }
  const imagesPath = require.resolve('../src/routes/images');
  delete require.cache[imagesPath];
  const mod = require('../src/routes/images');
  return {
    router: mod,
    restore() {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    },
  };
}

function listen(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(port, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: data === null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (raw) {
          try { json = JSON.parse(raw); } catch { json = { raw }; }
        }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${method} ${path}`)));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

async function waitUntil(pred, label) {
  const deadline = Date.now() + 2000;
  let last = null;
  while (Date.now() < deadline) {
    last = await pred();
    if (last === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function withRouter(env, fn) {
  const loaded = loadRouter(env);
  const server = await listen(loaded.router);
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    loaded.restore();
    // close() alone waits for open sockets. A failed assertion leaves the held
    // jobs' connections open, so the throw never reaches the runner and a
    // mutation harness scores the hang as a survivor.
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

const CONV_A = '1f0e4b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const CONV_B = '22222222-3333-4444-8555-666666666666';

add('three texts run together and the fourth waits', async () => {
  let entered = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  bridge.completeText = async (prompt, options) => {
    entered += 1;
    await hold;
    if (options.beforeSubmit) await options.beforeSubmit();
    return { text: prompt, conversation_id: null, applied: { thinking: false, thinking_mode: 'instant' } };
  };
  await withRouter({
    MAX_CONCURRENT_JOBS: 3, MAX_QUEUE_SIZE: 5, MIN_TURN_STAGGER_SEC: 0, MIN_JOB_GAP_SEC: 0,
  }, async (port) => {
    const pending = [1, 2, 3, 4].map((n) => request(port, 'POST', '/v1/chat/completions', { input: `t${n}` }));
    await waitUntil(() => entered === 3, 'three entries');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(entered, 3, 'the fourth must not enter completeText yet');
    release();
    const results = await Promise.all(pending);
    assert.strictEqual(entered, 4);
    for (const result of results) assert.strictEqual(result.status, 200);
  });
});

add('a full waiting list is 429 queue_full with Retry-After for two waiters', async () => {
  let entered = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  bridge.completeText = async () => {
    entered += 1;
    await hold;
    return { text: 'ok', conversation_id: null, applied: { thinking: false, thinking_mode: 'instant' } };
  };
  await withRouter({
    MAX_CONCURRENT_JOBS: 3, MAX_QUEUE_SIZE: 2, MIN_TURN_STAGGER_SEC: 0, MIN_JOB_GAP_SEC: 60,
  }, async (port) => {
    const pending = [1, 2, 3, 4, 5].map((n) => request(port, 'POST', '/v1/chat/completions', { input: `q${n}` }));
    await waitUntil(async () => {
      if (entered !== 3) return false;
      const status = await request(port, 'GET', '/v1/images/status');
      return status.json.running === 3 && status.json.waiting === 2;
    }, '3 running and 2 waiting');
    const rejected = await request(port, 'POST', '/v1/chat/completions', { input: 'overflow' });
    assert.strictEqual(rejected.status, 429);
    assert.strictEqual(rejected.json.error_kind, 'queue_full');
    assert.strictEqual(rejected.headers['retry-after'], '120');
    release();
    const results = await Promise.all(pending);
    for (const result of results) assert.strictEqual(result.status, 200);
  });
});

add('the same conversation_id does not run on two slots', async () => {
  const started = [];
  let releaseA;
  const holdA = new Promise((resolve) => { releaseA = resolve; });
  bridge.completeText = async (prompt, options) => {
    started.push(prompt);
    if (prompt === 'A' || prompt === 'A-again') await holdA;
    if (options.beforeSubmit) await options.beforeSubmit();
    return { text: prompt, conversation_id: null, applied: { thinking: false, thinking_mode: 'instant' } };
  };
  await withRouter({
    MAX_CONCURRENT_JOBS: 3, MAX_QUEUE_SIZE: 5, MIN_TURN_STAGGER_SEC: 0, MIN_JOB_GAP_SEC: 0,
  }, async (port) => {
    const a = request(port, 'POST', '/v1/chat/completions', { input: 'A', conversation_id: CONV_A });
    // Dropped sockets reject these. A handler keeps that from being unhandled
    // when an assertion fails and the server closes in-flight connections.
    a.catch(() => {});
    try {
      await waitUntil(() => started.includes('A'), 'A started');
      const again = request(port, 'POST', '/v1/chat/completions', {
        input: 'A-again', conversation_id: CONV_A.toUpperCase(),
      });
      const b = request(port, 'POST', '/v1/chat/completions', { input: 'B', conversation_id: CONV_B });
      again.catch(() => {});
      b.catch(() => {});
      await waitUntil(() => started.includes('B'), 'B started');
      // A free slot would have started the second copy by now. It must still be
      // waiting, and the busy tab must be the one that owns this conversation.
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.ok(!started.includes('A-again'), `same conversation overlapped: ${started.join(',')}`);
      const status = await request(port, 'GET', '/v1/images/status', undefined, 1000);
      assert.strictEqual(status.json.waiting, 1, JSON.stringify(status.json));
      assert.ok(
        status.json.slots.some((slot) => slot.busy && slot.key === CONV_A),
        JSON.stringify(status.json.slots),
      );
      releaseA();
      const results = await Promise.race([
        Promise.all([a, again, b]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('conversation requests hung')), 2000)),
      ]);
      for (const result of results) assert.strictEqual(result.status, 200);
      assert.ok(started.indexOf('A-again') > started.indexOf('A'));
    } finally {
      releaseA();
    }
  });
});

add('beforeSubmit paces a second slot by the stagger', async () => {
  const times = [];
  bridge.completeText = async (prompt, options) => {
    await options.beforeSubmit();
    times.push(Date.now());
    return { text: prompt, conversation_id: null, applied: { thinking: false, thinking_mode: 'instant' } };
  };
  await withRouter({
    MAX_CONCURRENT_JOBS: 2, MAX_QUEUE_SIZE: 2, MIN_TURN_STAGGER_SEC: '0.08', MIN_JOB_GAP_SEC: 0,
  }, async (port) => {
    const pending = ['s1', 's2'].map((input) => request(port, 'POST', '/v1/chat/completions', { input }));
    const results = await Promise.all(pending);
    for (const result of results) assert.strictEqual(result.status, 200);
    assert.strictEqual(times.length, 2);
    const gap = times[1] - times[0];
    assert.ok(gap >= 70, `second beforeSubmit returned after ${gap}ms, stagger is 80ms`);
  });
});

add('a cooldown armed by one job refuses the next inside beforeSubmit', async () => {
  let releaseB;
  const holdB = new Promise((resolve) => { releaseB = resolve; });
  let hookError = null;
  bridge.completeText = async (prompt, options) => {
    if (prompt === 'A') throw new Error('You have hit the rate limit for image generation');
    await holdB;
    try {
      await options.beforeSubmit();
    } catch (err) {
      hookError = err;
      throw err;
    }
    return { text: 'sent', conversation_id: null, applied: { thinking: false, thinking_mode: 'instant' } };
  };
  await withRouter({
    MAX_CONCURRENT_JOBS: 2, MAX_QUEUE_SIZE: 2, MIN_TURN_STAGGER_SEC: 0, MIN_JOB_GAP_SEC: 0,
  }, async (port) => {
    const b = request(port, 'POST', '/v1/chat/completions', { input: 'B' });
    await waitUntil(async () => {
      const status = await request(port, 'GET', '/v1/images/status');
      return status.json.running === 1;
    }, 'B running');
    const a = await request(port, 'POST', '/v1/chat/completions', { input: 'A' });
    assert.strictEqual(a.status, 429);
    assert.strictEqual(a.json.error_kind, 'rate_limit');
    releaseB();
    const bResult = await b;
    assert.strictEqual(bResult.status, 429);
    assert.strictEqual(bResult.json.error_kind, 'rate_limit');
    assert.ok(hookError, 'the refusal must come from beforeSubmit');
    assert.strictEqual(hookError.code, 'rate_limit');
    assert.notStrictEqual(bResult.json.output_text, 'sent');
  });
});

add('retryAfterMaintenance puts the same job back at the head', async () => {
  const order = [];
  let aRuns = 0;
  let releaseA;
  const holdA = new Promise((resolve) => { releaseA = resolve; });
  bridge.completeText = async (prompt, options) => {
    order.push(prompt);
    if (prompt === 'A') {
      aRuns += 1;
      if (aRuns === 1) {
        await holdA;
        const err = new Error('page failed before submit');
        err.code = 'page_load_failed';
        err.retryAfterMaintenance = true;
        throw err;
      }
    }
    if (options.beforeSubmit) await options.beforeSubmit();
    return { text: prompt, conversation_id: null, applied: { thinking: false, thinking_mode: 'instant' } };
  };
  await withRouter({
    MAX_CONCURRENT_JOBS: 1, MAX_QUEUE_SIZE: 5, MIN_TURN_STAGGER_SEC: 0, MIN_JOB_GAP_SEC: 0,
  }, async (port) => {
    const a = request(port, 'POST', '/v1/chat/completions', { input: 'A' });
    await waitUntil(() => order[0] === 'A', 'A started');
    const b = request(port, 'POST', '/v1/chat/completions', { input: 'B' });
    await waitUntil(async () => {
      const status = await request(port, 'GET', '/v1/images/status');
      return status.json.running === 1 && status.json.waiting === 1;
    }, 'B waiting behind A');
    releaseA();
    const results = await Promise.all([a, b]);
    for (const result of results) assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(order, ['A', 'A', 'B']);
  });
});

add('status reports running and waiting slots', async () => {
  let entered = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  bridge.completeText = async () => {
    entered += 1;
    await hold;
    return { text: 'ok', conversation_id: null, applied: { thinking: false, thinking_mode: 'instant' } };
  };
  await withRouter({
    MAX_CONCURRENT_JOBS: 3, MAX_QUEUE_SIZE: 5, MIN_TURN_STAGGER_SEC: 0, MIN_JOB_GAP_SEC: 0,
  }, async (port) => {
    const pending = [1, 2].map((n) => request(port, 'POST', '/v1/chat/completions', { input: `st${n}` }));
    await waitUntil(async () => {
      if (entered !== 2) return false;
      const status = await request(port, 'GET', '/v1/images/status');
      return status.json.running === 2 && status.json.waiting === 0 && status.json.queue_size === 2;
    }, 'two running');
    const status = await request(port, 'GET', '/v1/images/status');
    assert.strictEqual(status.json.running, 2);
    assert.strictEqual(status.json.waiting, 0);
    assert.strictEqual(status.json.concurrency, 3);
    assert.ok(Array.isArray(status.json.slots));
    assert.ok(status.json.pacing);
    release();
    await Promise.all(pending);
  });
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
