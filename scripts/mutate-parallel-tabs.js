// Kills the parallel-tabs regressions named in the M2 spec.
// rc=0 only when every fragment is unique, the clean target test is green,
// the mutated tree fails that test, and the original bytes are restored.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

const mutations = [
  {
    id: '1',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'function activeCapture(slot) {\n  return slot.capture;\n}',
    to: 'function activeCapture(slot) {\n  return getSlot(0).capture;\n}',
  },
  {
    id: '2',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'slot.lastConversationFetch = { ...snap, at: Date.now() };',
    to: 'getSlot(0).lastConversationFetch = { ...snap, at: Date.now() };',
  },
  {
    id: '3',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'const victim = slot;',
    to: 'const victim = getSlot(0);',
  },
  {
    id: '4',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'const target = slot;',
    to: 'const target = getSlot(0);',
  },
  {
    id: '5',
    file: 'src/chatgpt.js',
    test: 'scripts/test-parallel-slots.js',
    from: '  if (!opts.exclusive) {',
    to: '  if (false) {',
  },
  {
    id: '6',
    file: 'src/routes/images.js',
    test: 'scripts/test-parallel-routes.js',
    from: 'return submitJob(fn, { key: jobKey });',
    to: 'return submitJob(fn, { key: undefined });',
  },
  {
    id: '7',
    file: 'src/routes/images.js',
    test: 'scripts/test-parallel-routes.js',
    from: '        await turnGate.gate(ctx.slotId);\n        assertNotRateLimited();\n        paced += 1;',
    to: '        await turnGate.gate(ctx.slotId);\n        paced += 1;',
  },
  {
    id: '8',
    file: 'src/chatgpt-tiers.js',
    test: 'scripts/test-parallel-slots.js',
    from: 'const key = strikeKey(mode, slotId);',
    to: 'const key = strikeKey(mode, 0);',
  },
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function runTest(rel) {
  return spawnSync(process.execPath, [path.join(root, rel)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });
}

let failed = 0;

for (const mutation of mutations) {
  const filePath = path.join(root, mutation.file);
  const original = fs.readFileSync(filePath);
  const hash = sha256(original);
  const restore = () => {
    fs.writeFileSync(filePath, original);
    const after = sha256(fs.readFileSync(filePath));
    if (after !== hash) {
      console.error(`${mutation.id}: sha256 mismatch after rollback: ${after} !== ${hash}`);
      process.exit(1);
    }
  };

  const clean = runTest(mutation.test);
  if (clean.status !== 0) {
    console.error(`${mutation.id}: clean run failed`);
    console.error(clean.stdout);
    console.error(clean.stderr);
    process.exit(1);
  }

  const text = original.toString('utf8');
  const count = text.split(mutation.from).length - 1;
  if (count !== 1) {
    console.error(`${mutation.id}: выжил — fragment occurs ${count} times`);
    failed += 1;
    continue;
  }

  fs.writeFileSync(filePath, text.replace(mutation.from, mutation.to));
  try {
    const result = runTest(mutation.test);
    const timedOut = result.error && result.error.code === 'ETIMEDOUT';
    if (timedOut || result.status === 0) {
      console.error(`${mutation.id}: выжил${timedOut ? ' (timeout)' : ''}`);
      if (result.stdout) console.error(result.stdout);
      if (result.stderr) console.error(result.stderr);
      failed += 1;
    } else {
      console.log(`${mutation.id}: убит`);
    }
  } finally {
    restore();
  }
}

if (failed) {
  console.error(`${failed} mutation(s) survived`);
  process.exit(1);
}
console.log(`all ${mutations.length} mutations killed`);
