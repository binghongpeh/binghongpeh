// imethai.com automated ticket booking
// Supports: Cloudflare bypass (CapSolver), Standing (qty) + Seating (seats), multiple zones
//
// Setup:
//   1) cp config.example.json config.json  — fill in credentials, zones, capsolver key
//   2) npm install && npm run install:browsers
//   3) node auto-book.js  (headless by default; HEADED=1 node auto-book.js for visible)
//
// Zone keywords: put your preferred zones in order, e.g. ["A", "B1", "B2", "M3"]
// Each zone is tried in order; OOS zones are skipped automatically.
// Standing zones → sets quantity dropdown. Seating zones → clicks seats front-row first.

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');
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
const RETRY_MS    = cfg.timing?.retryDelayMs    ?? 100;

// Per-account context stored via AsyncLocalStorage so helpers use the right
// account credentials and log tag when running multiple accounts in parallel.
const accountStore = new AsyncLocalStorage();
function ctx()      { return accountStore.getStore() || { creds: cfg.credentials, tag: '' }; }
function getCreds() { return ctx().creds; }

const log = (...a) => {
  const tag = ctx().tag;
  if (tag) console.log(`[${new Date().toISOString()}] ${tag}`, ...a);
  else      console.log(`[${new Date().toISOString()}]`, ...a);
};
const wait = ms => new Promise(r => setTimeout(r, ms));

// ─── account loader ─────────────────────────────────────────────────────────

function loadAccounts() {
  const file = cfg.accountsFile || 'accounts.txt';
  const fp   = path.join(__dirname, file);
  if (!fs.existsSync(fp)) {
    if (cfg.credentials?.username) {
      log(`No ${file} found – using single account from config.json.`);
      return [cfg.credentials];
    }
    throw new Error(`No accounts.txt and no credentials in config.json`);
  }
  const lines = fs.readFileSync(fp, 'utf-8').split(/\r?\n/);
  const accounts = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf(':');
    if (idx < 1) { log(`Skipping malformed line: "${t}"`); continue; }
    accounts.push({ username: t.slice(0, idx).trim(), password: t.slice(idx + 1).trim() });
  }
  if (!accounts.length) throw new Error(`${file} has no valid accounts`);
  log(`Loaded ${accounts.length} account(s) from ${file}.`);
  return accounts;
}

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

  const taskId = created.taskId;
  const start  = Date.now();
  while (Date.now() - start < timeoutMs) {
    await wait(POLL_MS);
    const result = await capsolverPost('getTaskResult', { clientKey: apiKey, taskId });
    if (result.status === 'ready') return result.solution;
    if (result.errorId)            throw new Error(`CapSolver error: ${result.errorDescription}`);
  }
  throw new Error('CapSolver timed out');
}

