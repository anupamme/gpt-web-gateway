# Веха M2: подключение параллельных вкладок (пул, слоты страниц, обслуживание)

- Репозиторий: `~/github/gpt-web-gateway`, база — ветка `feat/parallel-pool`, коммит `1268703` («Fix pool retry, hold, and stagger»). Дата 2026-10-15.
- Исполнитель: `auto`. Вторая из двух вех «3 параллельные вкладки»; первая (M1) дала
  `src/job-pool.js` (`createJobPool`, `parseConcurrency`), `createTurnGate`/`staggerMs` в
  `src/pacer.js`, `progress.jobRunning/touch(jobId)/jobFinished(kind, jobId)` — это контракт,
  его API не менять.

## Где работать

Клон `<clone-root>/parallel-tabs`, новая ветка `feat/parallel-tabs`. Живое дерево не трогать.
**`git push` в origin запрещён** — работу заберёт постановщик через `git fetch`. Всё — в
Docker `node:24` под `-u 1002:1002`. `node_modules` положен постановщиком (untracked).
Браузер и ChatGPT в этой вехе НЕ запускаются: живую проверку делает постановщик на проде.

## Задача и почему

Сделать так, чтобы до `MAX_CONCURRENT_JOBS` (дефолт 3) заданий шли одновременно, каждое в
СВОЕЙ вкладке одного browser context, а остальные ждали в FIFO. Сейчас `chatgpt.js` держит
ОДНУ страницу и пачку модульных состояний, рассчитанных на одно задание; всё ниже сломается
при параллельности и обязано быть починено в этой вехе.

Архитектура (решено с ревьюерами, НЕ менять):
1. **Слот** — объект `{ id, page, pagePromise, jobId, capture, lastConversationFetch,
   staleStreams, recoveryState, pendingReset, menuFailures }`, по одному на slotId пула
   (реестр в `chatgpt.js`, создаётся лениво). Публичные функции `generateImage`,
   `editImage`, `completeText` принимают `options.slotId` (целое; отсутствует → 0, чтобы
   прежние вызовы и тесты работали) и работают ТОЛЬКО со страницей своего слота. Контекст
   слота передаётся ЯВНО (параметром), AsyncLocalStorage для страницы и перехвата НЕ
   использовать: события Playwright (`on('response')`, `exposeFunction`) приходят вне
   async-контекста задания.
2. **Перехват ответа — по странице.** `setupBackendReadHooks(p, slot)` замыкается на свой
   слот: `currentCapture`, `lastConversationFetch`, `staleStreams` живут в слоте, модульных
   глобалов для них больше нет. `waitAndExtractText` читает `lastConversationFetch` своего
   слота. Ответ/`conversation_id` одной вкладки не может попасть в задание другой.
3. **Обслуживание только между заданиями.** Всё, что трогает весь браузер или сессию —
   `hardResetBrowser`, перестройка контекста при серии inconclusive-проверок, `autoLogin`
   (он же `clearSession`), — выполняется ТОЛЬКО через `pool.requestMaintenance(name, fn,
   { sinceEpoch })`, т.е. когда ни одно задание не работает. Задание, которому ДО отправки
   промпта это понадобилось, не ждёт обслуживание внутри себя: оно запрашивает его (без
   await) и бросает ошибку с `retryAfterMaintenance = true` (и осмысленным `code`, например
   `login_failed` / `page_load_failed`) — пул вернёт его в голову очереди. После отправки
   промпта — запросить обслуживание без await и бросить исходную ошибку (как сейчас «giving
   up»). `sinceEpoch` = `epoch` задания — второй запрос от задания, стартовавшего до уже
   выполненного reset, пропускается. `hardResetBrowser` закрывает страницы ВСЕХ слотов.
   Внедрение пула в `chatgpt.js` — через `setPoolHooks` (см. R2), без require-цикла.
4. **Сброс одной страницы** (`resetPage`, `recreatePage`, `closeWedgedPage`, pre-submit
   transient в `completeText`, pending 'page' reset) — только страница своего слота.
   `recoveryState`/`pendingReset('page')`/`consecutiveMenuFailures` — на слот; эскалация
   'hard' из probation слота → обслуживание `hard-reset`. `markHealthyCompletion` слота B не
   трогает слот A.
