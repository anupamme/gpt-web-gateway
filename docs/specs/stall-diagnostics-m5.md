# Веха M5: диагностика зависаний текста, повтор на свежей странице, логи слотов

- Репозиторий: `~/github/gpt-web-gateway`, ветка `main`, коммит `7d97d08` («Add release script that pushes main last»).
  BASE_SHA `7d97d0898ca3b33bb9735586e49d587694006489`. Дата 2026-10-15.
- Исполнитель: `cx`. Мутации по новым тестам потом гоняет другой исполнитель.

## Где работать

Клон `<clone-root>/stall-diag`, новая ветка `feat/stall-diagnostics`. Живое дерево не трогать.
**`git push` в origin запрещён**: работу постановщик заберёт через `git fetch`. Всё запускать
в Docker `node:24` под `-u 1002:1002`. `node_modules` положен постановщиком (untracked).

## Почему (факты из логов прода, проверено постановщиком)

- Примерно 15% текстовых заданий зависают. На 2.14.10 это 119 из 766 отправок,
  на 2.15.0 — 9 из 62. Началось 2026-10-14 около 21:00 UTC, до этого зависаний не было.
  Последовательность в логе всегда одна: `Prompt submitted (confirmed)`, через 60 с
  `[rescue] no rendered text … reloading page`, ещё через 120 с `session degraded (text turn stalled …)`.
  Клиент получает 504 примерно через 280 с. Следующее задание на свежей странице почти всегда
  проходит, в логах 2.15.0 — каждое.
- Причину установить нельзя. `onBackendResponse` (`src/chatgpt.js`) молча игнорирует ответ
  на `POST /backend-api/(f/)conversation`, если он не `text/event-stream`, то есть 429, 403
  или JSON с ошибкой. GET разговора с `!ok` тоже игнорируется. Снапшот `text_stalled`
  пишется только при `DEBUG_SNAPSHOTS=1`, а на проде он выключен.
- При трёх вкладках строки разных заданий в логе перемешаны: номера слота в них нет.
- Раз в минуту внешний аптайм-монитор делает `GET /`, и каждый такой запрос даёт две строки
  access-лога.
- Одна страница за 33 часа (766 ходов) выросла по памяти пода с 2 до 6,3 ГиБ и сбросилась
  только после пересоздания страницы.

## Что проверено вживую, а что предположение

Проверено чтением кода на BASE (src не менялся с b89c3c2):
- `onBackendResponse(slot, response)`: для POST разговора выходит, если ct не SSE; для GET
  разговора выходит, если `!response.ok()`;
- `CONVERSATION_POST_PATH_RE = /^\/backend-api\/(f\/)?conversation$/`;
- stall-abort и rescue находятся в `waitAndExtractText`, там же
  `saveDebugSnapshot(p, 'text_stalled')`, а `saveDebugSnapshot` выходит, если
  `!DEBUG_SNAPSHOTS_ENABLED`;
- цикл попыток текста: `for (attempt < maxAttempts)`, `maxAttempts = CHATGPT_TEXT_RETRY_ATTEMPTS`;
  сбой при `submitted` не повторяется; `maybeRecoverSession(slot)` стоит в начале попытки;
- `markSessionDegraded` ставит `'page'`, а на probation — `'hard'`; `discardSlotPage`
  обнуляет page/capture слота;
- `submitJob(fn, { key })` в `src/routes/images.js`; `ACCESS_LOG_SKIP` в `src/server.js`
  не покрывает `/`;
- на проде `DEBUG_SNAPSHOTS` не задан, `GET /` приходит каждые 60 с.

Предположения, не проверены:
- что при зависании ChatGPT отвечает на POST не-SSE или не-2xx. F1 нужен как раз для того,
  чтобы это выяснить, поэтому F2 не должен на это предположение опираться;
- что рост памяти — утечка в SPA одной страницы, а не в Chrome вообще.

## Что сделать

### F1. Диагностика ответа backend-api (`src/chatgpt.js`)

1. Любой ответ на `POST` по `CONVERSATION_POST_PATH_RE` при активном capture (снимок capture
   ДО любого await, как сейчас для SSE) сразу, по заголовкам, записывает в capture
   `postStatus = { status, contentType, at }`. Это нужно и для F2.
   Если статус вне 2xx ИЛИ content-type не `text/event-stream`:
   - СИНХРОННО, до чтения тела, положить в capture
     `postFailure = { status, contentType, snippet: '' }`;
   - затем прочитать тело с ограничением 5 с (`Promise.race` с таймером, таймер снимать):
     зависшее тело не должно задерживать ни ошибку, ни лог;
   - дописать `snippet`: до 300 символов, пробелы схлопнуты;
   - записать ОДНУ строку `[backend-read] slot=<id> conversation POST status=<n> ct=<ct> body="<snippet>"`.
     `slot=` обязателен: колбэк Playwright выполняется вне ALS-контекста F3, и префикса там нет.
     Если тело не прочиталось за 5 с, вместо него `body=<unread>`.
