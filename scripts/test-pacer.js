// Fake-clock tests for src/pacer.js — the proactive gap between jobs.
const assert = require('assert');
const {
  createPacer, gapMs, heartbeatMsFor, DEFAULT_GAP_MS, HEARTBEAT_MS,
  createTurnGate, staggerMs, DEFAULT_STAGGER_MS,
} = require('../src/pacer');

let passed = 0;
function ok(name, fn) {
  const done = fn();
  const finish = () => { console.log(`PASS: ${name}`); passed++; };
  return done && typeof done.then === 'function' ? done.then(finish) : (finish(), null);
}

function harness(startMs = 0, gap = 60000, heartbeatMs = 30000) {
  let t = startMs;
  const slept = [];
  const beats = [];
  const now = () => t;
  const sleep = (ms) => { slept.push(ms); t += ms; return Promise.resolve(); };
  const heartbeat = () => beats.push(t);
  const pacer = createPacer({ now, sleep, gap, heartbeat, heartbeatMs });
  const total = () => slept.reduce((a, b) => a + b, 0);
  return { pacer, slept, beats, total, advance: (ms) => { t += ms; } };
}

const tests = [];
const add = (name, fn) => tests.push([name, fn]);

add('the first job is never delayed', async () => {
  const { pacer, slept } = harness();
  assert.strictEqual(await pacer.gate(), 0);
  assert.deepStrictEqual(slept, []);
});

add('a turn right after the previous one waits out the whole gap', async () => {
  const { pacer, total } = harness();
  await pacer.gate();
  pacer.finished();
  assert.strictEqual(await pacer.gate(), 60000);
  assert.strictEqual(total(), 60000);
});

add('the gap counts from the FINISH, so a long job leaves nothing to wait', async () => {
  // A gap measured from the START would be spent by the job itself: these jobs
  // run a minute or more, and the setting would have changed nothing at all.
  const { pacer, advance, total } = harness();
  await pacer.gate();
  advance(90 * 1000); // the turn itself took 90s, longer than the gap
  pacer.finished();
  assert.strictEqual(await pacer.gate(), 60000);
  assert.strictEqual(total(), 60000);
});

add('an idle instance waits nothing: the gap already passed', async () => {
  const { pacer, advance, slept } = harness();
  await pacer.gate();
  pacer.finished();
  advance(10 * 60 * 1000);
  assert.strictEqual(await pacer.gate(), 0);
  assert.deepStrictEqual(slept, []);
});

add('a partly elapsed gap waits only the remainder', async () => {
  const { pacer, advance } = harness();
  await pacer.gate();
  pacer.finished();
  advance(20 * 1000);
  assert.strictEqual(await pacer.gate(), 40 * 1000);
});

add('a failed turn still stamps the finish', async () => {
  // The refused request reached ChatGPT exactly as a successful one did, and
  // the account counts it. Pacing on successes only would let a failing batch
  // hammer at full speed.
  const { pacer } = harness();
  await pacer.gate();
  pacer.finished(); // caller does this in finally, success or not
  assert.strictEqual(await pacer.gate(), 60000);
});

add('gap 0 disables pacing entirely', async () => {
  const { pacer, slept } = harness(0, 0);
  await pacer.gate();
  pacer.finished();
  assert.strictEqual(await pacer.gate(), 0);
  assert.deepStrictEqual(slept, []);
});

add('a clock that stepped backwards does not stall the queue', async () => {
  // NTP correction: without a guard the negative interval reads as "the gap
  // has not started yet" and the wait comes out larger than the gap.
  const { pacer, advance } = harness();
  await pacer.gate();
  pacer.finished();
  advance(-5 * 60 * 1000);
  assert.strictEqual(await pacer.gate(), 0);
});

add('the wait beats a heartbeat so a deliberate pause reads as progress', async () => {
  // A waiting job holds a queue slot. Without a beat the liveness detector sees
  // queued work and no progress and restarts a container doing exactly what it
  // was told — for any gap at or above the stuck threshold. Found by codex.
  const { pacer, beats, slept } = harness(0, 60000, 30000);
  await pacer.gate();
  pacer.finished();
  await pacer.gate();
  assert.deepStrictEqual(slept, [30000, 30000], 'the wait is broken into beats');
  assert.strictEqual(beats.length, 2);
});

add('a gap shorter than one beat still beats exactly once', async () => {
  const { pacer, beats, slept } = harness(0, 5000, 30000);
  await pacer.gate();
  pacer.finished();
  await pacer.gate();
  assert.deepStrictEqual(slept, [5000]);
  assert.strictEqual(beats.length, 1);
});

