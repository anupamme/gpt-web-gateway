# Независимый мутационный прогон M3

- Дата: 2026-10-15T09:44:59.835Z. HEAD: 5e9521e7ba95c7d4f26895dd21df67822161be5d.
- Среда: Docker node:24 uid:gid=1002:1002, Node v24.21.0.
- Мутаций: 45; убито: 30; выжило: 15.
- Каталог N01–N45 новый: замены I01–I34/D1–D7 и обеих старых обвязок не повторялись; старые обвязки не запускались.
- Все 11 целевых тестов зелёные до мутаций и после восстановления; перед КАЖДОЙ заменой повторён чистый целевой тест.
- Фрагменты уникальны. Исходные Buffer и SHA-256 сохранены; запись и тест внутри try/finally; после каждого отката сверены хеши всех 54 защищённых файлов.
- «Убит»: rc=1, AssertionError/ERR_ASSERTION, ожидаемый сценарий в первой строке FAIL и stack-frame целевого теста. Сбои загрузки/синтаксиса/таймауты не засчитываются.
- Мутационная оценка выявляет ограничения тестов; она не означает, что исходный код содержит внесённые дефекты.
- Для каждой мутации, пережившей первичный тест, на том же мутанте дополнительно прогнаны все остальные тесты из задания. Каждый «выжил» означает rc=0 всего набора из 11 тестов. Первая обнаружившая мутацию проверка указана в таблице.

## Результаты