async function bypassCloudflare(page) {
  const cfFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
  const hasCF   = await cfFrame.locator('body').count().catch(() => 0);
  if (!hasCF) return;

  log('Cloudflare Turnstile detected – asking CapSolver...');
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    if (el) return el.dataset.sitekey;
    const m = document.documentElement.innerHTML.match(/sitekey["\s:=]+["']([^"']{20,})/i);
    return m ? m[1] : null;
  });
  if (!siteKey) throw new Error('Cloudflare sitekey not found in page');

  log('Sitekey:', siteKey);
  const solution = await capsolverSolve({
    type:       'AntiTurnstileTaskProxyLess',
    websiteURL: page.url(),
    websiteKey: siteKey
  });
  await page.evaluate(token => {
    let el = document.querySelector('[name="cf-turnstile-response"]');
    if (!el) { el = document.createElement('input'); el.name = 'cf-turnstile-response'; document.body.appendChild(el); }
    el.value = token;
    if (typeof turnstile !== 'undefined') turnstile.getResponse = () => token;
  }, solution.token);
  log('Cloudflare token injected.');
  await page.waitForTimeout(500);
}

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

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function waitUntilOpen(iso, leadMs = 1500) {
  if (!iso) return;
  const targetMs = new Date(iso).getTime() - leadMs;
  const gap      = targetMs - Date.now();
  if (gap <= 0) return;

  const target = new Date(targetMs);
  const bkk    = new Date(targetMs + 7 * 3600 * 1000);
  log(`Ticket opens in ${formatDuration(gap)} (target: ${target.toISOString()} / BKK ${bkk.toISOString().replace('T', ' ').slice(0, 19)})`);

  while (Date.now() < targetMs) {
    const remain = targetMs - Date.now();
    if (remain <= 30000) { await wait(remain); break; }
    log(`  ...${formatDuration(remain)} remaining`);
    await wait(Math.min(30000, remain));
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

  await userField.fill(getCreds().username);
  await passField.fill(getCreds().password);
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
  await page.waitForLoadState('networkidle').catch(() => {});
  await wait(300);
  log('myaccount.php submitted (real verification happens on step.php)');
}

// ─── step 2: navigate to booking step ───────────────────────────────────────

async function gotoBookingStep(page) {
  log('Going to event step page:', cfg.eventUrl);

  const MAX_RETRIES = 1200;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch { /* retry */ }
    await solveCaptchas(page).catch(() => {});
    await wait(150);

    const finalUrl = page.url();
    if (!/step\.php/i.test(finalUrl)) {
      if (attempt === 1 || attempt % 10 === 0) {
        log(`Redirected to ${finalUrl} – not on step.php yet (attempt ${attempt})`);
      }
      await wait(RETRY_MS);
      continue;
    }

    const needsLogin = await page.evaluate(() => {
      return !!document.querySelector('input[type="password"]')
          && /please.*login|กรุณาเข้าสู่ระบบ/i.test(document.body.innerText || '');
    }).catch(() => false);

    if (needsLogin) {
      log('step.php showing inline login form – logging in here...');
      const ok = await loginInline(page);
      if (!ok) {
        await page.screenshot({ path: 'debug-step-login.png', fullPage: true });
        throw new Error('Inline login on step.php failed – see debug-step-login.png');
      }
      await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await wait(200);
    }

    log(`Booking page loaded (attempt ${attempt}). URL: ${page.url()}`);
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, 'debug-page.html'), html);
      log(`Saved debug-page.html (${html.length} bytes)`);
    } catch {}
    return;
  }

  log('Max retries reached – proceeding anyway.');
}

async function loginInline(page) {
  const userField = await firstVisible(page, [
    'input[name="username"]', 'input[name="user_login"]', 'input[name="user"]',
    'input[name="email"]',    'input[type="text"]'
  ]);
  const passField = await firstVisible(page, ['input[type="password"]']);
  if (!userField || !passField) return false;

  await userField.fill('');
  await userField.fill(getCreds().username);
  await passField.fill('');
  await passField.fill(getCreds().password);

  const submitBtn = await firstVisible(page, [
    'button:has-text("LOGIN")', 'button:has-text("Login")',
    'input[type="submit"][value*="LOGIN" i]',
    'input[type="submit"]', 'button[type="submit"]'
  ]);
  if (!submitBtn) return false;

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {}),
    submitBtn.click()
  ]);

  const stillNeedsLogin = await page.evaluate(() => {
    return !!document.querySelector('input[type="password"]')
        && /please.*login|กรุณาเข้าสู่ระบบ/i.test(document.body.innerText || '');
  }).catch(() => false);

  if (!stillNeedsLogin) {
    log('========================================');
    log(`  ✓ LOGIN SUCCESS (step.php) — ${getCreds().username}`);
    log('========================================');
    return true;
  }
  return false;
}

// ─── step 3: select show round ───────────────────────────────────────────────

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

// ─── step 4: zone selection ──────────────────────────────────────────────────
// Returns available zone names from the zoneplanForm on the current page.
// Returns null if the form isn't there yet.
async function getAvailableZones(page) {
  return page.evaluate(() => {
    if (!document.forms['zoneplanForm']) return null;
    const zones = new Set();
    document.querySelectorAll('area[onclick]').forEach(a => {
      const m = a.getAttribute('onclick').match(/zone\.value\s*=\s*['"]([^'"]+)['"]/i);
      if (m) zones.add(m[1]);
    });
    return Array.from(zones);
  }).catch(() => null);
}

