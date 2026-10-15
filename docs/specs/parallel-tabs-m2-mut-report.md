# Независимый мутационный прогон M2

Исходный коммит: <code>3e37fb57f0811ddd3711648bf4f219af7f93bee0</code>. Среда: Docker node:24, Node v24.21.0, UID/GID 1002:1002.

Всего 36 мутаций: **убит — 18, выжил — 18**. Время прогона: 21 с. Выжившие не означают провал AC.

Проверяются существующие тесты без дополнений и исправлений. Все семь базовых наборов зелёные; непосредственно перед каждой мутацией её целевой тест повторно прошёл на чистом дереве. Каждая замена встретилась ровно один раз. Каждая мутация восстановлена в finally; SHA-256 всех отслеживаемых src/ и scripts/test-*.js совпал с исходным; git diff HEAD по этим путям пуст.

Исходные mutate-parallel.js и mutate-parallel-tabs.js прочитаны, но не запускались. Их пары замен не повторены. Проверки на соседний слот здесь меняют callback проводки или добавляют загрязнение соседа, а не подменяют activeCapture/target/victim. Флаги обслуживания меняются в отдельных call-site, а не в общей ветке runOrDefer.

«Убит» засчитывается только при ожидаемом ассерте целевого сценария. Синтаксические ошибки, сбои загрузки, сигналы, таймауты и посторонние падения не засчитываются; необъяснённое падение останавливает обвязку. rc=0 означает выполненный аудит, а не отсутствие выживших.

## Базовые тесты

- <code>node scripts/test-parallel-slots.js</code>: rc=0; 9/9 passed
- <code>node scripts/test-parallel-routes.js</code>: rc=0; 11/11 passed
- <code>node scripts/test-job-pool.js</code>: rc=0; 28/28 passed
- <code>node scripts/test-pacer.js</code>: rc=0; 34/34 passed
- <code>node scripts/test-progress.js</code>: rc=0; All 15 progress tests passed.
- <code>node scripts/test-tiers.js</code>: rc=0; 36 tier tests passed
- <code>node scripts/test-cooldown.js</code>: rc=0; 9/9 passed

## Результаты

