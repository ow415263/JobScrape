import { test, expect, Page } from '@playwright/test';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

chromium.use(StealthPlugin());

const TARGET_URL =
  'https://www.google.com/search?q=ece%20jobs&jbr=sep:0&udm=8&ved=2ahUKEwjrivbTjv2PAxXK1fACHZ80KKAQ3L8LegQIKBAM';

const SHOTS_DIR = path.resolve('screens');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const SERP_USER = 'brd-customer-hl_89e14601-zone-serp_api1';
const SERP_PASS = '5mu2hmgs3yc1';
const COUNTRY = 'ca';

function serpProxy() {
  const session = `session-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    server: 'http://brd.superproxy.io:22225',
    username: `${SERP_USER}-${session}-country-${COUNTRY}`,
    password: SERP_PASS,
  };
}

async function acceptConsent(page: Page) {
  for (const f of page.frames()) {
    const btn = f.locator('button#L2AGLb, #W0wltc, button:has-text("I agree"), button:has-text("Accept all")').first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      return;
    }
  }
  const top = page.locator('button#L2AGLb, #W0wltc, button:has-text("I agree"), button:has-text("Accept all")').first();
  if (await top.isVisible().catch(() => false)) await top.click({ timeout: 3000 }).catch(() => {});
}

async function looksLikeGate(page: Page) {
  const texts = [/unusual traffic/i, /verify you'?re? a human/i, /before you continue/i, /detected unusual/i];
  for (const t of texts) {
    if (await page.getByText(t).first().isVisible().catch(() => false)) return true;
  }
  const recaptcha = await page
    .locator('iframe[title*="challenge"], iframe[title*="captcha"], iframe[src*="recaptcha"]')
    .count();
  const results = await page.locator('#search, #rcnt').count();
  return recaptcha > 0 && results === 0;
}

async function humanize(page: Page) {
  await page.mouse.move(200 + Math.random() * 300, 220 + Math.random() * 220, { steps: 12 });
  await page.waitForTimeout(350 + Math.round(Math.random() * 450));
  await page.mouse.wheel(0, 300 + Math.round(Math.random() * 400));
  await page.waitForTimeout(350 + Math.round(Math.random() * 450));
}

async function gotoWithRetry(page: Page, url: string, tries = 3) {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(800);
    }
  }
  throw lastErr ?? new Error('Navigation failed');
}

async function loadAllResults(page: Page, maxLoops = 20) {
  let lastH = 0;
  for (let i = 0; i < maxLoops; i++) {
    const more = page.locator('text=More results, #pnnext').first();
    if (await more.isVisible().catch(() => false)) {
      await more.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    const h = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(900 + Math.round(Math.random() * 600));
    if (h === lastH) break;
    lastH = h;
  }
}

// chromium-only
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only test');

test('Google → full-page before/after screenshots (Chromium only)', async () => {
  test.setTimeout(240_000);

  const proxy = serpProxy();
  const browser = await chromium.launch({ headless: true, proxy });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport: { width: 1290, height: 900 },
    extraHTTPHeaders: { 'accept-language': 'en-CA,en;q=0.9' },
  });

  const page = await context.newPage();

  try {
    // BEFORE (full page as-is)
    await gotoWithRetry(page, TARGET_URL, 3);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'google-before.png'), fullPage: true }).catch(() => {});

    // Consent + light gate handling
    await acceptConsent(page);
    for (let i = 0; i < 4; i++) {
      if (!(await looksLikeGate(page))) break;
      await humanize(page);
      await page.waitForTimeout(900 + Math.round(Math.random() * 800));
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    // Confirm results container exists
    try {
      await expect(page.locator('#search')).toBeVisible({ timeout: 15_000 });
    } catch {
      await expect(page.locator('#rcnt')).toBeVisible({ timeout: 15_000 });
    }

    // Load the whole results list (so fullPage truly captures the bottom)
    await loadAllResults(page);

    // AFTER (true full-page)
    await page.screenshot({ path: path.join(SHOTS_DIR, 'google-after.png'), fullPage: true });

    console.log(`✅ Google full-page screenshots captured via SERP username: ${proxy.username}`);
  } finally {
    await browser.close().catch(() => {});
  }
});