// Waits for zoneplanForm and returns the list of available zones.
async function waitForZoneMap(page) {
  const MAX = 100;
  for (let i = 1; i <= MAX; i++) {
    const zones = await getAvailableZones(page);
    if (zones !== null) {
      log(`Zone map ready. Available zones: [${zones.join(', ')}]`);
      return zones;
    }
    if (i % 10 === 0) log(`Waiting for zone map (attempt ${i})...`);
    await wait(RETRY_MS);
  }
  await page.screenshot({ path: 'debug-zone.png', fullPage: true });
  throw new Error('Zone map never appeared – see debug-zone.png');
}

// Submits zoneplanForm for a specific zone. Returns false if zone not on page.
async function submitZone(page, zone) {
  const zones = await getAvailableZones(page);
  if (!zones || !zones.includes(zone)) return false;

  log(`Submitting zoneplanForm with zone="${zone}"`);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {}),
    page.evaluate(z => {
      document.forms['zoneplanForm'].zone.value = z;
      document.forms['zoneplanForm'].submit();
    }, zone)
  ]);
  log(`✓ Zone "${zone}" submitted.`);
  return true;
}

// ─── step 5: OOS detection ───────────────────────────────────────────────────
// Returns true if the current ticket-selection page has no bookable items.
// imethai seating: available = label.ui-button[aria-pressed="false"]
// imethai standing: <select> with at least one value > 0

async function isOOS(page) {
  await page.waitForTimeout(800);

  // Explicit sold-out text
  const textOOS = await page.evaluate(() => {
    const t = (document.body?.innerText || '').toLowerCase();
    return /sold.?out|หมดแล้ว|ไม่มีที่นั่ง|no.*seat|out.of.stock/.test(t);
  }).catch(() => false);
  if (textOOS) return true;

  // Standing: <select> present
  const selCount = await page.locator('select').count().catch(() => 0);
  if (selCount > 0) {
    const opts = await page.locator('select').first().evaluate(el =>
      Array.from(el.options).map(o => o.value.trim()).filter(v => v && v !== '0')
    ).catch(() => []);
    if (opts.length === 0) {
      log('Standing select has no valid quantity options – OOS.');
      return true;
    }
    return false;
  }

  // Seating (imethai jQuery UI buttons): label.ui-button[aria-pressed="false"]
  const uiBtnTotal = await page.locator('label.ui-button').count().catch(() => 0);
  if (uiBtnTotal > 0) {
    const availCount = await page.locator('label.ui-button[aria-pressed="false"]').count().catch(() => 0);
    if (availCount === 0) {
      log(`Seat map has ${uiBtnTotal} seats but none available – OOS.`);
      return true;
    }
    return false;
  }

  // Generic fallback: no recognised seat elements
  const genericAvail = await page.locator([
    'input[type="checkbox"][name*="seat" i]:not([disabled])',
    '.seat.available',
    '[data-status="available"]'
  ].join(', ')).count().catch(() => 0);

  const onSeatPage = await page.evaluate(() =>
    /seat|ที่นั่ง|zone/i.test(document.body?.innerText || '')
  ).catch(() => false);

  if (onSeatPage && uiBtnTotal === 0 && genericAvail === 0) {
    log('No recognisable seat elements on page – treating as OOS.');
    return true;
  }

  return false;
}

// ─── step 6: ticket quantity / seat selection ────────────────────────────────

