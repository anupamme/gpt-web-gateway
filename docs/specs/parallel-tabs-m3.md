# Веха M3: исправления параллельных вкладок по ревью и мутациям M2

- Репозиторий: `~/github/gpt-web-gateway`, ветка `feat/parallel-tabs`, коммит `f570ca2`
  («Fix slot recovery and queue pacing»). Дата 2026-10-15.
- Исполнитель: `cx` — решение владельца: доделать Codex (Grok остановлен до первых правок).
- Третья веха «3 параллельные вкладки». Дефекты ниже найдены независимым ревью Codex и
  независимым мутационным прогоном Codex (36 мутаций, 18 выжило —
  `docs/specs/parallel-tabs-m2-mut-report.md`, коммитится вместе с работой).

## Где работать

Клон `/home/deploy/exec-clones/parallel-tabs-fix`, новая ветка `fix/parallel-tabs`. Живое
дерево не трогать. **`git push` в origin запрещён** — работу заберёт постановщик через
`git fetch`. Всё — в Docker `node:24` под `-u 1002:1002`. `node_modules` положен
постановщиком (untracked). Браузер и ChatGPT не запускаются.

## Задача и почему

Выпуск 2.15.0 заблокирован: семь дефектов в коде и тесты, которые не ловят нарушение
изоляции вкладок. Каждое исправление — с тестом, падающим на коде `f570ca2`.

### Дефекты кода (все подтверждены постановщиком чтением кода)

D1. **`/login/screenshot` после `/login/save` снова захватывает эксклюзив** (`src/routes/login.js`,
    `enterManualLogin` в каждом маршруте). Страница `/login` опрашивает скриншот каждые 3 с,
    и после сохранения пул снова блокируется, пока вкладка открыта. Исправить: эксклюзив
    берут только `GET /login` и действия (`click`/`type`/`key`/`navigate`/`save`);
    `/login/screenshot` без активного захвата НЕ захватывает и не создаёт login-страницу —
    отвечает 409 `{"error":"login session is not active — open /login"}`; при активном
    захвате — как сейчас и продлевает таймер простоя.
D2. **Таймер простоя срабатывает до получения эксклюзива** (`armLoginIdle` вызывается до
    `await acquired`): ожидающий `/login/save` после 10 мин ожидания продолжает БЕЗ захвата,
    и `resetAllSlotPages()` закрывает страницы работающих заданий. Исправить: таймер простоя
    взводится только после того, как захват получен; ожидающий захвата вызов никогда не
    продолжает без захвата (ошибка — 503 `{"error": ...}`, страницы не трогаются).
D3. **Маркер обслуживания на картинке i>0 перезапускает весь батч** (`src/routes/images.js`,
    `catch (turnErr)` пробрасывает `retryAfterMaintenance` при любом `i`). Повтор батча
    заново генерирует готовые картинки и теряет их результаты. Исправить: пробрасывать маркер
    только если в этом задании ещё НЕ получено ни одной картинки (`out` пуст и это первая
    картинка); иначе — обычная ошибка хода (`partial`), обслуживание уже запрошено.
D4. **Диагностированные ошибки `autoLogin()` минуют cooldown и счётчик**
    (`src/chatgpt.js`, `autoLoginMaintenance`, первая строка `catch`: `if (e.code ===
    'login_failed' && e.loginBlocker) throw e;`). `src/auto-login.js` бросает именно такие
    ошибки (стр. ~107-119), поэтому `loginThrottle.recordFailure`, `recordLoginFailure` и
    `sessionHealth.invalidate` для них не вызываются — следующие задания снова запускают
    логин без cooldown. Исправить: без повторной записи пробрасывать только ошибку, уже
    учтённую внутри этого же `try` (пост-проверка) — пометить её явно (например
    `e.loginRecorded = true`) и проверять флаг; всё остальное — учёт как в 2.14.10 (обёртка
    `auto-login failed: …`, `loginBlocker`/`loginStep`/`modelMessage`, `cause`).
D5. **Между картинками батча `progress.touch()` без jobId** (`src/routes/images.js` ~599):
    per-job метка не обновляется, длинный батч при `MIN_JOB_GAP_SEC=0` проваливает liveness.
    Исправить: `progress.touch(ctx.jobId)`.
D6. **Watchdog без эксклюзива** (`checkSessionOnce`): проверка «пул пуст» и проба разделены
    `await`, параллельный `/login/save` или задание может закрыть/использовать страницу.
    Исправить: при наличии `poolHooks.acquireExclusive` watchdog берёт
    `acquireExclusive('watchdog')` только если пул пуст в момент вызова (иначе skip
    `queue_busy`), выполняет пробу и в `finally` отпускает. Пропуск по `recent_traffic`,
    `reset_pending`, `probe_in_flight`, `no_page` — до захвата, как сейчас.

D7. **Таймаут аренды пробы watchdog закрывает страницу не того слота** (`_ensureLoggedIn`,
    ветка `lease === PROBE_DEADLINE`: `markSessionDegraded(..., slot)` и
    `closeWedgedPage(slot.page)` для слота задания). Watchdog пробует страницу слота 0 —
    закрывать и помечать надо её (страницу, которую держит проба), а страницу своего слота
    не трогать. (Найдено agy.)

