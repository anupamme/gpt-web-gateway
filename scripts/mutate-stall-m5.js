// Independent mutation run for stall-diagnostics M5.
// Re-runnable: each mutation is applied to a unique fragment, tested, then the
// original bytes are restored and the sha256 is checked. rc=0 when every
// fragment was unique, every file was restored, and the clean stall tests pass.
// A surviving mutant is not a script failure — the report records it.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const stallTests = [
  'scripts/test-stall-diagnostics.js',
  'scripts/test-stall-routes.js',
];
const sourceFiles = [
  'src/chatgpt.js',
  'src/routes/images.js',
  'src/server.js',
  'src/log-context.js',
];
const checkOnly = process.argv.includes('--check');
const preflightOnly = process.argv.includes('--preflight');
const only = (process.argv.find((arg) => arg.startsWith('--id=')) || '').slice(5);
const logDir = path.join(root, '.mut-logs');
const resultsPath = path.join(root, '.stall-m5-results.json');

const mutations = [
  {
    id: 'M01',
    file: 'src/chatgpt.js',
    area: 'stallNoAnswer: !bestText',
    from: 'if (!bestText && capture && capture.boundStream === null && !capture.text',
    to: 'if (capture && capture.boundStream === null && !capture.text',
  },
  {
    id: 'M02',
    file: 'src/chatgpt.js',
    area: 'stallNoAnswer: boundStream === null',
    from: 'capture.boundStream === null && !capture.text',
    to: 'true && !capture.text',
  },
  {
    id: 'M03',
    file: 'src/chatgpt.js',
    area: 'stallNoAnswer: !capture.text',
    from: 'capture.boundStream === null && !capture.text',
    to: 'capture.boundStream === null',
  },
  {
    id: 'M04',
    file: 'src/chatgpt.js',
    area: 'stallNoAnswer: !postFailure',
    from: '&& !capture.postFailure && !capture.postAccepted',
    to: '&& !capture.postAccepted',
  },
  {
    id: 'M05',
    file: 'src/chatgpt.js',
    area: 'stallNoAnswer: !postAccepted',
    from: '&& !capture.postAccepted\n          && (!capture.postStatus',
    to: '\n          && (!capture.postStatus',
  },
  {
    id: 'M06',
    file: 'src/chatgpt.js',
    area: 'stallNoAnswer: no 2xx POST',
    from: '&& !capture.postFailure && !capture.postAccepted\n          && (!capture.postStatus || capture.postStatus.status < 200 || capture.postStatus.status >= 300)) {',
    to: '&& !capture.postFailure) {',
  },
  {
    id: 'M07',
    file: 'src/chatgpt.js',
    area: 'retry: !anyDeltaEmitted',
    from: 'if (err.stallNoAnswer && !anyDeltaEmitted && !options.conversationId',
    to: 'if (err.stallNoAnswer && !options.conversationId',
  },
  {
    id: 'M08',
    file: 'src/chatgpt.js',
    area: 'retry: !conversationId',
    from: 'err.stallNoAnswer && !anyDeltaEmitted && !options.conversationId\n          && slot.pendingReset',
    to: 'err.stallNoAnswer && !anyDeltaEmitted\n          && slot.pendingReset',
  },
  {
    id: 'M09',
    file: 'src/chatgpt.js',
    area: 'retry: pendingReset !== hard',
    from: 'slot.pendingReset !== \'hard\' && stallRetryState.used < TEXT_STALL_RETRIES',
    to: 'true && stallRetryState.used < TEXT_STALL_RETRIES',
  },
  {
    id: 'M10',
    file: 'src/chatgpt.js',
    area: 'retry: stall budget boundary',
    from: 'stallRetryState.used < TEXT_STALL_RETRIES',
    to: 'stallRetryState.used <= TEXT_STALL_RETRIES',
  },
  {
    id: 'M11',
    file: 'src/chatgpt.js',
    area: 'retry: TEXT_STALL_RETRIES default',
    from: 'const TEXT_STALL_RETRIES = safeNonNegativeInt(process.env.TEXT_STALL_RETRIES, 1);',
    to: 'const TEXT_STALL_RETRIES = safeNonNegativeInt(process.env.TEXT_STALL_RETRIES, 0);',
  },
  {
    id: 'M12',
    file: 'src/chatgpt.js',
    area: 'attempt -= 1',
    from: '        attempt -= 1;\n',
    to: '',
  },
  {
    id: 'M13',
    file: 'src/routes/images.js',
    area: 'stallRetryState passed into the job',
    from: 'const value = await fn({ ...ctx, stallRetryState });',
    to: 'const value = await fn(ctx);',
  },
  {
    id: 'M14',
    file: 'src/routes/images.js',
    area: 'stallRetryState survives a pool restart',
    from: '  const stallRetryState = { used: 0 };\n  const promise = pool.submit((ctx) => runWithLogContext({ slotId: ctx.slotId }, async () => {\n    attempts += 1;',
    to: '  const promise = pool.submit((ctx) => runWithLogContext({ slotId: ctx.slotId }, async () => {\n    const stallRetryState = { used: 0 };\n    attempts += 1;',
  },
  {
    id: 'M15',
    file: 'src/routes/images.js',
    area: 'recordSlotJobFinished skips a requeue',
    from: 'if (!requeued) recordSlotJobFinished?.(ctx.slotId);',
    to: 'recordSlotJobFinished?.(ctx.slotId);',
  },
  {
    id: 'M16',
    file: 'src/routes/images.js',
    area: 'onAttemptFinished releases the pacer',
    from: '      onAttemptFinished: () => {\n        if (paced > 0) {\n          turnGate.finished(ctx.slotId);\n          paced -= 1;\n        }\n      },',
    to: '      onAttemptFinished: () => {},',
  },
  {
    id: 'M17',
    file: 'src/routes/images.js',
    area: 'paced decrement',
    from: '          paced -= 1;\n',
    to: '',
  },
  {
    id: 'M18',
    file: 'src/chatgpt.js',
    area: 'postFailure published before body read',
    from: '        cap.postFailure = failure;\n        let timer;\n        let body = null;\n        try {\n          body = await Promise.race([\n            response.text(),\n            new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),\n          ]);\n        } catch {} finally { clearTimeout(timer); }\n        if (body !== null) failure.snippet = String(body).replace(/\\s+/g, \' \').trim().slice(0, 300);',
    to: '        let timer;\n        let body = null;\n        try {\n          body = await Promise.race([\n            response.text(),\n            new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),\n          ]);\n        } catch {} finally { clearTimeout(timer); }\n        cap.postFailure = failure;\n        if (body !== null) failure.snippet = String(body).replace(/\\s+/g, \' \').trim().slice(0, 300);',
  },
  {
    id: 'M19',
    file: 'src/chatgpt.js',
    area: 'unread body timer 5s',
    from: 'setTimeout(() => resolve(null), 5000)',
    to: 'setTimeout(() => resolve(null), 5001)',
  },
  {
    id: 'M20',
    file: 'src/chatgpt.js',
    area: '429 rate_limit else server_error',
    from: 'err.code = failure.status === 429 ? \'rate_limit\' : \'server_error\';',
    to: 'err.code = failure.status === 429 ? \'server_error\' : \'rate_limit\';',
  },
  {
    id: 'M21',
    file: 'src/chatgpt.js',
    area: 'onSubmitted before throwBackendPostFailure',
    from: '  if (onSubmitted) onSubmitted();\n',
    to: '',
  },
  {
    id: 'M22',
    file: 'src/chatgpt.js',
    area: '429 modelMessage',
    from: '  if (failure.status === 429) err.modelMessage = failure.snippet;\n',
    to: '',
  },
  {
    id: 'M23',
    file: 'src/chatgpt.js',
    area: '429 message text',
    from: 'failure.status === 429 ? \' rate limit\' : \'\'',
    to: '\'\'',
  },
  {
    id: 'M24',
    file: 'src/chatgpt.js',
    area: 'ring filter at >= startedAt',
    from: 'entry.at >= capture?.startedAt',
    to: 'entry.at > capture?.startedAt',
  },
  {
    id: 'M25',
    file: 'src/chatgpt.js',
    area: 'path id redact: 16-hex',
    from: '|[0-9a-f]{16,}',
    to: '',
  },
  {
    id: 'M26',
    file: 'src/chatgpt.js',
    area: 'path id redact: uuid',
    from: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|',
    to: '',
  },
  {
    id: 'M27',
    file: 'src/chatgpt.js',
    area: 'ring buffer limit 30',
    from: 'slot.backendResponses.length > 30',
    to: 'slot.backendResponses.length > 31',
  },
  {
    id: 'M28',
    file: 'src/chatgpt.js',
    area: 'STALL_SNAPSHOTS default on',
    from: 'const STALL_SNAPSHOTS_ENABLED = process.env.STALL_SNAPSHOTS !== \'0\';',
    to: 'const STALL_SNAPSHOTS_ENABLED = process.env.STALL_SNAPSHOTS === \'1\';',
  },
  {
    id: 'M29',
    file: 'src/chatgpt.js',
    area: 'STALL_SNAPSHOTS vs DEBUG_SNAPSHOTS',
    from: 'if (stall ? !STALL_SNAPSHOTS_ENABLED : !DEBUG_SNAPSHOTS_ENABLED) return;',
    to: 'if (stall ? !DEBUG_SNAPSHOTS_ENABLED : !STALL_SNAPSHOTS_ENABLED) return;',
  },
  {
    id: 'M30',
    file: 'src/chatgpt.js',
    area: 'prune keeps newest',
    from: 'b.at - a.at',
    to: 'a.at - b.at',
  },
  {
    id: 'M31',
    file: 'src/chatgpt.js',
    area: 'STALL_SNAPSHOT_KEEP',
    from: '.slice(STALL_SNAPSHOT_KEEP)',
    to: '.slice(STALL_SNAPSHOT_KEEP + 1)',
  },
  {
    id: 'M32',
    file: 'src/chatgpt.js',
    area: 'prune ignores ordinary debug files',
    from: '/_text_(?:rescue|stalled)\\.(?:png|html)$/',
    to: '/\\.(?:png|html)$/',
  },
  {
    id: 'M33',
    file: 'src/chatgpt.js',
    area: 'recycle does not enter probation',
    from: '  if (kind === \'recycle\') {\n    resetPage(slot);\n    return;\n  }',
    to: '  if (kind === \'recycle\') {\n    resetPage(slot);\n  }',
  },
  {
    id: 'M34',
    file: 'src/chatgpt.js',
    area: 'recycle respects an existing pendingReset',
    from: 'slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS && !slot.pendingReset',
    to: 'slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS',
  },
  {
    id: 'M35',
    file: 'src/chatgpt.js',
    area: 'discardSlotPage resets completedJobs',
    from: '  victim.completedJobs = 0;\n',
    to: '',
  },
  {
    id: 'M36',
    file: 'src/chatgpt.js',
    area: 'watchdog still probes when recycle is pending',
    from: 'if (getSlot(0).pendingReset && getSlot(0).pendingReset !== \'recycle\') {',
    to: 'if (getSlot(0).pendingReset) {',
  },
  {
    id: 'M37',
    file: 'src/log-context.js',
    area: 'ALS prefix keeps console format strings',
    from: '        if (typeof args[0] === \'string\') args[0] = `${prefix} ${args[0]}`;\n        else args.unshift(prefix);',
    to: '        args.unshift(prefix);',
  },
  {
    id: 'M38',
    file: 'src/log-context.js',
    area: 'ALS prefix absent outside a job',
    from: '      const context = storage.getStore();\n      if (context && Number.isInteger(context.slotId)) {\n        const prefix = `[s${context.slotId}]`;',
    to: '      const context = storage.getStore() || { slotId: 0 };\n      if (Number.isInteger(context.slotId)) {\n        const prefix = `[s${context.slotId}]`;',
  },
  {
    id: 'M39',
    file: 'src/server.js',
    area: 'access log skips GET /',
    from: 'if ((req.method === \'GET\' && req.path === \'/\') || ACCESS_LOG_SKIP.test(req.path)) return next();',
    to: 'if (ACCESS_LOG_SKIP.test(req.path)) return next();',
  },
  {
    id: 'M40',
    file: 'src/server.js',
    area: 'access log keeps POST /',
    from: 'if ((req.method === \'GET\' && req.path === \'/\') || ACCESS_LOG_SKIP.test(req.path)) return next();',
    to: 'if (req.path === \'/\' || ACCESS_LOG_SKIP.test(req.path)) return next();',
  },
  {
    id: 'M41',
    file: 'src/chatgpt.js',
    area: 'fresh chat after a stall retry',
    from: 'else if (!options.reuseChat || attempt > 0 || stallRetryState.used > 0) await ensureNewChat(p);',
    to: 'else if (!options.reuseChat || attempt > 0) await ensureNewChat(p);',
  },
  {
    id: 'M42',
    file: 'src/chatgpt.js',
    area: 'safeNonNegativeInt accepts 0',
    from: 'Number.isInteger(n) && n >= 0',
    to: 'Number.isInteger(n) && n > 0',
  },
  {
    id: 'M43',
    file: 'src/chatgpt.js',
    area: 'capture.startedAt',
    from: '  slot.capture.startedAt = Date.now();\n',
    to: '',
  },
  {
    id: 'M44',
    file: 'src/chatgpt.js',
    area: 'POST snippet length 300',
    from: 'failure.snippet = String(body).replace(/\\s+/g, \' \').trim().slice(0, 300);',
    to: 'failure.snippet = String(body).replace(/\\s+/g, \' \').trim().slice(0, 299);',
  },
  {
    id: 'M45',
    file: 'src/chatgpt.js',
    area: 'GET mapping fallback last message',
    from: '|| nodes.filter(node => node.message).at(-1)?.message;',
    to: '|| nodes.filter(node => node.message).at(0)?.message;',
  },
  {
    id: 'M46',
    file: 'src/chatgpt.js',
    area: 'recycle disabled at zero',
    from: 'PAGE_RECYCLE_AFTER_JOBS > 0 && slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS',
    to: 'PAGE_RECYCLE_AFTER_JOBS >= 0 && slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS',
  },
  {
    id: 'M47',
    file: 'src/chatgpt.js',
    area: 'recycle threshold is inclusive',
    from: 'slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS',
    to: 'slot.completedJobs > PAGE_RECYCLE_AFTER_JOBS',
  },
  {
    id: 'M48',
    file: 'src/chatgpt.js',
    area: 'onBackendResponse returns its promise',
    from: '  return (async () => {',
    to: '  (async () => {',
  },
  {
    id: 'M49',
    file: 'src/chatgpt.js',
    area: 'snapshot sequence',
    from: 'const base = `${DEBUG_SNAPSHOT_DIR}/${ts}_s${slotOf(p).id}_${++snapshotSequence}_${label}`;',
    to: 'const base = `${DEBUG_SNAPSHOT_DIR}/${ts}_s${slotOf(p).id}_${label}`;',
  },
  {
    id: 'M50',
    file: 'src/log-context.js',
    area: 'ALS wrapper installed once',
    from: 'if (!console[key]) {',
    to: 'if (true) {',
  },
  {
    id: 'M51',
    file: 'src/chatgpt.js',
    area: 'safeNonNegativeInt trims whitespace',
    from: 'String(envValue ?? \'\').trim()',
    to: 'String(envValue ?? \'\')',
  },
  {
    id: 'M52',
    file: 'src/log-context.js',
    area: 'runWithLogContext enters ALS',
    from: '  return console[key].run(context, fn);',
    to: '  return fn();',
  },
  {
    id: 'M53',
    file: 'src/chatgpt.js',
    area: 'GET diagnostic message count',
    from: 'conversation GET status=${status} messages=${nodes.length}',
    to: 'conversation GET status=${status} messages=${nodes.length - 1}',
  },
  {
    id: 'M54',
    file: 'src/chatgpt.js',
    area: 'postAccepted set only for 2xx',
    from: 'if (status >= 200 && status < 300) cap.postAccepted = true;',
    to: 'if (status > 200 && status < 300) cap.postAccepted = true;',
  },
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function countOf(text, fragment) {
  let n = 0;
  let i = 0;
  while (i <= text.length) {
    const at = text.indexOf(fragment, i);
    if (at === -1) return n;
    n += 1;
    i = at + Math.max(fragment.length, 1);
  }
  return n;
}

function runNode(args, timeout) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    env: process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timedOut: !!(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : '',
  };
}