5. **ensureLoggedIn(slot)**: пер-слотная проверка сессии (неразрушающий GET) без общего
   single-flight, возвращающего страницу. Ветки `refuse` — как сейчас. Ветки `reset`
   (перестройка контекста) и авто-логин — через п.3; их тела переезжают в функции
   обслуживания (`rebuildContextMaintenance`, `autoLoginMaintenance`), поведение (троттлинг
   `loginThrottle`, `CONTEXT_RESET_COOLDOWN_SEC`, `sessionHealth.invalidate/recordProbe`,
   saveSession перед перестройкой, пост-проверка после логина) сохранить. Счётчик
   `consecutiveUnknownChecks` остаётся аккаунтным.
6. **Темп у отправки.** `generateImage/editImage/completeText` принимают
   `options.beforeSubmit` (async) и вызывают его непосредственно перед `typeAndSubmit` (после
   всей подготовки: логин, новый чат, tier, загрузки). Routes передают хук:
   `await turnGate.gate(slotId); assertNotRateLimited();` и вызывают `turnGate.finished(slotId)`
   в finally вызова, только если хук был вызван. `upstreamTurn` и одиночный `pacer` уходят.
   Cooldown `rateLimitedUntil` общий.
7. **Routes** (`src/routes/images.js`): Promise-цепочку `queue`/`enqueue` заменить на
   `createJobPool({ concurrency: parseConcurrency(), maxWaiting: MAX_QUEUE_SIZE })`. Учёт
   liveness: `progress.jobStarted()` при приёме, `jobRunning(jobId)` при старте,
   `jobFinished(kind, jobId)` при оседании (ровно один раз; возврат в голову очереди не
   считается финишем). Текст с `conversation_id` → `key` = id в нижнем регистре (одна беседа
   не идёт в двух вкладках). `MAX_QUEUE_SIZE` теперь — лимит ОЖИДАЮЩИХ. `Retry-After`
   для queue_full: `QUEUE_FULL_RETRY_AFTER + ceil(waiting / concurrency) * min_gap_sec`.
   `/v1/images/status`: `running`, `waiting`, `concurrency`, слоты, `pacing` из
   `turnGate.status()`; `queue_size` = running + waiting (совместимость).
8. **progress.touch** в `chatgpt.js` — с jobId слота страницы (WeakMap page→slot), чтобы
   зависшая вкладка была видна при живых соседях.
9. **Вне заданий.** Startup warm-up (`ensureSessionReady`) и session watchdog — через
   `pool.acquireExclusive` (watchdog: только когда пул пуст, иначе skip `queue_busy` как
   сейчас; пробует страницу слота 0, если она есть). `GET /v1/images/capabilities`: кэш есть и
   пул занят — stale cache; кэша нет — проба как обычное задание через пул (свой slotId).
   `/login/*`: первый вызов, создающий login-страницу, берёт `acquireExclusive('manual-login')`;
   `/login/save` и простой ≥ 10 мин отпускают; `/login/save` сбрасывает страницы всех слотов.
   Код, который УЖЕ держит эксклюзив (warm-up, функции обслуживания), вызывает
   `ensureLoggedIn(slot, { exclusive: true })`, и деструктивные ветки выполняются инлайн —
   запрос обслуживания изнутри эксклюзива = самоблокировка, это запрещено.
10. **tierAvailability**: серия «подряд» считается по паре (tier, slotId); наблюдения разных
    слотов не складываются и не рвут чужую серию.
10a. **Разрешённые дополнения к модулям M1** (только эти, обратно совместимо, с тестами):
    - `createTurnGate`: `heartbeat` вызывается с `slotId` (`heartbeat(slotId)`), чтобы routes
      обновляли per-job метку ожидающего паузу задания (иначе пауза ≥ `HEALTH_STUCK_SEC`
      объявит его зависшим).
    - `progress.jobRequeued(jobId)`: убрать задание из работающих, не трогая `queueSize` и
      streak'и — для возврата в голову очереди (иначе старая запись уронит liveness).
    - `job-pool`: задание с `retryAfterMaintenance` удерживается до роста epoch ТОЛЬКО если
      в момент оседания есть ожидающее или активное обслуживание; иначе оно встаёт в голову
      очереди без удержания (защита от вечного ожидания, если маркер брошен без запроса).
