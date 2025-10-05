// tests/jobbank.spec.ts
import { test, expect, Page, BrowserContext } from '@playwright/test';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

chromium.use(StealthPlugin());

// Target page (results list)
const TARGET_URL =
  'https://www.jobbank.gc.ca/jobsearch/jobsearch?fn21=42202&page=1&sort=M&fprov=ON';

const SHOTS_DIR = path.resolve('screens');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

// --- Your Bright Data residential proxies (same as Indeed) ---
type ProxyAuth = { server: string; username: string; password: string };
const BASE_PROXIES: ProxyAuth[] = [
  { server: 'http://brd.superproxy.io:33335', username: 'brd-customer-hl_89e14601-zone-residential_proxy1', password: 'iplu2iawmm2z' },
  { server: 'http://brd.superproxy.io:33335', username: 'brd-customer-hl_89e14601-zone-residential_proxy2', password: 'wekc39rm8od1' },
  { server: 'http://brd.superproxy.io:33335', username: 'brd-customer-hl_89e14601-zone-residential_proxy3', password: '5iymfyjztb7u' },
];

function stickyUser(u: string) {
  const sess = `session-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let out = u.includes('-session-') ? u : `${u}-${sess}`;
  if (!/-country-/.test(out)) out = `${out}-country-ca`; // CA exit helps here
  return out;
}
function pickProxy(i: number): ProxyAuth {
  const b = BASE_PROXIES[i % BASE_PROXIES.length];
  return { ...b, username: stickyUser(b.username) };
}

// ---- helpers ----
async function acceptConsent(page: Page): Promise<void> {
  // Generic cookie/consent banners
  const btn = page
    .locator(
      [
        '#onetrust-accept-btn-handler',
        'button:has-text("Accept all")',
        'button:has-text("Accept All")',
        'button:has-text("I agree")',
        'button:has-text("Got it")',
      ].join(', ')
    )
    .first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function looksLikeGate(page: Page): Promise<boolean> {
  const texts = [
    /captcha/i,
    /verify you/i,
    /are you a robot/i,
    /unusual traffic/i,
    /access denied/i,
    /additional verification required/i,
  ];
  for (const t of texts) {
    if (await page.getByText(t).first().isVisible().catch(() => false)) return true;
  }
  const recaptcha = await page
    .locator('iframe[title*="challenge"], iframe[title*="captcha"], iframe[src*="recaptcha"]')
    .count();
  // If there are no obvious results anchors but a captcha frame is present, call it a gate.
  const hasJobLinks = await page.locator('a[href*="/jobsearch/jobposting/"]').count();
  return recaptcha > 0 && hasJobLinks === 0;
}

async function humanize(page: Page): Promise<void> {
  await page.mouse.move(200 + Math.random() * 400, 220 + Math.random() * 240, { steps: 10 + Math.floor(Math.random() * 8) });
  await page.waitForTimeout(350 + Math.round(Math.random() * 450));
  await page.mouse.wheel(0, 300 + Math.round(Math.random() * 500));
  await page.waitForTimeout(350 + Math.round(Math.random() * 450));
}

async function loadAllResults(page: Page, maxLoops = 12): Promise<void> {
  let lastH = 0;
  for (let i = 0; i < maxLoops; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(800 + Math.round(Math.random() * 600));
    if (h === lastH) break;
    lastH = h;
  }
}

async function isResultsReady(page: Page): Promise<boolean> {
  // Look for any job posting link
  return (await page.locator('a[href*="/jobsearch/jobposting/"]').first().isVisible().catch(() => false)) === true;
}

// Chromium only
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only test');

test('JobBank → pass consent/captcha then full-page before/after screenshots (Chromium only)', async () => {
  test.setTimeout(240_000);

  let lastErr: unknown;
  const MAX_ATTEMPTS = Math.max(3, BASE_PROXIES.length * 3);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const proxy = pickProxy(attempt);

    const browser = await chromium.launch({
      headless: true,
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
    });

    const context = await browser.newContext({
      ignoreHTTPSErrors: true, // proxy MITM certs
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-CA',
      timezoneId: 'America/Toronto',
      viewport: { width: 1290, height: 900 },
      extraHTTPHeaders: { 'accept-language': 'en-CA,en;q=0.9' },
    });

    const page = await context.newPage();

    try {
      // BEFORE (as-is)
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.screenshot({ path: path.join(SHOTS_DIR, 'jobbank-before.png'), fullPage: true }).catch(() => {});

      // Handle consent + light gating
      await acceptConsent(page);
      for (let i = 0; i < 5; i++) {
        if (!(await looksLikeGate(page))) break;
        await humanize(page);
        await page.waitForTimeout(900 + Math.round(Math.random() * 700));
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await acceptConsent(page);
      }

      // Confirm we’re looking at results (at least one job link)
      await expect(async () => {
        if (!(await isResultsReady(page))) throw new Error('results not ready');
      }).toPass({ timeout: 15_000, intervals: [500, 800, 1000] });

      // Scroll to bottom so fullPage grabs everything
      await loadAllResults(page);

      // AFTER
      await page.screenshot({ path: path.join(SHOTS_DIR, 'jobbank-after.png'), fullPage: true });

      console.log(`✅ JobBank ready via proxy username: ${proxy.username}`);
      await browser.close();
      return; // success
    } catch (e) {
      lastErr = e;
      await page.screenshot({ path: path.join(SHOTS_DIR, `jobbank-gate-attempt-${attempt + 1}.png`), fullPage: true }).catch(() => {});
      console.warn(`Attempt ${attempt + 1} failed: ${String(e)} → rotating proxy…`);
      await browser.close().catch(() => {});
    }
  }

  throw lastErr ?? new Error('Still gated on JobBank after attempts.');
});
