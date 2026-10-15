# Независимый мутационный прогон M5

Дата: 2026-10-15. Мутировался коммит `d58875c` (ветка `mut/stall-m5`). Среда: Docker `node:24`, Node v24.21.0, uid/gid 1002:1002. Чистый `npm test` до прогона: rc=0.

Всего 54 мутации по строкам, которые M5 добавила или изменила в `src/chatgpt.js`, `src/routes/images.js`, `src/server.js`, `src/log-context.js`: **убито 40, выжило 13, невалидных 1**.

Из 13 выживших 6 эквивалентны исходному коду (M01, M04, M05, M21, M48, M54). Семь меняют поведение, и тесты этого не видят: M03, M15, M41, M45, M49, M50, M51.

## Методика

- Фрагмент встречается в файле ровно один раз. После замены sha256 файла меняется. `node --check` отсекает синтаксис до тестов.
- На каждой мутации оба файла: `scripts/test-stall-diagnostics.js` и `scripts/test-stall-routes.js`. Если оба зелёные, следом весь `npm test`.
- «Убит» — только `AssertionError`. Сбой загрузки, синтаксис и таймаут сюда не входят. Таких трёх в прогоне не было.
- После каждой мутации байты файла возвращаются и sha256 сверяется с байтами до замены. В конце прогона `git diff` по `src/` пустой.
- Прогон: `scripts/mutate-stall-m5.js` внутри `docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24`. Скрипт в конце удаляет свои `.mut-logs/` и `.stall-m5-results.json`.

## Таблица мутаций

