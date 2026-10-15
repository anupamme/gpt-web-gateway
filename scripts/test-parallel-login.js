// Exercise the actual login handlers with a fake browser and deterministic idle clock.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('module');

const loginPath = require.resolve('../src/routes/login');
const localRequire = createRequire(loginPath);
const tests = [];
const add = (name, fn) => tests.push([name, fn]);
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function fixture() {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const pending = [];
  const state = { acquires: 0, held: 0, releases: 0, pages: 0, saves: 0, resets: 0, unsafe: 0, screenshots: 0 };
  const checkHeld = () => { if (state.held !== 1) state.unsafe += 1; };
  const page = {
    closed: false,
    isClosed() { return this.closed; },
    async goto() { checkHeld(); },
    async close() { checkHeld(); this.closed = true; },
    async screenshot() { checkHeld(); state.screenshots += 1; return Buffer.from('jpeg'); },
    mouse: { async click() { checkHeld(); } },
    keyboard: { async type() { checkHeld(); }, async press() { checkHeld(); } },
  };
  const browser = {
    async getContext() {
      checkHeld();
      return { async newPage() { checkHeld(); state.pages += 1; page.closed = false; return page; } };
    },
    async saveSession() { checkHeld(); state.saves += 1; },
    async maybeHideWebdriverOnPage() { checkHeld(); },
  };
  const hooks = {
    acquireExclusive(name) {
      assert.strictEqual(name, 'manual-login');
      state.acquires += 1;
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  const chatgpt = {
    getPoolHooks: () => hooks,
    resetAllSlotPages() { checkHeld(); state.resets += 1; },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(loginPath, 'utf8'), {
    module,
    require(id) {
      if (id === '../browser') return browser;
      if (id === '../chatgpt') return chatgpt;
      if (id === '../progress') return { progress: { touch() {} } };
      return localRequire(id);
    },
    console,
    setTimeout(fn, delay) {
      const timer = { id: ++nextTimer, at: now + delay, fn, unref() {} };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer.id); },
  }, { filename: loginPath });

  function start(method, path, body = {}) {
    const layer = module.exports.stack.find((entry) => entry.route.path === path && entry.route.methods[method]);
    assert.ok(layer, `${method} ${path} exists`);
    const result = { status: 200, body: null, done: false };
    const response = {
      status(code) { result.status = code; return this; },
      set() { return this; },
      json(value) { result.body = value; result.done = true; return this; },
      send(value) { result.body = value; result.done = true; return this; },
    };
    result.promise = Promise.resolve(layer.route.stack[0].handle({ body }, response));
    return result;
  }
  return {
    state, timers, start,
    async grant() {
      assert.ok(pending.length, 'an exclusive acquisition is pending');
      state.held += 1;
      let released = false;
      pending.shift().resolve(() => {
        if (released) return;
        released = true;
        state.held -= 1;
        state.releases += 1;
      });
      await flush();
    },
    async reject() {
      assert.ok(pending.length);
      pending.shift().reject(new Error('exclusive acquisition failed'));
      await flush();
    },
    async advance(ms) {
      now += ms;
      for (const timer of [...timers.values()]) {
        if (timer.at <= now && timers.delete(timer.id)) timer.fn();
      }
      await flush();
    },
  };
}

add('inactive login screenshot returns 409 without acquiring or creating a page', async () => {
  const f = fixture();
  const shot = f.start('get', '/login/screenshot');
  await flush();
  assert.strictEqual(shot.status, 409, 'inactive screenshot must refuse the request');
  assert.strictEqual(shot.body.error, 'login session is not active — open /login');
  assert.strictEqual(f.state.acquires, 0);
  assert.strictEqual(f.state.pages, 0);
});

add('screenshot polling after save cannot reacquire the manual login hold', async () => {
  const f = fixture();
  const open = f.start('get', '/login');
  await flush();
  await f.grant();
  await open.promise;
  const active = f.start('get', '/login/screenshot');
  await active.promise;
  assert.strictEqual(active.status, 200);
  assert.strictEqual(f.state.pages, 1);
  const save = f.start('post', '/login/save');
  await save.promise;
  assert.strictEqual(save.status, 200);
  const shot = f.start('get', '/login/screenshot');
  await flush();
  assert.strictEqual(shot.status, 409, 'post-save polling must leave the pool available');
  assert.strictEqual(shot.body.error, 'login session is not active — open /login');
  assert.strictEqual(f.state.acquires, 1);
  assert.strictEqual(f.state.pages, 1);
  assert.strictEqual(f.state.held, 0);
});

add('pending login acquisition has no idle deadline and save remains exclusive after ten minutes', async () => {
  const f = fixture();
  const save = f.start('post', '/login/save');
  await flush();
  await f.advance(10 * 60 * 1000 + 1);
  assert.strictEqual(save.done, false, 'save must wait for the exclusive acquisition');
  await f.grant();
  await save.promise;
  assert.strictEqual(save.status, 200);
  assert.strictEqual(f.state.saves, 1);
  assert.strictEqual(f.state.resets, 1);
  assert.strictEqual(f.state.unsafe, 0, 'save or reset ran after a pending hold expired');
  assert.strictEqual(f.state.held, 0);
});

add('parallel login callers share one pending exclusive and wait before using pages', async () => {
  const f = fixture();
  const open = f.start('get', '/login');
  await flush();
  const click = f.start('post', '/login/click', { x: 1, y: 2 });
  const shot = f.start('get', '/login/screenshot');
  await flush();
  assert.strictEqual(f.state.acquires, 1, 'parallel callers requested another exclusive');
  assert.strictEqual(f.state.pages, 0, 'a pending caller touched the browser');
  assert.strictEqual(open.done || click.done || shot.done, false);
  await f.grant();
  await Promise.all([open.promise, click.promise, shot.promise]);
  for (const result of [open, click, shot]) assert.strictEqual(result.status, 200);
  assert.strictEqual(f.state.unsafe, 0);
});

add('failed pending login acquisition returns 503 to every caller without touching pages', async () => {
  const f = fixture();
  const open = f.start('get', '/login');
  await flush();
  const callers = [open,
    f.start('get', '/login/screenshot'),
    f.start('post', '/login/click', { x: 1, y: 2 }),
    f.start('post', '/login/type', { text: 'x' }),
    f.start('post', '/login/key', { key: 'Enter' }),
    f.start('post', '/login/navigate'),
    f.start('post', '/login/save'),
  ];
  await flush();
  await f.reject();
  await Promise.all(callers.map((call) => call.promise));
  for (const result of callers) {
    assert.strictEqual(result.status, 503, 'failed acquisition must return service unavailable');
    assert.strictEqual(result.body.error, 'exclusive acquisition failed');
  }
  assert.strictEqual(f.state.pages, 0);
  assert.strictEqual(f.state.saves, 0);
  assert.strictEqual(f.state.resets, 0);
  assert.strictEqual(f.timers.size, 0);
});

add('a failed login save does not poison the next save on the same router', async () => {
  const f = fixture();
  const failed = f.start('post', '/login/save');
  await flush();
  await f.reject();
  await failed.promise;
  assert.strictEqual(failed.status, 503);
  const retry = f.start('post', '/login/save');
  await flush();
  assert.strictEqual(f.state.acquires, 2, 'N32: a rejected save chain must allow the next save to acquire');
  await f.grant();
  await retry.promise;
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(f.state.saves, 1);
  assert.strictEqual(f.state.resets, 1);
  assert.strictEqual(f.state.unsafe, 0);
  assert.strictEqual(f.state.held, 0);
});

add('manual login save resets every slot exactly once while the exclusive is held', async () => {
  const f = fixture();
  const save = f.start('post', '/login/save');
  await flush();
  await f.grant();
  await save.promise;
  assert.strictEqual(save.status, 200);
  assert.strictEqual(f.state.resets, 1, 'save omitted the required reset of all slot pages');
  assert.strictEqual(f.state.saves, 1);
  assert.strictEqual(f.state.unsafe, 0);
  assert.strictEqual(f.state.releases, 1);
});

add('active screenshot renews idle timeout and expired screenshots cannot reacquire', async () => {
  const f = fixture();
  const open = f.start('get', '/login');
  await flush();
  await f.grant();
  await open.promise;
  await f.advance(9 * 60 * 1000);
  const shot = f.start('get', '/login/screenshot');
  await shot.promise;
  await f.advance(2 * 60 * 1000);
  assert.strictEqual(f.state.held, 1, 'active screenshot did not renew the idle timeout');
  await f.advance(8 * 60 * 1000 + 1);
  assert.strictEqual(f.state.held, 0);
  const expired = f.start('get', '/login/screenshot');
  await flush();
  assert.strictEqual(expired.status, 409, 'expired screenshot must not acquire again');
  assert.strictEqual(f.state.acquires, 1);
});

let finished = false;
process.on('beforeExit', () => {
  if (!finished) { console.error('FAIL: login test runner stopped before completing all scenarios'); process.exitCode = 1; }
});

(async () => {
  let passed = 0;
  const selected = tests.filter(([name]) => !process.env.LOGIN_TEST_FILTER || new RegExp(process.env.LOGIN_TEST_FILTER).test(name));
  for (const [name, fn] of selected) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`FAIL: ${name} — ${err.stack || err}`);
    }
  }
  finished = true;
  console.log(`\n${passed}/${selected.length} login tests passed`);
  if (passed !== selected.length || selected.length === 0) process.exitCode = 1;
})();
