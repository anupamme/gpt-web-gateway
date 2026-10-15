# Веха M4: добить выживших мутантов параллельных вкладок (только тесты)

- Репозиторий: `~/github/gpt-web-gateway`, ветка `main`, коммит `8c50abd` («Release 2.15.0»).
  Дата 2026-10-15.
- Исполнитель: `cx` (решение владельца — оставшееся делает Codex).

## Где работать

Клон `<clone-root>/parallel-tests`, новая ветка `test/parallel-survivors`. Живое дерево не
трогать. **`git push` в origin запрещён** — работу заберёт постановщик через `git fetch`.
Всё — в Docker `node:24` под `-u 1002:1002`. `node_modules` положен постановщиком (untracked).

## Задача и почему

Независимый мутационный прогон по 2.15.0 (`docs/specs/parallel-tabs-m3-mut-report.md`,
коммитится вместе с работой): 45 новых мутаций, 30 убито, **15 выжило** — N02, N04, N06,
N07, N08, N09, N10, N11, N15, N19, N21, N32, N36, N37, N43 (точные замены и целевые
тесты — в отчёте). Это дыры в ТЕСТАХ: боевой код корректен и выпущен. Задача — тесты,
на которых каждый из этих мутантов падает на СВОЁМ ассерте.

Особо важны (эксплуатационно значимые):
- N43 — тип ошибки задания должен классифицироваться в `progress.jobFinished` (иначе
  счётчик инфраструктурных сбоев и liveness не видят деградацию);
- N15 — обслуживания с РАЗНЫМИ именами не сливаются (иначе `auto-login` теряется в
  `hard-reset`);
- N32 — упавшая `/login/save` не ломает последующие;
- N06/N07 — сброс страницы слота не трогает `pendingReset`/`staleStreams` другого слота;
- N09/N10 — после перестройки контекста и после неудачного авто-логина сбрасываются
  страницы всех слотов;
- N37 — `turnGate.finished` получает слот своего задания;
- N19/N21 — watchdog берёт эксклюзив без `await` между проверкой «пул пуст» и захватом,
  и `sessionProbeInFlight` — та же проба, на которую ждут задания.

Эквивалентный мутант (N11 — порядок `resetAllSlotPages`/`closeBrowser` — кандидат;
N36 — двойной `beforeSubmit`, если наблюдаемо неотличим) исключается только с письменным
обоснованием, ПОЧЕМУ поведение не меняется, в `note` AC-002 («не смог убить» —
не обоснование).

Добавь все 15 мутаций (точные замены из отчёта) в `scripts/mutate-parallel-tabs.js`.

## Что проверено вживую

- Постановщик на `8c50abd`: `npm test`, `node scripts/mutate-parallel.js`,
  `node scripts/mutate-parallel-tabs.js` в `node:24` под `-u 1002:1002` — rc=0.
- Отчёт мутаций снят на `5e9521e`; `8c50abd` отличается от него только CHANGELOG, версиями,
  CLAUDE.md и путями в `docs/specs` — `src/` и `scripts/` идентичны.

## Не трогать

Всё, кроме `scripts/test-*.js` и `scripts/mutate-parallel-tabs.js`. Боевой код `src/` НЕ
менять: если мутанта нельзя убить без правки `src/` — остановись по контракту. **Эту
спеку и `docs/specs/parallel-tabs-m3-mut-report.md` закоммить вместе с работой.**
**`git push` в origin запрещён.**

## Критерии приёмки

- **AC-001. Полный сьют зелёный.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 npm test'`
- **AC-002. Обвязка убивает все мутации, включая 15 выживших (или эквивалентные исключены с обоснованием).**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node scripts/mutate-parallel-tabs.js'`
- **AC-003. В обвязке есть все id выживших.**
  `bash -c 'for id in N02 N04 N06 N07 N08 N09 N10 N11 N15 N19 N21 N32 N36 N37 N43; do grep -q "$id" scripts/mutate-parallel-tabs.js || exit 1; done'`
- **AC-004. Только тесты, боевой код не тронут, дерево чистое.**
  `bash -c 'git diff --quiet 8c50abd HEAD -- src package.json package-lock.json && test -z "$(git status --porcelain -- . ":(exclude)report.json" ":(exclude)report-blocked.md")" && test -z "$(git diff --name-only 8c50abd HEAD | grep -vxE "scripts/test-[a-z0-9-]+\.js|scripts/mutate-parallel-tabs.js|docs/specs/parallel-tabs-m4-tests.md|docs/specs/parallel-tabs-m3-mut-report.md")"'`

## Авторевью

После коммита работы прогони ревью Grok (только чтение; сам себя Codex не ревьюит):
`bash ~/.claude/skills/ask-grok/scripts/run.sh result "<контекст: клон, диапазон 8c50abd..HEAD, спека>"`.
Исправь найденное ОДНИМ заходом; вердикт — в `note` AC-001.

## Контракт отчёта

`report.json` в корне клона, untracked:
`{"criteria": [{"id": "AC-001", "status": "pass|fail|blocked", "command": "…", "rc": 0, "note": "…"}]}` —
ровно 4 записи (AC-001…AC-004), команды дословно как в спеке.

## Контракт на невыполнимое

Мутанта не убить без правки `src/`, существующий тест можно сохранить только ослабив, или
базовый сьют не зелёный — остановись, `report-blocked.md` с фактами.
