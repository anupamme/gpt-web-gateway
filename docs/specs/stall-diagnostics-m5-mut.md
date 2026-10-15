# Независимый мутационный прогон вехи M5 (stall-диагностика)

- Репозиторий: `~/github/gpt-web-gateway`, ветка `feat/stall-diagnostics`, коммит `d58875c`.
  BASE_SHA `d58875c`. Дата 2026-10-15.
- Исполнитель: `gk`. Код вехи писал Codex, мутации делает другой исполнитель.

## Где работать

Клон `<clone-root>/stall-mut`, создай ветку `mut/stall-m5` от текущего HEAD. Живое дерево
не трогать. **`git push` в origin запрещён.** Всё запускай в Docker `node:24` под
`-u 1002:1002`, например:
`docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node <скрипт>`.
`node_modules` положен постановщиком (untracked).

## Задача и почему

Веха M5 (спека `docs/specs/stall-diagnostics-m5.md`, дифф `7d97d08..d58875c`) добавила
F1–F4 и тесты `scripts/test-stall-diagnostics.js` и `scripts/test-stall-routes.js`. Задача —
проверить, ловят ли НОВЫЕ тесты удаление или порчу НОВОГО поведения. Выживший мутант —
дыра в тестах, а не в коде.

Составь свой каталог из НЕ МЕНЕЕ 30 мутаций только по строкам, которые M5 добавила или
изменила в `src/chatgpt.js`, `src/routes/images.js`, `src/server.js`, `src/log-context.js`.
Обязательно покрой:
- каждое из четырёх условий `stallNoAnswer` и каждое из условий повтора (`anyDeltaEmitted`,
  `conversationId`, `pendingReset !== 'hard'`, бюджет);
- `attempt -= 1`, сохранение `stallRetryState` в `submitJob`, `onAttemptFinished` и `paced`
  в `runTurn`;
- `postFailure` до чтения тела, таймер 5 с, `postAccepted`, `throwBackendPostFailure`:
  429 → `rate_limit`, иначе `server_error`, плюс вызов `onSubmitted`;
- фильтр `at >= capture.startedAt`, замену id в path, ограничение буфера 30;
- `STALL_SNAPSHOTS`/`DEBUG_SNAPSHOTS`, prune и `STALL_SNAPSHOT_KEEP`;
- `'recycle'`: probation не включается, `!slot.pendingReset`, сброс счётчика в
  `discardSlotPage`, watchdog;
- ALS-префикс внутри задания и его отсутствие вне задания, пропуск `GET /` в access-логе.

Для каждой мутации:
1. Проверь, что фрагмент уникален и замена ЛЕГЛА (файл изменился).
2. Запусти оба `test-stall-*` теста.
3. Если мутант выжил, прогони на нём весь `npm test`.
4. Восстанови файл, сверь хеш с исходным.

«Убит» засчитывается только при падении на ассерте (`AssertionError` / `FAIL:`). Сбой
загрузки, синтаксиса или таймаут — это «невалидная мутация», а не «убит». Эквивалентные
мутации отмечай с обоснованием.

## Результат

Отчёт `docs/specs/stall-diagnostics-m5-mut-report.md` (закоммитить) в формате:
- шапка: HEAD, среда, сколько мутаций / убито / выжило / невалидных;
- таблица `| ID | Файл | Замена | Тест | Результат | Первая упавшая строка |`.

Вспомогательный скрипт прогона, если он нужен, положи в `scripts/mutate-stall-m5.js` и тоже
закоммить. Скрипт должен перезапускаться и возвращать дерево в исходное состояние.

## Не трогать

Всё, кроме `docs/specs/stall-diagnostics-m5-mut-report.md`, `scripts/mutate-stall-m5.js`
и этой спеки. **`src/` и существующие тесты НЕ менять**: тесты не чинить, только отчитаться.
**`git push` в origin запрещён.**

## Критерии приёмки

- **AC-001. Отчёт есть и в нём не меньше 30 мутаций.**
  `bash -c 'test "$(grep -cE "^\| M?[0-9]+" docs/specs/stall-diagnostics-m5-mut-report.md)" -ge 30'`
- **AC-002. Боевой код и тесты не тронуты, дерево чистое.**
  `bash -c 'git diff --quiet d58875c HEAD -- src scripts/test-stall-diagnostics.js scripts/test-stall-routes.js package.json && test -z "$(git status --porcelain -- . ":(exclude)report.json" ":(exclude)report-blocked.md")" && test -z "$(git diff --name-only d58875c HEAD | grep -vxE "docs/specs/stall-diagnostics-m5-mut-report.md|docs/specs/stall-diagnostics-m5-mut.md|scripts/mutate-stall-m5.js")"'`
- **AC-003. Сьют на HEAD зелёный (мутанты откачены).**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 npm test >/dev/null'`

## Что проверено вживую, а что предположение

Проверено постановщиком на `d58875c`: `npm test` rc=0, `mutate-parallel.js` и
`mutate-parallel-tabs.js` убивают все свои мутации, все имена в разделе «Задача»
(`stallNoAnswer`, `stallRetryState`, `onAttemptFinished`, `postFailure`, `postAccepted`,
`throwBackendPostFailure`, `startedAt`, `recordSlotJobFinished`, `runWithLogContext`) есть
в дифе `7d97d08..d58875c`. Предположений нет.

## Авторевью

После коммита отчёта прогони ревью Codex (только чтение):
`bash ~/.claude/skills/ask-codex/scripts/run.sh result "<контекст: клон, диапазон d58875c..HEAD, спека; проверь, что мутации легли, а «убит» засчитан на ассерте>"`.
Исправь найденное одним заходом, вердикт запиши в `note` AC-003.

## Контракт отчёта

`report.json` в корне клона, не коммитится:
`{"criteria": [{"id": "AC-001", "status": "pass|fail|blocked", "command": "…", "rc": 0, "note": "…"}]}`.
Ровно 3 записи, команды дословно как в спеке. В `note` AC-001 укажи итог: убито, выжило,
id выживших.

## Контракт на невыполнимое

Если базовый сьют не зелёный или фрагменты из дифа нельзя мутировать, не трогая
«Не трогать», остановись и запиши `report-blocked.md` с фактами.
