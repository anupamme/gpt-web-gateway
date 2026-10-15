// Exercise the mutation runner against disposable sources, never the live src/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGate } = require('./mutate-stall');

const original = Buffer.from("module.exports = 'good';\n");
function sandbox(t, fn) {
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
  try { fn({ root, source, mutation, messages }); }
  finally {
    t.mock.restoreAll();
    try { assert.deepEqual(fs.readFileSync(source), original, 'restore the exact original bytes'); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

test('gate kills a behavioral mutant only on the selected test assertion and restores bytes', t => {
  sandbox(t, ({ root, mutation, messages }) => {
    assert.equal(runGate(root, [mutation]), true);
    assert.ok(messages.some(line => /T01.*killed: not ok 1 - target/.test(line)));
  });
});

test('gate fails when one mutant survives even if another is killed', t => {
  sandbox(t, ({ root, mutation, messages }) => {
    assert.equal(runGate(root, [mutation, { ...mutation, id: 'T02', to: "'good' /* equivalent */" }]), false);
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
  test(`gate rejects a ${kind} and restores bytes`, t => {
    sandbox(t, ({ root, mutation }) => {
      assert.equal(runGate(root, [{ ...mutation, to }], { timeout: 1000 }), false);
    });
  });
}

for (const [kind, change, message] of [
  ['missing fragment', { from: 'absent' }, /fragment occurs 0 times/],
  ['nonunique fragment', { from: 'o' }, /fragment occurs 4 times/],
  ['no-op', { to: "'good'" }, /no-op/],
]) {
  test(`gate rejects a ${kind} before mutation`, t => {
    sandbox(t, ({ root, mutation }) => {
      assert.throws(() => runGate(root, [{ ...mutation, ...change }]), message);
    });
  });
}

test('gate preflights the entire catalogue and rejects duplicate IDs', t => {
  sandbox(t, ({ root, mutation }) => {
    assert.throws(() => runGate(root, [mutation, { ...mutation, id: 'T02', from: 'absent' }]), /fragment occurs 0 times/);
    assert.throws(() => runGate(root, [mutation, mutation]), /duplicate id/);
    assert.throws(() => runGate(root, []), /empty mutation catalogue/);
    assert.equal(runGate(root, [mutation], { preflight: true }), true);
  });
});

test('gate rejects a failing clean baseline without applying a mutation', t => {
  sandbox(t, ({ root, mutation }) => {
    fs.writeFileSync(path.join(root, 'test.js'), "require('node:assert/strict').fail('baseline');\n");
    assert.throws(() => runGate(root, [mutation]), /clean test.js failed/);
  });
});

test('gate checks that the replacement was actually written', t => {
  sandbox(t, ({ root, source, mutation }) => {
    const write = fs.writeFileSync;
    let writes = 0;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (file === source && ++writes === 1) return;
      return write(file, ...args);
    });
    assert.throws(() => runGate(root, [mutation]), /replacement not applied/);
  });
});

test('gate fails if rollback hash verification detects changed bytes', t => {
  sandbox(t, ({ root, source, mutation }) => {
    const write = fs.writeFileSync;
    let writes = 0;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (file === source && ++writes === 2) return write(file, 'bad restore');
      return write(file, ...args);
    });
    assert.throws(() => runGate(root, [mutation]), /hash mismatch after rollback/);
  });
});