| ID | Файл | Замена | Тест | Результат | Первая упавшая строка |
| --- | --- | --- | --- | --- | --- |
| M01 | src/chatgpt.js | внутренний `!bestText &&` у `stallNoAnswer` убран | оба stall-теста и npm test | эквивалент | — |
| M02 | src/chatgpt.js | `capture.boundStream === null` заменён на `true` | stall resend is forbidden: bound | убит | AssertionError: Missing expected rejection. — scripts/test-stall-diagnostics.js:373 |
| M03 | src/chatgpt.js | `&& !capture.text` убран | оба stall-теста и npm test | выжил | — |
| M04 | src/chatgpt.js | `&& !capture.postFailure` убран | оба stall-теста и npm test | эквивалент | — |
| M05 | src/chatgpt.js | `&& !capture.postAccepted` убран | оба stall-теста и npm test | эквивалент | — |
| M06 | src/chatgpt.js | проверки `postAccepted` и диапазона `postStatus` убраны, оставлен `!postFailure` | stall resend is forbidden: accepted | убит | AssertionError: Missing expected rejection. — scripts/test-stall-diagnostics.js:373 |
| M07 | src/chatgpt.js | `&& !anyDeltaEmitted` убран из условия повтора | stall resend is forbidden: delta | убит | AssertionError: Missing expected rejection. — scripts/test-stall-diagnostics.js:373 |
| M08 | src/chatgpt.js | `&& !options.conversationId` убран из условия повтора | stall resend is forbidden: conversation | убит | AssertionError: Missing expected rejection. — scripts/test-stall-diagnostics.js:373 |
| M09 | src/chatgpt.js | `slot.pendingReset !== 'hard'` заменён на `true` | stall resend is forbidden: hard | убит | AssertionError: validation returned false (caught `pool hooks not set`, not timeout) — scripts/test-stall-diagnostics.js:373 |
| M10 | src/chatgpt.js | `used < TEXT_STALL_RETRIES` заменён на `used <= TEXT_STALL_RETRIES` | a used stall budget follows the job | убит | AssertionError: Missing expected rejection. — scripts/test-stall-diagnostics.js:346 |
| M11 | src/chatgpt.js | дефолт `TEXT_STALL_RETRIES` сменён с 1 на 0 | stall retries once on a fresh page | невалиден | Error: ChatGPT page showed no progress (code timeout, stallNoAnswer true), не AssertionError — scripts/test-stall-diagnostics.js:310 |
| M12 | src/chatgpt.js | `attempt -= 1` убран | a used stall budget follows the job | убит | AssertionError: rejects validation returned undefined — scripts/test-stall-diagnostics.js:340 |
| M13 | src/routes/images.js | `fn({ ...ctx, stallRetryState })` заменён на `fn(ctx)` | JSON job retains its stall budget | убит | AssertionError: 200 !== 504 — scripts/test-stall-routes.js:99 |
| M14 | src/routes/images.js | `stallRetryState` создаётся внутри попытки пула, а не снаружи | JSON job retains its stall budget | убит | AssertionError: pool restart replaced the job budget (`used` 0 !== 1) — scripts/test-stall-routes.js:99 |
| M15 | src/routes/images.js | `recordSlotJobFinished` вызывается и при `requeued` | оба stall-теста и npm test | выжил | — |
| M16 | src/routes/images.js | `onAttemptFinished` стал пустой функцией | real JSON job paces a stall resend | убит | AssertionError: retry ignored MIN_JOB_GAP_SEC — scripts/test-stall-routes.js:64 |
| M17 | src/routes/images.js | `paced -= 1` убран | real JSON job paces a stall resend | убит | AssertionError: no extra final finish (3 !== 2) — scripts/test-stall-routes.js:63 |
| M18 | src/chatgpt.js | `cap.postFailure = failure` перенесён на место после `await` тела | POST failure is published before reading the body | убит | AssertionError: snippet `''` !== `Too many requests` — scripts/test-stall-diagnostics.js:151 |
| M19 | src/chatgpt.js | таймер непрочитанного тела 5000 заменён на 5001 | unread POST body has a bounded single diagnostic | убит | AssertionError: нет `body=<unread>` — scripts/test-stall-diagnostics.js:169 |
| M20 | src/chatgpt.js | коды 429 и не-429 поменяны местами: `server_error` / `rate_limit` | POST failure is published before reading the body | убит | AssertionError: rejects validation returned false — scripts/test-stall-diagnostics.js:147 |
| M21 | src/chatgpt.js | `if (onSubmitted) onSubmitted();` убран | оба stall-теста и npm test | эквивалент | — |
| M22 | src/chatgpt.js | присваивание `err.modelMessage` убрано | POST failure is published before reading the body | убит | AssertionError: rejects validation returned false (`modelMessage` не `''`) — scripts/test-stall-diagnostics.js:147 |
| M23 | src/chatgpt.js | текст `' rate limit'` в сообщении POST убран | POST failure is published before reading the body | убит | AssertionError: rejects validation returned false (нет `/rate limit/`) — scripts/test-stall-diagnostics.js:147 |
| M24 | src/chatgpt.js | фильтр кольца `at >= startedAt` заменён на `at > startedAt` | backend ring is per slot | убит | AssertionError: diag `none` вместо пути с `<id>` — scripts/test-stall-diagnostics.js:229 |
| M25 | src/chatgpt.js | из redact-регулярки убрана ветка 16+ hex | backend ring is per slot | убит | AssertionError: в diag остался `abcdef0123456789` — scripts/test-stall-diagnostics.js:229 |
| M26 | src/chatgpt.js | из redact-регулярки убрана ветка UUID | backend ring is per slot | убит | AssertionError: в diag остался UUID разговора — scripts/test-stall-diagnostics.js:229 |
| M27 | src/chatgpt.js | предел кольца `length > 30` заменён на `length > 31` | backend ring is per slot | убит | AssertionError: 31 !== 30 — scripts/test-stall-diagnostics.js:224 |
| M28 | src/chatgpt.js | `STALL_SNAPSHOTS !== '0'` заменён на `=== '1'` | stall snapshot defaults, opt-out and retention | убит | AssertionError: png 0 !== 2 — scripts/test-stall-diagnostics.js:268 |
| M29 | src/chatgpt.js | тернарник stall/debug снапшотов переставлен | stall snapshot defaults, opt-out and retention | убит | AssertionError: файлов в каталоге 3 !== 1 — scripts/test-stall-diagnostics.js:262 |
| M30 | src/chatgpt.js | сортировка prune `b.at - a.at` заменена на `a.at - b.at` | stall snapshot defaults, opt-out and retention | убит | AssertionError: third snapshot was not retained — scripts/test-stall-diagnostics.js:271 |
| M31 | src/chatgpt.js | `.slice(STALL_SNAPSHOT_KEEP)` заменён на `.slice(STALL_SNAPSHOT_KEEP + 1)` | stall snapshot defaults, opt-out and retention | убит | AssertionError: png 3 !== 2 — scripts/test-stall-diagnostics.js:268 |
| M32 | src/chatgpt.js | prune-регулярка матчит любой `.png`/`.html` | stall snapshot defaults, opt-out and retention | убит | AssertionError: html 2 !== 3 — scripts/test-stall-diagnostics.js:269 |
| M33 | src/chatgpt.js | у ветки `kind === 'recycle'` убран `return` | recycle threshold counts jobs | убит | AssertionError: recoveryState `probation` !== `healthy` — scripts/test-stall-diagnostics.js:403 |
| M34 | src/chatgpt.js | `&& !slot.pendingReset` убран из порога recycle | recycle threshold counts jobs | убит | AssertionError: `recycle` !== `page` — scripts/test-stall-diagnostics.js:409 |
| M35 | src/chatgpt.js | `victim.completedJobs = 0` убран из `discardSlotPage` | recycle threshold counts jobs | убит | AssertionError: completedJobs 2 !== 0 — scripts/test-stall-diagnostics.js:404 |
| M36 | src/chatgpt.js | watchdog пропускает любой `pendingReset`, включая `recycle` | watchdog probes a usable page even when recycle is pending | убит | AssertionError: `skipped` !== `in` — scripts/test-stall-diagnostics.js:433 |
| M37 | src/log-context.js | префикс всегда `unshift`, форматная строка не склеивается | job log context survives awaits | убит | AssertionError: нет `[s0] job-start-0`, в выводе `job-start-%d` — scripts/test-stall-routes.js:137 |
| M38 | src/log-context.js | вне задания контекст подменяется на `{ slotId: 0 }` | job log context survives awaits | убит | AssertionError: `outside-before` получил префикс `[s0]` — scripts/test-stall-routes.js:142 |
| M39 | src/server.js | пропуск `GET /` убран, остался только `ACCESS_LOG_SKIP` | access logger skips only GET root | убит | AssertionError: в логе есть `[req …] > GET /` — scripts/test-stall-routes.js:174 |
| M40 | src/server.js | пропускается любой метод на `/`, не только GET | access logger skips only GET root | убит | AssertionError: нет `POST /` в access-логе — scripts/test-stall-routes.js:179 |
| M41 | src/chatgpt.js | условие `stallRetryState.used > 0` убрано из `ensureNewChat` | оба stall-теста и npm test | выжил | — |
| M42 | src/chatgpt.js | `safeNonNegativeInt`: `n >= 0` заменён на `n > 0` | stall resend is forbidden: disabled | убит | AssertionError: Missing expected rejection. — scripts/test-stall-diagnostics.js:373 |
| M43 | src/chatgpt.js | `slot.capture.startedAt = Date.now()` убран | backend ring is per slot | убит | AssertionError: diag `none` вместо пути с `<id>` — scripts/test-stall-diagnostics.js:229 |
| M44 | src/chatgpt.js | обрезка snippet `.slice(0, 300)` заменена на `.slice(0, 299)` | non-SSE diagnostics normalize and truncate body | убит | AssertionError: 299 !== 300 — scripts/test-stall-diagnostics.js:184 |
| M45 | src/chatgpt.js | fallback сообщения GET: `.at(-1)` заменён на `.at(0)` | оба stall-теста и npm test | выжил | — |
| M46 | src/chatgpt.js | `PAGE_RECYCLE_AFTER_JOBS > 0` заменён на `>= 0` | recycle is disabled by zero | убит | AssertionError: `recycle` !== null — scripts/test-stall-diagnostics.js:425 |
| M47 | src/chatgpt.js | `completedJobs >= PAGE_RECYCLE_AFTER_JOBS` заменён на `>` | recycle threshold counts jobs | убит | AssertionError: null !== `recycle` — scripts/test-stall-diagnostics.js:400 |
| M48 | src/chatgpt.js | `return` перед async-IIFE `onBackendResponse` убран | оба stall-теста и npm test | эквивалент | — |
| M49 | src/chatgpt.js | `++snapshotSequence` убран из имени снапшота | оба stall-теста и npm test | выжил | — |
| M50 | src/log-context.js | `if (!console[key])` заменён на `if (true)` | оба stall-теста и npm test | выжил | — |
| M51 | src/chatgpt.js | у `safeNonNegativeInt` убран `.trim()` | оба stall-теста и npm test | выжил | — |
| M52 | src/log-context.js | `runWithLogContext` вызывает `fn()` без `AsyncLocalStorage.run` | job log context survives awaits | убит | AssertionError: нет `[s0] job-start-0` — scripts/test-stall-routes.js:137 |
| M53 | src/chatgpt.js | в GET-диагностике `messages=${nodes.length}` заменён на `nodes.length - 1` | GET diagnostics include mapping size | убит | AssertionError: `messages=1` вместо `messages=2` — scripts/test-stall-diagnostics.js:249 |
| M54 | src/chatgpt.js | `postAccepted` ставится при `status > 200`, не при `>= 200` | оба stall-теста и npm test | эквивалент | — |

