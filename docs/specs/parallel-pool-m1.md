# Веха M1: примитивы параллельной обработки (пул, темп, liveness) — без подключения

- Репозиторий: `~/github/gpt-web-gateway`, ветка `main`, база `1626872`
  («Revert "Cancel expired text requests and bound browser reads"»). Дата 2026-10-15.
- Исполнитель: `auto` (новая спека).
- Это первая из двух вех «3 параллельные вкладки». Здесь — только чистые модули и тесты;
  подключение к браузеру, маршрутам и `chatgpt.js` — следующая веха.

## Где работать

Клон `<clone-root>/parallel-pool`, новая ветка `feat/parallel-pool`. Живое дерево
`~/github/gpt-web-gateway` не трогать. **`git push` в origin запрещён** — работу заберёт
постановщик через `git fetch` из клона. Всё запускать в Docker `node:24` под `-u 1002:1002`.
Постановщик уже положил `node_modules` (`npm ci --ignore-scripts`, untracked, в .gitignore).

## Задача и почему

Сервис гоняет все задания через одну Promise-цепочку (`enqueue()` в `src/routes/images.js`):
одно задание за раз. Цель продукта — до `MAX_CONCURRENT_JOBS` (дефолт 3) заданий
одновременно, каждое в своей вкладке; остальные в FIFO-очереди. Операции на весь браузер
(перезапуск, авто-логин, проба сессии, ручной логин) обязаны идти только когда ни одно
задание не работает. Ревью плана (Codex + agy) отвергло схему «RW-аренда с апгрейдом
изнутри задания» — дедлок, если задание ждёт вердикт лидера под shared-арендой, и протухшие
ссылки на страницу у двух апгрейдеров. Поэтому принята схема **«обслуживание только между
заданиями»**: пул останавливает выдачу, дожидается, пока работающие осядут, выполняет
обслуживание эксклюзивно и продолжает. Задание, которому до отправки промпта понадобилось
обслуживание, НЕ ждёт его внутри себя, а бросает ошибку-маркер и возвращается в голову очереди.

Решения владельца по темпу: пауза `MIN_JOB_GAP_SEC` — **на слот** (от финиша предыдущего
upstream turn этого же слота); реактивный cooldown общий (не в этой вехе); между стартами
turn'ов разных слотов разнос ≥ `MIN_TURN_STAGGER_SEC` (дефолт 10 с, `0` выключает),
резервирование атомарное.

## Что проверено вживую (постановщиком, на базе 1626872)

- `npm test` в `node:24` под `-u 1002:1002` в этом клоне — rc=0.
- `src/pacer.js`: `createPacer({now, sleep, gap, heartbeat, heartbeatMs})` возвращает
  `{gate(), finished(), status()}`; `gate()` без аргументов, ждёт `gap` от последнего
  `finished()`, бьёт `heartbeat()` каждые `heartbeatMs`, на застывших часах не зацикливается;
  `status()` → `{min_gap_sec, next_slot_in_sec, throttled_seconds_total}`. Экспорт:
  `createPacer, gapMs, heartbeatMsFor, DEFAULT_GAP_MS, HEARTBEAT_MS`. `gapMs()` читает
  `MIN_JOB_GAP_SEC` (пусто → 60 с, `0` → выключено, мусор → warn + 60 с).
- `src/progress.js`: `createProgress(now)` → `{touch(), jobStarted(), jobFinished(errorKind),
  recordInfraFailure(kind), clearPartialInfra(), snapshot(), liveness()}`; один
  `lastProgressAt`; `liveness()` мёртв, если `queueSize>0` и нет прогресса дольше
  `HEALTH_STUCK_MS`, либо streak'и ≥ `HEALTH_FAILURE_STREAK`. Экспорт:
  `progress, createProgress, INFRA_ERROR_KINDS, HEALTH_STUCK_MS, HEALTH_FAILURE_STREAK`.
- Тесты — самописные скрипты `scripts/test-*.js` (assert + свой `ok/add`), цепочка в
  `package.json` `scripts.test` через `&&`. Браузер в тестах не запускается.
- Предположение (не проверено, проверять не требуется в этой вехе): M2 будет звать
  `progress.touch(jobId)` из цепочек async задания, получая jobId из AsyncLocalStorage.

## Что сделать

### 1. `src/job-pool.js` (новый)

`createJobPool({ concurrency, maxWaiting })` → объект:

- `submit(fn, { key } = {})` → Promise результата `fn`. Если ожидающих уже `maxWaiting` —
  синхронно бросает `Error` с `code = 'queue_full'` (не reject позже). Иначе задание встаёт
  в FIFO. `fn({ slotId, jobId, epoch })`: `slotId` — целое в `[0, concurrency)`, у
  одновременно работающих заданий разные; `jobId` — уникальная строка; `epoch` — значение
  счётчика завершённых обслуживаний на момент старта задания.
- Выдача: первое по порядку ожидающее задание, чей `key` (если задан) не занят работающим
  заданием. Задания с одинаковым `key` никогда не работают одновременно и стартуют в порядке
  подачи. Задания без `key` ограничений не имеют. Пока есть ожидающее/активное обслуживание —
  новые задания не стартуют.
