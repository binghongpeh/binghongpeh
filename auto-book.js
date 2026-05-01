// Automated login + seat selection for the NEXZ Global Showcase
// "Mmchk : Not Typical" ticket flow.
//
// Usage:
//   1) cp config.example.json config.json  (then fill in your credentials)
//   2) npm install && npm run install:browsers
//   3) npm run book          (headless)
//      npm run book:headed   (visible browser - recommended first run)
//
// The script intentionally pauses for the user to solve the CAPTCHA when one
// appears - that step cannot (and should not) be bypassed automatically.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json. Copy config.example.json to config.json and fill it in.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const HEADED = process.env.HEADED === '1';
const NAV_TIMEOUT = cfg.timing?.navTimeoutMs ?? 30000;

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

async function waitUntilOpen(openTimeISO, leadMs = 1500) {
  if (!openTimeISO) return;
  const target = new Date(openTimeISO).getTime() - leadMs;
  const wait = target - Date.now();
  if (wait > 0) {
    log(`Waiting ${(wait / 1000).toFixed(1)}s until just before open time...`);
    await new Promise(r => setTimeout(r, wait));
  }
}

async function login(page) {
  log('Navigating to login page:', cfg.siteUrl);
  await page.goto(cfg.siteUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

  // Try a few common selectors for username / password fields.
  const userSelectors = [
    'input[name="username"]', 'input[name="user"]', 'input[name="email"]',
    'input[id*="user" i]', 'input[type="email"]', 'input[placeholder*="user" i]'
  ];
  const passSelectors = [
    'input[name="password"]', 'input[id*="pass" i]',
    'input[type="password"]', 'input[placeholder*="pass" i]'
  ];

  const userField = await firstVisible(page, userSelectors);
  const passField = await firstVisible(page, passSelectors);
  if (!userField || !passField) throw new Error('Could not find login fields - update selectors in auto-book.js');

  await userField.fill(cfg.credentials.username);
  await passField.fill(cfg.credentials.password);

  const submit = await firstVisible(page, [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Login")', 'button:has-text("Sign in")',
    'button:has-text("เข้าสู่ระบบ")'
  ]);
  if (!submit) throw new Error('Could not find login submit button');

  // CAPTCHA handling: if a captcha widget is present, ask the user to solve it.
  if (await hasCaptcha(page)) {
    log('CAPTCHA detected - please solve it in the visible browser window. Waiting up to 3 minutes...');
    await page.waitForFunction(() => {
      const el = document.querySelector('input[name="captcha"], #captcha, .captcha');
      return el && (el.value || el.dataset.solved === 'true');
    }, { timeout: 3 * 60 * 1000 }).catch(() => {});
  }

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    submit.click()
  ]);
  log('Login submitted.');
}

async function hasCaptcha(page) {
  return await page.evaluate(() => {
    return !!document.querySelector(
      'iframe[src*="captcha"], iframe[src*="recaptcha"], #captcha, .captcha, [class*="captcha" i]'
    );
  });
}

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function gotoEvent(page) {
  if (!cfg.eventUrl) return;
  log('Navigating to event page:', cfg.eventUrl);
  await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

  // Click "Buy ticket" / "ซื้อบัตร" if present.
  const buy = await firstVisible(page, [
    'a:has-text("Buy")', 'button:has-text("Buy")',
    'a:has-text("ซื้อบัตร")', 'button:has-text("ซื้อบัตร")',
    'a:has-text("Book")', 'button:has-text("Book")'
  ]);
  if (buy) await buy.click();
}

async function selectShowRound(page) {
  if (!cfg.booking.showRound) return;
  const round = page.locator(`:text("${cfg.booking.showRound}")`).first();
  if (await round.count()) {
    log('Selecting show round:', cfg.booking.showRound);
    await round.click().catch(() => {});
  }
}

