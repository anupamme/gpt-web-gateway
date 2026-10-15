// M5c mutation gate. The historical M5 runner is deliberately unchanged.
// Excluded from the catalogue (see stall-diagnostics-m5-mut-report.md):
// M01: the outer branch already requires !bestText and diagnostics never assign it.
// M04: throwBackendPostFailure rejects non-2xx first; 2xx is blocked by postStatus.
// M05: postStatus independently blocks stallNoAnswer for the same 2xx acceptance.
// M54 is included: M5b also needs postAccepted to confirm a POST 200 without DOM evidence.
// M48: the response listener ignores the returned promise; the IIFE still runs/catches.
// M11: excluded by the spec as invalid (the old test throws before its assertion).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const mutations = [
  {
    id: 'M02',
    name: "^stall resend is forbidden: bound$",
    file: "src/chatgpt.js",
    area: "stallNoAnswer: boundStream === null",
    from: "capture.boundStream === null && !capture.text",
    to: "true && !capture.text",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M03',
    name: "^backend partial text without a delta callback forbids a resend$",
    file: "src/chatgpt.js",
    area: "stallNoAnswer: !capture.text",
    from: "capture.boundStream === null && !capture.text",
    to: "capture.boundStream === null",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M06',
    name: "^stall resend is forbidden: accepted$",
    file: "src/chatgpt.js",
    area: "stallNoAnswer: no 2xx POST",
    from: "&& !capture.postFailure && !capture.postAccepted\n          && (!capture.postStatus || capture.postStatus.status < 200 || capture.postStatus.status >= 300)) {",
    to: "&& !capture.postFailure) {",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M07',
    name: "^stall resend is forbidden: delta$",
    file: "src/chatgpt.js",
    area: "retry: !anyDeltaEmitted",
    from: "if (err.stallNoAnswer && !anyDeltaEmitted && !options.conversationId",
    to: "if (err.stallNoAnswer && !options.conversationId",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M08',
    name: "^stall resend is forbidden: conversation$",
    file: "src/chatgpt.js",
    area: "retry: !conversationId",
    from: "err.stallNoAnswer && !anyDeltaEmitted && !options.conversationId\n          && slot.pendingReset",
    to: "err.stallNoAnswer && !anyDeltaEmitted\n          && slot.pendingReset",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M09',
    name: "^stall resend is forbidden: hard$",
    file: "src/chatgpt.js",
    area: "retry: pendingReset !== hard",
    from: "slot.pendingReset !== 'hard' && stallRetryState.used < TEXT_STALL_RETRIES",
    to: "true && stallRetryState.used < TEXT_STALL_RETRIES",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M10',
    name: "^a used stall budget follows the job to a different slot after maintenance$",
    file: "src/chatgpt.js",
    area: "retry: stall budget boundary",
    from: "stallRetryState.used < TEXT_STALL_RETRIES",
    to: "stallRetryState.used <= TEXT_STALL_RETRIES",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M12',
    name: "^a used stall budget follows the job to a different slot after maintenance$",
    file: "src/chatgpt.js",
    area: "attempt -= 1",
    from: "        attempt -= 1;\n",
    to: "",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M13',
    name: "^JSON job retains its stall budget across retryAfterMaintenance$",
    file: "src/routes/images.js",
    area: "stallRetryState passed into the job",
    from: "const value = await fn({ ...ctx, stallRetryState });",
    to: "const value = await fn(ctx);",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M14',
    name: "^JSON job retains its stall budget across retryAfterMaintenance$",
    file: "src/routes/images.js",
    area: "stallRetryState survives a pool restart",
    from: "  const stallRetryState = { used: 0 };\n  const promise = pool.submit((ctx) => runWithLogContext({ slotId: ctx.slotId }, async () => {\n    attempts += 1;",
    to: "  const promise = pool.submit((ctx) => runWithLogContext({ slotId: ctx.slotId }, async () => {\n    const stallRetryState = { used: 0 };\n    attempts += 1;",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M15',
    name: "^JSON requeue without discarding pages counts only the completed job$",
    file: "src/routes/images.js",
    area: "recordSlotJobFinished skips a requeue",
    from: "if (!requeued) recordSlotJobFinished?.(ctx.slotId);",
    to: "recordSlotJobFinished?.(ctx.slotId);",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M16',
    name: "^real JSON job paces a stall resend from the previous finish exactly once per attempt$",
    file: "src/routes/images.js",
    area: "onAttemptFinished releases the pacer",
    from: "      onAttemptFinished: () => {\n        if (paced > 0) {\n          turnGate.finished(ctx.slotId);\n          paced -= 1;\n        }\n      },",
    to: "      onAttemptFinished: () => {},",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M17',
    name: "^real JSON job paces a stall resend from the previous finish exactly once per attempt$",
    file: "src/routes/images.js",
    area: "paced decrement",
    from: "          paced -= 1;\n",
    to: "",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M18',
    name: "^POST failure is published before reading the body and rejects immediately$",
    file: "src/chatgpt.js",
    area: "postFailure published before body read",
    from: "        cap.postFailure = failure;\n        let timer;\n        let body = null;\n        try {\n          body = await Promise.race([\n            response.text(),\n            new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),\n          ]);\n        } catch {} finally { clearTimeout(timer); }\n",
    to: "        let timer;\n        let body = null;\n        try {\n          body = await Promise.race([\n            response.text(),\n            new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),\n          ]);\n        } catch {} finally { clearTimeout(timer); }\n        cap.postFailure = failure;\n",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M19',
    name: "^unread POST body has a bounded single diagnostic and cannot contaminate a new capture$",
    file: "src/chatgpt.js",
    area: "unread body timer 5s",
    from: "setTimeout(() => resolve(null), 5000)",
    to: "setTimeout(() => resolve(null), 5001)",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M20',
    name: "^POST failure is published before reading the body and rejects immediately$",
    file: "src/chatgpt.js",
    area: "429 rate_limit else server_error",
    from: "err.code = failure.status === 429 ? 'rate_limit' : 'server_error';",
    to: "err.code = failure.status === 429 ? 'server_error' : 'rate_limit';",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M21',
    name: "^a rejected POST with transient-looking body never resubmits an unconfirmed turn$",
    file: "src/chatgpt.js",
    area: "onSubmitted before throwBackendPostFailure",
    from: "  if (onSubmitted) onSubmitted();\n",
    to: "",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M22',
    name: "^POST failure is published before reading the body and rejects immediately$",
    file: "src/chatgpt.js",
    area: "429 modelMessage",
    from: "  if (failure.status === 429) err.modelMessage = failure.snippet;\n",
    to: "",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M23',
    name: "^POST failure is published before reading the body and rejects immediately$",
    file: "src/chatgpt.js",
    area: "429 message text",
    from: "failure.status === 429 ? ' rate limit' : ''",
    to: "''",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M24',
    name: "^backend ring is per slot, bounded, redacts ids and includes pre-wait responses at rescue and abort$",
    file: "src/chatgpt.js",
    area: "ring filter at >= startedAt",
    from: "entry.at >= capture?.startedAt",
    to: "entry.at > capture?.startedAt",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M25',
    name: "^backend ring is per slot, bounded, redacts ids and includes pre-wait responses at rescue and abort$",
    file: "src/chatgpt.js",
    area: "path id redact: 16-hex",
    from: "|[0-9a-f]{16,}",
    to: "",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M26',
    name: "^backend ring is per slot, bounded, redacts ids and includes pre-wait responses at rescue and abort$",
    file: "src/chatgpt.js",
    area: "path id redact: uuid",
    from: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|",
    to: "",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M27',
    name: "^backend ring is per slot, bounded, redacts ids and includes pre-wait responses at rescue and abort$",
    file: "src/chatgpt.js",
    area: "ring buffer limit 30",
    from: "slot.backendResponses.length > 30",
    to: "slot.backendResponses.length > 31",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M28',
    name: "^stall snapshot defaults, opt-out and retention leave ordinary debug files alone$",
    file: "src/chatgpt.js",
    area: "STALL_SNAPSHOTS default on",
    from: "const STALL_SNAPSHOTS_ENABLED = process.env.STALL_SNAPSHOTS !== '0';",
    to: "const STALL_SNAPSHOTS_ENABLED = process.env.STALL_SNAPSHOTS === '1';",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M29',
    name: "^stall snapshot defaults, opt-out and retention leave ordinary debug files alone$",
    file: "src/chatgpt.js",
    area: "STALL_SNAPSHOTS vs DEBUG_SNAPSHOTS",
    from: "if (stall ? !STALL_SNAPSHOTS_ENABLED : !DEBUG_SNAPSHOTS_ENABLED) return;",
    to: "if (stall ? !DEBUG_SNAPSHOTS_ENABLED : !STALL_SNAPSHOTS_ENABLED) return;",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M30',
    name: "^stall snapshot defaults, opt-out and retention leave ordinary debug files alone$",
    file: "src/chatgpt.js",
    area: "prune keeps newest",
    from: "b.at - a.at",
    to: "a.at - b.at",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M31',
    name: "^stall snapshot defaults, opt-out and retention leave ordinary debug files alone$",
    file: "src/chatgpt.js",
    area: "STALL_SNAPSHOT_KEEP",
    from: ".slice(STALL_SNAPSHOT_KEEP)",
    to: ".slice(STALL_SNAPSHOT_KEEP + 1)",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M32',
    name: "^stall snapshot defaults, opt-out and retention leave ordinary debug files alone$",
    file: "src/chatgpt.js",
    area: "prune ignores ordinary debug files",
    from: "/_text_(?:rescue|stalled)\\.(?:png|html)$/",
    to: "/\\.(?:png|html)$/",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M33',
    name: "^recycle threshold counts jobs, preserves recovery and resets only its own page counter$",
    file: "src/chatgpt.js",
    area: "recycle does not enter probation",
    from: "  if (kind === 'recycle') {\n    resetPage(slot);\n    return;\n  }",
    to: "  if (kind === 'recycle') {\n    resetPage(slot);\n  }",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M34',
    name: "^recycle threshold counts jobs, preserves recovery and resets only its own page counter$",
    file: "src/chatgpt.js",
    area: "recycle respects an existing pendingReset",
    from: "slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS && !slot.pendingReset",
    to: "slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M35',
    name: "^recycle threshold counts jobs, preserves recovery and resets only its own page counter$",
    file: "src/chatgpt.js",
    area: "discardSlotPage resets completedJobs",
    from: "  victim.completedJobs = 0;\n",
    to: "",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M36',
    name: "^watchdog probes a usable page even when recycle is pending$",
    file: "src/chatgpt.js",
    area: "watchdog still probes when recycle is pending",
    from: "if (getSlot(0).pendingReset && getSlot(0).pendingReset !== 'recycle') {",
    to: "if (getSlot(0).pendingReset) {",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M37',
    name: "^job log context survives awaits and isolates concurrent slots; outside logs are unchanged$",
    file: "src/log-context.js",
    area: "ALS prefix keeps console format strings",
    from: "        if (typeof args[0] === 'string') args[0] = `${prefix} ${args[0]}`;\n        else args.unshift(prefix);",
    to: "        args.unshift(prefix);",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M38',
    name: "^job log context survives awaits and isolates concurrent slots; outside logs are unchanged$",
    file: "src/log-context.js",
    area: "ALS prefix absent outside a job",
    from: "      const context = storage.getStore();\n      if (context && Number.isInteger(context.slotId)) {\n        const prefix = `[s${context.slotId}]`;",
    to: "      const context = storage.getStore() || { slotId: 0 };\n      if (Number.isInteger(context.slotId)) {\n        const prefix = `[s${context.slotId}]`;",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M39',
    name: "^access logger skips only GET root, including query string, and keeps other requests$",
    file: "src/server.js",
    area: "access log skips GET /",
    from: "if ((req.method === 'GET' && req.path === '/') || ACCESS_LOG_SKIP.test(req.path)) return next();",
    to: "if (ACCESS_LOG_SKIP.test(req.path)) return next();",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M40',
    name: "^access logger skips only GET root, including query string, and keeps other requests$",
    file: "src/server.js",
    area: "access log keeps POST /",
    from: "if ((req.method === 'GET' && req.path === '/') || ACCESS_LOG_SKIP.test(req.path)) return next();",
    to: "if (req.path === '/' || ACCESS_LOG_SKIP.test(req.path)) return next();",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M41',
    name: "^a stall resend starts a new chat even when reuseChat was requested$",
    file: "src/chatgpt.js",
    area: "fresh chat after a stall retry",
    from: "else if (!options.reuseChat || attempt > 0 || stallRetryState.used > 0) await ensureNewChat(p);",
    to: "else if (!options.reuseChat || attempt > 0) await ensureNewChat(p);",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M42',
    name: "^stall resend is forbidden: disabled$",
    file: "src/chatgpt.js",
    area: "safeNonNegativeInt accepts 0",
    from: "Number.isInteger(n) && n >= 0",
    to: "Number.isInteger(n) && n > 0",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M43',
    name: "^backend ring is per slot, bounded, redacts ids and includes pre-wait responses at rescue and abort$",
    file: "src/chatgpt.js",
    area: "capture.startedAt",
    from: "  slot.capture.startedAt = Date.now();\n",
    to: "",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M44',
    name: "^non-SSE diagnostics normalize and truncate body, 5xx rejects, 2xx keeps waiting$",
    file: "src/chatgpt.js",
    area: "POST snippet length 300",
    from: "failure.snippet = String(body).replace(/\\s+/g, ' ').trim().slice(0, 300);",
    to: "failure.snippet = String(body).replace(/\\s+/g, ' ').trim().slice(0, 299);",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M45',
    name: "^GET diagnostics fall back to the last message when current_node is absent$",
    file: "src/chatgpt.js",
    area: "GET mapping fallback last message",
    from: "|| nodes.filter(node => node.message).at(-1)?.message;",
    to: "|| nodes.filter(node => node.message).at(0)?.message;",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M46',
    name: "^recycle is disabled by zero and defaults to fifty completed jobs$",
    file: "src/chatgpt.js",
    area: "recycle disabled at zero",
    from: "PAGE_RECYCLE_AFTER_JOBS > 0 && slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS",
    to: "PAGE_RECYCLE_AFTER_JOBS >= 0 && slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M47',
    name: "^recycle threshold counts jobs, preserves recovery and resets only its own page counter$",
    file: "src/chatgpt.js",
    area: "recycle threshold is inclusive",
    from: "slot.completedJobs >= PAGE_RECYCLE_AFTER_JOBS",
    to: "slot.completedJobs > PAGE_RECYCLE_AFTER_JOBS",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M49',
    name: "^same-millisecond snapshots with the same slot and label keep distinct pairs$",
    file: "src/chatgpt.js",
    area: "snapshot sequence",
    from: "const base = `${DEBUG_SNAPSHOT_DIR}/${ts}_s${slotOf(p).id}_${++snapshotSequence}_${label}`;",
    to: "const base = `${DEBUG_SNAPSHOT_DIR}/${ts}_s${slotOf(p).id}_${label}`;",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M50',
    name: "^reloading log context inside a job preserves the shared installation$",
    file: "src/log-context.js",
    area: "ALS wrapper installed once",
    from: "if (!console[key]) {",
    to: "if (true) {",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M51',
    name: "^whitespace-only numeric settings use their defaults$",
    file: "src/chatgpt.js",
    area: "safeNonNegativeInt trims whitespace",
    from: "String(envValue ?? '').trim()",
    to: "String(envValue ?? '')",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M52',
    name: "^job log context survives awaits and isolates concurrent slots; outside logs are unchanged$",
    file: "src/log-context.js",
    area: "runWithLogContext enters ALS",
    from: "  return console[key].run(context, fn);",
    to: "  return fn();",
    test: "scripts/test-stall-routes.js",
  },
  {
    id: 'M53',
    name: "^GET diagnostics include mapping size and current message metadata, with status only on rejection$",
    file: "src/chatgpt.js",
    area: "GET diagnostic message count",
    from: "conversation GET status=${status} messages=${nodes.length}",
    to: "conversation GET status=${status} messages=${nodes.length - 1}",
    test: "scripts/test-stall-diagnostics.js",
  },
  {
    id: 'M54',
    name: "^D1: accepted POST without DOM confirmation sends once \\(answer=true\\)$",
    file: "src/chatgpt.js",
    area: "postAccepted must include status 200 for submit confirmation",
    from: "if (status >= 200 && status < 300) cap.postAccepted = true;",
    to: "if (status > 200 && status < 300) cap.postAccepted = true;",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B01',
    name: "^D1: accepted POST exits confirmation polling immediately$",
    file: "src/chatgpt.js",
    area: "D1: backend acceptance confirms inside the submit loop",
    from: "    if (capture?.postAccepted) { submitted = true; break; }",
    to: "    if (false) { submitted = true; break; }",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B02',
    name: "^D1: acceptance arriving at the submit deadline still calls onSubmitted$",
    file: "src/chatgpt.js",
    area: "D1: backend acceptance confirms at the submit deadline",
    from: "  if (capture?.postAccepted) submitted = true;",
    to: "  if (false) submitted = true;",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B03',
    name: "^D2: hung screenshot cannot hold stall-abort beyond its snapshot deadline$",
    file: "src/chatgpt.js",
    area: "D2: screenshot deadline",
    from: "raceDeadline(p.screenshot({ fullPage: true }), 5000)",
    to: "p.screenshot({ fullPage: true })",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B04',
    name: "^D2: hung content cannot hold stall-abort beyond its snapshot deadline$",
    file: "src/chatgpt.js",
    area: "D2: content deadline",
    from: "raceDeadline(p.content(), 5000)",
    to: "p.content()",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B05',
    name: "^D3: replaced-page POST, SSE and GET responses cannot affect the current turn$",
    file: "src/chatgpt.js",
    area: "D3: reject a replaced page before dispatch",
    from: "    if (p !== slot.page) return;\n    // Snapshot before any await:",
    to: "    // Snapshot before any await:",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B06',
    name: "^D3: replacing the page while GET/SSE bodies are pending ignores their late data$",
    file: "src/chatgpt.js",
    area: "D3: reject a replaced page after GET body",
    from: "      if (p !== slot.page) return;\n      if (cap) {",
    to: "      if (cap) {",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B07',
    name: "^D3: non-SSE POST body completing after page replacement stays silent$",
    file: "src/chatgpt.js",
    area: "D3: reject a replaced page after non-SSE POST body",
    from: "        if (p !== slot.page) return;\n        if (body !== null)",
    to: "        if (body !== null)",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B08',
    name: "^D4: concurrent snapshots retain only the newer complete pair$",
    file: "src/chatgpt.js",
    area: "D4: serialize snapshots across slots",
    from: "  const pending = stallSnapshotQueue.then(save);",
    to: "  const pending = save();",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B09',
    name: "^R1: POST 429 during submit error banner prevents a duplicate send$",
    file: "src/chatgpt.js",
    area: "R1: recheck a POST rejection after submit diagnostics",
    from: "    throwBackendPostFailure(capture, onSubmitted);\n    if (!capture?.postAccepted) throw err;",
    to: "    if (!capture?.postAccepted) throw err;",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B10',
    name: "^R1: POST 200 during submit snapshot prevents a duplicate send$",
    file: "src/chatgpt.js",
    area: "R1: recheck acceptance after submit diagnostics",
    from: "    if (!capture?.postAccepted) throw err;",
    to: "    throw err;",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B11',
    name: "^R2: a screenshot resolved after its deadline cannot write an orphan PNG or break retention$",
    file: "src/chatgpt.js",
    area: "R2: screenshot is buffered rather than written late by Playwright",
    from: "p.screenshot({ fullPage: true })",
    to: "p.screenshot({ path: `${base}.png`, fullPage: true })",
    test: "scripts/test-stall-review.js",
  },
  {
    id: 'B12',
    name: "^R2: a screenshot resolved after its deadline cannot write an orphan PNG or break retention$",
    file: "src/chatgpt.js",
    area: "R2: persist an on-time screenshot buffer",
    from: "      if (Buffer.isBuffer(png)) fs.writeFileSync(`${base}.png`, png);",
    to: "      void png;",
    test: "scripts/test-stall-review.js",
  },
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function runGate(root, catalog = mutations, { preflight = false, timeout = 30000 } = {}) {
  const originals = new Map();
  const ids = new Set();
  // Preflight the entire catalogue before writing any file.
  for (const mutation of catalog) {
    if (ids.has(mutation.id)) throw new Error(`duplicate id ${mutation.id}`);
    ids.add(mutation.id);
    if (!originals.has(mutation.file)) {
      originals.set(mutation.file, fs.readFileSync(path.join(root, mutation.file)));
    }
    const source = originals.get(mutation.file).toString('utf8');
    const count = mutation.from ? source.split(mutation.from).length - 1 : 0;
    if (count !== 1) throw new Error(`${mutation.id}: fragment occurs ${count} times`);
    if (mutation.from === mutation.to) throw new Error(`${mutation.id}: no-op replacement`);
  }
  if (!catalog.length) throw new Error('empty mutation catalogue');
  console.log(`preflight: ${catalog.length} unique fragments`);
  if (preflight) return true;

  let activeChild = null;
  // Yield while a target runs so SIGTERM/SIGINT can restore an applied mutation.
  const run = args => new Promise(resolve => {
    activeChild = execFile(process.execPath, args, {
      cwd: root, encoding: 'utf8', timeout, killSignal: 'SIGKILL', env: process.env,
    }, (error, stdout, stderr) => {
      activeChild = null;
      resolve({ stdout, stderr, signal: error?.signal,
        status: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
        error: error && !Number.isInteger(error.code) ? error : null });
    });
  });
  // Match npm test's direct execution. --test's child-process transport is
  // incompatible with these tests' intentional stdout capture.
  const testArgs = mutation => ['--test-reporter=tap',
    ...(mutation.name ? ['--test-name-pattern', mutation.name] : []), mutation.test];
  const cleanTargets = new Set(catalog.map(m => m.test));
  for (const target of cleanTargets) {
    const clean = await run(['--test-reporter=tap', target]);
    if (clean.error || clean.status !== 0) {
      throw new Error(`clean ${target} failed\n${clean.stdout || ''}${clean.stderr || ''}`);
    }
  }

  let activeFile = null;
  const restore = () => {
    if (!activeFile) return;
    const original = originals.get(activeFile);
    fs.writeFileSync(path.join(root, activeFile), original);
    if (sha256(fs.readFileSync(path.join(root, activeFile))) !== sha256(original)) {
      throw new Error(`${activeFile}: hash mismatch after rollback`);
    }
    activeFile = null;
  };
  const onExit = () => {
    try { restore(); } catch (error) { console.error(error); process.exitCode = 1; }
  };
  const onSignal = signal => {
    try { restore(); }
    catch (error) { console.error(error); }
    finally {
      activeChild?.kill('SIGTERM');
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  const onSigterm = () => onSignal('SIGTERM');
  const onSigint = () => onSignal('SIGINT');
  process.on('exit', onExit);
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  let killed = 0;
  try {
    for (const mutation of catalog) {
      let detail;
      try {
        const original = originals.get(mutation.file);
        const next = original.toString('utf8').replace(mutation.from, mutation.to);
        activeFile = mutation.file;
        fs.writeFileSync(path.join(root, activeFile), next);
        const applied = fs.readFileSync(path.join(root, activeFile));
        if (!applied.equals(Buffer.from(next)) || sha256(applied) === sha256(original)) {
          throw new Error(`${mutation.id}: replacement not applied`);
        }
        const syntax = await run(['--check', mutation.file]);
        if (syntax.error || syntax.status !== 0) {
          detail = `invalid syntax/check: ${syntax.error || syntax.stderr}`;
        } else {
          const result = await run(testArgs(mutation));
          const output = `${result.stdout || ''}\n${result.stderr || ''}`;
          // Only a real node:test assertion counts. A printed "AssertionError",
          // module-load error, cancellation, timeout or signal is not a kill.
          const failures = output.split(/(?=^not ok \d+ - )/m).slice(1);
          const assertionOnly = failures.length > 0 && failures.every(block => {
            const diagnostic = block.split(/^  \.\.\.$/m)[0];
            return /^  failureType: 'testCodeFailure'$/m.test(diagnostic)
              && /^  code: 'ERR_ASSERTION'$/m.test(diagnostic);
          });
          if (!result.error && result.status === 1 && !result.signal && assertionOnly) {
            killed++;
            detail = `killed: ${failures.map(block => block.split('\n')[0]).join('; ')}`;
          } else {
            detail = result.status === 0 && !result.error ? 'SURVIVED' : 'INVALID (not an assertion failure)';
            detail += `\n${result.error || ''}\n${output}`;
          }
        }
      } finally {
        restore();
      }
      console.log(`${mutation.id} ${mutation.area}: ${detail}`);
    }
  } finally {
    try { restore(); } finally {
      process.removeListener('exit', onExit);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
    }
  }
  for (const [file, original] of originals) {
    if (sha256(fs.readFileSync(path.join(root, file))) !== sha256(original)) {
      throw new Error(`${file}: hash mismatch after gate`);
    }
  }
  console.log(`killed ${killed}/${catalog.length}; all source hashes restored`);
  return killed === catalog.length;
}

if (require.main === module) {
  const only = process.argv.find(arg => arg.startsWith('--id='))?.slice(5);
  const catalog = only ? mutations.filter(m => m.id === only) : mutations;
  runGate(path.join(__dirname, '..'), catalog,
    { preflight: process.argv.includes('--preflight') }).then(ok => {
    process.exitCode = ok ? 0 : 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runGate, mutations };
