# Веха M5b: исправления по ревью вехи M5

- Репозиторий: `~/github/gpt-web-gateway`, ветка `feat/stall-diagnostics`, коммит `d58875c`
  (результат вехи M5, спека `docs/specs/stall-diagnostics-m5.md`).
  BASE_SHA `d58875c`. Дата 2026-10-15.
- Исполнитель: `cx`.

## Где работать

Клон `<clone-root>/stall-fix`, ветка `fix/stall-review`. Ветка уже создана и активна.
Живое дерево не трогать. **`git push` в origin запрещён.** Всё запускать в Docker
`node:24` под `-u 1002:1002`. `node_modules` положен постановщиком (untracked).

## Задача и почему

Ревью результата M5 нашло пять дефектов. Постановщик перепроверил каждый по коду, все
настоящие. D1–D4 — дефекты кода, D5 — дыра только в тесте.

- Тесты на D1–D4 положи в НОВЫЙ файл `scripts/test-stall-review.js` и подключи его к
  `npm test`. Этот файл обязан падать на коде `d58875c` и проходить после исправления.
- D5 — доработка теста в `scripts/test-stall-diagnostics.js`. Код на `d58875c` уже
  корректен, поэтому падения на базе от этого теста НЕ требуется. Он обязан убивать
  мутацию из AC-005.

### D1. Тройная отправка: принятый POST не считается отправкой

`typeAndSubmit` в цикле подтверждения (около `src/chatgpt.js:2700`) смотрит только на DOM.
Если POST разговора вернул 2xx (`capture.postAccepted`), а DOM за 12 с отправку не
подтвердил, функция бросает `page_load_failed` с `submitted = false`, и `completeText`
повторяет ход как неотправленный. Ревьюер воспроизвёл три отправки при
`TEXT_STALL_RETRIES=1`.

Исправление: `capture.postAccepted` в цикле подтверждения и после него = отправка
состоялась. Вызвать `onSubmitted`, «Prompt submitted (confirmed)» залогировать как
подтверждённое по backend и продолжить ожидание ответа так же, как при DOM-подтверждении.

Тест: POST 2xx без DOM-подтверждения → ровно одна отправка, ход не повторяется до
отправки. Во всём задании при `TEXT_STALL_RETRIES=1` максимум две отправки.

### D2. Снапшот без ограничения времени

`saveDebugSnapshot` ждёт `p.screenshot()` и `p.content()` без дедлайна. Зависшая страница
блокирует rescue и stall-abort и держит слот. Нужно обернуть оба вызова в
`raceDeadline(…, <не больше 10 с>)` (функция уже есть в `src/chatgpt.js`), а по истечении
дедлайна идти дальше без этой части снимка.

Тест: `content()`, который никогда не резолвится, не задерживает stall-abort дольше
дедлайна.

### D3. Поздний ответ заменённой страницы попадает в чужой capture

`setupBackendReadHooks` вешает `p.on('response', r => onBackendResponse(slot, r))` с
замыканием на СЛОТ. После `discardSlotPage` старая страница может ещё закрываться, и её
поздний ответ (например, 429) попадёт в `activeCapture(slot)` нового задания. Тогда новое
задание завершится ошибкой и включится общий cooldown.

Исправление: `onBackendResponse` принимает и страницу, от которой пришёл ответ, и
игнорирует ответ, если эта страница не `slot.page`. Это касается записи в
`postStatus`/`postFailure`/`postAccepted`, `merge` SSE и GET-лога. Буфер
`backendResponses` может хранить запись и от старой страницы, но без привязки к capture.

Тест: ответ 429 от страницы, которая больше не `slot.page`, не меняет capture текущего
хода и не бросает ошибку.

### D4. Гонка ротации снапшотов

`pruneStallSnapshots` считает и незавершённые пары. При параллельном сохранении и
`STALL_SNAPSHOT_KEEP=1` ревьюер воспроизвёл удаление новой полной пары: остался только HTML
старого снимка. Исправление: сериализовать сохранение stall-снапшотов вместе с ротацией
(одна очередь-промис на модуль), чтобы ротация никогда не шла, пока другой снимок
дописывается. При ошибке одного сохранения очередь не должна ломаться.

Тест: два одновременных stall-снапшота при `STALL_SNAPSHOT_KEEP=1` дают ровно одну полную
пару, и это пара более нового снимка.

### D5. Дыра в тесте изоляции capture (только тест)

