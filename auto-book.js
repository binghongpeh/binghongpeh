// Automated login + seat selection for NEXZ Global Showcase "Mmchk : Not Typical"
// Ticket site: imethai.com
//
// Setup:
//   1) cp config.example.json config.json   (fill in username/password/zones)
//   2) npm install && npm run install:browsers
//   3) npm run book:headed    (first run - visible so you can verify each step)
//      npm run book           (headless once you've confirmed it works)
//
// CAPTCHA: the script pauses and waits up to 3 min for you to solve it manually.
// Payment: left to you - the browser stays open after reaching the payment page.

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json – copy config.example.json and fill it in.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const HEADED      = process.env.HEADED === '1';
const NAV_TIMEOUT = cfg.timing?.navTimeoutMs ?? 30000;
const POLL_MS     = cfg.timing?.pollIntervalMs ?? 250;

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ─── helpers ────────────────────────────────────────────────────────────────

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() && await loc.isVisible()) return loc;
    } catch { /* continue */ }
  }
  return null;
}

async function waitUntilOpen(iso, leadMs = 1500) {
  if (!iso) return;
  const gap = new Date(iso).getTime() - leadMs - Date.now();
  if (gap > 0) {
    log(`Sleeping ${(gap / 1000).toFixed(1)}s until just before ticket open...`);
    await new Promise(r => setTimeout(r, gap));
  }
}

// ─── step 1: login ───────────────────────────────────────────────────────────
// imethai login form field names – update if the site changes them.
// You can find the real names by doing F12 → Elements → inspect the login form.

async function login(page) {
  log('Opening site:', cfg.siteUrl);
  await page.goto(cfg.siteUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

  // Known imethai selectors (update with real ones from DevTools if these fail):
  const userField = await firstVisible(page, [
    'input[name="username"]', 'input[name="user_login"]', 'input[name="user"]',
    'input[id="username"]',   'input[id="user_login"]',
    'input[type="email"]',    'input[placeholder*="user" i]', 'input[placeholder*="email" i]'
  ]);
  const passField = await firstVisible(page, [
    'input[name="password"]', 'input[name="user_pass"]', 'input[name="pass"]',
    'input[id="password"]',   'input[id="user_pass"]',
    'input[type="password"]'
  ]);

  if (!userField || !passField) {
    await page.screenshot({ path: 'debug-login.png', fullPage: true });
    throw new Error('Login fields not found – see debug-login.png. Update selectors.');
  }

  await userField.fill(cfg.credentials.username);
  await passField.fill(cfg.credentials.password);

  if (await hasCaptcha(page)) await waitForCaptcha(page);

  const submitBtn = await firstVisible(page, [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Login")', 'button:has-text("เข้าสู่ระบบ")',
    'a:has-text("เข้าสู่ระบบ")'
  ]);
  if (!submitBtn) throw new Error('Login submit button not found');

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    submitBtn.click()
  ]);
  log('Login submitted.');
}

async function hasCaptcha(page) {
  return page.evaluate(() =>
    !!document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],#captcha,.captcha,[class*="captcha" i]')
  );
}

async function waitForCaptcha(page) {
  log('CAPTCHA detected – solve it in the browser. Waiting up to 3 minutes...');
  await page.waitForFunction(() => {
    // Resolve once the captcha iframe disappears or a success token appears
    const iframe = document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"]');
    const token  = document.querySelector('textarea#g-recaptcha-response,input[name="captcha_token"]');
    return !iframe || (token && token.value.length > 0);
  }, { timeout: 3 * 60 * 1000 }).catch(() => log('CAPTCHA wait timed out – continuing anyway.'));
}

// ─── step 2: navigate directly to step.php (buy-ticket page) ─────────────────

async function gotoBookingStep(page) {
  log('Navigating to buy-ticket step:', cfg.eventUrl);
  await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(600);
}

// ─── step 3: select show round (if multiple rounds shown) ────────────────────

async function selectShowRound(page) {
  if (!cfg.booking.showRound) return;
  const dateText = cfg.booking.showRound; // e.g. "04/07/2026" or "2026-07-04"
  const loc = page.locator(`text="${dateText}"`).first();
  if (await loc.count()) {
    log('Selecting round:', dateText);
    await loc.click();
    await page.waitForTimeout(500);
  }
}

// ─── step 4: zone / section selection ───────────────────────────────────────
// imethai seat maps are usually SVG elements where each zone is an <a> or
// <path>/<polygon> with a title or id matching the section label (e.g. "B1").
// UPDATE the selectors below once you share the seat map HTML.