function runNpmTest() {
  const result = spawnSync('npm', ['test'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300000,
    env: process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timedOut: !!(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : '',
  };
}

function firstStack(text) {
  const match = text.match(/(scripts\/[\w.-]+\.js:\d+:\d+)/);
  return match ? match[1] : '';
}

function extractFailure(text) {
  const lines = text.split('\n');
  let name = '';
  for (const line of lines) {
    const marked = line.match(/^✖\s+(.+?)(?:\s+\([\d.]+m?s\))?$/);
    if (marked) {
      name = marked[1];
      break;
    }
    const tap = line.match(/^not ok \d+ - (.+)$/);
    if (tap) {
      name = tap[1];
      break;
    }
    const fail = line.match(/^FAIL:\s*(.*)$/);
    if (fail) {
      name = line.trim();
      break;
    }
  }
  const assertion = lines.find((line) => /AssertionError/.test(line) || /^\s*FAIL:/.test(line));
  const stack = firstStack(text);
  return [name, assertion && assertion.trim(), stack].filter(Boolean).join(' — ').slice(0, 700);
}

function classify(runs) {
  if (runs.some((run) => run.timedOut)) {
    return { result: 'invalid', reason: 'timeout', line: 'spawn ETIMEDOUT' };
  }
  const text = runs.map((run) => `${run.stdout}\n${run.stderr}`).join('\n');
  const failed = runs.some((run) => run.status !== 0);
  if (!failed) return { result: 'pass', line: '' };
  if (/AssertionError|(^|\n)\s*FAIL:/.test(text)) {
    return { result: 'killed', line: extractFailure(text) };
  }
  if (/SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/.test(text)) {
    return { result: 'invalid', reason: 'syntax-or-load', line: extractFailure(text) || text.split('\n').find((line) => /SyntaxError|Cannot find module/.test(line)) || '' };
  }
  if (/timed out/i.test(text)) {
    return { result: 'invalid', reason: 'timeout', line: extractFailure(text) || 'test timed out' };
  }
  const detail = linesOfInterest(text);
  return { result: 'invalid', reason: 'non-assertion', line: detail };
}

function linesOfInterest(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const interesting = lines.filter((line) => /Error|not ok|✖|FAIL|throw/.test(line));
  return (interesting[0] || lines.slice(-3).join(' | ')).slice(0, 700);
}

function writeResults(rows) {
  fs.writeFileSync(resultsPath, JSON.stringify(rows, null, 2));
}

const originals = new Map();
for (const file of sourceFiles) {
  originals.set(file, fs.readFileSync(path.join(root, file)));
}

function restoreAll() {
  for (const [file, buf] of originals) {
    fs.writeFileSync(path.join(root, file), buf);
  }
}

let mutated = false;
process.on('exit', () => {
  if (!mutated) return;
  try { restoreAll(); } catch (err) { console.error(err); }
});

const dirty = spawnSync('git', ['diff', '--quiet', '--', ...sourceFiles], { cwd: root });
if (dirty.status !== 0) {
  console.error('source files are dirty; refusing to mutate');
  process.exit(1);
}

const selected = only ? mutations.filter((mutation) => mutation.id === only) : mutations;
if (selected.length === 0) {
  console.error(`unknown id ${only}`);
  process.exit(1);
}

for (const mutation of selected) {
  const text = originals.get(mutation.file).toString('utf8');
  const count = countOf(text, mutation.from);
  if (count !== 1) {
    console.error(`${mutation.id}: fragment occurs ${count} times`);
    process.exit(1);
  }
  if (mutation.from === mutation.to) {
    console.error(`${mutation.id}: replacement is a no-op`);
    process.exit(1);
  }
}
console.error(`preflight: ${selected.length} fragments are unique`);
if (preflightOnly) process.exit(0);

if (!checkOnly) {
  for (const rel of stallTests) {
    const clean = runNode([path.join(root, rel)], 60000);
    if (clean.status !== 0 || clean.timedOut) {
      console.error(`clean ${rel} failed`);
      console.error(clean.stdout.slice(-2000));
      console.error(clean.stderr.slice(-2000));
      process.exit(1);
    }
  }
  console.error('clean stall tests passed');
}

fs.mkdirSync(logDir, { recursive: true });
const rows = [];

for (const mutation of selected) {
  const filePath = path.join(root, mutation.file);
  const original = originals.get(mutation.file);
  const before = sha256(original);
  const text = original.toString('utf8');
  const next = text.replace(mutation.from, mutation.to);
  mutated = true;
  fs.writeFileSync(filePath, next);
  const row = {
    id: mutation.id,
    file: mutation.file,
    area: mutation.area,
    from: mutation.from,
    to: mutation.to,
    applied: sha256(fs.readFileSync(filePath)) !== before,
  };
  if (!row.applied) {
    row.result = 'invalid';
    row.reason = 'not-applied';
    row.line = 'file hash unchanged';
    rows.push(row);
    restoreAll();
    writeResults(rows);
    console.error(`${mutation.id}: replacement did not change the file`);
    continue;
  }

  const syntax = runNode(['--check', filePath], 15000);
  if (syntax.status !== 0 || syntax.timedOut) {
    row.result = 'invalid';
    row.reason = syntax.timedOut ? 'timeout' : 'syntax-or-load';
    row.line = `${syntax.stdout}\n${syntax.stderr}`.trim().slice(0, 700);
    row.test = mutation.file;
    fs.writeFileSync(path.join(logDir, `${mutation.id}.txt`), `${syntax.stdout}\n${syntax.stderr}`);
    restoreFile(filePath, original, before, mutation.id);
    rows.push(row);
    writeResults(rows);
    console.error(`${mutation.id}: invalid (${row.reason})`);
    continue;
  }

  if (checkOnly) {
    restoreFile(filePath, original, before, mutation.id);
    row.result = 'check';
    rows.push(row);
    console.error(`${mutation.id}: syntax ok`);
    continue;
  }

  const runs = [];
  let log = '';
  for (const rel of stallTests) {
    const run = runNode([path.join(root, rel)], 60000);
    run.name = rel;
    runs.push(run);
    log += `\n===== ${rel} status=${run.status} timedOut=${run.timedOut} =====\n${run.stdout}\n${run.stderr}\n`;
  }
  let verdict = classify(runs);
  row.test = (runs.find((run) => run.status !== 0 || run.timedOut) || {}).name || stallTests.join(', ');
  if (verdict.result === 'pass') {
    const full = runNpmTest();
    log += `\n===== npm test status=${full.status} timedOut=${full.timedOut} =====\n${full.stdout}\n${full.stderr}\n`;
    const fullVerdict = classify([full]);
    if (fullVerdict.result === 'pass') {
      row.result = 'survived';
      row.line = '';
      row.test = 'scripts/test-stall-diagnostics.js, scripts/test-stall-routes.js, npm test';
    } else if (fullVerdict.result === 'killed') {
      row.result = 'killed';
      row.line = fullVerdict.line;
      row.test = firstStack(full.stdout + full.stderr).replace(/:\d+:\d+$/, '') || 'npm test';
      row.killedBy = 'npm test';
    } else {
      row.result = 'invalid';
      row.reason = fullVerdict.reason;
      row.line = fullVerdict.line;
      row.note = 'stall tests passed; npm test did not fail on an assertion';
    }
  } else {
    row.result = verdict.result;
    row.reason = verdict.reason || '';
    row.line = verdict.line;
  }
  fs.writeFileSync(path.join(logDir, `${mutation.id}.txt`), log);
  restoreFile(filePath, original, before, mutation.id);
  rows.push(row);
  writeResults(rows);
  console.error(`${mutation.id}: ${row.result}${row.reason ? ` (${row.reason})` : ''}`);
}

restoreAll();
for (const file of sourceFiles) {
  const now = sha256(fs.readFileSync(path.join(root, file)));
  const expected = sha256(originals.get(file));
  if (now !== expected) {
    console.error(`${file}: sha256 mismatch after the run`);
    process.exit(1);
  }
}
const counts = rows.reduce((acc, row) => {
  acc[row.result] = (acc[row.result] || 0) + 1;
  return acc;
}, {});
console.error(`done ${JSON.stringify(counts)}`);
console.log(JSON.stringify({ counts, results: resultsPath }, null, 2));
fs.rmSync(logDir, { recursive: true, force: true });
fs.rmSync(resultsPath, { force: true });

function restoreFile(filePath, original, before, id) {
  fs.writeFileSync(filePath, original);
  const after = sha256(fs.readFileSync(filePath));
  if (after !== before) {
    console.error(`${id}: sha256 mismatch after rollback`);
    process.exit(1);
  }
}