| ID | Файл | Замена | Целевой тест | Результат | Первая упавшая строка |
| --- | --- | --- | --- | --- | --- |
| N01 | <code>src/chatgpt.js</code> | <code>  victim.capture = null;</code> → <code>  void victim.capture;</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: hardResetBrowser closes every slot page — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N02 | <code>src/chatgpt.js</code> | <code>  victim.lastConversationFetch = null;</code> → <code>  void victim.lastConversationFetch;</code> | <code>scripts/test-parallel-adapter.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N03 | <code>src/chatgpt.js</code> | <code>    slot.pendingReset = null;<br>    slot.staleStreams = new Set();</code> → <code>    void slot.pendingReset;<br>    slot.staleStreams = new Set();</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: hardResetBrowser closes every slot page — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N04 | <code>src/chatgpt.js</code> | <code>    slot.staleStreams = new Set();</code> → <code>    void slot.staleStreams;</code> | <code>scripts/test-parallel-slots.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N05 | <code>src/chatgpt.js</code> | <code>  target.recoveryState = 'healthy';<br>  target.menuFailures = 0;</code> → <code>  target.recoveryState = 'healthy';<br>  void target.menuFailures;</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: markHealthyCompletion of one slot leaves the other on probation — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N06 | <code>src/chatgpt.js</code> | <code>  victim.pagePromise = null;</code> → <code>  victim.pagePromise = null;<br>  getSlot(1 - victim.id).pendingReset = null;</code> | <code>scripts/test-parallel-adapter.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N07 | <code>src/chatgpt.js</code> | <code>if (cap &amp;&amp; cap.boundStream) slot.staleStreams.add(cap.boundStream);</code> → <code>if (cap &amp;&amp; cap.boundStream) getSlot(1 - slot.id).staleStreams.add(cap.boundStream);</code> | <code>scripts/test-parallel-adapter.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N08 | <code>src/chatgpt.js</code> | <code>  for (const slot of slotsById.values()) {<br>    discardSlotPage(slot);</code> → <code>  for (const slot of slotsById.values()) {<br>    if (!slot.page) continue;<br>    discardSlotPage(slot);</code> | <code>scripts/test-parallel-slots.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N09 | <code>src/chatgpt.js</code> | <code>return await autoLoginMaintenance(slot, 'out');<br>  } finally {<br>    resetAllSlotPages();</code> → <code>return await autoLoginMaintenance(slot, 'out');<br>  } finally {<br>    void slot;</code> | <code>scripts/test-session-check.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N10 | <code>src/chatgpt.js</code> | <code>    throw err;<br>  } finally {<br>    resetAllSlotPages();<br>  }<br>}<br><br>// ==== Traffic-independent</code> → <code>    throw err;<br>  } finally {<br>    if (!recordedLoginError) resetAllSlotPages();<br>  }<br>}<br><br>// ==== Traffic-independent</code> | <code>scripts/test-parallel-watchdog.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N11 | <code>src/chatgpt.js</code> | <code>  resetAllSlotPages();<br>  await closeBrowser().catch(() =&gt; {});</code> → <code>  await closeBrowser().catch(() =&gt; {});<br>  resetAllSlotPages();</code> | <code>scripts/test-parallel-slots.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N12 | <code>src/chatgpt.js</code> | <code>requestMaintenanceNoAwait(name, fn, slot.epoch);</code> → <code>requestMaintenanceNoAwait(name, fn, slot.id);</code> | <code>scripts/test-parallel-adapter.js</code> | убит | FAIL: hard recovery inside a job requests maintenance before destroying either page — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N13 | <code>src/job-pool.js</code> | <code>nameDoneEpoch.get(name) &gt; opts.sinceEpoch</code> → <code>nameDoneEpoch.get(name) &gt;= opts.sinceEpoch</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: sinceEpoch skips a maintenance that already completed after that epoch — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| N14 | <code>src/job-pool.js</code> | <code>if (pending) return pending.promise;</code> → <code>if (pending) return Promise.resolve({ skipped: true });</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: same-name maintenance merges only while it is waiting to start — AssertionError [ERR_ASSERTION]: Expected "actual" to be reference-equal to "expected": |
| N15 | <code>src/job-pool.js</code> | <code>entry.name === name &amp;&amp; entry.kind === kind</code> → <code>entry.kind === kind</code> | <code>scripts/test-job-pool.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N16 | <code>src/job-pool.js</code> | <code>if (pending) return pending.promise;</code> → <code>if (pending) { pending.fn = fn; return pending.promise; }</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: same-name maintenance merges only while it is waiting to start — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| N17 | <code>src/chatgpt.js</code> | <code>  if (getSlot(0).pendingReset) {</code> → <code>  if (getSlot(1).pendingReset) {</code> | <code>scripts/test-parallel-watchdog.js</code> | убит | FAIL: watchdog skips reset, fresh traffic and absent pages before acquiring AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N18 | <code>src/chatgpt.js</code> | <code>  if (!force &amp;&amp; sessionHealth.isFreshlyValid(SESSION_WATCHDOG_INTERVAL_MS)) {</code> → <code>  if (sessionHealth.isFreshlyValid(SESSION_WATCHDOG_INTERVAL_MS)) {</code> | <code>scripts/test-parallel-watchdog.js</code> | убит | FAIL: watchdog skips reset, fresh traffic and absent pages before acquiring AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N19 | <code>src/chatgpt.js</code> | <code>      if (hasExclusive) release = await hooks.acquireExclusive('watchdog');</code> → <code>      if (hasExclusive) { await Promise.resolve(); release = await hooks.acquireExclusive('watchdog'); }</code> | <code>scripts/test-parallel-watchdog.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N20 | <code>src/chatgpt.js</code> | <code>      return await probeSessionState(p, { attempts: Math.min(2, SESSION_PROBE_ATTEMPTS) });</code> → <code>      return probeSessionState(p, { attempts: Math.min(2, SESSION_PROBE_ATTEMPTS) });</code> | <code>scripts/test-parallel-watchdog.js</code> | убит | FAIL: watchdog holds the pool while probing and releases it afterwards AssertionError [ERR_ASSERTION]: D6: a job must wait for watchdog exclusive |
| N21 | <code>src/chatgpt.js</code> | <code>  sessionProbeInFlight = probe;</code> → <code>  sessionProbeInFlight = probe.then(state =&gt; state);</code> | <code>scripts/test-parallel-watchdog.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N22 | <code>src/chatgpt.js</code> | <code>    recordLoginFailure(err.loginBlocker);</code> → <code>    recordLoginFailure("unknown");</code> | <code>scripts/test-parallel-watchdog.js</code> | убит | FAIL: diagnosed auto-login failures are wrapped, counted and throttled AssertionError [ERR_ASSERTION]: D4: failure counter |
| N23 | <code>src/chatgpt.js</code> | <code>    loginThrottle.recordFailure(err);</code> → <code>    void err;</code> | <code>scripts/test-parallel-watchdog.js</code> | убит | FAIL: diagnosed auto-login failures are wrapped, counted and throttled AssertionError [ERR_ASSERTION]: The input did not match the regular expression /auto-login on cooldown/. Input: |
| N24 | <code>src/chatgpt.js</code> | <code>    err.cause = e;</code> → <code>    err.cause = null;</code> | <code>scripts/test-parallel-watchdog.js</code> | убит | FAIL: diagnosed auto-login failures are wrapped, counted and throttled AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N25 | <code>src/routes/images.js</code> | <code>if (turnErr &amp;&amp; turnErr.retryAfterMaintenance &amp;&amp; i === 0 &amp;&amp; out.length === 0) throw turnErr;</code> → <code>if (turnErr &amp;&amp; turnErr.retryAfterMaintenance &amp;&amp; i === 0 &amp;&amp; out.length === 0) delete turnErr.retryAfterMaintenance;</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: a first image maintenance marker retries the untouched batch — AssertionError [ERR_ASSERTION]: {"ok":false,"error_kind":"page_load_failed","should_retry":true,"model_message":null,"error":{"message":"first page needs maintenance","type":"server_error"}} |
| N26 | <code>src/routes/images.js</code> | <code>const partial = results.length &lt; n;</code> → <code>const partial = results.length === n;</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: a later image maintenance marker preserves the completed batch prefix — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N27 | <code>src/routes/images.js</code> | <code>progress.touch(ctx.jobId); // per-image heartbeat</code> → <code>progress.touch(ctx.slotId); // per-image heartbeat</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: per-image heartbeat keeps a long batch alive with no gap — AssertionError [ERR_ASSERTION]: D5: completed images must refresh the running batch liveness |
| N28 | <code>src/routes/login.js</code> | <code>throw loginError('login session is not active — open /login', 409);</code> → <code>throw loginError('login session is not active — open /login', 503);</code> | <code>scripts/test-parallel-login.js</code> | убит | FAIL: inactive login screenshot returns 409 without acquiring or creating a page — AssertionError [ERR_ASSERTION]: inactive screenshot must refuse the request |
| N29 | <code>src/routes/login.js</code> | <code>    armLoginIdle();<br>    return;</code> → <code>    return;</code> | <code>scripts/test-parallel-login.js</code> | убит | FAIL: active screenshot renews idle timeout and expired screenshots cannot reacquire — AssertionError [ERR_ASSERTION]: active screenshot did not renew the idle timeout |
| N30 | <code>src/routes/login.js</code> | <code>  if (loginHold.timer) clearTimeout(loginHold.timer);</code> → <code>  void loginHold.timer;</code> | <code>scripts/test-parallel-login.js</code> | убит | FAIL: active screenshot renews idle timeout and expired screenshots cannot reacquire — AssertionError [ERR_ASSERTION]: active screenshot did not renew the idle timeout |
| N31 | <code>src/routes/login.js</code> | <code>      await attempt.acquired;</code> → <code>      void attempt.acquired;</code> | <code>scripts/test-parallel-login.js</code> | убит | FAIL: parallel login callers share one pending exclusive and wait before using pages — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N32 | <code>src/routes/login.js</code> | <code>saveChain = run.then(() =&gt; {}, () =&gt; {});</code> → <code>saveChain = run;</code> | <code>scripts/test-parallel-routes.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N33 | <code>src/routes/login.js</code> | <code>  loginHold = null;<br>  if (attempt.timer)</code> → <code>  void loginHold;<br>  if (attempt.timer)</code> | <code>scripts/test-parallel-login.js</code> | убит | FAIL: screenshot polling after save cannot reacquire the manual login hold — AssertionError [ERR_ASSERTION]: post-save polling must leave the pool available |
| N34 | <code>src/routes/images.js</code> | <code>return String(id).toLowerCase();</code> → <code>return String(id);</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: the same conversation_id does not run on two slots — AssertionError [ERR_ASSERTION]: same conversation overlapped: A,A-again,B |
| N35 | <code>src/routes/images.js</code> | <code>return String(id).toLowerCase();</code> → <code>return String(id).toLowerCase().slice(0, -1);</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: the same conversation_id does not run on two slots — AssertionError [ERR_ASSERTION]: [{"slotId":0,"busy":true,"jobId":"j1","key":"1f0e4b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5"},{"slotId":1,"busy":false,"jobId":null,"key":null},{"slotId":2,"busy":false,"jobId":null,"key":null}] |
| N36 | <code>src/chatgpt.js</code> | <code>      const timing = {};<br>      if (typeof options.beforeSubmit === 'function') await options.beforeSubmit();</code> → <code>      const timing = {};<br>      if (typeof options.beforeSubmit === 'function') { await options.beforeSubmit(); await options.beforeSubmit(); }</code> | <code>scripts/test-parallel-adapter.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N37 | <code>src/routes/images.js</code> | <code>for (let i = 0; i &lt; paced; i += 1) turnGate.finished(ctx.slotId);</code> → <code>for (let i = 0; i &lt; paced; i += 1) turnGate.finished((ctx.slotId + 1) % pool.status().concurrency);</code> | <code>scripts/test-parallel-routes.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N38 | <code>src/job-pool.js</code> | <code>if (!canAdmitImmediately(normalizedKey) &amp;&amp; limitedWaiting &gt;= maxWaiting) {</code> → <code>if (!canAdmitImmediately(normalizedKey) &amp;&amp; limitedWaiting &gt; maxWaiting) {</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: submit throws queue_full synchronously when maxWaiting is reached — AssertionError [ERR_ASSERTION]: queue_full must be thrown, not returned |
| N39 | <code>src/routes/images.js</code> | <code>  observeDuration('queue_full', elapsedSec(startedAt));<br>  res.set('Retry-After', String(retryAfterSec));</code> → <code>  observeDuration('queue_full', elapsedSec(startedAt));<br>  res.set('Retry-After', String(QUEUE_FULL_RETRY_AFTER));</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: a full waiting list is 429 queue_full with Retry-After for two waiters — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N40 | <code>src/routes/images.js</code> | <code>    progress.jobRunning(ctx.jobId);</code> → <code>    progress.jobRunning(ctx.slotId);</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: per-image heartbeat keeps a long batch alive with no gap — AssertionError [ERR_ASSERTION]: D5: completed images must refresh the running batch liveness |
| N41 | <code>src/routes/images.js</code> | <code>        progress.jobRequeued(ctx.jobId);</code> → <code>        progress.jobFinished(null, ctx.jobId);</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: a maintenance requeue removes the old running heartbeat — AssertionError [ERR_ASSERTION]: the waiting request remains admitted |
| N42 | <code>src/routes/images.js</code> | <code>      progress.jobFinished(null, ctx.jobId);</code> → <code>      progress.jobFinished(null, ctx.slotId);</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: per-image heartbeat keeps a long batch alive with no gap — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| N43 | <code>src/routes/images.js</code> | <code>      progress.jobFinished(classifyError(err &amp;&amp; err.message, err &amp;&amp; err.code), ctx.jobId);</code> → <code>      progress.jobFinished(null, ctx.jobId);</code> | <code>scripts/test-parallel-routes.js</code><br>+ все 11 тестов | выжил | — (rc=0) |
| N44 | <code>src/chatgpt-tiers.js</code> | <code>strikes.delete(strikeKey(mode, slotIdFrom(opts)));</code> → <code>strikes.delete(strikeKey(mode, 1 - slotIdFrom(opts)));</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: tier strikes do not add across slots or break a neighbour series — AssertionError [ERR_ASSERTION]: slot 1 success cleared slot 0 |
| N45 | <code>src/chatgpt-tiers.js</code> | <code>if (count &gt;= stickyAfter) this.markUnavailable(mode, reason, { env, now });</code> → <code>if (count &gt; stickyAfter) this.markUnavailable(mode, reason, { env, now });</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: tier strikes do not add across slots or break a neighbour series — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |

## Проверка причин обнаружения

- **N01** — discardSlotPage сохраняет capture. <code>scripts/test-parallel-slots.js:214:10</code>; rc=1. <code>FAIL: hardResetBrowser closes every slot page — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:<br>+ actual - expected<br>+ {<br>+   boundStream: null,<br>+   feed: [Function: feed],<br>+   text: ''<br>+ }<br>- null</code>
- **N03** — Общий reset сохраняет pendingReset. <code>scripts/test-parallel-slots.js:213:10</code>; rc=1. <code>FAIL: hardResetBrowser closes every slot page — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:</code>
- **N05** — Успех слота сохраняет menuFailures. <code>scripts/test-parallel-slots.js:102:10</code>; rc=1. <code>FAIL: markHealthyCompletion of one slot leaves the other on probation — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:</code>
- **N12** — sinceEpoch ошибочно равен slotId. <code>scripts/test-parallel-adapter.js:181:10</code>; rc=1. <code>FAIL: hard recovery inside a job requests maintenance before destroying either page — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:</code>
- **N13** — Reset пропускается при равенстве epoch. <code>scripts/test-job-pool.js:267:10</code>; rc=1. <code>FAIL: sinceEpoch skips a maintenance that already completed after that epoch — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:<br>+ actual - expected<br>+   skipped: true<br>-   skipped: false,<br>-   value: 'third'</code>
- **N14** — Второй слот не ждёт общего pending reset. <code>scripts/test-job-pool.js:235:10</code>; rc=1. <code>FAIL: same-name maintenance merges only while it is waiting to start — AssertionError [ERR_ASSERTION]: Expected "actual" to be reference-equal to "expected":<br>+ actual - expected<br>+   &lt;pending&gt;<br>-   {<br>-     skipped: true<br>-   }</code>
- **N16** — Последний запрос подменяет callback первого. <code>scripts/test-job-pool.js:238:10</code>; rc=1. <code>FAIL: same-name maintenance merges only while it is waiting to start — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:<br>+ actual - expected<br>+   value: 'two'<br>-   value: 'one'</code>
- **N17** — Watchdog проверяет pendingReset другого слота. <code>scripts/test-parallel-watchdog.js:132:10</code>; rc=1. <code>FAIL: watchdog skips reset, fresh traffic and absent pages before acquiring AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:<br>  actual: 'in',<br>  expected: 'skipped',<br>  operator: 'strictEqual',</code>
- **N18** — Свежий traffic блокирует принудительную пробу. <code>scripts/test-parallel-watchdog.js:139:10</code>; rc=1. <code>FAIL: watchdog skips reset, fresh traffic and absent pages before acquiring AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:<br>+ actual - expected<br>+ 'skipped'<br>- 'unknown'<br>  actual: 'skipped',<br>  expected: 'unknown',<br>  operator: 'strictEqual',</code>
- **N20** — Отсутствие await запускает finally до завершения пробы. <code>scripts/test-parallel-watchdog.js:96:10</code>; rc=1. <code>FAIL: watchdog holds the pool while probing and releases it afterwards AssertionError [ERR_ASSERTION]: D6: a job must wait for watchdog exclusive<br>  actual: true,<br>  expected: false,<br>  operator: 'strictEqual',</code>
- **N22** — Ошибка auto-login учитывается под неверным blocker. <code>scripts/test-parallel-watchdog.js:62:12</code>; rc=1. <code>FAIL: diagnosed auto-login failures are wrapped, counted and throttled AssertionError [ERR_ASSERTION]: D4: failure counter<br>  actual: 0,<br>  expected: 1,<br>  operator: 'strictEqual',</code>
- **N23** — Ошибка auto-login не включает cooldown. <code>scripts/test-parallel-watchdog.js:66:5</code>; rc=1. <code>FAIL: diagnosed auto-login failures are wrapped, counted and throttled AssertionError [ERR_ASSERTION]: The input did not match the regular expression /auto-login on cooldown/. Input:<br>  actual: [Error],<br>  expected: /auto-login on cooldown/,<br>  operator: 'rejects',</code>
- **N24** — Обёртка auto-login теряет cause. <code>scripts/test-parallel-watchdog.js:58:12</code>; rc=1. <code>FAIL: diagnosed auto-login failures are wrapped, counted and throttled AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:<br>+ actual - expected<br>+ null<br>- Error: form changed<br>-     at /app/scripts/test-parallel-watchdog.js:49:33<br>-     at /app/scripts/test-parallel-watchdog.js:198:11<br>-     at Object.&lt;anonymous&gt; (/app/scripts/test-parallel-watchdog.js:202:3)<br>-     at Module._compile (node:internal/modules/cjs/loader:1929:14)<br>-     at Object..js (node:internal/modules/cjs/loader:2060:10)<br>-     at Module.load (node:internal/modules/cjs/loader:1651:32)</code>
- **N25** — Первый image-marker теряет retry-флаг. <code>scripts/test-parallel-routes.js:644:14</code>; rc=1. <code>FAIL: a first image maintenance marker retries the untouched batch — AssertionError [ERR_ASSERTION]: {"ok":false,"error_kind":"page_load_failed","should_retry":true,"model_message":null,"error":{"message":"first page needs maintenance","type":"server_error"}}</code>
- **N26** — Флаг partial инвертирован. <code>scripts/test-parallel-routes.js:613:14</code>; rc=1. <code>FAIL: a later image maintenance marker preserves the completed batch prefix — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:<br>+ actual - expected<br>+ undefined<br>- true</code>
- **N27** — Heartbeat картинки адресуется slotId вместо jobId. <code>scripts/test-parallel-routes.js:674:16</code>; rc=1. <code>FAIL: per-image heartbeat keeps a long batch alive with no gap — AssertionError [ERR_ASSERTION]: D5: completed images must refresh the running batch liveness<br>+ actual - expected<br>+   alive: false,<br>+   reason: 'job j1 no progress for 1080s'<br>-   alive: true,<br>-   reason: 'ok'</code>
- **N28** — Неактивный screenshot возвращает 503. <code>scripts/test-parallel-login.js:112:10</code>; rc=1. <code>FAIL: inactive login screenshot returns 409 without acquiring or creating a page — AssertionError [ERR_ASSERTION]: inactive screenshot must refuse the request</code>
- **N29** — Активный caller не продлевает idle timeout. <code>scripts/test-parallel-login.js:219:10</code>; rc=1. <code>FAIL: active screenshot renews idle timeout and expired screenshots cannot reacquire — AssertionError [ERR_ASSERTION]: active screenshot did not renew the idle timeout</code>
- **N30** — Продление idle не отменяет старый таймер. <code>scripts/test-parallel-login.js:219:10</code>; rc=1. <code>FAIL: active screenshot renews idle timeout and expired screenshots cannot reacquire — AssertionError [ERR_ASSERTION]: active screenshot did not renew the idle timeout</code>
- **N31** — Параллельный caller не ждёт общий acquire. <code>scripts/test-parallel-login.js:164:10</code>; rc=1. <code>FAIL: parallel login callers share one pending exclusive and wait before using pages — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:</code>
- **N33** — Release сохраняет запись старого loginHold. <code>scripts/test-parallel-login.js:133:10</code>; rc=1. <code>FAIL: screenshot polling after save cannot reacquire the manual login hold — AssertionError [ERR_ASSERTION]: post-save polling must leave the pool available</code>
- **N34** — Conversation key сохраняет регистр. <code>scripts/test-parallel-routes.js:260:14</code>; rc=1. <code>FAIL: the same conversation_id does not run on two slots — AssertionError [ERR_ASSERTION]: same conversation overlapped: A,A-again,B</code>
- **N35** — Conversation key теряет последний символ UUID. <code>scripts/test-parallel-routes.js:263:14</code>; rc=1. <code>FAIL: the same conversation_id does not run on two slots — AssertionError [ERR_ASSERTION]: [{"slotId":0,"busy":true,"jobId":"j1","key":"1f0e4b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5"},{"slotId":1,"busy":false,"jobId":null,"key":null},{"slotId":2,"busy":false,"jobId":null,"key":null}]</code>
- **N38** — submit допускает одно лишнее ожидающее задание. <code>scripts/test-job-pool.js:150:10</code>; rc=1. <code>FAIL: submit throws queue_full synchronously when maxWaiting is reached — AssertionError [ERR_ASSERTION]: queue_full must be thrown, not returned</code>
- **N39** — Retry-After игнорирует gap ожидающих jobs. <code>scripts/test-parallel-routes.js:224:12</code>; rc=1. <code>FAIL: a full waiting list is 429 queue_full with Retry-After for two waiters — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:</code>
- **N40** — jobRunning использует slotId. <code>scripts/test-parallel-routes.js:674:16</code>; rc=1. <code>FAIL: per-image heartbeat keeps a long batch alive with no gap — AssertionError [ERR_ASSERTION]: D5: completed images must refresh the running batch liveness<br>+ actual - expected<br>+   alive: false,<br>+   reason: 'job 0 no progress for 1080s'<br>-   alive: true,<br>-   reason: 'ok'</code>
- **N41** — Requeue учитывается как успешное завершение. <code>scripts/test-parallel-routes.js:746:16</code>; rc=1. <code>FAIL: a maintenance requeue removes the old running heartbeat — AssertionError [ERR_ASSERTION]: the waiting request remains admitted</code>
- **N42** — Успешное jobFinished удаляет slotId. <code>scripts/test-parallel-routes.js:676:16</code>; rc=1. <code>FAIL: per-image heartbeat keeps a long batch alive with no gap — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:</code>
- **N44** — markAvailable удаляет strikes соседа. <code>scripts/test-parallel-slots.js:128:10</code>; rc=1. <code>FAIL: tier strikes do not add across slots or break a neighbour series — AssertionError [ERR_ASSERTION]: slot 1 success cleared slot 0</code>
- **N45** — Tier cooldown включается на одно наблюдение позже. <code>scripts/test-parallel-slots.js:124:10</code>; rc=1. <code>FAIL: tier strikes do not add across slots or break a neighbour series — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:</code>

## Разбор выживших

### N02: discardSlotPage сохраняет conversation GET

Дыра в проверке очистки: response-listener проверяет запись snapshot, но recreate не заполняет snapshot перед reset и не проверяет его очистку. Важно: waitAndExtractText дополнительно требует fetched.at >= start и новый текст, поэтому обычный старый ответ защищён временем. Различие гарантированно видно в состоянии slot.lastConversationFetch; риск выдачи старого ответа требует совпадения миллисекунды или отката wall clock. Это не доказанный дефект обычного пользовательского запроса.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N04: Общий reset сохраняет staleStreams

Дыра в инварианте общего reset: тест hard-reset не заполняет staleStreams и не проверяет новую пустую Set. Мутант сохраняет старые id и по-другому обработает повтор такого id в новом документе. Генератор stream id использует Date.now()+Math.random(), поэтому случайное совпадение маловероятно; практический сбой этим прогоном не доказан, изменение состояния при reset — наблюдаемо.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N06: Локальный discard очищает pendingReset соседа

Дыра: recreatePage очищает page/pageToSlot напрямую и обходит discardSlotPage, поэтому сценарий recreate не достигает этой замены. Auto-login в adapter начинается в слоте 0, а pendingReset соседа там не задан. Локальный reset слота при pendingReset соседа поглотит его восстановление.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N07: Завершённый stream помечается stale у соседа

Дыра: beforeSubmit-сценарий завершает capture без boundStream; SSE-сценарий не вызывает endBackendCapture и следующий turn. Свой поздний stream сможет снова привязаться; сосед потеряет одноимённый stream.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N08: Общий reset пропускает слоты без страницы

Дыра: hard-reset создаёт страницы обоим слотам; нет комбинации page=null с pendingReset/staleStreams. После обслуживания флаги пустого слота сохраняются.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N09: Context-rebuild не выполняет заключительный общий reset

Дыра: session-check проверяет probe/re-navigation, но не rebuildContextMaintenance. hardResetBrowser очищает старые страницы ДО getPage; новая страница после maintenance остаётся.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N10: Auto-login пропускает общий reset при отказе post-check

Дыра: post-login failure проверяет текст, счётчик и reason, но не страницы. recordedLoginError появляется только после post-check; тест диагностированной ошибки по-прежнему очищает страницы.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N11: Hard-reset закрывает browser до отсоединения страниц

Дыра: проверяется итоговый close/page=null, но не порядок относительно closeBrowser. Пока closeBrowser ожидает, старые page/capture доступны; порядок наблюдаем на асинхронной границе.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N15: Сливаются pending maintenance разных имён

Дыра: merge тестирует одинаковые имена; sinceEpoch тестирует разные имена последовательно, а не одновременно за занятым слотом. Параллельные hard-reset/auto-login потеряют один callback.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N19: Watchdog откладывает acquire на микрозадачу после idle-check

Дыра: job в тесте появляется после сигнала started из probe; нет job сразу после вызова checkSessionOnce. В новом окне job может занять слот до acquireExclusive.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N21: Watchdog публикует lease с другой identity и не очищает его в finally

Дыра: single-flight проверяется во время pending/probe, но после завершения нет нового checkSessionOnce на том же экземпляре модуля. Условие sessionProbeInFlight === probe становится ложным; все следующие тики будут skipped.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N32: Ошибка save сохраняет rejected promise в saveChain

Дыра: есть одновременные успешные save и общий отказ acquire, но после неудачного save на том же router нет успешного повторного save. Rejected saveChain не запускает следующие saveManualLogin даже после восстановления exclusive.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N36: completeText вызывает beforeSubmit дважды

Дыра: hook в сценарии сразу бросает sentinel, второй вызов недостижим. Успешный hook вызовется дважды и повторно резервирует pacing.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N37: finished отмечает pacer соседа

Дыра: batch проверяет gap при concurrency=1, где сосед совпадает с владельцем. Stagger проверяет gate между слотами, но не повторный turn одного слота при concurrency>1. Владелец теряет gap, сосед получает чужой.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

### N43: Ошибка submitJob учитывается как успех

Дыра: сценарий отказа проверяет HTTP 503 и pacing, но не consecutive_infra_failures после submitJob. Ошибки перестают накапливаться в liveness.

Не эквивалентен исходному коду: описанное состояние/порядок исполнения меняет наблюдаемое поведение. Все 11 тестов задания завершились с rc=0 на этой мутации.

## Контроль восстановления

Восстановлены исходные байты и SHA-256 всех 54 файлов src/ и scripts/test-*.js; целевые тесты повторены после последней мутации.

| Файл с мутациями | Исходный и итоговый SHA-256 |
| --- | --- |
| <code>src/chatgpt.js</code> | <code>9498df8150fa19a88ecfdbc5d99d25100b34f8df790f87d7d736e3330befc240</code> |
| <code>src/job-pool.js</code> | <code>15cb2bcd6f6953dd5aa0d2c31636f719c91ffbb829abeea398ba4820e6df9585</code> |
| <code>src/routes/images.js</code> | <code>c14352cffee3d9c5a54e680c9d443ef7967676bdb6159af0ceed2036d0548959</code> |
| <code>src/routes/login.js</code> | <code>cf328c3371a3bf443d02c3c2dfa626f8727c05b8010a38b138eb4ecffc7ec24a</code> |
| <code>src/chatgpt-tiers.js</code> | <code>1ce607c9af60730f70702cdba113c3845b70a4871a4890592dfb98b8c3db5bbf</code> |

Боевой код и тесты не исправлялись. Коммиты и push не выполнялись.