- Слот освобождается только когда Promise `fn` осел (resolve или reject).
- **Возврат в голову очереди**: если `fn` бросил ошибку с `err.retryAfterMaintenance === true`
  и это задание ещё ни разу так не возвращалось — Promise задания НЕ отклоняется, задание
  встаёт в НАЧАЛО очереди ожидающих (не считается против `maxWaiting`) и стартует заново
  после обслуживания (с новым `epoch`). Второй такой бросок — обычный reject этой ошибкой.
- `requestMaintenance(name, fn, { sinceEpoch } = {})` → Promise. Если `sinceEpoch` задан и
  обслуживание с тем же `name` завершилось после этого epoch (т.е. счётчик завершений
  `name` вырос с момента `sinceEpoch`) — немедленно resolve `{ skipped: true }`, `fn` не
  вызывается (защита от второго паразитного reset). Если обслуживание с тем же `name` уже
  ждёт старта — вернуть его Promise (слияние). Иначе встать в очередь обслуживаний.
  Обслуживание стартует, когда работающих заданий 0; обслуживания идут по одному в порядке
  запроса; результат — `{ skipped: false, value }`; ошибка `fn` отклоняет только его Promise,
  пул продолжает работу. Вызов из работающего задания допустим (задание не должно его
  ждать — обслуживание начнётся только после того, как задание осядет).
- `acquireExclusive(name)` → Promise функции `release()`: то же, что обслуживание, но
  длительность определяет вызывающий; пока не вызван `release()`, задания не стартуют.
  Повторный `release()` — no-op. Счётчик завершений растёт на `release()`.
- `isFull()`, `status()` → `{ concurrency, running, waiting, slots: [{ slotId, busy, jobId,
  key }], maintenance: { active: name|null, pending: [names] }, epoch }`.
- Невалидный `concurrency`/`maxWaiting` (не целое ≥1 / ≥0) — `TypeError` при создании.
- `parseConcurrency(env = process.env)`: `MAX_CONCURRENT_JOBS`, пусто → 3, целое 1..5 →
  оно, иначе `console.warn` и 3. Экспорт: `createJobPool, parseConcurrency,
  DEFAULT_CONCURRENCY, MAX_CONCURRENCY`.

### 2. `src/pacer.js` — дополнить, существующий API не менять

- `staggerMs(env = process.env)`: `MIN_TURN_STAGGER_SEC`, пусто → 10 000, `0` → 0, мусор →
  warn + 10 000.
- `createTurnGate({ slots, now, sleep, gap, stagger, heartbeat, heartbeatMs })`:
  внутри — по одному `createPacer` на слот и общий разнос стартов.
  - `async gate(slotId)`: сначала паузa своего слота (как `createPacer.gate`), затем
    **атомарное резервирование** времени старта: `start = max(now(), lastReservedStart +
    stagger)`, `lastReservedStart = start` — резерв делается синхронно до первого `await`
    ожидания разноса, так что два одновременных `gate` получают старты, разнесённые ≥
    `stagger`. Ожидание разноса бьёт `heartbeat()` с тем же шагом. Возвращает суммарное
    ожидание в мс. Первый turn в пустом гейте — без задержки.
  - `finished(slotId)` — финиш turn'а этого слота (на другие слоты не влияет).
  - `status()` → `{ min_gap_sec, min_stagger_sec, throttled_seconds_total, slots:
    [{ slotId, next_slot_in_sec }] }`.
  - `slotId` вне `[0, slots)` — `RangeError`.
- Экспорт дополнить: `createTurnGate, staggerMs, DEFAULT_STAGGER_MS`.

### 3. `src/progress.js` — дополнить, обратная совместимость обязательна

- `jobRunning(jobId)` — задание реально стартовало в слоте; заводит ему собственный
  `lastProgressAt = now()`.
- `touch(jobId)` — обновляет общий `lastProgressAt` и, если `jobId` известен как работающий,
  его собственный. `touch()` без аргумента — как сейчас.
- `jobFinished(errorKind, jobId)` — как сейчас + убирает `jobId` из работающих.
- `liveness()`: дополнительно мёртв, если **любое** работающее задание без собственного
  прогресса дольше `HEALTH_STUCK_MS` (reason содержит `job <jobId>` и секунды). Прежние
  правила сохраняются (в т.ч. «queueSize>0 и общий прогресс старый»).
- `snapshot()` дополнить `running_jobs` (число) и `oldest_job_ms_since_progress` (или `null`).

### 4. Тесты и мутации

- `scripts/test-job-pool.js` — минимум: лимит параллельности (при concurrency=3 четвёртое
  ждёт, стартует после оседания любого), различные `slotId` у одновременных, FIFO, `key`
  сериализует и не блокирует чужие ключи, `queue_full` синхронно при `maxWaiting`,
  слот не освобождается до оседания `fn` (в т.ч. при reject), обслуживание ждёт дренажа и
  блокирует новые старты, слияние одноимённых, `sinceEpoch` → `skipped`, ошибка обслуживания
  не ломает пул, возврат в голову очереди ровно один раз, `acquireExclusive`/`release`,
  вызов `requestMaintenance` из задания без ожидания — без дедлока, `parseConcurrency`.
