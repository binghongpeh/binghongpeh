// imethai.com automated ticket booking
// Supports: Cloudflare bypass (CapSolver), Standing (qty) + Seating (seats), multiple zones
//
// Setup:
//   1) cp config.example.json config.json  — fill in credentials, zones, capsolver key
//   2) npm install && npm run install:browsers
//   3) npm run book:headed    ← always start here so you can see what's happening
//      npm run book           ← headless once confirmed working
//
// Zone keywords: put your preferred zones in order, e.g. ["A", "B1", "B2", "M3"]
// The script tries each in order and stops at the first available one.
// Standing zones → auto-detects quantity input and sets ticketCount.
// Seating zones  → clicks individual available seat cells.

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { chromium } = require('playwright');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json – copy config.example.json and fill it in.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const HEADED      = process.env.HEADED === '1';
const NAV_TIMEOUT = cfg.timing?.navTimeoutMs    ?? 30000;
const POLL_MS     = cfg.timing?.pollIntervalMs  ?? 500;

const log  = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const wait = ms    => new Promise(r => setTimeout(r, ms));

// ─── CapSolver (Cloudflare Turnstile / hCaptcha) ────────────────────────────

function capsolverPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname: 'api.capsolver.com',
      path:     `/${endpoint}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('CapSolver bad JSON: ' + raw)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function capsolverSolve(taskPayload, timeoutMs = 120000) {
  const apiKey = cfg.capsolver?.apiKey;
  if (!apiKey) throw new Error('capsolver.apiKey not set in config.json');

  const created = await capsolverPost('createTask', { clientKey: apiKey, task: taskPayload });
  if (created.errorId) throw new Error(`CapSolver createTask error: ${created.errorDescription}`);

  const taskId  = created.taskId;
  const start   = Date.now();
  while (Date.now() - start < timeoutMs) {
    await wait(POLL_MS);
    const result = await capsolverPost('getTaskResult', { clientKey: apiKey, taskId });
    if (result.status === 'ready') return result.solution;
    if (result.errorId)            throw new Error(`CapSolver error: ${result.errorDescription}`);
  }
  throw new Error('CapSolver timed out');
}

// Detects and solves Cloudflare Turnstile on the current page.
async function bypassCloudflare(page) {
  const cfFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
  const hasCF   = await cfFrame.locator('body').count().catch(() => 0);
  if (!hasCF) return;

  log('Cloudflare Turnstile detected – asking CapSolver...');

  // Extract sitekey from page source
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    if (el) return el.dataset.sitekey;
    const m = document.documentElement.innerHTML.match(/sitekey["\s:=]+["']([^"']{20,})/i);
    return m ? m[1] : null;
  });
  if (!siteKey) throw new Error('Cloudflare sitekey not found in page');

  log('Sitekey:', siteKey);
  const solution = await capsolverSolve({
    type:    'AntiTurnstileTaskProxyLess',
    websiteURL: page.url(),
    websiteKey: siteKey
  });

  // Inject the token into the hidden field Cloudflare reads
  await page.evaluate(token => {
    let el = document.querySelector('[name="cf-turnstile-response"]');
    if (!el) { el = document.createElement('input'); el.name = 'cf-turnstile-response'; document.body.appendChild(el); }
    el.value = token;
    // Also try the callback if available
    if (typeof turnstile !== 'undefined') turnstile.getResponse = () => token;
  }, solution.token);

  log('Cloudflare token injected.');
  await page.waitForTimeout(500);
}

// Detects and solves hCaptcha on the current page.
async function bypassHcaptcha(page) {
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('.h-captcha,[data-hcaptcha-widget-id]');
    return el?.dataset?.sitekey ?? null;
  });
  if (!siteKey) return;

  log('hCaptcha detected – asking CapSolver...');
  const solution = await capsolverSolve({
    type:       'HCaptchaTaskProxyLess',
    websiteURL: page.url(),
    websiteKey: siteKey
  });
  await page.evaluate(token => {
    document.querySelector('[name="h-captcha-response"]').value = token;
  }, solution.gRecaptchaResponse);
  log('hCaptcha token injected.');
}

// Master captcha handler – called before any form submit.
async function solveCaptchas(page) {
  await bypassCloudflare(page).catch(e => log('CF bypass skipped:', e.message));
  await bypassHcaptcha(page).catch(e => log('hCaptcha bypass skipped:', e.message));
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() && await loc.isVisible()) return loc;
    } catch { /* next */ }
  }
  return null;
}

async function waitUntilOpen(iso, leadMs = 1500) {
  if (!iso) return;
  const gap = new Date(iso).getTime() - leadMs - Date.now();
  if (gap > 0) {
    log(`Sleeping ${(gap / 1000).toFixed(1)}s until just before ticket open...`);
    await wait(gap);
  }
}

// ─── step 1: login ───────────────────────────────────────────────────────────

async function login(page) {
  log('Opening login page:', cfg.siteUrl);
  await page.goto(cfg.siteUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await solveCaptchas(page);

  const userField = await firstVisible(page, [
    'input[name="username"]', 'input[name="user_login"]', 'input[name="user"]',
    'input[name="email"]',    'input[id="username"]',     'input[id="user_login"]',
    'input[type="email"]',    'input[placeholder*="user" i]', 'input[placeholder*="email" i]'
  ]);
  const passField = await firstVisible(page, [
    'input[name="password"]', 'input[name="user_pass"]', 'input[name="pass"]',
    'input[id="password"]',   'input[id="user_pass"]',   'input[type="password"]'
  ]);

  if (!userField || !passField) {
    await page.screenshot({ path: 'debug-login.png', fullPage: true });
    throw new Error('Login fields not found – see debug-login.png');
  }

  await userField.fill(cfg.credentials.username);
  await passField.fill(cfg.credentials.password);
  await solveCaptchas(page);

  const submitBtn = await firstVisible(page, [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Login")',       'button:has-text("Sign in")',
    'button:has-text("เข้าสู่ระบบ")', 'a:has-text("เข้าสู่ระบบ")'
  ]);
  if (!submitBtn) throw new Error('Login submit button not found');

  log('Submitting login...');
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    submitBtn.click()
  ]);

  // Confirm login succeeded by checking for common post-login indicators
  const loggedIn = await firstVisible(page, [
    'a:has-text("ออกจากระบบ")', 'a:has-text("Logout")', 'a:has-text("Sign out")',
    '[class*="account"]', '[class*="myaccount"]'
  ]);
  if (loggedIn) log('Login confirmed.');
  else           log('Login submitted (could not confirm – check debug-login.png if stuck).');
}

// ─── step 2: navigate to buy-ticket step ────────────────────────────────────

async function gotoBookingStep(page) {
  log('Going to event step page:', cfg.eventUrl);
  await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await solveCaptchas(page);
  await page.waitForTimeout(800);
}

// ─── step 3: select show round (if multiple shown) ───────────────────────────

async function selectShowRound(page) {
  const round = cfg.booking.showRound;
  if (!round) return;
  for (const sel of [`text="${round}"`, `text*="${round}"`, `[value="${round}"]`]) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      log('Selecting show round:', round);
      await loc.click();
      await page.waitForTimeout(500);
      return;
    }
  }
}

// ─── step 4: zone / section selection ───────────────────────────────────────
// imethai uses an SVG seat map. Zones are typically <a> tags wrapping SVG shapes
// with text labels, or <g> groups with titles. We try every plausible selector.

function zoneSelectors(zone) {
  return [
    // SVG text node containing exactly the zone name
    `svg text:has-text("${zone}")`,
    // Named group / path / polygon
    `g[id="${zone}"]`,          `g[id*="${zone}"]`,
    `g[data-zone="${zone}"]`,   `g[title="${zone}"]`,
    `path[id="${zone}"]`,       `path[data-zone="${zone}"]`,
    `polygon[id="${zone}"]`,    `polygon[data-zone="${zone}"]`,
    // Anchor wrapping zone shape
    `a[title="${zone}"]`,       `a[href*="${zone}"]`,
    // Image-map
    `area[alt="${zone}"]`,      `area[title="${zone}"]`,
    // Div / table / generic
    `[data-section="${zone}"]`, `[data-zone="${zone}"]`,
    `[data-name="${zone}"]`,    `[id="${zone}"]`,
    `td:has-text("${zone}")`,
    // Exact text match anywhere (last resort)
    `:text-is("${zone}")`
  ];
}

async function selectZone(page, preferredZones) {
  log('Waiting for seat/zone map...');
  // Give the page a moment to fully render the SVG map
  await page.waitForTimeout(1000);

  for (const zone of preferredZones) {
    log(`Trying zone: "${zone}"`);
    for (const sel of zoneSelectors(zone)) {
      try {
        const loc = page.locator(sel).first();
        if (!await loc.count()) continue;

        const cls = (await loc.getAttribute('class') ?? '').toLowerCase();
        if (/sold.?out|disable|unavail|full|close/i.test(cls)) {
          log(`  "${zone}" looks unavailable – trying next zone.`);
          break;
        }

        log(`  Clicking "${zone}" via: ${sel}`);
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ force: true, timeout: 5000 });
        await page.waitForTimeout(900);
        log(`  Zone "${zone}" selected.`);
        return zone;
      } catch { /* try next selector */ }
    }
  }

  await page.screenshot({ path: 'debug-zone.png', fullPage: true });
  throw new Error('No preferred zone clicked – see debug-zone.png');
}

// ─── step 5: standing OR seating auto-detection ─────────────────────────────

async function handleTicketSelection(page, count) {
  await page.waitForTimeout(600);

  // ── Standing: look for a quantity input / select ──────────────────────────
  const qtySelectors = [
    'select[name*="qty" i]',    'select[name*="quantity" i]', 'select[name*="amount" i]',
    'select[id*="qty" i]',      'select[id*="quantity" i]',
    'input[name*="qty" i][type="number"]',
    'input[name*="quantity" i][type="number"]',
    'input[type="number"]'
  ];
  const qtyEl = await firstVisible(page, qtySelectors);

  if (qtyEl) {
    const tag = await qtyEl.evaluate(el => el.tagName.toLowerCase());
    log(`Standing mode detected (${tag}) – setting quantity to ${count}`);
    if (tag === 'select') {
      await qtyEl.selectOption(String(count));
    } else {
      await qtyEl.fill(String(count));
    }
    log(`Quantity set to ${count}.`);
    return;
  }

  // ── Seating: click individual available seat cells ─────────────────────────
  log('Seating mode – picking individual seats...');

  const availSel = [
    'input[type="checkbox"][name*="seat" i]:not([disabled])',
    '.seat.available', '.seat:not(.sold):not(.disabled):not(.reserved)',
    'td.seat:not(.sold):not(.disabled)', 'td.available',
    'rect[class*="avail"]', 'circle[class*="avail"]',
    '[data-status="available"]',
    '[class*="seat"]:not([class*="sold"]):not([class*="disabled"])'
  ].join(', ');

  // Wait for at least one available seat
  await page.waitForSelector(availSel, { timeout: NAV_TIMEOUT });

  const seats = await page.locator(availSel).all();
  let picked   = 0;
  for (const seat of seats) {
    if (picked >= count) break;
    if (!await seat.isVisible().catch(() => false)) continue;
    try {
      await seat.click({ timeout: 3000 });
      picked++;
      log(`  Seat ${picked}/${count} selected.`);
      await page.waitForTimeout(300);
    } catch { /* try next */ }
  }

  if (picked < count) {
    await page.screenshot({ path: 'debug-seats.png', fullPage: true });
    throw new Error(`Only picked ${picked}/${count} seats – see debug-seats.png`);
  }
}

// ─── step 6: pickup method ───────────────────────────────────────────────────

async function choosePickup(page, method) {
  if (!method) return;
  const texts = { self: ['Self', 'รับเอง', 'รับด้วยตนเอง'], ems: ['EMS'] }[method] ?? [method];
  for (const t of texts) {
    const loc = await firstVisible(page, [
      `label:has-text("${t}")`, `input[value="${t}"]`, `input[value*="${t}" i]`
    ]);
    if (loc) { await loc.click().catch(() => {}); log('Pickup:', t); return; }
  }
}

// ─── step 7: accept terms ────────────────────────────────────────────────────

async function acceptTerms(page) {
  if (!cfg.booking.agreeTerms) return;
  const cb = await firstVisible(page, [
    'input[type="checkbox"][name*="agree" i]',
    'input[type="checkbox"][name*="term" i]',
    'input[type="checkbox"][id*="agree" i]',
    'input[type="checkbox"]'
  ]);
  if (cb && !await cb.isChecked().catch(() => false)) {
    await cb.check({ force: true });
    log('Terms accepted.');
  }
}

// ─── step 8: next / confirm ──────────────────────────────────────────────────

async function clickNext(page) {
  const btn = await firstVisible(page, [
    'button:has-text("Next")',    'button:has-text("ถัดไป")',
    'button:has-text("Confirm")', 'button:has-text("ยืนยัน")',
    'button:has-text("ซื้อบัตร")', 'input[type="submit"]',
    'button[type="submit"]'
  ]);
  if (btn) { log('Clicking next/confirm...'); await btn.click(); }
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  await waitUntilOpen(cfg.timing?.openTimeISO, cfg.timing?.preOpenLeadMs);

  const browser = await chromium.launch({
    headless: !HEADED,
    slowMo:   HEADED ? 60 : 0,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    viewport:  { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:    'th-TH',
    extraHTTPHeaders: { 'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8' }
  });

  // Hide webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  try {
    await login(page);
    await gotoBookingStep(page);
    await selectShowRound(page);
    const chosenZone = await selectZone(page, cfg.booking.preferredZones);
    await handleTicketSelection(page, cfg.booking.ticketCount);
    await choosePickup(page, cfg.booking.pickupMethod);
    await acceptTerms(page);
    await solveCaptchas(page);
    await clickNext(page);

    log(`\n✓ SUCCESS – zone "${chosenZone}" booked. Complete payment in the browser.`);

    if (HEADED) {
      log('Browser stays open for 15 minutes for payment.');
      await wait(15 * 60 * 1000);
    }
  } catch (err) {
    console.error('\n✗ Automation failed:', err.message);
    await page.screenshot({ path: `debug-final-${Date.now()}.png`, fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (!HEADED) await browser.close();
  }
})();