Тест около `scripts/test-stall-diagnostics.js:162` не дожидается тела после смены хода.
Поэтому мутация, которая пишет `snippet` в текущий `activeCapture(slot)` вместо снимка
capture, взятого до await, проходит оба файла тестов. Доработай тест: тело ответа хода A
завершается ПОСЛЕ того, как открыт capture хода B. Проверь, что snippet попал в capture A,
а capture B остался чистым (`postFailure` отсутствует). Присваивание
`failure.snippet = …` в `onBackendResponse` должно остаться одной строкой, начинающейся с
`if (body !== null) failure.snippet = `, а `slot` и `activeCapture` — оставаться в её области
видимости: на этот текст опирается мутация AC-005.

## Что проверено вживую, а что предположение

Проверено постановщиком на `d58875c`: функции `typeAndSubmit`, `throwBackendPostFailure`,
`saveDebugSnapshot`, `pruneStallSnapshots`, `onBackendResponse`, `setupBackendReadHooks`,
`raceDeadline` и поля `postAccepted`/`postFailure` существуют; `npm test` rc=0.
Воспроизведение D1 и D4 сделал ревьюер (Codex), постановщик проверил его логику чтением
кода. Предположений нет.

## Не трогать

Ничего, кроме `src/chatgpt.js`, `src/routes/images.js`, `scripts/test-stall-*.js`,
`package.json` (только скрипт `test`), `CHANGELOG.md` (дописать пункт в `## Unreleased`)
и этой спеки. Инварианты параллельных вкладок (CLAUDE.md) не нарушать. Мутации
`scripts/mutate-parallel*.js` должны по-прежнему убиваться.
**Эту спеку закоммитить вместе с работой. `git push` в origin запрещён.**

## Критерии приёмки

- **AC-001. Полный сьют зелёный.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 npm test'`
- **AC-002. Мутации прошлых вех по-прежнему убиваются.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 sh -c "node scripts/mutate-parallel.js && node scripts/mutate-parallel-tabs.js"'`
- **AC-003. Тест D1–D4 падает на d58875c.** `scripts/test-stall-review.js` с HEAD
  накладывается на код `d58875c` и должен упасть.
  `bash -c 'set -e; test -f scripts/test-stall-review.js; t=$(mktemp -d); git worktree add -q "$t" d58875c; cp scripts/test-stall-review.js "$t/scripts/"; ln -s "$PWD/node_modules" "$t/node_modules"; rc=0; docker run --rm -u 1002:1002 -e HOME=/tmp -v "$t":/app -w /app node:24 node scripts/test-stall-review.js >/dev/null 2>&1 || rc=$?; git worktree remove --force "$t"; test $rc -ne 0'`
- **AC-005. Мутация D5 (утечка snippet в чужой capture) убивается тестом.**
  `bash -c 'set -e; f=src/chatgpt.js; cp $f /tmp/m5b-orig.js; trap "cp /tmp/m5b-orig.js $f" EXIT; perl -0pi -e "s/if \(body !== null\) failure\.snippet = (.*?);\n/if (body !== null) { failure.snippet = \$1; const leak = activeCapture(slot); if (leak) leak.postFailure = failure; }\n/" $f; ! cmp -s $f /tmp/m5b-orig.js; rc=0; docker run --rm -u 1002:1002 -e HOME=/tmp -v "$PWD":/app -w /app node:24 node scripts/test-stall-diagnostics.js >/dev/null 2>&1 || rc=$?; test $rc -ne 0'`
- **AC-004. Изменения только в разрешённых путях, дерево чистое.**
  `bash -c 'test -z "$(git status --porcelain -- . ":(exclude)report.json" ":(exclude)report-blocked.md")" && test -z "$(git diff --name-only d58875c HEAD | grep -vxE "src/chatgpt.js|src/routes/images.js|scripts/test-stall-[a-z0-9-]+\.js|package.json|CHANGELOG.md|docs/specs/stall-diagnostics-m5b.md")" && test -z "$(git diff d58875c HEAD -- package.json | grep -E "^[-+][^-+]" | grep -v "\"test\":")"'`

## Авторевью

Ревью Grok в прошлой вехе дважды упало по таймауту, поэтому авторевью здесь НЕ требуется.
Ревью проведёт постановщик. В `note` AC-001 перечисли, как закрыт каждый из D1–D5.

## Контракт отчёта

`report.json` в корне клона, не коммитится:
`{"criteria": [{"id": "AC-001", "status": "pass|fail|blocked", "command": "…", "rc": 0, "note": "…"}]}`.
Ровно 5 записей (AC-001…AC-005), команды дословно как в спеке.

## Контракт на невыполнимое

Остановись и запиши `report-blocked.md` с фактами, если:
- дефект нельзя исправить в разрешённых путях;
- исправление требует нарушить инварианты параллельных вкладок;
- тест на D1–D4 нельзя сделать падающим на `d58875c` или тест D5 не убивает мутацию AC-005.

Обходить запрещено.