2. В `waitAndExtractText`, если у capture есть `postFailure`, не ждать окно stall:
   - `status === 429` → бросить ошибку `code = 'rate_limit'`. В сообщении должна быть
     подстрока `rate limit` (на неё срабатывает `handleRateLimitError` в `src/routes/images.js`),
     `modelMessage` = snippet (может быть пустым, если тело ещё не прочитано);
   - любой другой статус вне 2xx → `code = 'server_error'`, в сообщении статус и snippet;
   - 2xx, но не SSE → только лог из п.1, поведение ожидания прежнее.

   Та же проверка нужна в цикле подтверждения отправки в `typeAndSubmit`, где сейчас 12 с
   ждут новый ход пользователя. При отказе POST ChatGPT может не отрисовать ход, и тогда цикл
   кончится ошибкой `page_load_failed` («submit not confirmed») раньше, чем дело дойдёт до
   `waitAndExtractText`. Передай capture в `typeAndSubmit`. Если в цикле появился
   `postFailure` вне 2xx, сразу брось ту же ошибку, что в п.2, и считай отправку состоявшейся:
   POST ушёл, поэтому обычный повтор до отправки запрещён.
3. Кольцевой буфер в СЛОТЕ: последние 30 ответов backend-api в виде
   `{ at, method, path, status, ct }`. В `path` id в форме UUID и hex от 16 символов
   заменяются на `<id>`. При rescue и при stall-abort одной строкой
   `[stall-diag] slot=<id> backend-api since submit: <METHOD path status>, …` вывести записи
   с `at >=` момента открытия capture этого хода (`beginBackendCapture`, это раньше submit),
   а НЕ начала `waitAndExtractText`: иначе быстрый ответ на POST выпадает. Если записей нет,
   вывести `none`.
4. GET одного разговора (`SINGLE_CONVERSATION_PATH_RE`) при активном capture: одна строка
   `[backend-read] slot=<id> conversation GET status=<n> messages=<число узлов mapping> last_role=<role>
   last_status=<status последнего сообщения>`. При `!ok` писать только статус. Поведение
   `rememberConversation` не менять.
5. Снапшоты зависаний пишутся НЕЗАВИСИМО от `DEBUG_SNAPSHOTS`:
   - новый env `STALL_SNAPSHOTS` (по умолчанию `1`, значение `0` выключает);
   - метка `text_rescue` — снимок ДО reload в rescue;
   - метка `text_stalled` — снимок в stall-abort (вызов уже есть);
   - каталог `DEBUG_SNAPSHOT_DIR`; хранить не больше `STALL_SNAPSHOT_KEEP` (по умолчанию 20)
     самых новых пар `.png`/`.html` с этими метками, старые удалять;
   - остальные снапшоты по-прежнему только при `DEBUG_SNAPSHOTS`.

### F2. Один повтор при зависании без ответа

Сейчас любой сбой после submit не повторяется, и это сделано намеренно: повтор дал бы дубль
генерации. Нужно узкое исключение. Ошибка stall-abort помечается `err.stallNoAnswer = true`,
только если выполнены все четыре условия:
- нет `bestText`;
- у capture нет привязанного потока (`boundStream === null`) и текст пустой;
- нет `postFailure`;
- за ход НЕ было 2xx-ответа на POST разговора (`postStatus` отсутствует или вне 2xx).
  Принятый сервером POST означает, что генерация могла начаться, даже если первый чанк
  не дошёл. Повтор в этом случае дал бы дубль, поэтому его нет.

Остаточный риск, принятый осознанно: POST ушёл, а ответ на него не пришёл вовсе. Тогда сервер
мог принять сообщение, и повтор даст дубль генерации в аккаунте. Для текстового чата цена
такого дубля — только лишний расход лимита.

В цикле попыток текстового задания такая ошибка повторяется ровно `TEXT_STALL_RETRIES` раз
(новый env, по умолчанию `1`, `0` выключает повтор), только если одновременно:
- `!anyDeltaEmitted`;
- нет `options.conversationId` (продолжение разговора не повторяется);
- `slot.pendingReset !== 'hard'`.

Повтор идёт по существующему пути следующей попытки: `maybeRecoverSession` потребляет
page-reset этого слота, затем новый чат, `beforeSubmit` (пейсинг), submit. Повтор при
зависании не расходует `CHATGPT_TEXT_RETRY_ATTEMPTS`: при значении `1` он всё равно
происходит.