async function handleTicketSelection(page, count) {
  await page.waitForTimeout(600);

  // ── Standing: quantity <select> or <input> ────────────────────────────────
  const qtySelectors = [
    'select[name*="qty" i]',    'select[name*="quantity" i]',
    'select[name*="amount" i]', 'select[name*="ticket" i]',
    'select[id*="qty" i]',      'select[id*="quantity" i]',
    'select',
    'input[name*="qty" i][type="number"]',
    'input[name*="quantity" i][type="number"]',
    'input[type="number"]'
  ];
  const qtyEl = await firstVisible(page, qtySelectors);

  if (qtyEl) {
    const tag = await qtyEl.evaluate(el => el.tagName.toLowerCase());
    log(`Standing mode (${tag}) – setting quantity to ${count}`);

    if (tag === 'select') {
      const options = await qtyEl.evaluate(el =>
        Array.from(el.options).map(o => ({ value: o.value, text: (o.textContent || '').trim() }))
      ).catch(() => []);
      const currentValue = await qtyEl.inputValue().catch(() => '');
      log(`Qty options: ${JSON.stringify(options)} (current="${currentValue}")`);

      const want  = String(count);
      const match = options.find(o => o.value === want)
                 || options.find(o => o.text === want)
                 || options.find(o => o.value.trim() === want)
                 || options.find(o => o.text.replace(/\s+/g, '') === want);

      if (!match) {
        log(`WARNING: no option matches "${want}" – skipping qty change.`);
      } else if (currentValue === match.value) {
        log(`Quantity already ${count} (value="${match.value}").`);
      } else {
        try {
          await qtyEl.selectOption({ value: match.value }, { timeout: 3000 });
          log(`Quantity set: value="${match.value}".`);
        } catch {
          await qtyEl.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, match.value);
          log(`Quantity set via DOM fallback: value="${match.value}".`);
        }
      }
    } else {
      await qtyEl.fill(String(count));
      log(`Quantity input filled with ${count}.`);
    }
    return;
  }

  // ── Seating: imethai jQuery UI seat labels ────────────────────────────────
  // Available: label.ui-button[aria-pressed="false"]
  // Selected:  label.ui-button[aria-pressed="true"]  (+ ui-state-active class)
  // When a seat is already taken by someone else imethai shows a JS alert
  // "Please select new seat" → global dialog handler accepts it → we detect
  // the click failed by checking aria-pressed is still "false" and retry.
  log('Seating mode – picking seats (front-row first, with race-condition retry)...');

  const AVAIL_SEL = 'label.ui-button[aria-pressed="false"]';

  // Wait for at least one available seat button to appear
  try {
    await page.waitForSelector(AVAIL_SEL, { timeout: NAV_TIMEOUT });
  } catch {
    await page.screenshot({ path: 'debug-seats.png', fullPage: true });
    throw new Error('No available seat buttons found – see debug-seats.png');
  }

  let picked       = 0;
  const MAX_TRIES  = 300; // generous: many seats may be taken during the rush
  let   totalTries = 0;

  while (picked < count && totalTries < MAX_TRIES) {
    totalTries++;

    // Re-query on every iteration so we see the live seat state
    const handles = await page.locator(AVAIL_SEL).all();
    if (handles.length === 0) {
      await page.screenshot({ path: 'debug-seats.png', fullPage: true });
      throw new Error('All seats are now taken – OOS. See debug-seats.png');
    }

    // Sort front-row first: smallest Y (top of viewport) → smallest X
    const seatData = await Promise.all(handles.map(async h => {
      const box     = await h.boundingBox().catch(() => null);
      const forAttr = await h.getAttribute('for').catch(() => '');
      return { handle: h, y: box?.y ?? 9999, x: box?.x ?? 9999, forAttr };
    }));
    seatData.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

    const seat = seatData[0]; // topmost-left available seat

    try {
      await seat.handle.scrollIntoViewIfNeeded().catch(() => {});
      await seat.handle.click({ timeout: 3000 });

      // Wait a moment for the dialog (if any) to fire and be dismissed,
      // then for the DOM to update.
      await wait(600);

      // Verify the seat is now active (aria-pressed="true")
      const nowPressed = await page
        .locator(`label[for="${seat.forAttr}"]`)
        .getAttribute('aria-pressed')
        .catch(() => 'false');

      if (nowPressed === 'true') {
        picked++;
        log(`  ✓ Seat ${picked}/${count} confirmed (for="${seat.forAttr}", row≈y${Math.round(seat.y)}).`);
      } else {
        log(`  ✗ Seat for="${seat.forAttr}" was taken (dialog dismissed) – retrying next seat.`);
        await wait(RETRY_MS);
      }
    } catch (e) {
      log(`  Seat click error: ${e.message} – retrying.`);
      await wait(RETRY_MS);
    }
  }

  if (picked < count) {
    await page.screenshot({ path: 'debug-seats.png', fullPage: true });
    throw new Error(`Only secured ${picked}/${count} seats after ${totalTries} attempts – see debug-seats.png`);
  }
}

// ─── step 7: pickup method ───────────────────────────────────────────────────