add('a batch of turns pays the gap between turns, not once for the batch', async () => {
  // What is paced is one UPSTREAM TURN, not one HTTP request: a batch sends up
  // to ten prompts inside a single job, and pacing the job alone left that
  // burst untouched. Three turns → two gaps. Found by codex.
  const { pacer, total, advance } = harness();
  for (let turn = 0; turn < 3; turn++) {
    await pacer.gate();
    advance(20 * 1000); // the turn itself
    pacer.finished();
  }
  assert.strictEqual(total(), 2 * 60000);
});

add('status shows the limit, the wait ahead and the total waited', async () => {
  const { pacer, advance } = harness();
  assert.deepStrictEqual(pacer.status(), {
    min_gap_sec: 60, next_slot_in_sec: 0, throttled_seconds_total: 0,
  });
  await pacer.gate();
  pacer.finished();
  advance(45 * 1000);
  assert.strictEqual(pacer.status().next_slot_in_sec, 15);
  await pacer.gate();
  assert.strictEqual(pacer.status().throttled_seconds_total, 15);
});

add('a stalled clock still releases the queue slot', async () => {
  // The remainder used to be recomputed from the clock alone, so a clock that
  // does not move never shrinks it: the wait spins forever, waking every beat
  // and holding a queue slot that never frees. Not reachable with a real
  // Date.now, but nothing should be able to hang the queue. Found by codex.
  let t = 0;
  const slept = [];
  const pacer = createPacer({
    now: () => t,
    // A sleep that does NOT advance the clock — the whole point of the test.
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
    gap: 60000,
    heartbeatMs: 30000,
  });
  await pacer.gate();
  pacer.finished();
  const waited = await pacer.gate();
  assert.strictEqual(waited, 60000, 'it must report the full gap it set out to wait');
  assert.deepStrictEqual(slept, [30000, 30000], 'and finish in exactly two beats, not spin');
});

add('a clock that jumps FORWARD mid-wait ends the wait early', async () => {
  // The other side of the same line: the clock still gets to shorten the wait.
  let t = 0;
  const pacer = createPacer({
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    gap: 300000,
    heartbeatMs: 30000,
  });
  pacer.finished();
  const gate = pacer.gate();
  t += 300000; // NTP step forward: the gap has now "passed"
  await gate;
  assert.ok(true, 'the wait returned instead of sitting out the original gap');
});

add('the beat lands inside the liveness window, not at a fixed 30s', () => {
  // HEALTH_STUCK_SEC has no lower bound. A fixed 30s cadence means the probe
  // fires before the first beat whenever the threshold is under 30s, killing a
  // container that was pacing exactly as told. Found by codex.
  assert.strictEqual(heartbeatMsFor({ HEALTH_STUCK_SEC: '10' }), 5000);
  assert.strictEqual(heartbeatMsFor({ HEALTH_STUCK_SEC: '900' }), HEARTBEAT_MS);
  assert.strictEqual(heartbeatMsFor({}), HEARTBEAT_MS, 'the default threshold keeps the full beat');
  assert.ok(heartbeatMsFor({ HEALTH_STUCK_SEC: '0' }) >= 250, 'never a zero-length beat');
});

add('a gap at or beyond the stuck threshold is called out, not silently obeyed', () => {
  // Such a gap is longer than the window the liveness probe calls "hung". The
  // heartbeat in gate() keeps the container alive through it, so this is no
  // longer an outage — but every queued caller then waits past that threshold
  // for its turn, which the operator should hear about. Refusing the value
  // would override them, so the warning is the whole remedy. Found by agy.
  const warned = [];
  const real = console.warn;
  console.warn = (msg) => warned.push(msg);
  try {
    assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '1000' }), 1000 * 1000);
    assert.strictEqual(warned.length, 1);
    assert.ok(warned[0].includes('HEALTH_STUCK_SEC'));
    warned.length = 0;
    gapMs({ MIN_JOB_GAP_SEC: '1000', HEALTH_STUCK_SEC: '3600' });
    assert.deepStrictEqual(warned, [], 'a raised threshold makes the gap fine');
    gapMs({ MIN_JOB_GAP_SEC: '60' });
    assert.deepStrictEqual(warned, [], 'the default gap is nowhere near it');
  } finally {
    console.warn = real;
  }
});

add('the default is a real gap, not a disabled one', () => {
  assert.strictEqual(gapMs({}), DEFAULT_GAP_MS);
  assert.strictEqual(DEFAULT_GAP_MS, 60000);
});

add('MIN_JOB_GAP_SEC is read from the environment', () => {
  assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '30' }), 30000);
  assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '0' }), 0);
  assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '2.5' }), 2500);
});