- `scripts/test-pacer.js` — дописать: разнос двух одновременных `gate` разных слотов ≥
  stagger, пауза одного слота не задерживает другой сверх разноса, `finished` слота 0 не
  влияет на слот 1, `stagger=0`, `staggerMs`, heartbeat во время разноса, `RangeError`.
- `scripts/test-progress.js` — дописать: зависшее задание видно при живом соседе, который
  делает `touch(свой jobId)`; `jobFinished` снимает задание; обратная совместимость
  `touch()`/`jobStarted()`.
- `package.json` `scripts.test`: добавить `node scripts/test-job-pool.js` в цепочку.
- `scripts/mutate-parallel.js` — обвязка по правилам: для каждой мутации сохранить байты и
  sha256, прогнать целевой тест на чистом дереве (обязан быть зелёным), проверить, что
  заменяемый фрагмент встречается ровно один раз, наложить, прогнать целевой тест, откатить
  в `finally`, сверить sha256; rc=0 только если все мутанты убиты. Минимум 8 мутаций:
  (1) пул выдаёт задание при `running === concurrency`; (2) слот освобождается до оседания
  `fn`; (3) `key` игнорируется; (4) обслуживание стартует при работающих заданиях;
  (5) `sinceEpoch` игнорируется; (6) возврат в голову очереди не ограничен одним разом
  (или идёт в хвост); (7) резервирование разноса не обновляет `lastReservedStart`;
  (8) liveness не смотрит на собственный прогресс заданий. Печатает «убит/выжил» по каждой.

## Не трогать

Всё, кроме: `src/job-pool.js`, `src/pacer.js`, `src/progress.js`, `scripts/test-job-pool.js`,
`scripts/test-pacer.js`, `scripts/test-progress.js`, `scripts/mutate-parallel.js`,
`package.json` (только `scripts.test`), и этой спеки — **спеку
`docs/specs/parallel-pool-m1.md` закоммить вместе с работой**. В частности НЕ трогать
`src/routes/*`, `src/chatgpt.js`, `src/browser.js`, README, CHANGELOG, helm, версии.

## Критерии приёмки

- **AC-001. Полный сьют зелёный.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 npm test'`
- **AC-002. Обвязка убивает все мутанты.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node scripts/mutate-parallel.js'`
- **AC-003. Публичный API на месте.**
  `bash -c 'docker run --rm -u 1002:1002 -v "$PWD":/app -w /app node:24 node -e "const a=require(\"./src/job-pool\");const b=require(\"./src/pacer\");const c=require(\"./src/progress\");for (const f of [a.createJobPool,a.parseConcurrency,b.createTurnGate,b.staggerMs,b.createPacer,b.gapMs,c.createProgress]) if (typeof f!==\"function\") process.exit(1); if (a.DEFAULT_CONCURRENCY!==3||b.DEFAULT_STAGGER_MS!==10000) process.exit(1)"'`
- **AC-004. Состав, чистота, в package.json изменён только scripts.test.**
  `bash -c 'test -z "$(git status --porcelain -- . ":(exclude)report.json" ":(exclude)report-blocked.md")" && test -z "$(git diff --name-only 1626872 HEAD | grep -vxE "src/job-pool.js|src/pacer.js|src/progress.js|scripts/test-job-pool.js|scripts/test-pacer.js|scripts/test-progress.js|scripts/mutate-parallel.js|package.json|docs/specs/parallel-pool-m1.md")" && test "$(git show 1626872:package.json | jq -S "del(.scripts.test)")" = "$(jq -S "del(.scripts.test)" package.json)"'`

## Авторевью

После коммита работы прогони ревью Codex (он только читает):
`bash ~/.claude/skills/ask-codex/scripts/run.sh result "<контекст: диапазон 1626872..HEAD, клон, спека>"`.
Исправь найденное одним заходом; вердикт и что исправлено — в `note` AC-001.

## Контракт отчёта

`report.json` в корне клона, untracked:
`{"criteria": [{"id": "AC-001", "status": "pass|fail|blocked", "command": "…", "rc": 0, "note": "…"}]}` —
ровно 4 записи (AC-001…AC-004), команды дословно как в спеке.

## Контракт на невыполнимое

Если базовый сьют не зелёный, требование спеки противоречит существующему коду или мутанта
нельзя убить без правки вне разрешённых файлов — остановись, `report-blocked.md` с фактами.
Обходить несовместимость запрещено.

## Стык со следующей вехой

Следующая веха подключит `createJobPool` вместо Promise-цепочки, `createTurnGate` вместо
одиночного пейсера, `progress.jobRunning/touch(jobId)` и переведёт восстановление браузера
и сессии в `requestMaintenance`/`acquireExclusive`. API этой вехи — контракт для неё.
