# Независимый мутационный прогон M1

Дата: 2026-10-15. Исследованный коммит исходников и тестов: `12687035964cb281af0d4d965e579b1e9bc1c40c`. Среда: Docker `node:24`, Node v24.21.0, uid/gid 1002:1002.

Всего 26 независимых мутаций: **убито 17, выжило 9**. Исходные 8 замен из scripts/mutate-parallel.js не повторяются. Это целевой набор, а не оценка всей возможной популяции мутаций.

## Методика и границы

- Каждый целевой тест сначала выполнен на чистом коде; затем перед КАЖДОЙ мутацией повторно проверены rc=0 и полная итоговая строка (pool 21/21, pacer 31/31, progress 9/9).
- Сохраняются исходные байты и SHA-256; заменяемый фрагмент обязан встречаться ровно один раз. Проверяется синтаксис, запускается неизменённый целевой тест; finally восстанавливает байты и сверяет SHA-256.
- «Убит» означает AssertionError в существующем целевом тесте со строкой ассерта. Ошибки обвязки, синтаксиса и timeout не засчитываются. Неполный выход с rc=0 отдельно отмечается и считается выжившим без ассерта.
- Дифференциальные примеры ниже лишь обосновывают неэквивалентность выживших; они не добавлены в тесты и не влияют на вердикт. Все выжившие имеют наблюдаемое отличие от исходного кода; эквивалентных нет.
- HEALTH_STUCK_SEC=900, HEALTH_FAILURE_STREAK=3; NODE_OPTIONS очищен. src и существующие тесты не исправлялись. Git push не выполняется.

## Таблица мутаций