function gateHarness({ slots = 2, gap = 0, stagger = 10000, heartbeatMs = 30000, startMs = 0 } = {}) {
  let t = startMs;
  const slept = [];
  const beats = [];
  const now = () => t;
  const sleep = (ms) => { slept.push(ms); t += ms; return Promise.resolve(); };
  const heartbeat = () => beats.push(t);
  const gate = createTurnGate({ slots, now, sleep, gap, stagger, heartbeat, heartbeatMs });
  return { gate, slept, beats, advance: (ms) => { t += ms; } };
}

add('the first turn in an empty gate is not delayed', async () => {
  const { gate, slept } = gateHarness({ stagger: 10000, gap: 60000 });
  assert.strictEqual(await gate.gate(0), 0);
  assert.deepStrictEqual(slept, []);
});

add('two concurrent gates on different slots start at least stagger apart', async () => {
  // Reservation is synchronous after each slot's own gap and before the stagger
  // wait, so the second caller observes the first caller's reserved start.
  const { gate } = gateHarness({ slots: 2, gap: 0, stagger: 10000, heartbeatMs: 30000 });
  const [first, second] = await Promise.all([gate.gate(0), gate.gate(1)]);
  assert.strictEqual(first, 0);
  assert.ok(second >= 10000, `second gate waited ${second}`);
});

add('three concurrent gates keep a stagger between each reserved start', async () => {
  const { gate } = gateHarness({ slots: 3, gap: 0, stagger: 10000, heartbeatMs: 30000 });
  const [first, second, third] = await Promise.all([gate.gate(0), gate.gate(1), gate.gate(2)]);
  assert.strictEqual(first, 0);
  assert.ok(second >= 10000, `second gate waited ${second}`);
  assert.ok(third >= 10000, `third gate waited ${third}`);
});

add('one slot gap does not hold another slot beyond the stagger', async () => {
  const { gate } = gateHarness({ slots: 2, gap: 60000, stagger: 10000, heartbeatMs: 30000 });
  assert.strictEqual(await gate.gate(0), 0);
  gate.finished(0);
  assert.strictEqual(await gate.gate(1), 10000);
});

add('finished on slot 0 does not arm the gap of slot 1', async () => {
  const { gate, advance } = gateHarness({ slots: 2, gap: 60000, stagger: 10000, heartbeatMs: 60000 });
  await gate.gate(0);
  await gate.gate(1);
  gate.finished(0);
  gate.finished(1);
  advance(120000);
  assert.strictEqual(await gate.gate(0), 0);
  gate.finished(0);
  assert.strictEqual(await gate.gate(1), 10000);
});

add('a late timer does not release two staggered gates together', async () => {
  // Reservations at 10s and 20s are both overdue when the clock jumps to
  // 20,001s. The first gate to resume claims that instant; the other must
  // still be waiting, then leave at least one stagger later.
  let t = 0;
  const pending = [];
  const now = () => t;
  const sleep = (ms) => new Promise((resolve) => { pending.push({ ms, resolve }); });
  const gate = createTurnGate({
    slots: 3, now, sleep, gap: 0, stagger: 10000, heartbeat: () => {}, heartbeatMs: 10000,
  });
  const marks = [];
  const all = Promise.all([0, 1, 2].map((slotId) => gate.gate(slotId).then(() => marks.push(t))));
  const idle = () => new Promise((resolve) => setImmediate(resolve));

  await idle();
  assert.deepStrictEqual(marks, [0], `early marks ${marks}`);
  assert.strictEqual(pending.length, 2);

  t = 20001;
  for (const timer of pending.splice(0)) timer.resolve();
  await idle();
  assert.deepStrictEqual(marks, [0, 20001], `late marks ${marks}`);
  assert.strictEqual(pending.length, 1, 'the third gate must still be waiting');

  const rest = pending.splice(0);
  t += rest[0].ms;
  for (const timer of rest) timer.resolve();
  await idle();
  await all;
  assert.strictEqual(marks.length, 3);
  assert.ok(marks[1] - marks[0] >= 10000, `marks ${marks}`);
  assert.ok(marks[2] - marks[1] >= 10000, `marks ${marks}`);
});

add('a stalled clock still releases a stagger wait', async () => {
  let t = 0;
  const slept = [];
  const gate = createTurnGate({
    slots: 1,
    now: () => t,
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
    gap: 0,
    stagger: 10000,
    heartbeatMs: 10000,
  });
  assert.strictEqual(await gate.gate(0), 0);
  assert.strictEqual(await gate.gate(0), 10000);
  assert.strictEqual(await gate.gate(0), 20000);
  assert.deepStrictEqual(slept, [10000, 10000, 10000]);
});

