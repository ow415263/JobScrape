import { test } from '@playwright/test';
import { chromium, Page } from 'patchright';
import fs from 'fs';
import path from 'path';

const SEARCH_QUERY = process.env.GOOGLE_QUERY?.trim() || 'ece jobs';

const TARGET_URL =
  process.env.GOOGLE_JOBS_URL?.trim() ||
  `https://www.google.com/search?q=${encodeURIComponent(SEARCH_QUERY)}&jbr=sep:0&udm=8&ved=2ahUKEwjrivbTjv2PAxXK1fACHZ80KKAQ3L8LegQIKBAM`;

const SHOTS_DIR = path.resolve('screens');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const OUT_PATH = path.resolve('data', 'google.json');
const DUMP_PATH = path.resolve('data', 'google-dump.html');

const SERP_PROXY_SERVER =
  process.env.SERP_PROXY_SERVER || 'http://brd.superproxy.io:33335';
const SERP_PROXY_USERNAME =
  process.env.SERP_PROXY_USERNAME || 'brd-customer-hl_89e14601-zone-serp_api1';
const SERP_PROXY_PASSWORD =
  process.env.SERP_PROXY_PASSWORD || '5mu2hmgs3yc1';

type Job = {
  title: string;
  employer: string;
  location?: string;
  date?: string;
  salary?: string;
  url: string;
};

// ---- helpers ----
async function acceptConsent(page: Page): Promise<void> {
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
  return !!(await page
    .locator('iframe[title*="challenge"], iframe[src*="recaptcha"], text=/unusual traffic|are you a robot|detected unusual/i')
    .first()
    .isVisible()
    .catch(() => false));
}

async function humanize(page: Page) {
  await page.mouse.move(200 + Math.random() * 300, 220 + Math.random() * 220, { steps: 12 });
  await page.waitForTimeout(800 + Math.random() * 600);
  await page.mouse.wheel(0, 400 + Math.random() * 200);
  await page.waitForTimeout(800 + Math.random() * 600);
}

async function gotoWithRetry(page: Page, url: string, tries = 3): Promise<void> {
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

async function loadAllResults(page: Page, maxLoops = 20): Promise<void> {
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

function canonicalizeUrl(input: string): string {
  if (!input) return '';
  try {
    const url = new URL(input);
    if (url.hostname.endsWith('google.com')) {
      const inner = url.searchParams.get('url') || url.searchParams.get('q');
      if (inner) {
        return canonicalizeUrl(decodeURIComponent(inner));
      }
    }
    url.hash = '';
    return url.toString();
  } catch {
    return input;
  }
}

async function isResultsReady(page: Page): Promise<boolean> {
  return (await page
    .locator('div[jscontroller="Q7Rsec"], div.BjJfJf, div.g a[href^="https://www.google.com/url"]')
    .first()
    .isVisible()
    .catch(() => false)) as boolean;
}

async function extractJobs(page: Page): Promise<Job[]> {
  const jobs = await page.evaluate(() => {
    const norm = (val?: string | null) => (val ? val.replace(/\s+/g, ' ').trim() : '');
    const items: Job[] = [];
    document.querySelectorAll('div.BjJfJf, div[jscontroller="Q7Rsec"]').forEach(card => {
      const anchor = card.querySelector<HTMLAnchorElement>('a[href^="https://www.google.com/url"], a[href^="https://www.google.com/aclk"]');
      const title = norm(card.querySelector('[role="heading"], .pMhGee, .FSrVnb')?.textContent);
      if (!anchor || !title) return;
      items.push({
        title,
        employer: norm(card.querySelector('.vNEEBe, .Qk80Jf')?.textContent) || '',
        location: norm(card.querySelector('.Q8LRLc, .r0Qyq')?.textContent) || undefined,
        date: norm(card.querySelector('.wwUB2c, time')?.textContent) || undefined,
        salary: norm(card.querySelector('.LL4CDc, .P2Tf5c, .gv4No, .jlKIjf')?.textContent) || undefined,
        url: anchor.href,
      });
    });
    return items;
  });
  return jobs.filter(j => j.title && j.url);
}

function deduplicateJobs(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  return jobs.filter(job => {
    const canonical = canonicalizeUrl(job.url);
    if (!canonical) return false;
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only test');

test('Google → bypass gates, capture screenshots, extract jobs', async () => {
  test.setTimeout(240_000);

  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const context = await chromium.launchPersistentContext('/tmp/patchright_google', {
      channel: 'chrome',
      headless: false,
      viewport: null,
      ignoreHTTPSErrors: true,
      args: ['--headless=new'],
      proxy: {
        server: SERP_PROXY_SERVER,
        username: SERP_PROXY_USERNAME,
        password: SERP_PROXY_PASSWORD,
      },
    });

    const page = context.pages()[0] || (await context.newPage());

    try {
      await gotoWithRetry(page, TARGET_URL, 3);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'google-before.png'), fullPage: true }).catch(() => {});
      await acceptConsent(page);

      for (let i = 0; i < 5; i++) {
        if (!(await looksLikeGate(page))) break;
        await humanize(page);
        await page.waitForTimeout(1_200 + Math.round(Math.random() * 800));
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await acceptConsent(page);
      }

      const start = Date.now();
      let ready = false;
      while (Date.now() - start < 15_000) {
        if (await isResultsReady(page)) {
          ready = true;
          break;
        }
        await page.waitForTimeout(600);
      }
      if (!ready) throw new Error('Results not ready in allotted time');

      await loadAllResults(page);

      await fs.promises.mkdir(path.dirname(OUT_PATH), { recursive: true }).catch(() => {});
      await fs.promises.writeFile(DUMP_PATH, await page.content(), 'utf8').catch(() => {});

      const jobs = await extractJobs(page);
      const unique = deduplicateJobs(jobs).map(job => ({
        ...job,
        url: canonicalizeUrl(job.url),
      }));

      await fs.promises.writeFile(OUT_PATH, JSON.stringify(unique, null, 2), 'utf8');

      await page.screenshot({ path: path.join(SHOTS_DIR, 'google-after.png'), fullPage: true }).catch(() => {});

      console.log(`✅ Google Jobs: captured ${unique.length} unique listings → ${OUT_PATH}`);
      await context.close();
      return;
    } catch (error) {
      lastErr = error;
      await page
        .screenshot({ path: path.join(SHOTS_DIR, `google-failure-attempt-${attempt + 1}.png`), fullPage: true })
        .catch(() => {});
      console.warn(`Attempt ${attempt + 1} failed: ${String(error)}. Retrying…`);
      await context.close().catch(() => {});
    }
  }

  throw lastErr ?? new Error('Still gated on Google after attempts.');
});