## Эквивалентные

### M01. Внутренний `!bestText`

Внешний `if` уже требует `!bestText`. До внутреннего условия вызываются `markSessionDegraded`, `logStallBackend`, `saveDebugSnapshot` и `throwBackendPostFailure`. Локальный `bestText` они не пишут. Флаг `stallNoAnswer` не меняется.

### M04. `!capture.postFailure`

До флага вызывается `throwBackendPostFailure`. Он бросает ошибку при `postFailure` вне 2xx, поэтому до условия доходит только отсутствие failure или failure со статусом 2xx. Статус 2xx в том же синхронном блоке ставит `postAccepted` и `postStatus` в диапазоне 2xx, и эти две проверки всё равно не дают поставить флаг. Снятие только `!postFailure` ничего не меняет. Совместное снятие `postAccepted` и проверки `postStatus` — это M06, её тест `accepted` убивает.

### M05 и M54. `postAccepted`

`postAccepted` становится истинным только вместе с `postStatus.status` в диапазоне 2xx. Более поздний не-2xx ответ записывает `postFailure`, и `throwBackendPostFailure` бросает ошибку раньше присваивания флага. Пока проверка диапазона `postStatus` на месте, отдельное выключение `postAccepted` (M05) и отказ ставить его ровно на статусе 200 (M54) дают тот же `stallNoAnswer`.