add('an early timer does not release the stagger before it is due', async () => {
  const stagger = 40;
  const gate = createTurnGate({
    slots: 2,
    gap: 0,
    stagger,
    heartbeatMs: 1000,
    sleep: (ms) => new Promise((resolve) => {
      setTimeout(resolve, Math.max(1, Math.floor(ms / 4)));
    }),
  });
  await gate.gate(0);
  // The next call is entered a millisecond or two after the previous release,
  // so the remaining wait reads short of the full stagger. Five milliseconds
  // is timer resolution. The early wake is a quarter of the stagger.
  for (let i = 0; i < 20; i += 1) {
    const started = Date.now();
    await gate.gate(i % 2);
    const interval = Date.now() - started;
    assert.ok(interval >= stagger - 5, `interval ${interval} < ${stagger}`);
  }
});

add('a stagger heartbeat receives the waiting slot id', async () => {
  const beats = [];
  let t = 0;
  const gate = createTurnGate({
    slots: 2,
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    gap: 0,
    stagger: 10000,
    heartbeat: (slotId) => beats.push(slotId),
    heartbeatMs: 10000,
  });
  await Promise.all([gate.gate(0), gate.gate(1)]);
  assert.ok(beats.length > 0);
  assert.ok(beats.every((slotId) => slotId === 1), `beats ${beats}`);
});

add('a per-slot gap heartbeat receives that slot id', async () => {
  const beats = [];
  let t = 0;
  const gate = createTurnGate({
    slots: 2,
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    gap: 25000,
    stagger: 0,
    heartbeat: (slotId) => beats.push(slotId),
    heartbeatMs: 10000,
  });
  await gate.gate(1);
  gate.finished(1);
  await gate.gate(1);
  assert.deepStrictEqual(beats, [1, 1, 1]);
});

add('stagger 0 does not delay a turn', async () => {
  const { gate, slept } = gateHarness({ slots: 2, gap: 0, stagger: 0 });
  assert.strictEqual(await gate.gate(0), 0);
  assert.strictEqual(await gate.gate(1), 0);
  assert.deepStrictEqual(slept, []);
});

add('the stagger wait beats a heartbeat', async () => {
  const { gate, beats } = gateHarness({ slots: 2, gap: 0, stagger: 25000, heartbeatMs: 10000 });
  await Promise.all([gate.gate(0), gate.gate(1)]);
  assert.strictEqual(beats.length, 3);
});

add('slotId outside the gate throws RangeError', async () => {
  const { gate } = gateHarness({ slots: 2 });
  await assert.rejects(gate.gate(-1), RangeError);
  await assert.rejects(gate.gate(2), RangeError);
  await assert.rejects(gate.gate(1.5), RangeError);
  assert.throws(() => gate.finished(-1), RangeError);
  assert.throws(() => gate.finished(2), RangeError);
});

add('turn gate status reports gap, stagger, throttle and per-slot wait', async () => {
  const { gate } = gateHarness({ slots: 2, gap: 60000, stagger: 10000, heartbeatMs: 30000 });
  assert.strictEqual(gate.status().min_gap_sec, 60);
  assert.strictEqual(gate.status().min_stagger_sec, 10);
  assert.strictEqual(gate.status().throttled_seconds_total, 0);
  assert.deepStrictEqual(gate.status().slots.map((slot) => slot.slotId), [0, 1]);
  await gate.gate(0);
  gate.finished(0);
  await gate.gate(1);
  assert.strictEqual(gate.status().throttled_seconds_total, 10);
  assert.strictEqual(gate.status().slots[0].next_slot_in_sec, 50);
  assert.strictEqual(gate.status().slots[1].next_slot_in_sec, 0);
});

add('MIN_TURN_STAGGER_SEC defaults to 10s, 0 disables, nonsense warns', () => {
  assert.strictEqual(DEFAULT_STAGGER_MS, 10000);
  assert.strictEqual(staggerMs({}), DEFAULT_STAGGER_MS);
  assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '' }), 10000);
  assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '0' }), 0);
  assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '2' }), 2000);
  assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '1.5' }), 1500);
  assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '   ' }), DEFAULT_STAGGER_MS);
  const warned = [];
  const real = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: 'soon' }), DEFAULT_STAGGER_MS);
    assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '-5' }), DEFAULT_STAGGER_MS);
  } finally {
    console.warn = real;
  }
  assert.strictEqual(warned.length, 2);
});

add('nonsense in MIN_JOB_GAP_SEC falls back to the default, loudly', () => {
  const warned = [];
  const real = console.warn;
  console.warn = (msg) => warned.push(msg);
  try {
    assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: 'soon' }), DEFAULT_GAP_MS);
    assert.strictEqual(gapMs({ MIN_JOB_GAP_SEC: '-5' }), DEFAULT_GAP_MS);
  } finally {
    console.warn = real;
  }
  assert.strictEqual(warned.length, 2);
});

(async () => {
  for (const [name, fn] of tests) await ok(name, fn);
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exit(1);
})();
