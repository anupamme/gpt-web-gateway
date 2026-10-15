const MAX_REQUEST_TIMEOUT_MS = 1020 * 1000;

function requestError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function bindRequest(req, res) {
  const raw = req.get('X-Request-Timeout-Ms');
  if (raw !== undefined && (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))) {
    throw requestError('invalid_request', 'X-Request-Timeout-Ms must be a positive integer');
  }
  const timeoutMs = Math.min(raw === undefined ? MAX_REQUEST_TIMEOUT_MS : Number(raw), MAX_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort(requestError('client_aborted', 'Client disconnected; request cancelled'));
  };
  res.once('close', onClose);
  const timer = setTimeout(() => controller.abort(requestError('request_timeout', 'Request deadline exceeded')), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); res.removeListener('close', onClose); },
  };
}

// Unlike Promise.race at the queue boundary, this is safe for an individual read:
// the caller owns the page and closes it before releasing the browser queue.
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  let listener;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      listener = () => reject(signal.reason);
      signal.addEventListener('abort', listener, { once: true });
    }),
  ]).finally(() => signal.removeEventListener('abort', listener));
}

async function withCancellationCleanup(operation, signal, cancel) {
  signal?.throwIfAborted();
  let cleanup;
  const onAbort = () => {
    cleanup = Promise.resolve(cancel());
    // A listener cannot return a handled promise to EventTarget. Await it below.
    cleanup.catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try { return await operation(); }
  finally {
    signal?.removeEventListener('abort', onAbort);
    await cleanup;
  }
}

module.exports = { bindRequest, requestError, abortable, withCancellationCleanup, MAX_REQUEST_TIMEOUT_MS };