11. **Конфиг/доки**: `MAX_CONCURRENT_JOBS` (1..5, дефолт 3), `MIN_TURN_STAGGER_SEC` (дефолт 10)
    — в README (таблица env, раздел Limitations переписать: N вкладок, FIFO, пауза на слот,
    общий cooldown, разнос), `.env.example`, `docker-compose.yml` (закомментированные
    примеры), `helm/values.yaml`: `MAX_CONCURRENT_JOBS: "3"`, `resources.limits` cpu "2",
    memory 4Gi. CHANGELOG, версии и теги НЕ трогать — это делает постановщик.

## Что проверено вживую

(заполнить после M1: grep-подтверждения сигнатур на BASE)
- Headful patchright+Chrome под Xvfb (образ 2.14.11): 3 страницы одного context —
  `visibilityState=visible`, `hasFocus()=true`, таймеры и rAF без троттлинга, ввод в
  не-последнюю вкладку доходит.

## Тесты (без браузера, фейковые страницы/контексты)

- `scripts/test-parallel-slots.js` (новый): две фейковые страницы, чанки SSE/ответы
  conversation одной не попадают в capture/lastConversationFetch другой; `getPage` слотов
  возвращает разные страницы; `resetPage` слота 0 не закрывает страницу слота 1;
  `markHealthyCompletion` слота 1 не снимает probation слота 0; деструктивная ветка
  ensureLoggedIn не вызывает autoLogin/closeBrowser инлайн, а запрашивает обслуживание и
  бросает `retryAfterMaintenance`; `hardResetBrowser` закрывает все страницы.
- `scripts/test-parallel-routes.js` (новый): реальный router поверх HTTP с подменённым
  `chatgpt`: 3 одновременных текста стартуют вместе, 4-й ждёт; переполнение ожидающих → 429
  `queue_full` с корректным Retry-After; одинаковый `conversation_id` не пересекается;
  `beforeSubmit` вызывается и паузирует; cooldown, взведённый одним заданием, отказывает
  второму в `beforeSubmit`; возврат в голову очереди после `retryAfterMaintenance`;
  `/v1/images/status` отдаёт running/waiting.
- Обновить затронутые существующие тесты (`test-session-check.js`, `test-tiers.js`,
  `test-cooldown.js` и др.) под новые сигнатуры — без ослабления их проверок.
- `scripts/mutate-parallel-tabs.js` — обвязка по правилам M1, минимум 8 мутаций: (1) chunk
  пишется в capture глобально/чужого слота; (2) lastConversationFetch общий; (3) resetPage
  закрывает чужую страницу; (4) recoveryState общий; (5) деструктивная ветка выполняется
  инлайн; (6) key по conversation_id не передаётся; (7) beforeSubmit не вызывается / не
  проверяет cooldown; (8) серия tier считается без slotId.

## Не трогать

Всё, кроме `src/chatgpt.js`, `src/chatgpt-tiers.js`, `src/browser.js` (только если нужно для
закрытия всех страниц), `src/routes/images.js`, `src/routes/login.js`, `src/server.js`,
`src/job-pool.js`, `src/pacer.js`, `src/progress.js` (ТОЛЬКО дополнения раздела 10a и
исправления раздела «Починить дефекты M1»; существующий API M1 не ломать), новых/затронутых
`scripts/test-*.js`, `scripts/mutate-parallel.js`, `scripts/mutate-parallel-tabs.js`,
`package.json` (только `scripts.test`), `README.md`, `.env.example`, `docker-compose.yml`,
`helm/values.yaml`. **Эту спеку и `docs/specs/parallel-pool-m1-mut-report.md` закоммить
вместе с работой.** CHANGELOG, `helm/Chart.yaml`, версию в `package.json` не трогать.
**`git push` в origin запрещён.**

## Уточнения после ревью спеки (Codex + agy) — обязательны