| ID / поведение | Файл | Точная замена (до → после) | Целевой тест | Итог | Первая упавшая строка |
| --- | --- | --- | --- | --- | --- |
| M01: Слияние: идентичность Promise одноимённых обслуживаний | <code>src/job-pool.js</code> | <code>if (pending) return pending.promise;</code> → <code>if (pending) return pending.promise.then((value) =&gt; value);</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: same-name maintenance merges only while it is waiting to start — AssertionError [ERR_ASSERTION]: Values have same structure but are not reference-equal:; scripts/test-job-pool.js:235: assert.strictEqual(first, second); |
| M02: Слияние по имени: сравнение имён инвертировано | <code>src/job-pool.js</code> | <code>entry.name === name &amp;&amp; entry.kind === kind</code> → <code>entry.name !== name &amp;&amp; entry.kind === kind</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: same-name maintenance merges only while it is waiting to start — AssertionError [ERR_ASSERTION]: Values have same structure but are not reference-equal:; scripts/test-job-pool.js:235: assert.strictEqual(first, second); |
| M03: Слияние ошибочно распространяется на acquireExclusive | <code>src/job-pool.js</code> | <code>if (kind === 'fn') {</code> → <code>if (true) {</code> | <code>scripts/test-job-pool.js</code> | выжил | — (rc=0; PASS=21; итоговая строка есть) |
| M04: acquireExclusive преждевременно вызывает release | <code>src/job-pool.js</code> | <code>return enqueueMaintenance(name, 'exclusive', null);</code> → <code>return enqueueMaintenance(name, 'exclusive', null).then((release) =&gt; { release(); return release; });</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: two acquireExclusive calls do not share a release — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:; scripts/test-job-pool.js:390: assert.strictEqual(secondStarted, false); |
| M05: Повторный release повторно завершает обслуживание | <code>src/job-pool.js</code> | <code>if (released) return;</code> → <code>if (false &amp;&amp; released) return;</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: acquireExclusive holds the pool until release and a second release is a no-op — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:; scripts/test-job-pool.js:422: assert.strictEqual(await third.then(() =&gt; pool.status().epoch), 3); |
| M06: Повтор разрешён уже при прежнем epoch (граница) | <code>src/job-pool.js</code> | <code>epoch &lt;= job.holdEpoch</code> → <code>epoch &lt; job.holdEpoch</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: retry waits for maintenance before the same job starts again — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:; scripts/test-job-pool.js:371: assert.deepStrictEqual(seen, [0]); |
| M07: queue_full: &gt;= заменено на &gt; в submit | <code>src/job-pool.js</code> | <code>if (limitedWaiting &gt;= maxWaiting) {</code> → <code>if (limitedWaiting &gt; maxWaiting) {</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: submit throws queue_full synchronously when maxWaiting is reached — AssertionError [ERR_ASSERTION]: queue_full must be thrown, not returned; scripts/test-job-pool.js:150: assert.ok(thrown instanceof Error, 'queue_full must be thrown, not returned'); |
| M08: Возвращённое задание ошибочно учитывается в лимите | <code>src/job-pool.js</code> | <code>waiting.unshift(job);</code> → <code>waiting.unshift(job); limitedWaiting += 1;</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: a requeued job does not count against maxWaiting — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:; scripts/test-job-pool.js:346: assert.strictEqual(pool.isFull(), false); |
| M09: После ошибки обслуживания пул остаётся заблокирован | <code>src/job-pool.js</code> | <code>finishMaintenance(entry);<br>          entry.reject(error);</code> → <code>finishMaintenance(entry);<br>          activeMaintenance = entry;<br>          entry.reject(error);</code> | <code>scripts/test-job-pool.js</code> | выжил | — (rc=0; PASS=12; ИТОГОВОЙ СТРОКИ НЕТ) |
| M10: Занятый key блокирует FIFO-поиск других ключей | <code>src/job-pool.js</code> | <code>if (job.key != null &amp;&amp; keyIsBusy(job.key)) continue;</code> → <code>if (job.key != null &amp;&amp; keyIsBusy(job.key)) return null;</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: a key runs one at a time and does not block other keys — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:; scripts/test-job-pool.js:112: assert.deepStrictEqual(events, ['a1', 'b']); |
| M11: Очередь ожидающих одного занятого key становится LIFO | <code>src/job-pool.js</code> | <code>waiting.push({</code> → <code>waiting[key != null &amp;&amp; keyIsBusy(key) ? 'unshift' : 'push']({</code> | <code>scripts/test-job-pool.js</code> | выжил | — (rc=0; PASS=21; итоговая строка есть) |
| M12: Выданный slotId выходит за диапазон | <code>src/job-pool.js</code> | <code>const ctx = { slotId: slot.slotId, jobId, epoch };</code> → <code>const ctx = { slotId: slot.slotId + 1, jobId, epoch };</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: the fourth job waits until one of three running jobs settles — AssertionError [ERR_ASSERTION]: slot 3; scripts/test-job-pool.js:70: for (const slotId of slotIds) assert.ok(slotId &gt;= 0 &amp;&amp; slotId &lt; 3, `slot ${slotId}`); |
| M13: Выданный slotId не соответствует занятому слоту status | <code>src/job-pool.js</code> | <code>const ctx = { slotId: slot.slotId, jobId, epoch };</code> → <code>const ctx = { slotId: concurrency - 1 - slot.slotId, jobId, epoch };</code> | <code>scripts/test-job-pool.js</code> | выжил | — (rc=0; PASS=21; итоговая строка есть) |
| M14: Граница разнесения стартов сокращена на 1 ms | <code>src/pacer.js</code> | <code>const due = Math.max(start, earliest);</code> → <code>const due = Math.max(start, earliest) - 1;</code> | <code>scripts/test-pacer.js</code> | убит | AssertionError [ERR_ASSERTION]: second gate waited 9999; scripts/test-pacer.js:251: assert.ok(second &gt;= 10000, `second gate waited ${second}`); |
| M15: Первый turn платит stagger при нулевых часах | <code>src/pacer.js</code> | <code>let lastReservedStart = null;</code> → <code>let lastReservedStart = 0;</code> | <code>scripts/test-pacer.js</code> | убит | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:; scripts/test-pacer.js:241: assert.strictEqual(await gate.gate(0), 0); |
| M16: stagger=0 ошибочно заменяется значением по умолчанию | <code>src/pacer.js</code> | <code>lastReservedStart + stagger);</code> → <code>lastReservedStart + (stagger &#124;&#124; DEFAULT_STAGGER_MS));</code> | <code>scripts/test-pacer.js</code> | убит | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:; scripts/test-pacer.js:335: assert.strictEqual(await gate.gate(1), 0); |
| M17: staggerMs округляет секунды до перевода в ms | <code>src/pacer.js</code> | <code>if (Number.isFinite(parsed) &amp;&amp; parsed &gt;= 0) return Math.round(parsed * 1000);<br>  console.warn(`[pacer] MIN_TURN_STAGGER_SEC=</code> → <code>if (Number.isFinite(parsed) &amp;&amp; parsed &gt;= 0) return Math.round(parsed) * 1000;<br>  console.warn(`[pacer] MIN_TURN_STAGGER_SEC=</code> | <code>scripts/test-pacer.js</code> | убит | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:; scripts/test-pacer.js:374: assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '1.5' }), 1500); |
| M18: staggerMs принимает отрицательные секунды по модулю | <code>src/pacer.js</code> | <code>if (Number.isFinite(parsed) &amp;&amp; parsed &gt;= 0) return Math.round(parsed * 1000);<br>  console.warn(`[pacer] MIN_TURN_STAGGER_SEC=</code> → <code>if (Number.isFinite(parsed)) return Math.round(Math.abs(parsed) * 1000);<br>  console.warn(`[pacer] MIN_TURN_STAGGER_SEC=</code> | <code>scripts/test-pacer.js</code> | убит | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:; scripts/test-pacer.js:380: assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '-5' }), DEFAULT_STAGGER_MS); |
| M19: staggerMs не обрезает пробельную строку | <code>src/pacer.js</code> | <code>const raw = String(env.MIN_TURN_STAGGER_SEC ?? '').trim();</code> → <code>const raw = String(env.MIN_TURN_STAGGER_SEC ?? '');</code> | <code>scripts/test-pacer.js</code> | выжил | — (rc=0; PASS=31; итоговая строка есть) |
| M20: Поздний таймер игнорирует время фактического предыдущего старта | <code>src/pacer.js</code> | <code>const earliest = lastReleasedAt === null ? start : lastReleasedAt + stagger;</code> → <code>const earliest = start;</code> | <code>scripts/test-pacer.js</code> | убит | AssertionError [ERR_ASSERTION]: late marks 0,20001,20001; scripts/test-pacer.js:303: assert.deepStrictEqual(marks, [0, 20001], `late marks ${marks}`); |
| M21: touch неизвестного id создаёт running job | <code>src/progress.js</code> | <code>if (jobId !== undefined &amp;&amp; runningJobs.has(jobId)) runningJobs.set(jobId, now());</code> → <code>if (jobId !== undefined) runningJobs.set(jobId, now());</code> | <code>scripts/test-progress.js</code> | выжил | — (rc=0; PASS=9; итоговая строка есть) |
| M22: jobFinished без jobId удаляет все выполняющиеся задания | <code>src/progress.js</code> | <code>if (jobId !== undefined) runningJobs.delete(jobId);</code> → <code>if (jobId !== undefined) runningJobs.delete(jobId); else runningJobs.clear();</code> | <code>scripts/test-progress.js</code> | выжил | — (rc=0; PASS=9; итоговая строка есть) |
| M23: oldest_job_ms_since_progress выбирает минимум вместо максимума | <code>src/progress.js</code> | <code>oldest === null &#124;&#124; ms &gt; oldest</code> → <code>oldest === null &#124;&#124; ms &lt; oldest</code> | <code>scripts/test-progress.js</code> | убит | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:; scripts/test-progress.js:88: assert.strictEqual(snap.oldest_job_ms_since_progress, 901 * 1000); |
| M24: oldest_job_ms_since_progress пустой карты равен 0 вместо null | <code>src/progress.js</code> | <code>let oldest = null;</code> → <code>let oldest = 0;</code> | <code>scripts/test-progress.js</code> | убит | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:; scripts/test-progress.js:99: assert.strictEqual(p.snapshot().oldest_job_ms_since_progress, null); |
| M25: Per-job liveness: &gt; HEALTH_STUCK_MS заменено на &gt;= | <code>src/progress.js</code> | <code>if (jobMs &gt; HEALTH_STUCK_MS) {</code> → <code>if (jobMs &gt;= HEALTH_STUCK_MS) {</code> | <code>scripts/test-progress.js</code> | выжил | — (rc=0; PASS=9; итоговая строка есть) |
| M26: Общий liveness: &gt; HEALTH_STUCK_MS заменено на &gt;= | <code>src/progress.js</code> | <code>state.queueSize &gt; 0 &amp;&amp; msSince &gt; HEALTH_STUCK_MS</code> → <code>state.queueSize &gt; 0 &amp;&amp; msSince &gt;= HEALTH_STUCK_MS</code> | <code>scripts/test-progress.js</code> | выжил | — (rc=0; PASS=9; итоговая строка есть) |

## Почему выжили

### M03: Слияние ошибочно распространяется на acquireExclusive

Дыра: тест вызывает два exclusive подряд, когда первый уже active. Нет двух одноимённых exclusive, одновременно ожидающих за занятым заданием; они ошибочно получают один Promise и release.

Чистый код: `{"samePromise":false,"pending":["login","login"]}`. Мутант: `{"samePromise":true,"pending":["login"]}`.

Воспроизводимый пример (node -e, отдельный процесс; поведенческий свидетель, не дополнительный целевой тест):

```js
const { createJobPool } = require('./src/job-pool');
(async () => {
  const p = createJobPool({ concurrency: 1, maxWaiting: 5 });
  let release;
  const blocker = p.submit(() => new Promise((r) => { release = r; }));
  await new Promise(setImmediate);
  const a = p.acquireExclusive('login');
  const b = p.acquireExclusive('login');
  console.log(JSON.stringify({ samePromise: a === b, pending: p.status().maintenance.pending }));
  release(); await blocker;
  const ra = await a; ra(); const rb = await b; rb();
})();
```

### M09: После ошибки обслуживания пул остаётся заблокирован

Дыра в завершении async-теста: после проверки epoch тест ждёт submit, который никогда не завершится. У Node нет активных handles, поэтому процесс выходит с rc=0 после 12/21 PASS; отсутствие итоговой строки тестами не проверяется. Это не успешный полный прогон и не убийство ассертом.

Чистый код: `{"active":null,"started":true}`. Мутант: `{"active":"reset","started":false}`.

Воспроизводимый пример (node -e, отдельный процесс; поведенческий свидетель, не дополнительный целевой тест):

```js
const { createJobPool } = require('./src/job-pool');
(async () => {
  const p = createJobPool({ concurrency: 1, maxWaiting: 5 });
  await p.requestMaintenance('reset', async () => { throw Error('boom'); }).catch(() => {});
  let started = false;
  p.submit(async () => { started = true; });
  await new Promise(setImmediate);
  console.log(JSON.stringify({ active: p.status().maintenance.active, started }));
})();
```

### M11: Очередь ожидающих одного занятого key становится LIFO

Дыра: проверяется только один ожидающий a2 за a1; нет двух ожидающих a2/a3 одного занятого key. Общий FIFO-тест использует задания без key и этой ветви не касается.

Чистый код: `["a1","a2","a3"]`. Мутант: `["a1","a3","a2"]`.

Воспроизводимый пример (node -e, отдельный процесс; поведенческий свидетель, не дополнительный целевой тест):

```js
const { createJobPool } = require('./src/job-pool');
(async () => {
  const p = createJobPool({ concurrency: 2, maxWaiting: 5 });
  const order = []; let release;
  const a = p.submit(async () => { order.push('a1'); await new Promise((r) => { release = r; }); }, { key: 'a' });
  await new Promise(setImmediate);
  const b = p.submit(async () => { order.push('a2'); }, { key: 'a' });
  const c = p.submit(async () => { order.push('a3'); }, { key: 'a' });
  release(); await Promise.all([a, b, c]); console.log(JSON.stringify(order));
})();
```

### M13: Выданный slotId не соответствует занятому слоту status

Дыра: при concurrency=3 проверяются только уникальность и диапазон slotId; соответствие ctx.slotId занятому слоту из status проверяется лишь при concurrency=1, где отражение 0 -> 0 тождественно.

Чистый код: `[{"issued":0,"actual":0},{"issued":1,"actual":1}]`. Мутант: `[{"issued":1,"actual":0},{"issued":0,"actual":1}]`.

Воспроизводимый пример (node -e, отдельный процесс; поведенческий свидетель, не дополнительный целевой тест):

```js
const { createJobPool } = require('./src/job-pool');
(async () => {
  const p = createJobPool({ concurrency: 2, maxWaiting: 5 });
  const seen = []; const releases = [];
  const jobs = [0, 1].map(() => p.submit(async (ctx) => {
    seen.push(ctx); await new Promise((r) => releases.push(r));
  }));
  await new Promise(setImmediate);
  console.log(JSON.stringify(seen.map((ctx) => ({ issued: ctx.slotId, actual: p.status().slots.find((s) => s.jobId === ctx.jobId).slotId }))));
  releases.forEach((r) => r()); await Promise.all(jobs);
})();
```

### M19: staggerMs не обрезает пробельную строку

Дыра: есть пустая строка и обычные числа, но нет строки из пробелов. Без trim пробелы проходят в Number как 0, отключая stagger вместо возврата DEFAULT_STAGGER_MS.

Чистый код: `{"whitespace":10000}`. Мутант: `{"whitespace":0}`.

Воспроизводимый пример (node -e, отдельный процесс; поведенческий свидетель, не дополнительный целевой тест):

```js
const { staggerMs } = require('./src/pacer'); console.log(JSON.stringify({ whitespace: staggerMs({ MIN_TURN_STAGGER_SEC: '   ' }) }));
```

### M21: touch неизвестного id создаёт running job

Дыра: проверяются touch() без аргумента и touch известного b, но не неизвестного id. Такой id начинает учитываться как выполняющийся и позже ошибочно проваливает liveness.

Чистый код: `{"running":0,"alive":true}`. Мутант: `{"running":1,"alive":false}`.

Воспроизводимый пример (node -e, отдельный процесс; поведенческий свидетель, не дополнительный целевой тест):

```js
const { createProgress, HEALTH_STUCK_MS } = require('./src/progress'); let t = 0; const p = createProgress(() => t); p.touch('ghost'); t = HEALTH_STUCK_MS + 1; console.log(JSON.stringify({ running: p.snapshot().running_jobs, alive: p.liveness().alive }));
```

### M22: jobFinished без jobId удаляет все выполняющиеся задания

Дыра: legacy-вызовы jobFinished(null) проверяются без одновременно зарегистрированного running job. Нет проверки, что завершение без id сохраняет наблюдение за другим зависшим заданием.

Чистый код: `{"running":1,"alive":false}`. Мутант: `{"running":0,"alive":true}`.

Воспроизводимый пример (node -e, отдельный процесс; поведенческий свидетель, не дополнительный целевой тест):

```js
const { createProgress, HEALTH_STUCK_MS } = require('./src/progress'); let t = 0; const p = createProgress(() => t); p.jobRunning('a'); t = HEALTH_STUCK_MS + 1; p.jobFinished(null); console.log(JSON.stringify({ running: p.snapshot().running_jobs, alive: p.liveness().alive }));
```

### M25: Per-job liveness: > HEALTH_STUCK_MS заменено на >=

Дыра: зависший job проверяется в 901 s при пороге 900 s; равенство порогу не проверяется. При точном HEALTH_STUCK_MS исходный код ещё alive, мутант уже dead.

Чистый код: `{"alive":true,"reason":"ok"}`. Мутант: `{"alive":false,"reason":"job a no progress for 900s"}`.

Воспроизводимый пример (node -e, отдельный процесс; поведенческий свидетель, не дополнительный целевой тест):

```js
const { createProgress, HEALTH_STUCK_MS } = require('./src/progress'); let t = 0; const p = createProgress(() => t); p.jobRunning('a'); t = HEALTH_STUCK_MS; console.log(JSON.stringify(p.liveness()));
```

### M26: Общий liveness: > HEALTH_STUCK_MS заменено на >=

Дыра: общий детектор также проверяется после порога (901 s), а не на пороге. Это отдельная ветвь от per-job, изменяет verdict в точности при HEALTH_STUCK_MS.

Чистый код: `{"alive":true,"reason":"ok"}`. Мутант: `{"alive":false,"reason":"queued work but no progress for 900s"}`.

Воспроизводимый пример (node -e, отдельный процесс; поведенческий свидетель, не дополнительный целевой тест):

```js
const { createProgress, HEALTH_STUCK_MS } = require('./src/progress'); let t = 0; const p = createProgress(() => t); p.jobStarted(); t = HEALTH_STUCK_MS; console.log(JSON.stringify(p.liveness()));
```

## Проверка каждого убийства по своему ассерту

- **M01** — <code>add('same-name maintenance merges only while it is waiting to start', async () =&gt; {</code>; <code>scripts/test-job-pool.js:235</code>: <code>assert.strictEqual(first, second);</code>. FAIL: same-name maintenance merges only while it is waiting to start — AssertionError [ERR_ASSERTION]: Values have same structure but are not reference-equal:

- **M02** — <code>add('same-name maintenance merges only while it is waiting to start', async () =&gt; {</code>; <code>scripts/test-job-pool.js:235</code>: <code>assert.strictEqual(first, second);</code>. FAIL: same-name maintenance merges only while it is waiting to start — AssertionError [ERR_ASSERTION]: Values have same structure but are not reference-equal:

- **M04** — <code>add('two acquireExclusive calls do not share a release', async () =&gt; {</code>; <code>scripts/test-job-pool.js:390</code>: <code>assert.strictEqual(secondStarted, false);</code>. FAIL: two acquireExclusive calls do not share a release — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

- **M05** — <code>add('acquireExclusive holds the pool until release and a second release is a no-op', async () =&gt; {</code>; <code>scripts/test-job-pool.js:422</code>: <code>assert.strictEqual(await third.then(() =&gt; pool.status().epoch), 3);</code>. FAIL: acquireExclusive holds the pool until release and a second release is a no-op — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

- **M06** — <code>add('retry waits for maintenance before the same job starts again', async () =&gt; {</code>; <code>scripts/test-job-pool.js:371</code>: <code>assert.deepStrictEqual(seen, [0]);</code>. FAIL: retry waits for maintenance before the same job starts again — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:

- **M07** — <code>add('submit throws queue_full synchronously when maxWaiting is reached', async () =&gt; {</code>; <code>scripts/test-job-pool.js:150</code>: <code>assert.ok(thrown instanceof Error, 'queue_full must be thrown, not returned');</code>. FAIL: submit throws queue_full synchronously when maxWaiting is reached — AssertionError [ERR_ASSERTION]: queue_full must be thrown, not returned

- **M08** — <code>add('a requeued job does not count against maxWaiting', async () =&gt; {</code>; <code>scripts/test-job-pool.js:346</code>: <code>assert.strictEqual(pool.isFull(), false);</code>. FAIL: a requeued job does not count against maxWaiting — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

- **M10** — <code>add('a key runs one at a time and does not block other keys', async () =&gt; {</code>; <code>scripts/test-job-pool.js:112</code>: <code>assert.deepStrictEqual(events, ['a1', 'b']);</code>. FAIL: a key runs one at a time and does not block other keys — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:

- **M12** — <code>add('the fourth job waits until one of three running jobs settles', async () =&gt; {</code>; <code>scripts/test-job-pool.js:70</code>: <code>for (const slotId of slotIds) assert.ok(slotId &gt;= 0 &amp;&amp; slotId &lt; 3, `slot ${slotId}`);</code>. FAIL: the fourth job waits until one of three running jobs settles — AssertionError [ERR_ASSERTION]: slot 3

- **M14** — <code>add('two concurrent gates on different slots start at least stagger apart', async () =&gt; {</code>; <code>scripts/test-pacer.js:251</code>: <code>assert.ok(second &gt;= 10000, `second gate waited ${second}`);</code>. AssertionError [ERR_ASSERTION]: second gate waited 9999

- **M15** — <code>add('the first turn in an empty gate is not delayed', async () =&gt; {</code>; <code>scripts/test-pacer.js:241</code>: <code>assert.strictEqual(await gate.gate(0), 0);</code>. AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

- **M16** — <code>add('stagger 0 does not delay a turn', async () =&gt; {</code>; <code>scripts/test-pacer.js:335</code>: <code>assert.strictEqual(await gate.gate(1), 0);</code>. AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

- **M17** — <code>add('MIN_TURN_STAGGER_SEC defaults to 10s, 0 disables, nonsense warns', () =&gt; {</code>; <code>scripts/test-pacer.js:374</code>: <code>assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '1.5' }), 1500);</code>. AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

- **M18** — <code>add('MIN_TURN_STAGGER_SEC defaults to 10s, 0 disables, nonsense warns', () =&gt; {</code>; <code>scripts/test-pacer.js:380</code>: <code>assert.strictEqual(staggerMs({ MIN_TURN_STAGGER_SEC: '-5' }), DEFAULT_STAGGER_MS);</code>. AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

- **M20** — <code>add('a late timer does not release two staggered gates together', async () =&gt; {</code>; <code>scripts/test-pacer.js:303</code>: <code>assert.deepStrictEqual(marks, [0, 20001], `late marks ${marks}`);</code>. AssertionError [ERR_ASSERTION]: late marks 0,20001,20001

- **M23** — <code>ok('a stuck job is dead while a neighbor job is making progress', () =&gt; {</code>; <code>scripts/test-progress.js:88</code>: <code>assert.strictEqual(snap.oldest_job_ms_since_progress, 901 * 1000);</code>. AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

- **M24** — <code>ok('jobFinished drops the job so it no longer fails liveness', () =&gt; {</code>; <code>scripts/test-progress.js:99</code>: <code>assert.strictEqual(p.snapshot().oldest_job_ms_since_progress, null);</code>. AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

## Восстановление

Проверены байты и SHA-256 после всех 26 откатов; в конце повторно сверены исходники и целевые тесты:

| Файл | SHA-256 до и после |
| --- | --- |
| <code>src/job-pool.js</code> | <code>9fff2895a07342a4a5e6419a9b5f50181eeb06e4aea78b46553f40e47e1f812e</code> |
| <code>src/pacer.js</code> | <code>83cc982e9f5a572ac0105bd5e19d372d469d426825911dc9ec81521141c7e31d</code> |
| <code>src/progress.js</code> | <code>35c3ddb874da24ebb855b07f053ce2c3be86860310300fb456b2397c2813ecb5</code> |
| <code>scripts/test-job-pool.js</code> | <code>ae6213e9566d333c2190ea488c6bbf2404fa69fe82e7b82372d8f4baf4da633f</code> |
| <code>scripts/test-pacer.js</code> | <code>17874d69de1df6792ce8f8b6335d73aa850a91335daed7831cfec79fd3db1e5b</code> |
| <code>scripts/test-progress.js</code> | <code>edd02157a37ac9ccf55cda338aaa3102614656f71b79d3cc675876184503971f</code> |

Дополнительно критерий AC-001 проверяет git diff относительно HEAD; результаты приёмки записываются отдельно в report.json после чтения этого отчёта.
