// A wedged renderer must not hide both the text deadline and client cancellation.
process.env.TEXT_PAGE_POLL_TIMEOUT_MS = '30';
const assert = require('assert');
const { _test: { waitAndExtractText } } = require('../src/chatgpt');

async function main() {
  let closed = false;
  const page = {
    evaluate: () => new Promise(() => {}),
    close: async () => { closed = true; },
    isClosed: () => closed,
  };
  const result = await Promise.race([
    waitAndExtractText(page, {}, { thinkingMode: 'instant' }).then(() => 'unexpected success', (e) => e),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
  ]);
  assert.notStrictEqual(result, 'hung', 'Node must enforce a deadline while page.evaluate is unresolved');
  assert.strictEqual(result.code, 'page_load_failed');
  assert.ok(closed, 'timed-out renderer must be discarded before another queued job runs');
  console.log('PASS: unresponsive DOM poll is bounded and closes its page');

  closed = false;
  const controller = new AbortController();
  const reason = Object.assign(new Error('client left'), { code: 'client_aborted' });
  const pending = waitAndExtractText({ ...page }, {}, { thinkingMode: 'instant', signal: controller.signal });
  setTimeout(() => controller.abort(reason), 5);
  await assert.rejects(pending, (e) => e === reason);
  assert.ok(closed);
  console.log('PASS: client cancellation interrupts an unresponsive DOM poll');

  let releaseClose;
  let closeStarted = false;
  let settled = false;
  const slowClosePage = {
    evaluate: () => new Promise(() => {}),
    isClosed: () => false,
    close: () => { closeStarted = true; return new Promise((resolve) => { releaseClose = resolve; }); },
  };
  const cleanup = waitAndExtractText(slowClosePage, {}, { thinkingMode: 'instant' })
    .catch((err) => { settled = true; return err; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(closeStarted);
  assert.strictEqual(settled, false, 'browser work must retain ownership until page.close actually settles');
  releaseClose();
  assert.strictEqual((await cleanup).code, 'page_load_failed');
  console.log('PASS: renderer cleanup awaits the actual page close before releasing work');

  const { abortable, withCancellationCleanup } = require('../src/request-lifecycle');
  const owner = new AbortController();
  let releaseOwnedClose;
  let ownerSettled = false;
  const owned = withCancellationCleanup(
    () => abortable(new Promise(() => {}), owner.signal), owner.signal,
    () => new Promise((resolve) => { releaseOwnedClose = resolve; }),
  ).catch((err) => { ownerSettled = true; return err; });
  owner.abort(reason);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(ownerSettled, false, 'whole text operation must await its abort cleanup');
  releaseOwnedClose();
  assert.strictEqual(await owned, reason);
  console.log('PASS: text cancellation owner awaits deferred page cleanup');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