R1. **Контекст задания целиком.** Публичные `generateImage/editImage/completeText` и
    `probeCapabilities` принимают `options.job = { slotId, jobId, epoch }` (из `fn` пула).
    Нет `options.job` → `{ slotId: 0, jobId: undefined, epoch: undefined }` (совместимость).
    `jobId` пишется в слот при старте задания — им `progress.touch(jobId)`; `epoch` — в
    `sinceEpoch` запросов обслуживания.
R2. **Внедрение пула без require-цикла:** `chatgpt.setPoolHooks({ requestMaintenance,
    acquireExclusive })` (вызывает `routes/images.js` после создания пула). До вызова —
    поведение безопасное: обслуживание выполняется инлайн только если явно передан
    `{ exclusive: true }`, иначе ошибка `server_error` «pool hooks not set».
R3. **Обслуживание без await — всегда с `.catch(log)`**: отклонённый Promise обслуживания не
    должен становиться unhandled rejection.
R4. **Маркер `retryAfterMaintenance` пробрасывается сразу**, мимо внутренних ретраев
    `completeText` (и любых других catch-ретраев): `catch` первым делом
    `if (err.retryAfterMaintenance) throw err;`. Ветка `needsHardReset` в `completeText`
    (второй `page_load_failed`) больше НЕ вызывает `hardResetBrowser()` в слоте: до отправки —
    запрос обслуживания `hard-reset` + маркер; после отправки — запрос без await + исходная
    ошибка. Внутри слота `hardResetBrowser`/`closeBrowser`/`autoLogin`/`clearSession`
    не вызываются ни в одной ветке (проверяется тестом и мутацией).
R5. **Обслуживание, меняющее сессию или браузер** (`hard-reset`, перестройка контекста,
    авто-логин, `/login/save`), после выполнения сбрасывает страницы ВСЕХ слотов (закрыть и
    обнулить; `pendingReset`/capture слотов очистить), чтобы ни одна вкладка не осталась на
    `/auth/login` или старом документе.
R6. **Ручной логин — один захват на всех.** Модульный single-flight в `routes/login.js`:
    первый `/login/*` (включая прямой `/login/save`) запускает `acquireExclusive('manual-login')`,
    все параллельные/последующие вызовы ждут ТОТ ЖЕ Promise и используют тот же `release`;
    второй захват не создаётся, пока первый не отпущен. Отпускают `/login/save` (после
    сохранения и R5) и простой ≥ 10 мин (таймер сбрасывается каждым `/login/*`).
R7. **Liveness во время обслуживания.** Пока активно обслуживание или эксклюзив, routes
    бьют `progress.touch()` каждые `heartbeatMsFor()` мс, но не дольше
    `MAINTENANCE_HEARTBEAT_MAX_MS` (900000) на одно обслуживание — по-настоящему зависшее
    обслуживание по-прежнему видно liveness. Для manual-login каждый `/login/*` вызов тоже
    `touch()`.
R8. **queue_full.** `submit` бросает синхронно — route ловит `err.code === 'queue_full'` (как и
    `pool.isFull()` в `checkQueueFull`) и отвечает 429 `queue_full` с `Retry-After`, а не 500.
R9. **Capabilities.** `probeCapabilities(options)` принимает `options.job`; проба без кэша идёт
    через `pool.submit`; если пул полон — 429 `queue_full` (как обычные запросы), при наличии
    кэша — stale cache.

## Починить дефекты M1 (найдены ревью Codex/agy и независимыми мутациями Codex)

Полный отчёт мутаций — `docs/specs/parallel-pool-m1-mut-report.md` (коммитится вместе с
работой). Каждый пункт — с тестом, который падал бы на старом коде.

1. `job-pool`: удерживаемое до обслуживания задание с `key` блокирует свой `key` — более
   поздние задания той же беседы его не обгоняют (A₁ → обслуживание → A₂ → B).
2. `job-pool`: при `maxWaiting = 0` задание принимается, если его можно запустить сразу
   (свободный слот, нет обслуживания, key свободен); `isFull()` согласован с этим.