async function selectZone(page, preferredZones) {
  log('Waiting for seat map...');
  await page.waitForLoadState('domcontentloaded');

  // Candidate selectors – covers SVG maps, image-maps, and div-based layouts.
  const buildSelectors = zone => [
    // SVG text label
    `svg text:has-text("${zone}")`,
    // SVG group/path with title
    `g[id="${zone}"]`, `g[data-zone="${zone}"]`, `g[title="${zone}"]`,
    `path[id="${zone}"]`, `path[data-zone="${zone}"]`,
    // Anchor wrapping a zone
    `a[href*="${zone}"]`, `a[title="${zone}"]`,
    // Image-map area
    `area[alt="${zone}"]`, `area[title="${zone}"]`,
    // Div / table cell
    `[data-section="${zone}"]`, `[data-zone="${zone}"]`,
    `td:has-text("${zone}")`, `div.zone:has-text("${zone}")`,
    // Fallback: any element whose visible text exactly matches
    `:text-is("${zone}")`
  ];

  for (const zone of preferredZones) {
    log(`Trying zone: ${zone}`);
    for (const sel of buildSelectors(zone)) {
      try {
        const loc = page.locator(sel).first();
        if (!await loc.count()) continue;

        // Skip sold-out zones
        const cls = (await loc.getAttribute('class')) ?? '';
        if (/sold.?out|disabled|unavail|full/i.test(cls)) {
          log(`  ${zone} appears sold out (${sel}), skipping.`);
          break;
        }

        log(`  Clicking zone ${zone} via: ${sel}`);
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ force: true, timeout: 4000 });
        await page.waitForTimeout(800);
        return zone;
      } catch { /* try next selector */ }
    }
  }

  await page.screenshot({ path: 'debug-zone.png', fullPage: true });
  throw new Error('No preferred zone was clickable – see debug-zone.png. Inspect the zone selectors.');
}

// ─── step 5: pick seats ──────────────────────────────────────────────────────

async function pickSeats(page, count) {
  log(`Picking ${count} seat(s)...`);

  await page.waitForSelector(
    [
      'input[type="checkbox"][name*="seat" i]',
      '.seat:not(.sold):not(.disabled)',
      '[class*="seat"]:not([class*="sold"]):not([class*="disabled"])',
      'td.available', 'td.seat',
      'rect[class*="seat"]', 'rect[class*="avail"]'
    ].join(', '),
    { timeout: NAV_TIMEOUT }
  );

  const seatSel = [
    'input[type="checkbox"][name*="seat" i]:not([disabled])',
    '.seat.available', '.seat:not(.sold):not(.disabled):not(.reserved)',
    'td.seat:not(.sold)', 'td.available',
    'rect[class*="avail"]',
    '[data-status="available"]', '[data-seat]:not([data-status="sold"])'
  ].join(', ');

  const seats = await page.locator(seatSel).all();
  let picked = 0;
  for (const seat of seats) {
    if (picked >= count) break;
    if (!await seat.isVisible().catch(() => false)) continue;
    try {
      await seat.click({ timeout: 2000 });
      picked++;
      log(`  Seat ${picked}/${count} selected.`);
      await page.waitForTimeout(300);
    } catch { /* try next */ }
  }

  if (picked < count) {
    await page.screenshot({ path: 'debug-seats.png', fullPage: true });
    throw new Error(`Only picked ${picked}/${count} seats – see debug-seats.png.`);
  }
}

// ─── step 6: pickup method ───────────────────────────────────────────────────

async function choosePickup(page, method) {
  if (!method) return;
  const labels = { self: ['Self', 'รับเอง', 'รับด้วยตนเอง'], ems: ['EMS'] };
  const texts = labels[method] ?? [method];
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
    'input[type="checkbox"][id*="agree" i]'
  ]);
  if (cb && !await cb.isChecked().catch(() => false)) {
    await cb.check({ force: true });
    log('Terms accepted.');
  }
}

// ─── step 8: next / confirm ──────────────────────────────────────────────────

async function clickNext(page) {
  const btn = await firstVisible(page, [
    'button:has-text("Next")', 'button:has-text("ถัดไป")',
    'button:has-text("Confirm")', 'button:has-text("ยืนยัน")',
    'input[type="submit"]', 'button[type="submit"]'
  ]);
  if (btn) { log('Clicking next/confirm...'); await btn.click(); }
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  await waitUntilOpen(cfg.timing?.openTimeISO, cfg.timing?.preOpenLeadMs);

  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 80 : 0 });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  try {
    await login(page);
    await gotoBookingStep(page);
    await selectShowRound(page);
    await selectZone(page, cfg.booking.preferredZones);
    await pickSeats(page, cfg.booking.ticketCount);
    await choosePickup(page, cfg.booking.pickupMethod);
    await acceptTerms(page);
    await clickNext(page);

    log('SUCCESS – reached payment screen. Complete payment in the browser.');

    if (HEADED) {
      log('Browser stays open for 15 minutes.');
      await page.waitForTimeout(15 * 60 * 1000);
    }
  } catch (err) {
    console.error('\nAutomation failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (!HEADED) await browser.close();
  }
})();