Бюджет повторов принадлежит ЗАДАНИЮ, а не одному вызову `completeText`. Если подготовка
повтора кончится `retryAfterMaintenance`, пул перезапустит задание, возможно в другом слоте.
Использованные повторы при этом должны сохраниться: храни счётчик в объекте, который
переживает перезапуск задания пулом (замыкание/опции задания в `src/routes/images.js`).
Суммарно за задание — не больше `TEXT_STALL_RETRIES` повторных отправок.

Пейсинг: повтор — это новая отправка, и пауза на слот (`MIN_JOB_GAP_SEC`) отсчитывается от
конца зависшей попытки. Сейчас `turnGate.finished()` зовётся только по выходу из всего
`completeText` (`runTurn` в `src/routes/images.js`). Нужен колбэк попытки (например,
`options.onAttemptFinished`), который `runTurn` связывает с `turnGate.finished` своего слота.
Его вызывают перед повтором, а финальный `finished` не задваивается. Тест проверяет, что при
`MIN_JOB_GAP_SEC > 0` повторная отправка ждёт паузу. Строка лога:
`[chatgpt] stall with no answer after submit — fresh page, resending once (stall retry k/N)`.
Повтор НЕ берёт эксклюзив и НЕ трогает чужие слоты. Повторный stall на испытательном сроке
(probation), как и сейчас, даёт `pendingReset = 'hard'` и обслуживание через пул.

### F3. Логи

1. Новый `src/log-context.js` на AsyncLocalStorage. `submitJob` в `src/routes/images.js`
   выполняет задание внутри контекста `{ slotId }` (берётся из `ctx.slotId`). Сигнатуры
   `submitJob`/`submitTextJob` и строку `return submitJob(fn, { key: jobKey });` не менять:
   на её текст опирается мутация 6 в `scripts/mutate-parallel-tabs.js`. Обёртка над
   `console.log/warn/error`, установленная один раз, добавляет к строке, выведенной в этом
   контексте, префикс `[s<slotId>]`. Строки вне контекста выводятся без изменений.
   В колбэках Playwright контекста может не быть: это допустимо, правильный префикс там
   не требуется.
2. Access-лог (`src/server.js`): не писать `GET /` (ровно путь `/`).

### F4. Плановое пересоздание страницы

Счётчик завершённых заданий на текущей странице слота сбрасывается при `discardSlotPage`.
Когда он достигает `PAGE_RECYCLE_AFTER_JOBS` (новый env, по умолчанию 50, `0` выключает),
слот получает `pendingReset = 'recycle'`, но только если сейчас `pendingReset` пуст.
Строка лога: `[recycle] slot <id>: page served <n> jobs — fresh page on next job`.
`maybeRecoverSession` обрабатывает `'recycle'` так: `resetPage(slot)` БЕЗ перевода в
probation и без изменения `recoveryState`. Остальные места, которые читают `pendingReset`
(например, проверка в районе `getSlot(0).pendingReset` в warm-up и watchdog), должны
корректно обрабатывать новое значение. Найди их все. В частности, `checkSessionOnce`
(watchdog) сейчас пропускает пробу при ЛЮБОМ непустом `getSlot(0).pendingReset`. Значение
`'recycle'` проверку пропускать НЕ должно: страница рабочая, иначе на простое watchdog
будет молчать бесконечно. Тест это проверяет.

### Документация

- `README.md`: новые env (`STALL_SNAPSHOTS`, `STALL_SNAPSHOT_KEEP`, `TEXT_STALL_RETRIES`,
  `PAGE_RECYCLE_AFTER_JOBS`) в таблицу/раздел, где описаны остальные.
- `CHANGELOG.md`: раздел `## Unreleased` наверху, по пункту на F1–F4. Версию не бампать.

## Тесты

Новые тесты положить в `scripts/test-stall-*.js` и добавить их в `npm test`
(`package.json`, скрипт `test`). Каждое поведение F1–F4 покрыто тестом, который падает,
если поведение убрать. Обязательно проверить:
- F1.2: 429 бросает `rate_limit` сразу, без ожидания окна stall;
- F2: повтора нет при `conversationId`, при `anyDeltaEmitted`, при привязанном потоке,
  при 2xx-ответе на POST без чанков, при `pendingReset === 'hard'`, при
  `TEXT_STALL_RETRIES=0`; повтор есть при `CHATGPT_TEXT_RETRY_ATTEMPTS=1`; бюджет не
  сбрасывается после `retryAfterMaintenance`; повтор соблюдает паузу слота;
- F1: 429 во время цикла подтверждения в `typeAndSubmit` даёт `rate_limit`, а не
  `page_load_failed`, и повтора до отправки нет;
- F1.1: `postFailure` выставлен до чтения тела; тело, которое не завершается, не задерживает
  ошибку 429 дольше чем на ~5 с;
- F3: префикс есть внутри задания и отсутствует вне его, `GET /` не логируется;
- F4: `'recycle'` не переводит слот в probation и не затирает уже стоящий `page`/`hard`.