3. `pacer.createTurnGate`: ранний (раньше срока) wake таймера не выпускает gate раньше
   `planned` — минимальный разнос соблюдается на реальных таймерах Node; при застывших
   часах выход по-прежнему без зацикливания, но `lastReleasedAt`/`lastReservedStart`
   обновляются, и следующий gate выдерживает разнос. Тест на реальных таймерах (малый
   stagger, например 30 мс, 20 повторов, интервал ≥ stagger).
4. `progress.liveness()`: проверка per-job идёт ДО общей, reason содержит `job <jobId>`.
5. Раннер тестов `scripts/test-job-pool.js` (и новые тест-файлы вехи) обязан падать
   (rc≠0), если выполнились не все зарегистрированные тесты — в т.ч. когда незавершённый
   Promise даёт процессу выйти раньше (выживший M09 вышел rc=0 после 12 из 21).
6. Добить выживших мутантов отчёта: M03, M09, M11, M13, M19, M21, M22, M25, M26 — тестами;
   эквивалентный мутант исключается только с письменным обоснованием в `note` AC-002.
   Добавить эти мутации (точные замены из отчёта, с поправкой на изменённый код) в
   `scripts/mutate-parallel.js`.

## Что проверено вживую (постановщиком, на 1268703)

- `npm test` и `node scripts/mutate-parallel.js` в `node:24` под `-u 1002:1002` — rc=0.
- Headful patchright + Chrome под Xvfb (образ 2.14.11): 3 страницы одного context —
  `visibilityState=visible`, `hasFocus()=true`, таймеры и rAF без троттлинга, ввод с
  клавиатуры в не-последнюю вкладку доходит. Clipboard в `src/` не используется.
- `src/chatgpt.js` (прочитаны тела): модульные `let page` (стр. ~167), `currentCapture`,
  `lastConversationFetch`, `const staleStreams` (~172-177), `pagePromise` (~461),
  `recoveryState`/`pendingReset`/`consecutiveMenuFailures` (~1103-1105),
  `ensureLoggedInPromise` (~3465), `consecutiveUnknownChecks`, `lastContextResetAt`,
  `watchdogTimer`, `sessionProbeInFlight`. Функции: `beginBackendCapture`,
  `endBackendCapture`, `onBackendResponse`, `setupBackendReadHooks(p)` (on('response'),
  `exposeFunction('__gwgSseChunk')`, `addInitScript`, on('load')), `getPage`, `_createPage`
  (в конце `saveSession()`), `closeWedgedPage`, `recreatePage`, `probeSessionWithRecovery`,
  `markSessionDegraded`, `consumePendingReset`, `markHealthyCompletion`,
  `maybeRecoverSession`, `ensureLoggedIn`/`_ensureLoggedIn` (ветки refuse / reset с
  `saveSession`+`hardResetBrowser` / auto-login с `resetPage`+`autoLogin(ctx)` и
  пост-проверкой), `checkSessionOnce`, `startSessionWatchdog`, `ensureSessionReady`,
  `generateImage`, `editImage`, `completeText` (ретраи pre-submit, `TEXT_HARD_RESET_ENABLED`,
  флаг `submitted` ставится колбэком `typeAndSubmit`), `resetPage`, `hardResetBrowser`
  (`resetPage` + `closeBrowser`), экспорт `_test` в конце файла.
- `src/routes/images.js`: `upstreamTurn(send)`, `enqueue(fn)` (Promise-цепочка, `queueSize`),
  `checkQueueFull`, `queueFullRetryAfterSec`, `assertNotRateLimited`, `rateLimitedUntil`;
  батч картинок — один `enqueue` с `upstreamTurn` на каждую картинку и `reuseChat: i > 0`;
  экспорт `_internals` (используется `scripts/test-cooldown.js`).
- `src/routes/login.js`: `getLoginPage` через `ctx.newPage()`, `/login/save` зовёт
  `saveSession()` и `resetPage()` из `chatgpt.js`.
- `src/server.js`: после `listen` — `ensureSessionReady().finally(startSessionWatchdog)`.
- `src/chatgpt-tiers.js`: `tierAvailability.noteUnavailable(mode, reason, {stickyAfter})`
  считает серию по `strikes` (Map mode → {reason, count}).