| ID | Файл | Замена (было → стало) | Целевой тест | Результат | Первая упавшая строка |
| --- | --- | --- | --- | --- | --- |
| I01 | <code>src/chatgpt.js</code> | <code>    acceptSseChunk(slot, streamId, chunk);</code> → <code>    acceptSseChunk(getSlot(1 - slot.id), streamId, chunk);</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I02 | <code>src/chatgpt.js</code> | <code>        rememberConversation(slot, snap);</code> → <code>        rememberConversation(getSlot(1 - slot.id), snap);</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I03 | <code>src/chatgpt.js</code> | <code>function resetPage(slot = getSlot(0)) {<br>  discardSlotPage(slot);<br>}</code> → <code>function resetPage(slot = getSlot(0)) {<br>  discardSlotPage(slot);<br>  discardSlotPage(getSlot(1 - slot.id));<br>}</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: resetPage closes only the page of the slot it was given — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I04 | <code>src/chatgpt.js</code> | <code>async function recreatePage(stale) {<br>  const slot = slotOf(stale);</code> → <code>async function recreatePage(stale) {<br>  const slot = slotOf(stale);<br>  resetPage(getSlot(1 - slot.id));</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I05 | <code>src/chatgpt.js</code> | <code>function closeWedgedPage(p) {<br>  try {</code> → <code>function closeWedgedPage(p) {<br>  p = getSlot(1 - slotOf(p).id).page;<br>  try {</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: closing a wedged page keeps it bound to its own slot — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I06 | <code>src/chatgpt.js</code> | <code>await runOrDefer('hard-reset', () =&gt; hardResetBrowser(), slot, {<br>      exclusive: false,</code> → <code>await runOrDefer('hard-reset', () =&gt; hardResetBrowser(), slot, {<br>      exclusive: true,</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I07 | <code>src/chatgpt.js</code> | <code>return runOrDefer('auto-login', () =&gt; autoLoginMaintenance(slot, state), slot, {<br>    exclusive: false,</code> → <code>return runOrDefer('auto-login', () =&gt; autoLoginMaintenance(slot, state), slot, {<br>    exclusive: true,</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: a logged-out slot requests auto-login maintenance and does not run it — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I08 | <code>src/chatgpt.js</code> | <code>    requestMaintenanceNoAwait(name, fn, slot.epoch);<br>    const err = new Error(opts.message);</code> → <code>    require('./browser').clearSession();<br>    requestMaintenanceNoAwait(name, fn, slot.epoch);<br>    const err = new Error(opts.message);</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I09 | <code>src/chatgpt.js</code> | <code>      if (err &amp;&amp; err.retryAfterMaintenance) throw err;</code> → <code>      if (err &amp;&amp; err.retryAfterMaintenance) delete err.retryAfterMaintenance;</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I10 | <code>src/chatgpt.js</code> | <code>  Promise.resolve(pending).catch((err) =&gt; {<br>    console.log(`[chatgpt] maintenance ${name} failed: ${err &amp;&amp; err.message ? err.message : err}`);<br>  });</code> → <code>  Promise.resolve(pending);</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I11 | <code>src/chatgpt.js</code> | <code>    sessionHealth.invalidate(`login_failed:${err.loginBlocker}`);<br>    throw err;<br>  } finally {<br>    resetAllSlotPages();</code> → <code>    sessionHealth.invalidate(`login_failed:${err.loginBlocker}`);<br>    throw err;<br>  } finally {<br>    resetPage(slot);</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I12 | <code>src/chatgpt.js</code> | <code>async function hardResetBrowser() {<br>  resetAllSlotPages();</code> → <code>async function hardResetBrowser() {<br>  resetPage(getSlot(0));</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: hardResetBrowser closes every slot page — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I13 | <code>src/chatgpt.js</code> | <code>  target.recoveryState = 'healthy';<br>  target.menuFailures = 0;</code> → <code>  target.recoveryState = 'healthy';<br>  target.menuFailures = 0;<br>  getSlot(1 - target.id).menuFailures = 0;</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: markHealthyCompletion of one slot leaves the other on probation — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I14 | <code>src/chatgpt.js</code> | <code>  target.pendingReset = target.recoveryState === 'probation' ? 'hard' : 'page';</code> → <code>  target.pendingReset = getSlot(1 - target.id).recoveryState === 'probation' ? 'hard' : 'page';</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I15 | <code>src/routes/images.js</code> | <code>heartbeat: (slotId) =&gt; progress.touch(jobIdBySlot.get(slotId)),</code> → <code>heartbeat: (slotId) =&gt; progress.touch(),</code> | <code>scripts/test-parallel-routes.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I16 | <code>src/chatgpt.js</code> | <code>liveness.touch(slotOf(p).jobId); // chunk boundary</code> → <code>liveness.touch(); // chunk boundary</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I17 | <code>src/routes/images.js</code> | <code>        progress.jobRequeued(ctx.jobId);</code> → <code>        void ctx.jobId;</code> | <code>scripts/test-parallel-routes.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I18 | <code>src/routes/images.js</code> | <code>      beforeSubmit,<br>    })), conversationKey(conversationId));</code> → <code>      beforeSubmit,<br>    })), undefined);</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: the same conversation_id does not run on two slots — AssertionError [ERR_ASSERTION]: same conversation overlapped: A,A-again,B |
| I19 | <code>src/routes/images.js</code> | <code>      },<br>    })), conversationKey(conversationId));</code> → <code>      },<br>    })), undefined);</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: a streamed conversation_id stays on one slot — AssertionError [ERR_ASSERTION]: stream overlapped: A,A-again,B |
| I20 | <code>src/chatgpt.js</code> | <code>      const timing = {};<br>      if (typeof options.beforeSubmit === 'function') await options.beforeSubmit();</code> → <code>      const timing = {};</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I21 | <code>src/chatgpt.js</code> | <code>      const thinkingMode = normalizeThinkingMode(options.thinkingMode ?? options.thinking);<br>      const thinkingState = await setThinkingMode(p, thinkingMode);</code> → <code>      if (typeof options.beforeSubmit === 'function') {<br>        await options.beforeSubmit();<br>        options = { ...options, beforeSubmit: undefined };<br>      }<br>      const thinkingMode = normalizeThinkingMode(options.thinkingMode ?? options.thinking);<br>      const thinkingState = await setThinkingMode(p, thinkingMode);</code> | <code>scripts/test-parallel-slots.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I22 | <code>src/routes/images.js</code> | <code>  const remainingMs = rateLimitedUntil - Date.now();</code> → <code>  const remainingMs = 0;</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: a cooldown armed by one job refuses the next inside beforeSubmit — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I23 | <code>src/routes/images.js</code> | <code>    for (let i = 0; i &lt; paced; i += 1) turnGate.finished(ctx.slotId);</code> → <code>    for (let i = 0; i &lt; paced; i += 1) void ctx.slotId;</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: a batch pays the gap between images — AssertionError [ERR_ASSERTION]: gap 0 |
| I24 | <code>src/routes/images.js</code> | <code>    for (let i = 0; i &lt; paced; i += 1) turnGate.finished(ctx.slotId);</code> → <code>    for (let i = 0; i &lt; Math.max(1, paced); i += 1) turnGate.finished(ctx.slotId);</code> | <code>scripts/test-parallel-routes.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I25 | <code>src/routes/images.js</code> | <code>  res.status(429).json(buildErrorBody({<br>    kind: 'queue_full',</code> → <code>  res.status(500).json(buildErrorBody({<br>    kind: 'queue_full',</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: a full waiting list is 429 queue_full with Retry-After for two waiters — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I26 | <code>src/routes/images.js</code> | <code>  observeDuration('queue_full', elapsedSec(startedAt));<br>  res.set('Retry-After', String(retryAfterSec));</code> → <code>  observeDuration('queue_full', elapsedSec(startedAt));<br>  res.set('Retry-After', String(retryAfterSec * 1000));</code> | <code>scripts/test-parallel-routes.js</code> | убит | FAIL: a full waiting list is 429 queue_full with Retry-After for two waiters — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I27 | <code>src/routes/login.js</code> | <code>  if (loginHold) {<br>    armLoginIdle();<br>    await loginHold.acquired;</code> → <code>  if (loginHold) {<br>    await getPoolHooks().acquireExclusive('manual-login');<br>    armLoginIdle();<br>    await loginHold.acquired;</code> | <code>scripts/test-parallel-routes.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I28 | <code>src/chatgpt.js</code> | <code>tierAvailability.noteUnavailable(mode, reason, { stickyAfter: strikesNeeded, env, slotId: menuSlot.id });</code> → <code>tierAvailability.noteUnavailable(mode, reason, { stickyAfter: strikesNeeded, env });</code> | <code>scripts/test-tiers.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I29 | <code>src/chatgpt-tiers.js</code> | <code>    strikes.delete(strikeKey(mode, slotIdFrom(opts)));</code> → <code>    clearStrikes(mode);</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: tier strikes do not add across slots or break a neighbour series — AssertionError [ERR_ASSERTION]: slot 1 success cleared slot 0 |
| I30 | <code>src/routes/images.js</code> | <code>  const gaps = Math.ceil(Number(waiting) / conc);</code> → <code>  const gaps = Math.floor(Number(waiting) / conc);</code> | <code>scripts/test-cooldown.js</code> | убит | FAIL: the queue-full estimate counts a gap per concurrency slice of waiters |
| I31 | <code>src/job-pool.js</code> | <code>      waiting.unshift(job);</code> → <code>      waiting.push(job);</code> | <code>scripts/test-job-pool.js</code> | убит | FAIL: retryAfterMaintenance returns the job to the head exactly once — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| I32 | <code>src/pacer.js</code> | <code>      pacers[slotId].finished();</code> → <code>      pacers.forEach((pacer) =&gt; pacer.finished());</code> | <code>scripts/test-pacer.js</code> | убит | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I33 | <code>src/progress.js</code> | <code>    jobRequeued(jobId) {<br>      runningJobs.delete(jobId);<br>    },</code> → <code>    jobRequeued(jobId) {<br>      runningJobs.delete(jobId);<br>      state.queueSize--;<br>    },</code> | <code>scripts/test-progress.js</code> | убит | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I34 | <code>src/routes/login.js</code> | <code>    // Session changed: no tab may keep a document from before the login.<br>    resetAllSlotPages();</code> → <code>    // Session changed: no tab may keep a document from before the login.<br>    void loginPage;</code> | <code>scripts/test-parallel-routes.js</code> | выжил | — (rc=0, все ассерты прошли) |
| I35 | <code>src/chatgpt.js</code> | <code>  const cap = activeCapture(slot);<br>  if (!cap) {<br>    // No turn in flight</code> → <code>  const cap = activeCapture(slot);<br>  if (cap) {<br>    const neighbour = getSlot(1 - slot.id).capture;<br>    if (neighbour) neighbour.feed(chunk);<br>  }<br>  if (!cap) {<br>    // No turn in flight</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: an SSE chunk on one slot does not land in the other capture — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| I36 | <code>src/chatgpt.js</code> | <code>function rememberConversation(slot, snap) {<br>  slot.lastConversationFetch = { ...snap, at: Date.now() };<br>}</code> → <code>function rememberConversation(slot, snap) {<br>  slot.lastConversationFetch = { ...snap, at: Date.now() };<br>  getSlot(1 - slot.id).lastConversationFetch = slot.lastConversationFetch;<br>}</code> | <code>scripts/test-parallel-slots.js</code> | убит | FAIL: a conversation snapshot stays on the slot that fetched it — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |

## Разбор выживших

### I01: SSE-binding страницы отправляет чанк соседнему слоту.

Дыра: test-parallel-slots вызывает acceptSseChunk напрямую; setupBackendReadHooks и callback exposeFunction не вызываются. При чанке со страницы 1 получателем станет слот 0.

### I02: Реальный conversation-GET записывает снимок в соседний слот.

Дыра: тест вызывает экспорт noteConversation напрямую, а не onBackendResponse с GET-ответом. Мутация меняет именно обработчик ответа, поэтому helper-тест остаётся зелёным.

### I04: recreatePage при восстановлении закрывает ещё и соседнюю вкладку.

Дыра: тесты слотов проверяют resetPage и сохранение page→slot в closeWedgedPage, но не вызывают recreatePage с двумя привязанными страницами. Побочное закрытие соседней страницы не наблюдается.

### I06: Hard reset при probation запускается внутри задания.

Дыра: нет вызова maybeRecoverSession с pendingReset=hard из задания. Прямой тест hardResetBrowser проверяет очистку, но не границу обслуживания.

### I08: clearSession ошибочно запускается непосредственно в задании до передачи обслуживания.

Дыра: clearSession вызывается на request-path, но browser.context в тесте отсутствует и clearSession сразу возвращает. Тест не шпионит за destructive API; при живом context этот вызов начинает очистку cookies до освобождения слота. Это не эквивалентность в рабочем окружении.

### I09: completeText съедает retryAfterMaintenance и оставляет ошибку внутреннему retry.

Дыра: test-parallel-slots не вызывает completeText, а test-parallel-routes использует его заглушку. Для page_load_failed выполнение пойдёт во внутренний retry вместо немедленного возврата задания пулу.

### I10: У запроса обслуживания удалён обработчик rejection.

Дыра: requestMaintenance в тесте auto-login всегда возвращает resolved Promise. Отказ обслуживания с unhandledRejection ни разу не моделируется.

### I11: После auto-login сбрасывается только инициатор, соседние страницы сохраняются.

Дыра: тест logged-out slot только получает callback обслуживания, не исполняет его. Финальный resetAllSlotPages внутри autoLoginMaintenance не проверен.

### I14: Эскалация восстановления зависит от probation соседнего слота.

Дыра: тест markHealthyCompletion проверяет завершение probation, но не markSessionDegraded при разных recoveryState двух слотов. Чужой probation ошибочно определит уровень reset.

### I15: Heartbeat gate теряет jobId ожидающего слота.

Дыра: HTTP-тесты ждут десятки миллисекунд и не проверяют per-job liveness или аргументы progress.touch. test-progress проверяет сам progress, но не связь jobIdBySlot→turnGate→touch.

### I16: Поток текстового ответа обновляет только общий heartbeat без jobId.

Дыра: тесты слотов не выполняют waitAndExtractText и не продвигают часы за HEALTH_STUCK_SEC во время прихода чанков. Здоровое долгое задание может выглядеть зависшим.

### I17: Возврат задания в очередь больше не удаляет running-id из progress.

Дыра: тест retryAfterMaintenance проверяет порядок A,A,B и HTTP 200, но не running_jobs/oldest_job_ms_since_progress. Старый jobId остаётся в progress после повторного запуска с новым id.

### I20: Реальный completeText не вызывает beforeSubmit.

Дыра: helper-тесты слотов не выполняют completeText. HTTP-тесты вызывают beforeSubmit из собственного stub и поэтому не доказывают его вызов реальным адаптером.

### I21: beforeSubmit переносится перед подготовкой thinking-mode и capture, поздний вызов убран.

Дыра: нет проверки порядка подготовки реального completeText и send-time hook. Это один перенос: ранний hook вызывается ровно один раз, но cooldown и stagger проверены до потенциально долгой подготовки.

### I24: turnGate.finished вызывается даже если beforeSubmit не был вызван или отказал.

Дыра: тесты не делают следующий turn на том же слоте после pre-submit отказа с ненулевым gap. При queue_full-тесте ошибочная метка не видна: его stub не вызывает beforeSubmit и не ждёт gate.

### I27: Параллельный /login/* запрашивает второй manual-login exclusive.

Дыра: единственный login-тест отправляет /login/save, сериализованные saveChain. Ветка уже существующего loginHold не достигается; параллельные /login и /login/screenshot при pending acquire не проверены. В реальном пуле второй acquire может ждать release первого.

### I28: setThinkingMode не передаёт slotId при подсчёте tier-серии.

Дыра: test-tiers использует один непривязанный fakePage, который slotOf относит к слоту 0; test-parallel-slots вызывает tierAvailability напрямую. При двух реальных страницах серии смешаются на slot 0.

### I34: После manual-login save страницы слотов вовсе не сбрасываются.

Дыра: login-тест считает только вызовы reset вне exclusive (resetsOpen). Нулевое число вызовов reset тоже даёт 0, обязательный reset после save не проверяется.

Все выжившие выше — пробелы покрытия, а не эквивалентные мутанты. Для I08 отсутствие browser.context объясняет лишь эквивалентность в фикстуре, не в рабочем процессе.

## Доказательства собственных ассертов

Для I07 собственный ассерт — caught.retryAfterMaintenance === true (test-parallel-slots.js:168). Ошибочная inline-ветка запускает autoLoginMaintenance, закрывает страницу и пытается получить CDP context; фикстура задаёт недоступный 127.0.0.1:1. Полученная ошибка не несёт маркер обслуживания. Это падение поведенческого ассерта, не загрузки модуля; фактическое выполнение autoLogin до конца этот тест не доказывает.

### I03: resetPage дополнительно закрывает страницу соседа.

Ожидаемый сценарий: <code>resetPage closes only the page of the slot it was given</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-slots.js:75:10</code>.

~~~text
FAIL: resetPage closes only the page of the slot it was given — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

true !== false

    at /app/scripts/test-parallel-slots.js:75:10
    at /app/scripts/test-parallel-slots.js:216:13

~~~

### I05: closeWedgedPage закрывает и очищает страницу другого слота.

Ожидаемый сценарий: <code>closing a wedged page keeps it bound to its own slot</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-slots.js:126:10</code>.

~~~text
FAIL: closing a wedged page keeps it bound to its own slot — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ {
+   close: [Function: close],
+   closed: false,
+   evaluate: [Function: evaluate],
+   isClosed: [Function: isClosed],
+   url: [Function: url]
+ }
- null

    at /app/scripts/test-parallel-slots.js:126:10
    at /app/scripts/test-parallel-slots.js:216:13

~~~

### I07: Auto-login запускается внутри задания вместо запроса обслуживания.

Ожидаемый сценарий: <code>a logged-out slot requests auto-login maintenance and does not run it</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-slots.js:168:12</code>.

~~~text
FAIL: a logged-out slot requests auto-login maintenance and does not run it — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ undefined
- true

    at /app/scripts/test-parallel-slots.js:168:12
    at async /app/scripts/test-parallel-slots.js:216:7

~~~

### I12: Hard-reset очищает только слот 0 и сохраняет страницы других слотов.

Ожидаемый сценарий: <code>hardResetBrowser closes every slot page</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-slots.js:197:10</code>.

~~~text
FAIL: hardResetBrowser closes every slot page — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

false !== true

    at /app/scripts/test-parallel-slots.js:197:10
    at async /app/scripts/test-parallel-slots.js:216:7

~~~

### I13: Успех слота обнуляет ещё и menuFailures соседа.

Ожидаемый сценарий: <code>markHealthyCompletion of one slot leaves the other on probation</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-slots.js:94:10</code>.

~~~text
FAIL: markHealthyCompletion of one slot leaves the other on probation — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

0 !== 4

    at /app/scripts/test-parallel-slots.js:94:10
    at /app/scripts/test-parallel-slots.js:216:13

~~~

### I18: Обычный text-путь не передаёт conversation key.

Ожидаемый сценарий: <code>the same conversation_id does not run on two slots</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-routes.js:217:14</code>.

~~~text
FAIL: the same conversation_id does not run on two slots — AssertionError [ERR_ASSERTION]: same conversation overlapped: A,A-again,B
    at /app/scripts/test-parallel-routes.js:217:14
    at async withRouter (/app/scripts/test-parallel-routes.js:120:5)
    at async /app/scripts/test-parallel-routes.js:198:3
    at async /app/scripts/test-parallel-routes.js:558:7

~~~

### I19: SSE text-путь не передаёт conversation key.

Ожидаемый сценарий: <code>a streamed conversation_id stays on one slot</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-routes.js:387:14</code>.

~~~text
FAIL: a streamed conversation_id stays on one slot — AssertionError [ERR_ASSERTION]: stream overlapped: A,A-again,B
    at /app/scripts/test-parallel-routes.js:387:14
    at async withRouter (/app/scripts/test-parallel-routes.js:120:5)
    at async /app/scripts/test-parallel-routes.js:368:3
    at async /app/scripts/test-parallel-routes.js:558:7

~~~

### I22: Проверка cooldown пропускает активный лимит в beforeSubmit.

Ожидаемый сценарий: <code>a cooldown armed by one job refuses the next inside beforeSubmit</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-routes.js:284:12</code>.

~~~text
FAIL: a cooldown armed by one job refuses the next inside beforeSubmit — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

200 !== 429

    at /app/scripts/test-parallel-routes.js:284:12
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async withRouter (/app/scripts/test-parallel-routes.js:120:5)
    at async /app/scripts/test-parallel-routes.js:271:3
    at async /app/scripts/test-parallel-routes.js:558:7

~~~

### I23: turnGate.finished не вызывается после отправленного turn.

Ожидаемый сценарий: <code>a batch pays the gap between images</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-routes.js:423:14</code>.

~~~text
FAIL: a batch pays the gap between images — AssertionError [ERR_ASSERTION]: gap 0
    at /app/scripts/test-parallel-routes.js:423:14
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async withRouter (/app/scripts/test-parallel-routes.js:120:5)
    at async /app/scripts/test-parallel-routes.js:417:5
    at async /app/scripts/test-parallel-routes.js:558:7

~~~

### I25: queue_full возвращает HTTP 500.

Ожидаемый сценарий: <code>a full waiting list is 429 queue_full with Retry-After for two waiters</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-routes.js:179:12</code>.

~~~text
FAIL: a full waiting list is 429 queue_full with Retry-After for two waiters — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

500 !== 429

    at /app/scripts/test-parallel-routes.js:179:12
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async withRouter (/app/scripts/test-parallel-routes.js:120:5)
    at async /app/scripts/test-parallel-routes.js:169:3
    at async /app/scripts/test-parallel-routes.js:558:7

~~~

### I26: Retry-After queue_full отдаётся в миллисекундах вместо секунд.

Ожидаемый сценарий: <code>a full waiting list is 429 queue_full with Retry-After for two waiters</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-routes.js:181:12</code>.

~~~text
FAIL: a full waiting list is 429 queue_full with Retry-After for two waiters — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

'120000' !== '120'

    at /app/scripts/test-parallel-routes.js:181:12
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async withRouter (/app/scripts/test-parallel-routes.js:120:5)
    at async /app/scripts/test-parallel-routes.js:169:3
    at async /app/scripts/test-parallel-routes.js:558:7

~~~

### I29: Успешный tier в одном слоте удаляет серии всех слотов.

Ожидаемый сценарий: <code>tier strikes do not add across slots or break a neighbour series</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-slots.js:115:10</code>.

~~~text
FAIL: tier strikes do not add across slots or break a neighbour series — AssertionError [ERR_ASSERTION]: slot 1 success cleared slot 0

0 !== 2

    at /app/scripts/test-parallel-slots.js:115:10
    at /app/scripts/test-parallel-slots.js:216:13

~~~

### I30: Неполная группа ожидающих не добавляет gap в Retry-After.

Ожидаемый сценарий: <code>the queue-full estimate counts a gap per concurrency slice of waiters</code>; rc=1.


~~~text
FAIL: the queue-full estimate counts a gap per concurrency slice of waiters
      one waiter costs one gap

0 !== 60

PASS: the queue-full estimate is always whole seconds

8/9 passed

~~~

### I31: Возвращённое задание попадает в хвост вместо головы очереди.

Ожидаемый сценарий: <code>retryAfterMaintenance returns the job to the head exactly once</code>; rc=1.
Ассерт: <code>at /app/scripts/test-job-pool.js:304:10</code>.

~~~text
FAIL: retryAfterMaintenance returns the job to the head exactly once — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected

  [
    'a-0',
    'maint',
+   'b-1',
    'a-1',
-   'b-1'
  ]

    at /app/scripts/test-job-pool.js:304:10
    at async /app/scripts/test-job-pool.js:639:7

~~~

### I32: finished одного слота навязывает gap всем слотам.

Ожидаемый сценарий: <code>one slot gap does not hold another slot beyond the stagger</code>; rc=1.
Ассерт: <code>at /app/scripts/test-pacer.js:266:10</code>.

~~~text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

60000 !== 10000

    at /app/scripts/test-pacer.js:266:10
    at async /app/scripts/test-pacer.js:461:35 {
  generatedMessage: true,
  code: 'ERR_ASSERTION',
  actual: 60000,
  expected: 10000,
  operator: 'strictEqual',
  diff: 'simple'
}

Node.js v24.21.0

~~~

### I33: jobRequeued ошибочно уменьшает общий размер очереди.

Ожидаемый сценарий: <code>jobRequeued drops the running id without touching the queue or streaks</code>; rc=1.
Ассерт: <code>at /app/scripts/test-progress.js:163:10</code>.

~~~text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

0 !== 1

    at /app/scripts/test-progress.js:163:10
    at ok (/app/scripts/test-progress.js:6:25)
    at Object.<anonymous> (/app/scripts/test-progress.js:152:1)
    at Module._compile (node:internal/modules/cjs/loader:1929:14)
    at Object..js (node:internal/modules/cjs/loader:2060:10)
    at Module.load (node:internal/modules/cjs/loader:1651:32)
    at Module._load (node:internal/modules/cjs/loader:1443:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47 {
  generatedMessage: true,
  code: 'ERR_ASSERTION',
  actual: 0,
  expected: 1,
~~~

### I35: Чанк доставляется своему capture и дополнительно дублируется соседу.

Ожидаемый сценарий: <code>an SSE chunk on one slot does not land in the other capture</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-slots.js:36:10</code>.

~~~text
FAIL: an SSE chunk on one slot does not land in the other capture — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'alphabeta'
- 'alpha'
        ^

    at /app/scripts/test-parallel-slots.js:36:10
    at /app/scripts/test-parallel-slots.js:216:13
    at Object.<anonymous> (/app/scripts/test-parallel-slots.js:227:3)
    at Module._compile (node:internal/modules/cjs/loader:1929:14)
    at Object..js (node:internal/modules/cjs/loader:2060:10)
    at Module.load (node:internal/modules/cjs/loader:1651:32)
    at Module._load (node:internal/modules/cjs/loader:1443:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47

~~~

### I36: Снимок conversation-GET сохраняется у владельца и дополнительно загрязняет соседа.

Ожидаемый сценарий: <code>a conversation snapshot stays on the slot that fetched it</code>; rc=1.
Ассерт: <code>at /app/scripts/test-parallel-slots.js:48:10</code>.

~~~text
FAIL: a conversation snapshot stays on the slot that fetched it — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ {
+   at: 1792053254111,
+   conversationId: 'slot-1-only'
+ }
- null

    at /app/scripts/test-parallel-slots.js:48:10
    at /app/scripts/test-parallel-slots.js:216:13

~~~

## SHA-256 после отката

| Файл с мутациями | Исходный SHA-256 = конечный SHA-256 |
| --- | --- |
| <code>src/chatgpt.js</code> | 58de3b17ca2ea49405780e89deeefa5c64b6848a4837f0bc511a3602d53b007e |
| <code>src/routes/images.js</code> | a05a48cc7ef051a1f2b92b292c9de57b1a31abf83f283cdab7448684b41948e5 |
| <code>src/routes/login.js</code> | b8c22af461204025502eebedef7b1ca92fb66664606a8e7fad4c03e04956b96e |
| <code>src/chatgpt-tiers.js</code> | 1ce607c9af60730f70702cdba113c3845b70a4871a4890592dfb98b8c3db5bbf |
| <code>src/job-pool.js</code> | 15cb2bcd6f6953dd5aa0d2c31636f719c91ffbb829abeea398ba4820e6df9585 |
| <code>src/pacer.js</code> | a665576456ea7cd641fa0ebb04aad40cafc1f8bb3fc96c7a6d9962c17a3c0e7b |
| <code>src/progress.js</code> | 94edeebc9973fedc26356ffd6e7dd86d8c7eeee7b250beab10f4caaaaad532db |

Дополнительно проверены байты всех 51 отслеживаемых файлов src/ и scripts/test-*.js. Боевой код и тесты не исправлялись.

Воспроизведение: <code>docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node scripts/mutate-independent-m2.js</code>
