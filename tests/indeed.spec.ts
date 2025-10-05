import { test, expect, Page, BrowserContext } from '@playwright/test';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

chromium.use(StealthPlugin());

const START_URL =
  process.env.START_URL ||
  'https://ca.indeed.com/jobs?q=ece&l=toronto%2C+on&radius=25';

const SHOTS_DIR = path.resolve('screens');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

// Your Bright Data proxies (we’ll add sticky session & CA exit to usernames)
type ProxyAuth = { server: string; username: string; password: string };
const BASE_PROXIES: ProxyAuth[] = [
  { server: 'http://brd.superproxy.io:33335', username: 'brd-customer-hl_89e14601-zone-residential_proxy1', password: 'iplu2iawmm2z' },
  { server: 'http://brd.superproxy.io:33335', username: 'brd-customer-hl_89e14601-zone-residential_proxy2', password: 'wekc39rm8od1' },
  { server: 'http://brd.superproxy.io:33335', username: 'brd-customer-hl_89e14601-zone-residential_proxy3', password: '5iymfyjztb7u' },
];

function stickyUser(u: string): string {
  const sess = `session-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let out = u.includes('-session-') ? u : `${u}-${sess}`;
  if (!/-country-/.test(out)) out = `${out}-country-ca`; // CA exit tends to help for Indeed CA
  return out;
}
function pickProxy(i: number): ProxyAuth {
  const b = BASE_PROXIES[i % BASE_PROXIES.length];
  return { ...b, username: stickyUser(b.username) };
}

async function isGate(page: Page): Promise<boolean> {
  const gates = [
    /Verify you are human/i,
    /Checking your browser/i,
    /Just a moment/i,
    /Additional Verification Required/i,
  ];
  for (const g of gates) {
    const el = page.getByText(g).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) return true;
  }
  const hasTurnstile = await page
    .locator('iframe[title*="cf"], iframe[title*="Cloudflare"], iframe[src*="challenge"], iframe[title*="Turnstile"]')
    .first()
    .count();
  const hasList = await page.locator('#mosaic-provider-jobcards').first().count();
  return hasTurnstile > 0 && hasList === 0;
}

async function injectCookies(context: BrowserContext): Promise<void> {
  // Optional: CF cookies from a manual solve: CF_COOKIES='cf_clearance=...; __cf_bm=...'
  const raw = process.env.CF_COOKIES?.trim();
  if (!raw) return;
  const cookies = raw
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(kv => {
      const [name, ...rest] = kv.split('=');
      return {
        name,
        value: rest.join('='),
        domain: '.indeed.com',
        path: '/',
        httpOnly: true,
        secure: true,
      };
    });
  if (cookies.length) await context.addCookies(cookies as any);
}

async function acceptCookies(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  const btn = page.locator('#onetrust-accept-btn-handler, button:has-text("Accept All Cookies")').first();
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
}

async function humanize(page: Page): Promise<void> {
  const jitter = () => 120 + Math.round(Math.random() * 420);
  await page.waitForTimeout(jitter());
  await page.mouse.move(
    200 + Math.random() * 400,
    200 + Math.random() * 300,
    { steps: 10 + Math.floor(Math.random() * 10) }
  );
  await page.waitForTimeout(jitter());
}

test('Indeed → pass Cloudflare then confirm cards (before/after screenshots)', async () => {
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

    await injectCookies(context);
    const page = await context.newPage();

    try {
      // Home first (lighter), then query
      await page.goto('https://ca.indeed.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await humanize(page);
      await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await acceptCookies(page);

      // BEFORE screenshot (pre-solve state)
      await page.screenshot({ path: path.join(SHOTS_DIR, 'indeed-before.png'), fullPage: true });

      // CF auto-verify loop
      for (let i = 0; i < 8; i++) {
        if (!(await isGate(page))) break;
        await page.mouse.move(200 + i * 30, 200 + i * 20);
        await page.waitForTimeout(900 + Math.floor(Math.random() * 1100));
      }

      if (await isGate(page)) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
      }

      if (await isGate(page)) {
        await page.screenshot({ path: path.join(SHOTS_DIR, `indeed-gate-attempt-${attempt + 1}.png`), fullPage: true }).catch(() => {});
        throw new Error('Cloudflare gate persisted');
      }

      // Confirm results and AFTER screenshot
      await expect(page.locator('#mosaic-provider-jobcards')).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: path.join(SHOTS_DIR, 'indeed-after.png'), fullPage: true });

      console.log(`✅ Ready using proxy username: ${proxy.username}`);
      await browser.close();
      return; // success
    } catch (e) {
      lastErr = e;
      console.warn(`Attempt ${attempt + 1} failed: ${String(e)} → rotating proxy…`);
      await browser.close().catch(() => {});
    }
  }

  throw lastErr ?? new Error('Still on Cloudflare after attempts.');
});