Стиль моков бери из существующих `scripts/test-parallel-*.js` и
`scripts/test-text-extraction.js`.

## Не трогать

Ничего, кроме `src/chatgpt.js`, `src/routes/images.js`, `src/server.js`, `src/log-context.js`
(новый), `scripts/test-stall-*.js` (новые), `package.json` (только скрипт `test`),
`README.md`, `CHANGELOG.md` и этой спеки. В частности:
- `helm/`, `.github/`, `package-lock.json` и версии не менять;
- `src/job-pool.js` не менять;
- инварианты параллельных вкладок (CLAUDE.md, раздел «Параллельные вкладки») не нарушать.

**Эту спеку закоммитить вместе с работой. `git push` в origin запрещён.**

## Критерии приёмки

- **AC-001. Полный сьют зелёный.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 npm test'`
- **AC-002. Новые тесты существуют и подключены к npm test.**
  `bash -c 'ls scripts/test-stall-*.js >/dev/null && for f in scripts/test-stall-*.js; do grep -qF "node $f" package.json || exit 1; done'`
- **AC-003. Мутации прошлых вех по-прежнему убиваются.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 sh -c "node scripts/mutate-parallel.js && node scripts/mutate-parallel-tabs.js"'`
- **AC-004. Новые env задокументированы.**
  `bash -c 'for v in STALL_SNAPSHOTS STALL_SNAPSHOT_KEEP TEXT_STALL_RETRIES PAGE_RECYCLE_AFTER_JOBS; do grep -q "$v" README.md && grep -q "$v" src/chatgpt.js || exit 1; done'`
- **AC-005. Изменения только в разрешённых путях, дерево чистое.**
  `bash -c 'test -z "$(git status --porcelain -- . ":(exclude)report.json" ":(exclude)report-blocked.md")" && test -z "$(git diff --name-only 7d97d0898ca3b33bb9735586e49d587694006489 HEAD | grep -vxE "src/chatgpt.js|src/routes/images.js|src/server.js|src/log-context.js|scripts/test-stall-[a-z0-9-]+\.js|package.json|README.md|CHANGELOG.md|docs/specs/stall-diagnostics-m5.md")" && test -z "$(git diff 7d97d0898ca3b33bb9735586e49d587694006489 HEAD -- package.json | grep -E "^[-+][^-+]" | grep -v "\"test\":")"'`

## Авторевью

После коммита работы прогони ревью Grok (только чтение; Codex сам себя не ревьюит):
`bash ~/.claude/skills/ask-grok/scripts/run.sh result "<контекст: клон, диапазон 7d97d08..HEAD, спека>"`.
Исправь найденное одним заходом, вердикт запиши в `note` AC-001.

## Контракт отчёта

`report.json` в корне клона, не коммитится:
`{"criteria": [{"id": "AC-001", "status": "pass|fail|blocked", "command": "…", "rc": 0, "note": "…"}]}`.
Ровно 5 записей (AC-001…AC-005), команды дословно как в спеке.

## Контракт на невыполнимое

Остановись и запиши `report-blocked.md` с фактами, если:
- требование нельзя выполнить, не нарушив «Не трогать» или инварианты параллельных вкладок;
- базовый сьют на BASE не зелёный;
- поведение F2 нельзя ограничить условиями из спеки.

Обходить запрещено.

## План исполнения

1. Проверить BASE полным `npm test` в указанном Docker (пройдено).
2. Добавить поведенческие тесты `scripts/test-stall-*.js`: реальные адаптер,
   маршруты и пул, подменены только браузер и часы. Проверить падение на BASE.
3. В `src/chatgpt.js` реализовать диагностику capture/ответов, кольцо слота,
   снапшоты с ротацией и узкий stall retry. В `src/routes/images.js` сохранить
   бюджет задания через maintenance и завершать пейсинг каждой попытки.
4. Добавить ALS в `src/log-context.js`, контекст задания и исключение `GET /`.
   Учёт завершённых заданий вызывать из пула маршрутов; `recycle` обрабатывать
   отдельно от деградации и разрешать watchdog проверять такую страницу.
5. Обновить README, Unreleased и только test-скрипт package.json. Выполнить
   AC-001…AC-004, закоммитить разрешённые файлы вместе со спецификацией.
6. Запустить read-only Grok review диапазона BASE..HEAD, исправить находки
   одним заходом с тестами, повторить затронутые проверки. Выполнить AC-005
   и записать ровно пять результатов в некоммитимый report.json. Не пушить.

Особое внимание тестов: отказ POST до DOM-подтверждения; зависшее чтение тела;
2xx без чанков и привязанный пустой поток; перенос бюджета на другой слот после
maintenance; пауза между попытками и watchdog при ожидающем recycle.
