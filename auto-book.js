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

// Per-account context (creds + log tag) stored via AsyncLocalStorage so all
// helpers below transparently use the right account when running in parallel.
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

  // Periodic countdown every 30 s while waiting
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

  // Wait briefly for any cookies / redirects to settle. The real login check
  // happens on step.php (the inline form there is the source of truth).
  await page.waitForLoadState('networkidle').catch(() => {});
  await wait(300);
  log('myaccount.php submitted (real verification happens on step.php)');
}

// ─── step 2: navigate to buy-ticket step ────────────────────────────────────
// Retries every retryDelayMs (100ms) until the seat map loads or a
// "not yet open" message disappears.

async function gotoBookingStep(page) {
  log('Going to event step page:', cfg.eventUrl);

  // Auto-dismiss any pre-launch JS alerts that might appear.
  page.on('dialog', async d => {
    log('JS dialog detected:', d.message().slice(0, 120));
    await d.accept().catch(() => d.dismiss().catch(() => {}));
  });

  const MAX_RETRIES = 1200;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch (e) { /* retry */ }
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

    // We're on step.php. Check whether it shows the inline login form
    // (which means we are NOT logged in even if myaccount.php login looked OK).
    const needsLogin = await page.evaluate(() => {
      return !!document.querySelector('input[type="password"]')
          && /please.*login|กรุณาเข้าสู่ระบบ/i.test(document.body.innerText || '');
    }).catch(() => false);

    if (needsLogin) {
      log('step.php is showing the inline login form. Logging in here...');
      const ok = await loginInline(page);
      if (!ok) {
        await page.screenshot({ path: 'debug-step-login.png', fullPage: true });
        throw new Error('Inline login on step.php failed – see debug-step-login.png');
      }
      // After inline login success, navigate again to refresh
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

// Inline login form on step.php (Username / Password / LOGIN button).
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

  // After login the inline form should be gone
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
  // Escape for use inside CSS attribute selectors
  const z = zone.replace(/"/g, '\\"');
  // Image-map area variants: imethai often uses href like "?zone=B1" or onclick="goto('B1')"
  const hrefVariants = [
    `area[href*="=${z}"]`,
    `area[href*="/${z}"]`,
    `area[href*="${z}.php"]`,
    `area[href*="zone=${z}"]`,
    `area[href*="seat=${z}"]`,
    `area[onclick*="'${z}'"]`,
    `area[onclick*="\\"${z}\\""]`
  ];
  return [
    // Image-map (most likely on imethai)
    `area[alt="${z}"]`,
    `area[title="${z}"]`,
    `area[name="${z}"]`,
    `area[data-zone="${z}"]`,
    ...hrefVariants,
    // Anchor / link
    `a[title="${z}"]`,
    `a[href*="zone=${z}"]`,
    `a[href*="=${z}"]`,
    `a[onclick*="'${z}'"]`,
    // SVG
    `svg [id="${z}"]`,
    `svg [id*="${z}"]`,
    `svg [data-zone="${z}"]`,
    `svg text:has-text("${z}")`,
    `g[id="${z}"]`,
    `path[id="${z}"]`,
    `polygon[id="${z}"]`,
    // Generic data-* / id
    `[data-section="${z}"]`,
    `[data-zone="${z}"]`,
    `[data-name="${z}"]`,
    `[id="${z}"]`,
    // Table / div fallback
    `td:has-text("${z}")`,
    `:text-is("${z}")`
  ];
}

async function dumpZoneCandidates(page) {
  const found = await page.evaluate(() => {
    const out = [];
    const sel = 'area, a[href], a[onclick], [onclick], svg a, svg [id], form, button';
    document.querySelectorAll(sel).forEach(el => {
      const text = (el.innerText || el.textContent || '').trim().slice(0, 50);
      out.push({
        tag:     el.tagName.toLowerCase(),
        alt:     el.getAttribute('alt'),
        title:   el.getAttribute('title'),
        href:    el.getAttribute('href'),
        onclick: el.getAttribute('onclick'),
        coords:  el.getAttribute('coords'),
        shape:   el.getAttribute('shape'),
        id:      el.id || null,
        name:    el.getAttribute('name'),
        cls:     el.getAttribute('class'),
        text:    text || undefined
      });
    });
    return out;
  }).catch(() => []);

  try {
    fs.writeFileSync(path.join(__dirname, 'debug-zones.json'), JSON.stringify(found, null, 2));
    log(`Saved debug-zones.json (${found.length} elements)`);
  } catch {}

  // Also print the most interesting ones: <area> tags and elements with onclick
  const interesting = found.filter(e => e.tag === 'area' || e.onclick);
  log(`Interesting clickable elements (${interesting.length}):`);
  interesting.slice(0, 40).forEach(e => log('  ' + JSON.stringify(e)));
}

async function selectZone(page, preferredZones) {
  log('Waiting for zoneplanForm to appear...');
  await page.waitForTimeout(300);

  const MAX_ZONE_RETRIES = 100; // 100 × 100ms = 10s max

  for (let attempt = 1; attempt <= MAX_ZONE_RETRIES; attempt++) {
    // Check which zones are actually available on this page (from <area> onclicks)
    const availableZones = await page.evaluate(() => {
      if (!document.forms['zoneplanForm']) return null;
      const zones = new Set();
      document.querySelectorAll('area[onclick]').forEach(a => {
        const m = a.getAttribute('onclick').match(/zone\.value\s*=\s*['"]([^'"]+)['"]/i);
        if (m) zones.add(m[1]);
      });
      return Array.from(zones);
    }).catch(() => null);

    if (availableZones === null) {
      if (attempt % 10 === 0) log(`zoneplanForm not yet on page (attempt ${attempt})...`);
      await wait(RETRY_MS);
      continue;
    }

    log(`Available zones on page: [${availableZones.join(', ')}]`);

    // Find the first preferred zone that exists on the page
    for (const zone of preferredZones) {
      if (!availableZones.includes(zone)) {
        log(`  "${zone}" not present – trying next preferred zone.`);
        continue;
      }

      log(`Submitting zoneplanForm with zone="${zone}"`);
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {}),
          page.evaluate(z => {
            document.forms['zoneplanForm'].zone.value = z;
            document.forms['zoneplanForm'].submit();
          }, zone)
        ]);
        log(`✓ Zone "${zone}" submitted.`);
        return zone;
      } catch (e) {
        log(`Submit failed for "${zone}": ${e.message}`);
      }
    }

    // None of the preferred zones were on this page – stop and report
    await page.screenshot({ path: 'debug-zone.png', fullPage: true });
    throw new Error(
      `None of [${preferredZones.join(', ')}] are available. ` +
      `Page only has [${availableZones.join(', ')}]. See debug-zone.png.`
    );
  }

  await page.screenshot({ path: 'debug-zone.png', fullPage: true });
  throw new Error('zoneplanForm never appeared – see debug-zone.png');
}