// Tries to click into the desired zone in the seat-plan SVG/map.
// The zone is identified by visible text like "B1", "A2", etc.
async function selectZone(page, preferredZones) {
  log('Looking for preferred zones:', preferredZones.join(', '));
  await page.waitForLoadState('domcontentloaded');

  for (const zone of preferredZones) {
    // Common patterns: <text>, <a title="B1">, <area alt="B1">, sold-out checks.
    const candidates = [
      `svg text:has-text("${zone}")`,
      `[data-zone="${zone}"]`,
      `[aria-label="${zone}"]`,
      `area[alt="${zone}"]`,
      `a[title="${zone}"]`,
      `:text-is("${zone}")`
    ];

    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if (!(await loc.count())) continue;

      // Skip obviously sold-out zones.
      const className = (await loc.getAttribute('class')) || '';
      if (/sold|disabled|unavailable/i.test(className)) continue;

      log(`Clicking zone ${zone} via selector: ${sel}`);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ force: true });
      await page.waitForTimeout(800);
      return zone;
    }
  }
  throw new Error('No preferred zone was clickable - check the seat plan or update preferredZones.');
}

// Picks the first available seat checkbox/cell in the seat-selection grid.
async function pickSeats(page, count) {
  log(`Picking ${count} available seat(s)...`);
  await page.waitForLoadState('domcontentloaded');

  // Wait for the seat grid to render.
  await page.waitForSelector(
    'input[type="checkbox"][name*="seat" i], .seat:not(.sold):not(.disabled), [data-seat]',
    { timeout: NAV_TIMEOUT }
  );

  const seats = await page.locator(
    'input[type="checkbox"][name*="seat" i]:not([disabled]), ' +
    '.seat.available, .seat:not(.sold):not(.disabled):not(.reserved), ' +
    '[data-seat]:not(.sold):not(.disabled)'
  ).all();

  let picked = 0;
  for (const seat of seats) {
    if (picked >= count) break;
    const isVisible = await seat.isVisible().catch(() => false);
    if (!isVisible) continue;
    try {
      await seat.click({ timeout: 2000 });
      picked++;
    } catch { /* try next */ }
  }
  if (picked < count) throw new Error(`Only picked ${picked}/${count} seats - zone may be sold out.`);
  log(`Picked ${picked} seat(s).`);
}

async function chooseDelivery(page, method) {
  if (!method) return;
  const map = {
    self: ['Self pickup', 'รับเอง', 'รับด้วยตนเอง'],
    ems:  ['EMS']
  };
  const labels = map[method] || [method];
  for (const text of labels) {
    const opt = page.locator(`label:has-text("${text}"), input[value*="${text}" i]`).first();
    if (await opt.count()) {
      await opt.click().catch(() => {});
      log('Selected pickup method:', text);
      return;
    }
  }
}

async function acceptTerms(page) {
  if (!cfg.booking.agreeTerms) return;
  const cb = page.locator('input[type="checkbox"][name*="agree" i], input[type="checkbox"][name*="term" i]').first();
  if (await cb.count() && !(await cb.isChecked().catch(() => false))) {
    await cb.check({ force: true }).catch(() => {});
    log('Accepted terms.');
  }
}

async function submitOrder(page) {
  const next = await firstVisible(page, [
    'button:has-text("Next")', 'button:has-text("ถัดไป")',
    'button:has-text("Confirm")', 'button:has-text("ยืนยัน")',
    'button[type="submit"]'
  ]);
  if (next) {
    log('Submitting order step...');
    await next.click();
  }
}

(async () => {
  await waitUntilOpen(cfg.timing?.openTimeISO, cfg.timing?.preOpenLeadMs);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  try {
    await login(page);
    await gotoEvent(page);
    await selectShowRound(page);
    await selectZone(page, cfg.booking.preferredZones);
    await pickSeats(page, cfg.booking.ticketCount);
    await chooseDelivery(page, cfg.booking.pickupMethod);
    await acceptTerms(page);
    await submitOrder(page);

    log('Reached payment / confirmation screen. Complete payment manually.');
    if (HEADED) {
      log('Browser will stay open for 10 minutes so you can finish payment.');
      await page.waitForTimeout(10 * 60 * 1000);
    }
  } catch (err) {
    console.error('Automation failed:', err.message);
    await page.screenshot({ path: `error-${Date.now()}.png`, fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (!HEADED) await browser.close();
  }
})();