async function choosePickup(page, method) {
  if (!method) return;

  const info = await page.evaluate(m => {
    const wantsSelf = m === 'self';
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const r of radios) {
      const lbl  = r.id ? document.querySelector(`label[for="${r.id}"]`) : null;
      const row  = r.closest('tr,td,div,label,li,p') || r.parentElement;
      const text = (lbl?.innerText || row?.innerText || '').trim();
      const isSelf = /รับด้วยตนเอง|self.?pickup/i.test(text);
      const isEms  = /EMS|ค่าส่ง/i.test(text);
      if ((wantsSelf && isSelf) || (!wantsSelf && isEms)) {
        return { id: r.id, name: r.name, value: r.value, text: text.slice(0, 60) };
      }
    }
    return null;
  }, method).catch(() => null);

  if (!info) { log('WARNING: pickup radio not found.'); return; }

  if (info.id) {
    try {
      const label = page.locator(`label[for="${info.id}"]`).first();
      await label.scrollIntoViewIfNeeded().catch(() => {});
      await label.click({ force: true, timeout: 3000 });
    } catch {}
  }
  await page.evaluate(id => {
    const r = document.getElementById(id);
    if (r && !r.checked) {
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, info.id).catch(() => {});

  log(`Pickup selected: "${info.text}"`);
}

// ─── step 8: accept terms ────────────────────────────────────────────────────

async function acceptTerms(page) {
  if (!cfg.booking.agreeTerms) return;

  const cbId = await page.evaluate(() => {
    const cb = document.querySelector('input[type="checkbox"][name="terms"]')
            || document.querySelector('#checkboxG1')
            || Array.from(document.querySelectorAll('input[type="checkbox"]'))
                .find(c => {
                  const row = c.closest('tr,td,div,label,li,p') || c.parentElement;
                  return /agree|ข้าพเจ้ายอมรับ|เงื่อนไข|terms.*conditions/i.test(row?.innerText || '');
                });
    return cb ? cb.id : null;
  }).catch(() => null);

  if (!cbId) { log('WARNING: terms checkbox not found.'); return; }

  try {
    const label = page.locator(`label[for="${cbId}"]`).first();
    await label.scrollIntoViewIfNeeded().catch(() => {});
    await label.click({ force: true, timeout: 3000 });
  } catch (e) {
    log('Label click failed, falling back to DOM:', e.message);
  }

  const ok = await page.evaluate(id => {
    const cb = document.getElementById(id);
    if (!cb) return false;
    if (!cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('click',  { bubbles: true }));
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return cb.checked;
  }, cbId).catch(() => false);

  log(ok ? `Terms accepted (#${cbId}).` : `WARNING: terms #${cbId} still unchecked.`);
}

// ─── step 9: continue button ─────────────────────────────────────────────────

async function clickNext(page) {
  const btn = await firstVisible(page, [
    'input.myButton[type="submit"]',
    'input[type="submit"][name="SUBMIT"]',
    'input[type="submit"][value*="CONTINUE" i]',
    'input[type="submit"][value*="ไปขั้นตอน" i]',
    'button:has-text("CONTINUE")',  'button:has-text("Continue")',
    'button:has-text("ไปขั้นตอนถัดไป")',
    'a:has-text("CONTINUE")',       'a:has-text("ไปขั้นตอนถัดไป")',
    'button:has-text("Next")',      'button:has-text("ถัดไป")',
    'button:has-text("Confirm")',   'button:has-text("ยืนยัน")',
    'button:has-text("ซื้อบัตร")',
    'input[type="submit"]', 'button[type="submit"]'
  ]);
  if (btn) {
    log('Clicking CONTINUE...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {}),
      btn.click()
    ]);
  } else {
    log('WARNING: CONTINUE button not found.');
  }
}

// ─── step 10: payment popup (headless → headed window) ───────────────────────
// When the bot is running headless, open a new VISIBLE browser window on the
// payment/checkout URL so the user can complete payment manually.