// ─── step 5: standing OR seating auto-detection ─────────────────────────────

async function handleTicketSelection(page, count) {
  await page.waitForTimeout(600);

  // ── Standing: look for a quantity input / select ──────────────────────────
  // imethai uses a <select> on the post-zone page (Amount / จำนวนบัตร).
  const qtySelectors = [
    'select[name*="qty" i]',      'select[name*="quantity" i]',
    'select[name*="amount" i]',   'select[name*="ticket" i]',
    'select[id*="qty" i]',        'select[id*="quantity" i]',
    'select',  // fallback: any <select> on the page
    'input[name*="qty" i][type="number"]',
    'input[name*="quantity" i][type="number"]',
    'input[type="number"]'
  ];
  const qtyEl = await firstVisible(page, qtySelectors);

  if (qtyEl) {
    const tag = await qtyEl.evaluate(el => el.tagName.toLowerCase());
    log(`Standing mode detected (${tag}) – setting quantity to ${count}`);
    try {
      if (tag === 'select') {
        await qtyEl.selectOption({ value: String(count) }).catch(async () => {
          await qtyEl.selectOption({ label: String(count) }).catch(() => {});
        });
      } else {
        await qtyEl.fill(String(count));
      }
      log(`Quantity set to ${count}.`);
    } catch (e) {
      log('Quantity set failed:', e.message);
    }
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

  let picked = 0;
  const MAX_SEAT_RETRIES = 50;

  for (let attempt = 1; attempt <= MAX_SEAT_RETRIES && picked < count; attempt++) {
    const seats = await page.locator(availSel).all();
    for (const seat of seats) {
      if (picked >= count) break;
      if (!await seat.isVisible().catch(() => false)) continue;
      try {
        await seat.click({ timeout: 3000 });
        picked++;
        log(`  Seat ${picked}/${count} selected.`);
        await wait(RETRY_MS);
      } catch { /* try next */ }
    }
    if (picked < count) await wait(RETRY_MS);
  }

  if (picked < count) {
    await page.screenshot({ path: 'debug-seats.png', fullPage: true });
    throw new Error(`Only picked ${picked}/${count} seats – see debug-seats.png`);
  }
}

// ─── step 6: pickup method ───────────────────────────────────────────────────

async function choosePickup(page, method) {
  if (!method) return;

  const result = await page.evaluate(m => {
    const wantsSelf = m === 'self';
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));

    for (const r of radios) {
      // Match by associated label text (Self pickup / EMS)
      const label = r.id ? document.querySelector(`label[for="${r.id}"]`) : null;
      const row   = r.closest('tr,td,div,label,li,p') || r.parentElement;
      const text  = (label?.innerText || row?.innerText || '').trim();

      const isSelf = /รับด้วยตนเอง|self.?pickup/i.test(text);
      const isEms  = /EMS|ค่าส่ง/i.test(text);

      if ((wantsSelf && isSelf) || (!wantsSelf && isEms)) {
        // Click the visible label (hidden radio trick) and force state
        if (label) label.click();
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: r.checked, name: r.name, value: r.value, text: text.slice(0, 60) };
      }
    }
    return { ok: false };
  }, method).catch(() => ({ ok: false }));

  if (result.ok) log(`Pickup selected: name="${result.name}" value="${result.value}" ("${result.text}")`);
  else            log('WARNING: pickup radio not found.');
}