### M21. `onSubmitted()` внутри `throwBackendPostFailure`

Вызов помечает попытку как уже отправленную. Функция бросает только `rate_limit` или `server_error`. Оба кода не входят в transient-повтор `completeText`, сообщение не похоже на logout, и локальный `submitted` после этого не читается: catch сразу делает `throw err`. Наблюдаемого отличия нет.

### M48. `return` у `onBackendResponse`

Единственный вызов — `p.on('response', …)`, возвращаемое значение не читается. IIFE по-прежнему запускается, и `.catch` висит на ней же.

## Выжившие дыры

### M03. `!capture.text`

Сценарий `backend-text` пишет `cap.text = 'partial'`. `snapshot().lastAssistantText` становится непустым, цикл шлёт delta, а тест всегда передаёт `onDelta`, поэтому `anyDeltaEmitted` уже запрещает повтор. Снятие `!capture.text` тестом не видно. Без `onDelta` флаг `anyDeltaEmitted` остаётся ложным, и непустой `capture.text` — единственный запрет `stallNoAnswer`.

### M15. `recordSlotJobFinished` на requeue

Инкремент в `finally` происходит до обслуживания. Обработчик теста вызывает `resetAllSlotPages`, а `discardSlotPage` обнуляет `completedJobs`. К ассерту `completedJobs === 1` и мутант, и исходный код приходят с одним значением. Если обслуживание страницу не выбрасывает, лишний инкремент остаётся.

### M41. `ensureNewChat` после stall-повтора

`stallRetryState.used > 0` меняет ветку только при `reuseChat === true` и `attempt === 0`. Stall-тесты `reuseChat` не передают, срабатывает `!options.reuseChat`, и `ensureNewChat` вызывается в любом случае.

### M45. Fallback последнего сообщения GET

Тест кладёт ответ в `mapping[current_node]`, первая часть `||` уже находит сообщение. `.at(-1)` против `.at(0)` различается, когда `current_node` пуст и в mapping больше одного сообщения. Такой фикстуры нет.

### M49. `snapshotSequence`

Имя файла без счётчика различается меткой и `Date.now()`. Тесты либо двигают подменённые часы на 1000 мс, либо пишут `text_rescue` и `text_stalled` в разные моменты. Два снимка одной метки в одну миллисекунду на одном слоте перезапишут друг друга. Счётчик это закрывает, тест коллизию не строит.

### M50. Повторная установка ALS-обёртки

`if (true)` вешает обёртку при каждой оценке модуля. `require` кэширует `log-context.js`, тесты кэш этого модуля не сбрасывают, поэтому тело выполняется один раз. Повторная загрузка даст префикс `[sN] [sN]`. Ассерт на двойной префикс есть, двойной загрузки нет.

### M51. `.trim()` в `safeNonNegativeInt`

Для `undefined`, `''`, `'0'`, `'1'` и `' 1 '` результат тот же: `Number` сам съедает пробелы вокруг числа. Строка из одних пробелов с `.trim()` даёт дефолт, без него `Number('   ')` равен 0, и функция возвращает 0. Для `TEXT_STALL_RETRIES` это выключение повтора, для `PAGE_RECYCLE_AFTER_JOBS` — выключение recycle. Тесты такую строку не подставляют.

## Невалидная мутация

M11 ставит дефолт `TEXT_STALL_RETRIES` в 0. Тест «stall retries once…» передаёт `TEXT_STALL_RETRIES: undefined` и ждёт успешный ответ. `completeText` бросает `Error` с `code: 'timeout'` и `stallNoAnswer: true` из `scripts/test-stall-diagnostics.js:310`, до ассерта выполнение не доходит. Это не `AssertionError` и не `FAIL:`, поэтому «убит» не ставится. Маршрутные тесты при этом зелёные: `fixture` явно пишет `TEXT_STALL_RETRIES=1` и дефолт не читает.