### Дыры в тестах (выжившие мутанты отчёта)

T1. **Изоляция слотов не проверяется по-настоящему** (I01, I02, I04, I14): тесты обязаны
    использовать ДВА ПРИВЯЗАННЫХ слота (`bindPage(getSlot(0), pA)`, `bindPage(getSlot(1), pB)`)
    и проверять, что чанк/ответ беседы/сброс/probation слота 0 не меняет состояние слота 1 и
    наоборот (ассерты на ОБА слота).
T2. Убить остальные выжившие мутанты отчёта: I06, I08, I09, I10, I11, I15, I16, I17, I20,
    I21, I24, I27, I28, I34 (точные замены — в отчёте). Для каждого — тест, падающий на
    СВОЁМ ассерте. Эквивалентный мутант исключается только с письменным обоснованием в
    `note` AC-002 (не «не смог убить»).
T3. Добавить все 18 выживших (с поправкой на изменённый код) и мутации на D1–D7 в
    `scripts/mutate-parallel-tabs.js`, чтобы они проверялись постоянно.

## Что проверено вживую (постановщиком, на f570ca2)

- `npm test`, `node scripts/mutate-parallel.js`, `node scripts/mutate-parallel-tabs.js` в
  `node:24` под `-u 1002:1002` — rc=0 (машинная приёмка M2).
- `src/routes/login.js`: `enterManualLogin()` вызывается в `GET /login`, `/login/screenshot`,
  `/click`, `/type`, `/key`, `/navigate` и в `saveManualLogin`; `armLoginIdle()` стоит до
  `await acquired`; `getLoginPage()` создаёт вкладку `ctx.newPage()` и идёт на chatgpt.com.
- `src/routes/images.js`: в батче `if (turnErr && turnErr.retryAfterMaintenance) throw turnErr;`
  без проверки `i`/`out`; `progress.touch(); // per-image heartbeat` без jobId; `submitJob`
  вызывает `progress.jobRequeued(ctx.jobId)` при первом маркере.
- `src/chatgpt.js`: `autoLoginMaintenance` — `catch` начинается с
  `if (e && e.code === 'login_failed' && e.loginBlocker) throw e;`; `checkSessionOnce`
  проверяет `poolIsIdle()` и пробует `getSlot(0).page` без захвата.
- `src/auto-login.js` ~107-119: ошибки шагов получают `code = 'login_failed'` и `loginBlocker`.

## Не трогать

Всё, кроме `src/chatgpt.js`, `src/routes/images.js`, `src/routes/login.js`,
`scripts/test-*.js`, `scripts/mutate-parallel-tabs.js`. **Эту спеку и
`docs/specs/parallel-tabs-m2-mut-report.md` закоммить вместе с работой.** CHANGELOG, README,
helm, `package.json`, `src/job-pool.js`, `src/pacer.js`, `src/progress.js` не трогать.
**`git push` в origin запрещён.**

## Критерии приёмки

- **AC-001. Полный сьют зелёный.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 npm test'`
- **AC-002. Обвязка вехи убивает все мутации, включая 18 выживших и D1–D7.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node scripts/mutate-parallel-tabs.js'`
- **AC-003. Обвязка M1 по-прежнему зелёная.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node scripts/mutate-parallel.js'`
- **AC-004. В обвязке есть мутации на все выжившие id.**
  `bash -c 'for id in I01 I02 I04 I06 I08 I09 I10 I11 I14 I15 I16 I17 I20 I21 I24 I27 I28 I34; do grep -q "$id" scripts/mutate-parallel-tabs.js || exit 1; done'`
- **AC-005. Состав и чистота.**
  `bash -c 'test -z "$(git status --porcelain -- . ":(exclude)report.json" ":(exclude)report-blocked.md")" && test -z "$(git diff --name-only f570ca2 HEAD | grep -vxE "src/chatgpt.js|src/routes/images.js|src/routes/login.js|scripts/test-[a-z0-9-]+\.js|scripts/mutate-parallel-tabs.js|docs/specs/parallel-tabs-m3.md|docs/specs/parallel-tabs-m2-mut-report.md")"'`

## Авторевью

После коммита работы прогони ревью Grok (только чтение; сам себя Codex не ревьюит):
`bash ~/.claude/skills/ask-grok/scripts/run.sh result "<контекст: клон, диапазон f570ca2..HEAD, спека>"`.
Исправь найденное ОДНИМ заходом; вердикт и что исправлено — в `note` AC-001.

## Контракт отчёта

`report.json` в корне клона, untracked:
`{"criteria": [{"id": "AC-001", "status": "pass|fail|blocked", "command": "…", "rc": 0, "note": "…"}]}` —
ровно 5 записей (AC-001…AC-005), команды дословно как в спеке.

## Контракт на невыполнимое

Если исправление требует правки вне разрешённых файлов, мутанта нельзя убить без
ослабления существующего теста, или базовый сьют не зелёный — остановись,
`report-blocked.md` с фактами. Обходить несовместимость запрещено.

## Стык

После приёмки постановщик выпускает 2.15.0 и проверяет на проде.