// ─── step 7: accept terms ────────────────────────────────────────────────────

async function acceptTerms(page) {
  if (!cfg.booking.agreeTerms) return;

  // imethai uses the css-checkbox/css-label trick: the real <input> is hidden,
  // and clicking the <label for="..."> toggles it. So we ALWAYS click the label.
  const result = await page.evaluate(() => {
    // 1) Try to find the terms checkbox by name="terms" or known id
    let cb = document.querySelector('input[type="checkbox"][name="terms"]')
          || document.querySelector('#checkboxG1')
          || Array.from(document.querySelectorAll('input[type="checkbox"]'))
              .find(c => {
                const row = c.closest('tr,td,div,label,li,p') || c.parentElement;
                return /agree|ข้าพเจ้ายอมรับ|เงื่อนไข|terms.*conditions/i.test(row?.innerText || '');
              });

    if (!cb) return { ok: false, reason: 'no checkbox' };

    // Click the matching <label for="..."> if it exists (toggles hidden checkbox)
    const label = cb.id ? document.querySelector(`label[for="${cb.id}"]`) : null;
    if (label && !cb.checked) label.click();
    // Force the underlying state too for safety
    if (!cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return { ok: cb.checked, id: cb.id, name: cb.name, hadLabel: !!label };
  }).catch(e => ({ ok: false, reason: e.message }));

  if (result.ok) {
    log(`Terms accepted (id="${result.id}" name="${result.name}" via ${result.hadLabel ? 'label' : 'direct'})`);
  } else {
    log('WARNING: terms checkbox not ticked –', result.reason || 'unknown');
  }
}

// ─── step 8: next / confirm ──────────────────────────────────────────────────

async function clickNext(page) {
  const btn = await firstVisible(page, [
    'input.myButton[type="submit"]',
    'input[type="submit"][name="SUBMIT"]',
    'input[type="submit"][value*="CONTINUE" i]',
    'input[type="submit"][value*="ไปขั้นตอน" i]',
    'button:has-text("CONTINUE")',  'button:has-text("Continue")',
    'button:has-text("ไปขั้นตอนถัดไป")',
    'a:has-text("CONTINUE")',        'a:has-text("ไปขั้นตอนถัดไป")',
    'button:has-text("Next")',       'button:has-text("ถัดไป")',
    'button:has-text("Confirm")',    'button:has-text("ยืนยัน")',
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

// ─── step 9: notify webhook with checkout URL ───────────────────────────────

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

async function notifyCheckout(page, zone) {
  const webhookUrl = cfg.webhook?.url;
  if (!webhookUrl) { log('No webhook configured – skipping notification.'); return; }

  // Wait for navigation to settle on the checkout/payment page
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await wait(800);

  const checkoutUrl = page.url();
  const screenshot  = `checkout-${Date.now()}.png`;
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});

  // Discord webhook? Format as embed; otherwise send a plain JSON payload.
  const isDiscord = /discord(app)?\.com\/api\/webhooks/i.test(webhookUrl);

  const acc = getCreds().username;
  const payload = isDiscord
    ? {
        username: 'imethai bot',
        content:  `🎫 **Ticket secured!**\nAccount: **${acc}**\nZone: **${zone}**\nClick to pay: ${checkoutUrl}`,
        embeds: [{
          title:       `Pay now — ${acc}`,
          url:         checkoutUrl,
          description: `**Account:** ${acc}\n**Zone:** ${zone}`,
          color:       0x57F287,
          timestamp:   new Date().toISOString(),
          footer:      { text: 'imethai auto-booker' }
        }]
      }
    : {
        event:       'checkout_ready',
        status:      'success',
        account:     acc,
        username:    acc,
        zone:        zone,
        checkoutUrl: checkoutUrl,
        timestamp:   new Date().toISOString()
      };

  try {
    const r = await postWebhook(webhookUrl, payload);
    log(`Webhook delivered (HTTP ${r.status}). Checkout URL: ${checkoutUrl}`);
  } catch (e) {
    log('Webhook failed:', e.message);
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

      log(`✓ SUCCESS – zone "${chosenZone}" booked.`);
      await notifyCheckout(page, chosenZone);
      log('Complete payment in the browser or via the webhook link.');

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
      // Notify failure too so you know which account didn't make it
      try {
        const url = cfg.webhook?.url;
        if (url) {
          const isDiscord = /discord(app)?\.com\/api\/webhooks/i.test(url);
          await postWebhook(url, isDiscord
            ? { content: `❌ **${creds.username}** failed: ${err.message}` }
            : { event: 'booking_failed', username: creds.username, error: err.message }
          );
        }
      } catch {}
      return { ok: false, username: creds.username, error: err.message };
    } finally {
      if (!HEADED) await browser.close();
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
