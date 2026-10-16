// Exercise the mutation runner against disposable sources, never the live src/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { runGate } = require('./mutate-stall');

const original = Buffer.from("module.exports = 'good';\n");
async function sandbox(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-gate-'));
  const source = path.join(root, 'source.js');
  fs.writeFileSync(source, original);
  fs.writeFileSync(path.join(root, 'test.js'), `
const test = require('node:test');
const assert = require('node:assert/strict');
const value = require('./source');
test('target', () => assert.equal(value, 'good'));
`);
  const messages = [];
  t.mock.method(console, 'log', line => messages.push(line));
  const mutation = { id: 'T01', area: 'runner contract', file: 'source.js',
    from: "'good'", to: "'bad'", test: 'test.js', name: '^target$' };
  try { await fn({ root, source, mutation, messages }); }
  finally {
    t.mock.restoreAll();
    try { assert.deepEqual(fs.readFileSync(source), original, 'restore the exact original bytes'); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

test('gate kills a behavioral mutant only on the selected test assertion and restores bytes', async t => {
  await sandbox(t, async ({ root, mutation, messages }) => {
    assert.equal(await runGate(root, [mutation]), true);
    assert.ok(messages.some(line => /T01.*killed: not ok 1 - target/.test(line)));
  });
});

test('gate fails when one mutant survives even if another is killed', async t => {
  await sandbox(t, async ({ root, mutation, messages }) => {
    assert.equal(await runGate(root, [mutation, { ...mutation, id: 'T02', to: "'good' /* equivalent */" }]), false);
    assert.ok(messages.some(line => /killed 1\/2; all source hashes restored/.test(line)));
  });
});

for (const [kind, to] of [
  ['survivor', "'good' /* equivalent */"],
  ['syntax error', "'unterminated"],
  ['load error', "require('./missing')"],
  ['runtime error mentioning AssertionError', "(() => { throw new Error('AssertionError'); })()"],
  ['timeout after a passing assertion', "'good'; setInterval(() => {}, 1000)"],
]) {
  test(`gate rejects a ${kind} and restores bytes`, async t => {
    await sandbox(t, async ({ root, mutation }) => {
      assert.equal(await runGate(root, [{ ...mutation, to }], { timeout: 1000 }), false);
    });
  });
}

for (const [kind, change, message] of [
  ['missing fragment', { from: 'absent' }, /fragment occurs 0 times/],
  ['nonunique fragment', { from: 'o' }, /fragment occurs 4 times/],
  ['no-op', { to: "'good'" }, /no-op/],
]) {
  test(`gate rejects a ${kind} before mutation`, async t => {
    await sandbox(t, async ({ root, mutation }) => {
      await assert.rejects(runGate(root, [{ ...mutation, ...change }]), message);
    });
  });
}

test('gate preflights the entire catalogue and rejects duplicate IDs', async t => {
  await sandbox(t, async ({ root, mutation }) => {
    await assert.rejects(runGate(root, [mutation, { ...mutation, id: 'T02', from: 'absent' }]), /fragment occurs 0 times/);
    await assert.rejects(runGate(root, [mutation, mutation]), /duplicate id/);
    await assert.rejects(runGate(root, []), /empty mutation catalogue/);
    assert.equal(await runGate(root, [mutation], { preflight: true }), true);
  });
});

test('gate rejects a failing clean baseline without applying a mutation', async t => {
  await sandbox(t, async ({ root, mutation }) => {
    fs.writeFileSync(path.join(root, 'test.js'), "require('node:assert/strict').fail('baseline');\n");
    await assert.rejects(runGate(root, [mutation]), /clean test.js failed/);
  });
});

test('gate checks that the replacement was actually written', async t => {
  await sandbox(t, async ({ root, source, mutation }) => {
    const write = fs.writeFileSync;
    let writes = 0;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (file === source && ++writes === 1) return;
      return write(file, ...args);
    });
    await assert.rejects(runGate(root, [mutation]), /replacement not applied/);
  });
});

test('gate fails if rollback hash verification detects changed bytes', async t => {
  await sandbox(t, async ({ root, source, mutation }) => {
    const write = fs.writeFileSync;
    let writes = 0;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (file === source && ++writes === 2) return write(file, 'bad restore');
      return write(file, ...args);
    });
    await assert.rejects(runGate(root, [mutation]), /hash mismatch after rollback/);
  });
});

for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`gate restores all source hashes on ${signal} during a pending target without filesystem watchers`, { timeout: 10000 }, async t => {
    // Shared CI hosts can exhaust inotify resources even in a fresh container.
    t.mock.method(fs, 'watch', () => {
      throw Object.assign(new Error('inotify resources exhausted'), { code: 'ENOSPC' });
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-gate-signal-'));
    const sources = ['src/chatgpt.js', 'src/routes/images.js', 'src/server.js', 'src/log-context.js'];
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    const hashes = new Map();
    for (const file of sources) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
      hashes.set(file, hash(file));
    }
    const mutation = { id: 'T-signal', area: 'signal rollback', file: 'src/chatgpt.js',
      from: 'if (status >= 200 && status < 300) cap.postAccepted = true;',
      to: 'if (status > 200 && status < 300) cap.postAccepted = true;', test: 'target.js' };
    // The mutated target announces readiness while it is still running under
    // the gate. No sleeps or guesses about when the mutation has been applied.
    fs.writeFileSync(path.join(root, 'target.js'), `
const fs = require('node:fs');
if (fs.readFileSync('src/chatgpt.js', 'utf8').includes(${JSON.stringify(mutation.to)})) {
  fs.writeFileSync('ready.tmp', String(process.pid));
  fs.renameSync('ready.tmp', 'ready');
  setInterval(() => {}, 1000);
}
`);
    const readyFile = path.join(root, 'ready');
    let readinessPoll;
    let deadline;
    const ready = new Promise((resolve, reject) => {
      // Poll the atomically published marker; readiness must not need inotify.
      readinessPoll = setInterval(() => { if (fs.existsSync(readyFile)) resolve(); }, 10);
      deadline = setTimeout(() => reject(new Error('mutated target did not announce readiness')), 5000);
    });
    const script = `
const { runGate } = require(${JSON.stringify(require.resolve('./mutate-stall'))});
Promise.resolve(runGate(${JSON.stringify(root)}, [${JSON.stringify(mutation)}]))
  .then(ok => { process.exitCode = ok ? 0 : 1; }, error => { console.error(error); process.exitCode = 1; });
`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      await Promise.race([ready, closed.then(() => assert.fail(`gate exited before readiness: ${output}`))]);
      assert.notEqual(hash(mutation.file), hashes.get(mutation.file), 'prove mutation is on disk before signalling');
      assert.equal(child.kill(signal), true);
      const result = await closed;
      for (const [file, expected] of hashes) assert.equal(hash(file), expected, `${signal} must restore ${file}`);
      assert.equal(result.code, exitCode, output);
      assert.equal(result.signal, null, 'explicit handler must finish with a nonzero exit code');
    } finally {
      clearTimeout(deadline);
      clearInterval(readinessPoll);
      child.kill('SIGKILL');
      await closed;
      if (fs.existsSync(readyFile)) {
        const targetPid = Number(fs.readFileSync(readyFile, 'utf8'));
        assert.ok(Number.isInteger(targetPid) && targetPid > 1, 'readiness must contain a complete child PID');
        try { process.kill(targetPid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
