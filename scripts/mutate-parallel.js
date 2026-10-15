// Kills the parallel-pool regressions named in the M1 spec.
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
    file: 'src/job-pool.js',
    test: 'scripts/test-job-pool.js',
    from: 'while (running < concurrency)',
    to: 'while (running <= concurrency)',
  },
  {
    id: '2',
    file: 'src/job-pool.js',
    test: 'scripts/test-job-pool.js',
    from: 'attempt.then(succeed, fail);',
    to: 'succeed();',
  },
  {
    id: '3',
    file: 'src/job-pool.js',
    test: 'scripts/test-job-pool.js',
    from: 'if (job.key != null && keyIsBusy(job.key)) continue;',
    to: 'if (false) continue;',
  },
  {
    id: '4',
    file: 'src/job-pool.js',
    test: 'scripts/test-job-pool.js',
    from: 'if (running === 0) beginMaintenance();',
    to: 'beginMaintenance();',
  },
  {
    id: '5',
    file: 'src/job-pool.js',
    test: 'scripts/test-job-pool.js',
    from: 'nameDoneEpoch.get(name) > opts.sinceEpoch',
    to: 'nameDoneEpoch.get(name) < opts.sinceEpoch',
  },
  {
    id: '6',
    file: 'src/job-pool.js',
    test: 'scripts/test-job-pool.js',
    from: 'job.returned !== true',
    to: 'true',
  },
  {
    id: '7',
    file: 'src/pacer.js',
    test: 'scripts/test-pacer.js',
    from: '      lastReservedStart = start;\n',
    to: '',
  },
  {
    id: '8',
    file: 'src/progress.js',
    test: 'scripts/test-progress.js',
    from: 'jobMs > HEALTH_STUCK_MS',
    to: 'false',
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