- Предположение (проверит постановщик на проде): выбор модели/tier и режим Chat/Work в одной
  вкладке не переключают composer соседней вкладки посреди её задания.

## Критерии приёмки

- **AC-001. Полный сьют зелёный.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 npm test'`
- **AC-002. Обвязка M1 убивает прежние и новые мутации.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node scripts/mutate-parallel.js'`
- **AC-003. Обвязка вехи убивает все мутации.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node scripts/mutate-parallel-tabs.js'`
- **AC-004. Модули грузятся без браузера.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node -e "require(\"./src/chatgpt\");require(\"./src/routes/images\");require(\"./src/routes/login\")"'`
- **AC-005. В chatgpt.js нет модульных глобалов страницы, перехвата и восстановления.**
  `bash -c '! grep -nE "^(let|var) (page|pagePromise|currentCapture|lastConversationFetch|recoveryState|pendingReset|consecutiveMenuFailures)\b" src/chatgpt.js && ! grep -nE "^const staleStreams\b" src/chatgpt.js'`
- **AC-006. Пул и хук отправки подключены, старая цепочка удалена.**
  `bash -c 'grep -q "createJobPool" src/routes/images.js && grep -q "createTurnGate" src/routes/images.js && grep -q "beforeSubmit" src/chatgpt.js && ! grep -nE "^let queue\b|function upstreamTurn" src/routes/images.js'`
- **AC-007. Конфиг и документация.**
  `bash -c 'grep -q "MAX_CONCURRENT_JOBS: \"3\"" helm/values.yaml && grep -qE "memory: 4Gi" helm/values.yaml && grep -qE "cpu: \"2\"" helm/values.yaml && grep -q "MAX_CONCURRENT_JOBS" README.md && grep -q "MIN_TURN_STAGGER_SEC" README.md && grep -q "MAX_CONCURRENT_JOBS" .env.example'`
- **AC-008. Состав, чистота, версии и CHANGELOG не тронуты.**
  `bash -c 'test -z "$(git status --porcelain -- . ":(exclude)report.json" ":(exclude)report-blocked.md")" && test -z "$(git diff --name-only 1268703 HEAD | grep -vxE "src/chatgpt.js|src/chatgpt-tiers.js|src/browser.js|src/routes/images.js|src/routes/login.js|src/server.js|src/job-pool.js|src/pacer.js|src/progress.js|scripts/test-[a-z0-9-]+\.js|scripts/mutate-parallel.js|scripts/mutate-parallel-tabs.js|package.json|README.md|\.env\.example|docker-compose.yml|helm/values.yaml|docs/specs/parallel-tabs-m2.md|docs/specs/parallel-pool-m1-mut-report.md")" && git diff --quiet 1268703 HEAD -- CHANGELOG.md helm/Chart.yaml && test "$(git show 1268703:package.json | jq -S "del(.scripts.test)")" = "$(jq -S "del(.scripts.test)" package.json)"'`

## Авторевью

После коммита работы прогони ревью Codex (только чтение):
`bash ~/.claude/skills/ask-codex/scripts/run.sh result "<контекст: клон, диапазон 1268703..HEAD, спека>"`.
Если ты сам Codex — вместо него `bash ~/.claude/skills/ask-grok/scripts/run.sh result "<тот же контекст>"`.
Исправь найденное ОДНИМ заходом; вердикт и что исправлено — в `note` AC-001.

## Контракт отчёта

`report.json` в корне клона, untracked:
`{"criteria": [{"id": "AC-001", "status": "pass|fail|blocked", "command": "…", "rc": 0, "note": "…"}]}` —
ровно 8 записей (AC-001…AC-008), команды дословно как в спеке.

## Контракт на невыполнимое

Если требование спеки противоречит существующему коду, без правки API M1 сверх раздела 10a
не обойтись, существующий тест можно сохранить только ослабив его проверку, или базовый
сьют не зелёный — остановись, `report-blocked.md` с фактами. Обходить несовместимость
запрещено.

## Стык

После приёмки постановщик сам выпускает 2.15.0 (CHANGELOG, версии, тег) и проверяет на
проде: 3 параллельных текста с уникальными токенами, картинка + 2 текста, переполнение
очереди, `/v1/images/status`.
