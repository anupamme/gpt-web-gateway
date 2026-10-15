# Text request cancellation — 2026-10-15

An HTTP client could disconnect while waiting for a text answer, but its job
remained in the Promise queue. Pending jobs still submitted prompts and running
jobs held the shared browser until the model or stall timeout. Repeated stalled
jobs reached the infrastructure failure streak and triggered liveness restarts.
Separately, an unresolved browser evaluate could prevent Node from reaching the
existing text and stall deadline checks at all.

Text endpoints now bind work to response connection lifetime and an optional
`X-Request-Timeout-Ms` header. It must be a positive safe integer; missing or
larger values use the 1,020,000 ms maximum. The clock starts at queue acceptance,
so expired or disconnected pending requests never submit a prompt. Expiration
returns HTTP 504, `error_kind: request_timeout`, `should_retry: true`.

Running cancellation closes the gateway's text page, stops pre-submit retries,
and prevents a later prompt submission. The response can finish at the deadline
while cleanup still owns the browser queue slot. The next job starts only after
the previous operation unwinds; there is no race that releases a live browser
operation into the next job. Session initialization already in progress may
finish its bounded recovery before yielding that slot. Neither client abort nor
caller-chosen deadline resets or increases the infrastructure failure streak.
The actual page close is awaited, including delayed close completion. If close
fails while the page is still open, the slot stays owned and the existing stuck
liveness guard remains the final recovery; it is unsafe to start overlapping
browser work in that state.

Individual text DOM reads and backend-reader priming have a Node-side deadline
of `TEXT_PAGE_POLL_TIMEOUT_MS` (default 10 seconds). Failure discards that page
and reports `page_load_failed`. The existing completion, adaptive extension and
reasoning stall budgets remain in effect for a responsive page. Image generation
and image batch lifetime are unchanged by this text-specific contract.

The shell text client accepts `CHATGPT_WEB_TIMEOUT_SECONDS`, a positive integer
from 1 to 86400 (default 1020), for curl and the header. The server still caps the
header at 1020 seconds. Authentication goes through curl's stdin configuration.
`--json` preserves structured API errors, including retry policy and delay;
HTTP 503 maps to exit 4 only for explicit `login_failed`, and otherwise exit 1.

Verification: real local HTTP tests cover disconnect while pending and running,
expiration in the queue and during processing, invalid headers, and exclusive
browser ownership during delayed cleanup. A deliberately unresolved page read
proves the Node deadline and cancellation close its page. Local wrapper HTTP
tests cover timeout propagation and structured 422/429/503/504 errors. Commands:

```sh
npm test
TMPDIR=/var/tmp python3 scripts/test-chat-wrapper.py
```

The local HTTP and page fixtures make no ChatGPT requests. Production checks
and any observation window are recorded separately from these deterministic
regressions; unit tests alone do not establish upstream service availability.
