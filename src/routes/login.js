const { Router } = require('express');
const { getContext, saveSession, maybeHideWebdriverOnPage } = require('../browser');
const { resetAllSlotPages, getPoolHooks } = require('../chatgpt');
const { progress } = require('../progress');

const router = Router();

let loginPage = null;

// One manual-login capture for every /login/* caller. Parallel requests wait
// on the same acquireExclusive promise and share its release. /login/save and
// ten minutes without a /login/* call drop it. The timer re-arms on each call.
const LOGIN_IDLE_MS = 10 * 60 * 1000;
let loginHold = null;

function releaseLoginHold() {
  const attempt = loginHold;
  if (!attempt) return;
  loginHold = null;
  if (attempt.timer) clearTimeout(attempt.timer);
  if (typeof attempt.release === 'function') {
    try {
      attempt.release();
    } catch (err) {
      console.log(`[login] release failed: ${err && err.message ? err.message : err}`);
    }
  }
}

function armLoginIdle() {
  if (!loginHold) return;
  if (loginHold.timer) clearTimeout(loginHold.timer);
  loginHold.timer = setTimeout(() => {
    console.log('[login] idle 10min — releasing manual-login hold');
    releaseLoginHold();
  }, LOGIN_IDLE_MS);
  if (typeof loginHold.timer.unref === 'function') loginHold.timer.unref();
}

async function enterManualLogin() {
  progress.touch();
  if (loginHold) {
    armLoginIdle();
    await loginHold.acquired;
    return;
  }
  const hooks = getPoolHooks();
  if (!hooks || typeof hooks.acquireExclusive !== 'function') {
    const err = new Error('pool hooks not set');
    err.code = 'server_error';
    throw err;
  }
  const acquired = hooks.acquireExclusive('manual-login');
  const attempt = { acquired, release: null, timer: null };
  loginHold = attempt;
  armLoginIdle();
  try {
    const release = await acquired;
    if (loginHold !== attempt) {
      if (typeof release === 'function') release();
      return;
    }
    attempt.release = release;
  } catch (err) {
    if (loginHold === attempt) {
      if (attempt.timer) clearTimeout(attempt.timer);
      loginHold = null;
    }
    throw err;
  }
}

async function getLoginPage() {
  if (loginPage && !loginPage.isClosed()) return loginPage;
  const ctx = await getContext();
  loginPage = await ctx.newPage();
  await maybeHideWebdriverOnPage(loginPage);
  await loginPage.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return loginPage;
}

// Remote login page
router.get('/login', async (req, res) => {
  try {
    await enterManualLogin();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Remote Login - ChatGPT</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #eee; font-family: sans-serif; }
  .toolbar { padding: 10px; display: flex; gap: 10px; align-items: center; background: #16213e; }
  .toolbar button { padding: 8px 16px; background: #a78bfa; color: #000; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
  .toolbar button:hover { background: #8b5cf6; }
  .toolbar .status { margin-left: auto; font-size: 14px; color: #aaa; }
  #screen { cursor: crosshair; display: block; max-width: 100%; border: 1px solid #333; }
  .input-row { padding: 10px; background: #16213e; display: flex; gap: 10px; }
  .input-row input { flex: 1; padding: 8px 12px; background: #1a1a2e; border: 1px solid #333; border-radius: 6px; color: #eee; font-size: 14px; }
</style>
</head><body>
<div class="toolbar">
  <button onclick="refresh()">Refresh</button>
  <button onclick="navigate('https://chatgpt.com')">ChatGPT</button>
  <button onclick="saveSession()">Save Session</button>
  <span class="status" id="status">Click on the screenshot to interact</span>
</div>
<div class="input-row">
  <input type="text" id="type-input" placeholder="Type text and press Enter to input into focused field..." />
</div>
<img id="screen" src="/login/screenshot" onclick="handleClick(event)" />
<script>
  const screen = document.getElementById('screen');
  const status = document.getElementById('status');
  const typeInput = document.getElementById('type-input');
  let refreshTimer = null;

  function refresh() {
    screen.src = '/login/screenshot?' + Date.now();
    status.textContent = 'Refreshed';
  }

  function autoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 3000);
  }

  async function handleClick(e) {
    const rect = screen.getBoundingClientRect();
    const scaleX = 1280 / rect.width;
    const scaleY = 800 / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    status.textContent = 'Clicking ' + x + ',' + y + '...';
    await fetch('/login/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y })
    });
    setTimeout(refresh, 500);
  }

  typeInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const text = typeInput.value;
      if (!text) return;
      status.textContent = 'Typing...';
      await fetch('/login/type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      typeInput.value = '';
      setTimeout(refresh, 500);
    }
  });

  async function navigate(url) {
    status.textContent = 'Navigating...';
    await fetch('/login/navigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    setTimeout(refresh, 2000);
  }

  async function saveSession() {
    status.textContent = 'Saving session...';
    const res = await fetch('/login/save', { method: 'POST' });
    const data = await res.json();
    status.textContent = data.message || 'Session saved!';
  }

  autoRefresh();
</script>
</body></html>`);
});

// Screenshot
router.get('/login/screenshot', async (req, res) => {
  try {
    await enterManualLogin();
    const p = await getLoginPage();
    const buffer = await p.screenshot({ type: 'jpeg', quality: 80 });
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Click
router.post('/login/click', async (req, res) => {
  try {
    await enterManualLogin();
    const { x, y } = req.body;
    const p = await getLoginPage();
    await p.mouse.click(x, y);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Type text
router.post('/login/type', async (req, res) => {
  try {
    await enterManualLogin();
    const { text } = req.body;
    const p = await getLoginPage();
    await p.keyboard.type(text, { delay: 30 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Press key
router.post('/login/key', async (req, res) => {
  try {
    await enterManualLogin();
    const { key } = req.body;
    const p = await getLoginPage();
    await p.keyboard.press(key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Navigate. The request body is deliberately IGNORED: the login flow only ever
// needs the ChatGPT landing page, and honoring a caller-supplied URL would let
// the API drive the authenticated browser to arbitrary hosts (SSRF / cookie
// exposure primitive) — an allowlist would still be bypassable via HTTP
// redirects, which page.goto() follows. In-page auth/SSO redirects after this
// initial load are unaffected.
const LOGIN_NAV_URL = 'https://chatgpt.com';

router.post('/login/navigate', async (req, res) => {
  try {
    await enterManualLogin();
    const p = await getLoginPage();
    await p.goto(LOGIN_NAV_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    res.json({ ok: true, url: LOGIN_NAV_URL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save session
router.post('/login/save', async (req, res) => {
  try {
    await enterManualLogin();
    await saveSession();
    // Close login page
    if (loginPage && !loginPage.isClosed()) {
      await loginPage.close();
      loginPage = null;
    }
    // Session changed: no tab may keep a document from before the login.
    resetAllSlotPages();
    releaseLoginHold();
    res.json({ message: 'Session saved! Main page reset. You can now use the API.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
