const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const { fixture, logs, flush } = require('./test-stall-diagnostics');

async function withRouter(f, fn, { gap = 0 } = {}) {
  const saved = {};
  const env = { MAX_CONCURRENT_JOBS: '2', MAX_QUEUE_SIZE: '5', MIN_JOB_GAP_SEC: String(gap), MIN_TURN_STAGGER_SEC: '0' };
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
  const pacerId = require.resolve('../src/pacer');
  const realPacer = require(pacerId);
  const oldPacer = require.cache[pacerId];
  const finishes = [];
  require.cache[pacerId] = { id: pacerId, filename: pacerId, loaded: true, exports: {
    ...realPacer,
    createTurnGate: options => {
      const gate = realPacer.createTurnGate({ ...options, now: () => f.clock.now, sleep: async ms => { f.clock.now += ms; } });
      const finished = gate.finished;
      gate.finished = slotId => { finishes.push({ slotId, at: f.clock.now }); finished(slotId); };
      return gate;
    },
  } };
  const routerId = require.resolve('../src/routes/images');
  delete require.cache[routerId];
  const app = express(); app.use(express.json()); app.use(require(routerId));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn({ port: server.address().port, finishes }); }
  finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    require.cache[pacerId] = oldPacer; delete require.cache[routerId];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: url,
      headers: body ? { 'content-type': 'application/json' } : {} }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

for (const stream of [false, true]) {
  test(`real ${stream ? 'streaming' : 'JSON'} job paces a stall resend from the previous finish exactly once per attempt`, async () => {
    await fixture({ PAGE_RECYCLE_AFTER_JOBS: '1' }, async f => {
      const stalled = f.page(); const fresh = f.page({ answer: true }); f.queue.push(stalled, fresh);
      await withRouter(f, async ({ port, finishes }) => {
        const result = await request(port, 'POST', '/v1/chat/completions', { input: 'hello', thinking_mode: 'instant', stream });
        assert.equal(result.status, 200, result.text);
        assert.match(result.text, /answer/);
        assert.equal(stalled.sends, 1); assert.equal(fresh.sends, 1);
        assert.equal(finishes.length, 2, 'no extra final finish for the already finished attempt');
        assert.ok(fresh.sentAt[0] - finishes[0].at >= 60000, 'retry ignored MIN_JOB_GAP_SEC');
        const slot = f.chat.getSlot(finishes[0].slotId);
        assert.equal(slot.completedJobs, 1, 'attempts are not jobs');
        assert.equal(slot.pendingReset, 'recycle', 'route must account for the completed job');
      }, { gap: 60 });
    });
  });

  test(`${stream ? 'streaming' : 'JSON'} job retains its stall budget across retryAfterMaintenance`, async () => {
    await fixture({}, async f => {
      f.queue.push(f.page(), f.page(), f.page(), f.page({ answer: true }));
      const realComplete = f.chat.completeText;
      let invocations = 0;
      let firstState;
      f.chat.completeText = async (prompt, options) => {
        invocations++;
        if (invocations === 1) firstState = options.stallRetryState;
        else assert.equal(options.stallRetryState, firstState, 'pool restart replaced the job budget');
        let preparations = 0;
        return realComplete(prompt, { ...options, beforeSubmit: async () => {
          preparations++;
          if (invocations === 1 && preparations === 2) {
            // Maintenance is requested without awaiting it while holding a slot.
            f.chat.getPoolHooks().requestMaintenance('test-maintenance', async () => {
              f.chat.resetAllSlotPages();
              f.chat.getSlot(0).recoveryState = 'healthy';
              f.chat.getSlot(1).recoveryState = 'healthy';
            });
            throw Object.assign(new Error('prepare retry needs maintenance'), { retryAfterMaintenance: true });
          }
          await options.beforeSubmit();
        } });
      };
      await withRouter(f, async ({ port }) => {
        const result = await request(port, 'POST', '/v1/chat/completions', { input: 'hello', thinking_mode: 'instant', stream });
        assert.equal(result.status, 504, result.text);
        assert.equal(invocations, 2);
        assert.equal(firstState.used, 1);
        assert.equal(f.pages.reduce((n, p) => n + p.sends, 0), 2, 'maintenance allowed an extra resend');
        assert.equal(f.chat.getSlot(0).completedJobs, 1, 'requeue must not count as a finished job');
      });
    });
  });
}

test('job log context survives awaits and isolates concurrent slots; outside logs are unchanged', { timeout: 5000 }, async () => {
  await fixture({}, async f => {
    let entered = 0;
    let release;
    const bothEntered = new Promise(resolve => { release = resolve; });
    f.chat.completeText = async (_prompt, options) => {
      console.log('job-start-%d', options.job.slotId);
      if (++entered === 2) release();
      await bothEntered;
      await flush();
      console.warn('job-warn-%d', options.job.slotId);
      console.error('job-error-%d', options.job.slotId);
      console.log('job-end-%d', options.job.slotId);
      return { text: 'ok' };
    };
    const originalErr = process.stderr.write;
    const stderr = [];
    process.stderr.write = chunk => { stderr.push(String(chunk)); return true; };
    try {
      const { output } = await logs(async () => {
        await withRouter(f, async ({ port }) => {
          console.log('outside-before');
          const results = await Promise.all([1, 2].map(n => request(port, 'POST', '/v1/chat/completions', { input: `hello${n}` })));
          assert.ok(results.every(r => r.status === 200));
          console.log('outside-after');
        });
      });
      for (const slot of [0, 1]) {
        assert.ok(output.includes(`[s${slot}] job-start-${slot}\n`), output);
        assert.ok(output.includes(`[s${slot}] job-end-${slot}\n`));
        assert.ok(stderr.join('').includes(`[s${slot}] job-warn-${slot}\n`));
        assert.ok(stderr.join('').includes(`[s${slot}] job-error-${slot}\n`));
      }
      assert.match(output, /(?:^|\n)outside-before\n/);
      assert.match(output, /\noutside-after\n/);
      assert.ok(!/\[s\d\] outside/.test(output));
      assert.ok(!/\[s\d\] \[s\d\]/.test(output), 'wrapper installed multiple times');
    } finally { process.stderr.write = originalErr; }
  });
});

test('access logger skips only GET root, including query string, and keeps other requests', async () => {
  const file = require.resolve('../src/server');
  const realRequire = createRequire(file);
  let app;
  const fakeExpress = () => {
    app = express();
    app.listen = () => {}; // Boot browser/warm-up is not part of this middleware test.
    return app;
  };
  Object.assign(fakeExpress, express);
  const req = name => {
    if (name === 'express') return fakeExpress;
    if (name === './routes/images' || name === './routes/login') return express.Router();
    return realRequire(name);
  };
  const compiled = vm.runInThisContext('(function(require, __dirname) {' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file });
  compiled(req, require('node:path').dirname(file));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const root = await logs(async () => {
      await request(port, 'GET', '/'); await request(port, 'GET', '/?uptime=1');
    });
    assert.ok(!root.output.includes('[req '), root.output);
    const others = await logs(async () => {
      await request(port, 'GET', '/unknown'); await request(port, 'POST', '/');
    });
    assert.match(others.output, /> GET \/unknown /);
    assert.match(others.output, /> POST \/ /);
    assert.equal(others.output.split('[req ').length - 1, 4);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});