async function openHeadedForPayment(context, checkoutUrl) {
  if (HEADED) return; // already visible

  log('Opening visible browser window for payment...');
  try {
    const headedBrowser = await chromium.launch({
      headless: false,
      slowMo:   40,
      args:     ['--disable-blink-features=AutomationControlled']
    });

    // Transfer session cookies so the payment page loads authenticated
    const cookies = await context.cookies().catch(() => []);
    const headedCtx = await headedBrowser.newContext({
      viewport:  { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    if (cookies.length) await headedCtx.addCookies(cookies);

    const payPage = await headedCtx.newPage();
    await payPage.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    log(`Payment window open → ${checkoutUrl}`);

    // Keep the headed browser open for 15 minutes then auto-close
    await wait(15 * 60 * 1000).catch(() => {});
    await headedBrowser.close().catch(() => {});
  } catch (e) {
    log('Could not open headed payment window:', e.message);
    log(`Complete payment manually at: ${checkoutUrl}`);
  }
}

// ─── step 11: webhook notification ──────────────────────────────────────────

function postWebhook(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u    = new URL(webhookUrl);
    const lib  = u.protocol === 'http:' ? require('http') : https;
    const req  = lib.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'http:' ? 80 : 443),
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Build the correct webhook payload depending on destination.
//
// Supported modes (detected from config.webhook):
//   1. Direct Discord  — url matches discord.com/api/webhooks/
//   2. AYCD Inbox      — url matches inbox-api.aycd.io  (proxies to Discord;
//                        requires discordWebhookId + discordWebhookToken in config)
//   3. Generic         — any other URL; sends a plain JSON body
//
function buildWebhookPayload(type, { acc, zone, checkoutUrl, errMsg }) {
  const isSuccess = !!checkoutUrl;
  const ts        = new Date().toISOString();

  const discordEmbed = isSuccess
    ? {
        username: 'imethai bot',
        content:  `🎫 **Ticket secured!**\nAccount: **${acc}**\nZone: **${zone}**\nClick to pay: ${checkoutUrl}`,
        embeds: [{
          title:       `Pay now — ${acc}`,
          url:         checkoutUrl,
          description: `**Account:** ${acc}\n**Zone:** ${zone}`,
          color:       0x57F287,
          timestamp:   ts,
          footer:      { text: 'imethai auto-booker' }
        }]
      }
    : { content: `❌ **${acc}** failed: ${errMsg}` };

  if (type === 'discord') return discordEmbed;

  if (type === 'aycd') {
    // AYCD Inbox expects Discord embed format PLUS webhook_id / webhook_token
    // so it can proxy the notification to your Discord and log it in Inbox.
    return {
      webhook_id:    cfg.webhook.discordWebhookId,
      webhook_token: cfg.webhook.discordWebhookToken,
      ...discordEmbed
    };
  }

  // Generic fallback
  return isSuccess
    ? {
        event:        'checkout_ready',
        status:       'success',
        account:      acc,
        zone:         zone,
        message:      `🎫 Checkout ready | Account: ${acc} | Zone: ${zone} | Pay: ${checkoutUrl}`,
        checkoutLink: checkoutUrl,
        checkoutUrl:  checkoutUrl,
        timestamp:    ts
      }
    : {
        event:     'booking_failed',
        status:    'failure',
        account:   acc,
        message:   `❌ Failed | Account: ${acc} | Error: ${errMsg}`,
        error:     errMsg,
        timestamp: ts
      };
}

function detectWebhookType(url) {
  if (!url) return null;
  if (/discord(app)?\.com\/api\/webhooks/i.test(url))  return 'discord';
  if (/inbox-api\.aycd\.io/i.test(url))                return 'aycd';
  return 'generic';
}

async function notifyCheckout(page, zone) {
  const webhookUrl = cfg.webhook?.url;
  const wtype      = detectWebhookType(webhookUrl);
  if (!wtype) { log('No webhook configured – skipping notification.'); return; }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await wait(800);

  const checkoutUrl = page.url();
  await page.screenshot({ path: `checkout-${Date.now()}.png`, fullPage: true }).catch(() => {});

  const payload = buildWebhookPayload(wtype, { acc: getCreds().username, zone, checkoutUrl });
  try {
    const r = await postWebhook(webhookUrl, payload);
    log(`Webhook delivered (HTTP ${r.status}): ${r.body.slice(0, 300)}`);
    log(`Checkout URL: ${checkoutUrl}`);
  } catch (e) {
    log('Webhook failed:', e.message);
    log(`Complete payment manually at: ${checkoutUrl}`);
  }
}

async function notifyFailure(creds, errMsg) {
  const webhookUrl = cfg.webhook?.url;
  const wtype      = detectWebhookType(webhookUrl);
  if (!wtype) return;

  const payload = buildWebhookPayload(wtype, { acc: creds.username, errMsg });
  try {
    const r = await postWebhook(webhookUrl, payload);
    log(`Failure webhook delivered (HTTP ${r.status}): ${r.body.slice(0, 300)}`);
  } catch (e) {
    log('Failure webhook error:', e.message);
  }
}

// ─── per-account run ─────────────────────────────────────────────────────────

async function runForAccount(creds, idx, total) {
  const tag = `[${creds.username}]`;
  return accountStore.run({ creds, tag }, async () => {
    log(`Starting (${idx + 1}/${total})`);

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
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    // Global dialog handler — covers login, zone nav, AND seat selection phase.
    // imethai shows "Please select new seat" as a JS alert when a seat is taken.
    page.on('dialog', async d => {
      const msg = d.message();
      log(`JS dialog: "${msg.slice(0, 120)}" → accepting`);
      await d.accept().catch(() => d.dismiss().catch(() => {}));
    });

    try {
      await login(page);
      await gotoBookingStep(page);
      await selectShowRound(page);

      // ── Zone selection: random order, retry forever until one has seats ─────
      // Zones are shuffled each pass so no single zone gets starved.
      // The loop runs until a zone is successfully entered (not OOS).
      const preferredZones = [...cfg.booking.preferredZones];
      let chosenZone   = null;
      let zonePass     = 0;

      while (!chosenZone) {
        zonePass++;

        // Shuffle preferred zones for this pass (Fisher-Yates)
        const shuffled = [...preferredZones];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        log(`Zone pass #${zonePass} – trying order: [${shuffled.join(', ')}]`);

        // Navigate to zone map (always refresh to get latest availability)
        await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await solveCaptchas(page).catch(() => {});
        await wait(300);
        await waitForZoneMap(page);

        for (const tryZone of shuffled) {
          const submitted = await submitZone(page, tryZone);
          if (!submitted) {
            log(`  "${tryZone}" not on map – skipping.`);
            // Navigate back to zone map to try next zone
            await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
            await wait(200);
            continue;
          }

          const oos = await isOOS(page);
          if (oos) {
            log(`  ⚠ Seat OOS for zone "${tryZone}" – trying next.`);
            // Navigate back to zone map for next zone
            await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
            await wait(200);
            await waitForZoneMap(page).catch(() => {});
            continue;
          }

          log(`  ✓ Zone "${tryZone}" has seats – proceeding.`);
          chosenZone = tryZone;
          break;
        }

        if (!chosenZone) {
          log(`All [${shuffled.join(', ')}] OOS on pass #${zonePass} – retrying in ${RETRY_MS}ms...`);
          await wait(RETRY_MS);
        }
      }

      await handleTicketSelection(page, cfg.booking.ticketCount);
      await choosePickup(page, cfg.booking.pickupMethod);
      await acceptTerms(page);
      await solveCaptchas(page);
      await clickNext(page);

      log(`✓ SUCCESS – zone "${chosenZone}" booked.`);
      await notifyCheckout(page, chosenZone);

      const checkoutUrl = page.url();

      // Open a visible browser window for payment (works even in headless mode)
      await openHeadedForPayment(context, checkoutUrl);

      if (HEADED) {
        log('Browser stays open 15 minutes for payment.');
        await wait(15 * 60 * 1000);
      }

      return { ok: true, username: creds.username, zone: chosenZone };
    } catch (err) {
      log('✗ Automation failed:', err.message);
      await page.screenshot({
        path: `debug-final-${creds.username.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}.png`,
        fullPage: true
      }).catch(() => {});
      await notifyFailure(creds, err.message);
      return { ok: false, username: creds.username, error: err.message };
    } finally {
      if (!HEADED) {
        // Small delay so the headed payment window (if opened) can take over
        await wait(2000);
        await browser.close().catch(() => {});
      }
    }
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  const accounts = loadAccounts();
  await waitUntilOpen(cfg.timing?.openTimeISO, cfg.timing?.preOpenLeadMs);

  log(`Launching ${accounts.length} account(s) in parallel...`);
  const results = await Promise.all(
    accounts.map((creds, idx) => runForAccount(creds, idx, accounts.length))
  );

  log('=== Summary ===');
  for (const r of results) {
    if (r.ok) log(`  ✓ ${r.username} → zone ${r.zone}`);
    else      log(`  ✗ ${r.username} → ${r.error}`);
  }
  process.exit(results.every(r => r.ok) ? 0 : 1);
})();
