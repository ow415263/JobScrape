import { test } from '@playwright/test';
import { chromium, Page } from 'patchright';
import fs from 'fs';
import path from 'path';

const START_URL =
  process.env.INDEED_START_URL?.trim() ||
  'https://ca.indeed.com/jobs?q=ece&l=toronto%2C+on&radius=25';

const SHOTS_DIR = path.resolve('screens');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const OUT_PATH = path.resolve('data', 'indeed.json');
const HTML_DUMP_PATH = path.resolve('data', 'indeed-dump.html');
const MAX_PAGES = Number(process.env.INDEED_PAGES || 3);

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
  await page.keyboard.press('Escape').catch(() => {});
  const modalDismiss = page.locator('button[aria-label="Close"], button[title="Close"], button:has-text("No thanks")').first();
  if (await modalDismiss.isVisible().catch(() => false)) {
    await modalDismiss.click().catch(() => {});
  }
  const accept = page
    .locator(
      [
        '#onetrust-accept-btn-handler',
        'button:has-text("Accept All Cookies")',
        'button:has-text("Accept all cookies")',
        'button:has-text("Accept Cookies")',
      ].join(', ')
    )
    .first();
  if (await accept.isVisible().catch(() => false)) {
    await accept.click().catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function looksLikeGate(page: Page): Promise<boolean> {
  const phrases = [
    /verify you are human/i,
    /checking your browser/i,
    /just a moment/i,
    /additional verification required/i,
    /robot check/i,
  ];
  for (const text of phrases) {
    const node = page.getByText(text).first();
    if ((await node.count()) > 0 && (await node.isVisible().catch(() => false))) return true;
  }
  const gateFrames = await page
    .locator('iframe[title*="cf"], iframe[title*="Cloudflare"], iframe[src*="challenge"], iframe[title*="Turnstile"]')
    .count();
  const jobCards = await page.locator('#mosaic-provider-jobcards, a.tapItem').count();
  return gateFrames > 0 && jobCards === 0;
}

async function humanize(page: Page): Promise<void> {
  const delay = () => 1800 + Math.round(Math.random() * 2200);
  await page.waitForTimeout(delay());
  await page.mouse.move(220 + Math.random() * 420, 220 + Math.random() * 260, { steps: 10 + Math.floor(Math.random() * 8) });
  await page.waitForTimeout(400 + Math.round(Math.random() * 400));
  await page.mouse.wheel(0, 320 + Math.round(Math.random() * 280));
  await page.waitForTimeout(400 + Math.round(Math.random() * 400));
}

async function waitForResults(page: Page, timeout = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await page.locator('a.tapItem, a[data-jk], .jobsearch-ResultsList').first().isVisible().catch(() => false);
    if (ready) return;
    await page.waitForTimeout(400);
  }
  throw new Error('Indeed results not ready in allotted time');
}

async function extractJobs(page: Page): Promise<Job[]> {
  return page.evaluate(() => {
    const clean = (value?: string | null) => (value ? value.replace(/\s+/g, ' ').trim() : undefined);
    const jobs: Job[] = [];
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('div.job_seen_beacon, li.job_seen_beacon, div.cardOutline, a.tapItem')
    );

    for (const card of cards) {
      const anchor =
        (card.matches('a') ? (card as HTMLAnchorElement) : card.querySelector<HTMLAnchorElement>('a.tapItem, a[id^="job_"]')) ||
        null;
      const titleEl = card.querySelector('[data-testid="jobTitle"], h2.jobTitle, h2 a');
      const employerEl = card.querySelector('[data-testid="company-name"], span.companyName');
      const locationEl = card.querySelector('[data-testid="text-location"], div.companyLocation');
      const dateEl = card.querySelector('[data-testid="myJobsStateDate"], span.date, .jobsearch-JobMetadataFooter');
      const salaryEl = card.querySelector('[data-testid="attribute_snippet_testId"], .salary-snippet, .attribute_snippet');

      if (!anchor || !titleEl) continue;

      const href = anchor.getAttribute('href') || anchor.href || '';
      let url = '';
      try {
        const abs = new URL(href, window.location.origin);
        abs.hash = '';
        url = abs.toString();
      } catch {
        url = href;
      }

      const job: Job = {
        title: clean(titleEl.textContent) || '',
        employer: clean(employerEl?.textContent) || '',
        location: clean(locationEl?.textContent),
        date: clean(dateEl?.textContent),
        salary: clean(salaryEl?.textContent),
        url,
      };

      if (job.title && job.url) jobs.push(job);
    }

    return jobs;
  });
}

function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = '';
    url.searchParams.delete('from');
    url.searchParams.delete('vjk');
    url.searchParams.delete('advn');
    url.searchParams.delete('adid');
    return url.toString();
  } catch {
    return input.split('#')[0].split('?')[0];
  }
}

function deduplicateJobs(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  return jobs.filter(job => {
    const canonical = canonicalizeUrl(job.url);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    job.url = canonical;
    return true;
  });
}

async function goToStart(page: Page): Promise<void> {
  await page.goto('https://ca.indeed.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await humanize(page);
  await page.waitForTimeout(600 + Math.round(Math.random() * 600));
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
}

async function loadNextPage(page: Page): Promise<boolean> {
  const next = page.locator('a[aria-label="Next"], button[aria-label="Next"]').first();
  if (!(await next.isVisible().catch(() => false))) return false;

  await next.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400 + Math.round(Math.random() * 400));
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
    next.click({ timeout: 8_000 }).catch(() => {}),
  ]);

  await page.waitForTimeout(600 + Math.round(Math.random() * 600));
  return true;
}

// ---- main test ----

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only test');
test.skip(() => !!process.env.CI, 'Skip Indeed scraper in CI environment');

test('Indeed → bypass gate, paginate, extract jobs', async () => {
  test.setTimeout(240_000);

  let lastErr: unknown;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const context = await chromium.launchPersistentContext('/tmp/patchright_indeed', {
      channel: 'chrome',
      headless: false,
      viewport: null,
      ignoreHTTPSErrors: true,
      args: ['--headless=new'],
    });

    const page = context.pages()[0] || (await context.newPage());

    try {
      await goToStart(page);
      await acceptConsent(page);

      for (let gateRetry = 0; gateRetry < 6; gateRetry++) {
        if (!(await looksLikeGate(page))) break;
        await humanize(page);
        await page.waitForTimeout(1_000 + Math.round(Math.random() * 800));
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await acceptConsent(page);
      }

      if (await looksLikeGate(page)) {
        await page.screenshot({
          path: path.join(SHOTS_DIR, `indeed-gate-attempt-${attempt + 1}.png`),
          fullPage: true,
        }).catch(() => {});
        throw new Error('Cloudflare gate persisted after retries');
      }

      const allJobs: Job[] = [];

      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
        await waitForResults(page);
        await page.screenshot({
          path: path.join(SHOTS_DIR, `indeed-page-${pageIndex + 1}.png`),
          fullPage: true,
        }).catch(() => {});

        if (pageIndex === 0) {
          await fs.promises.writeFile(HTML_DUMP_PATH, await page.content(), 'utf8').catch(() => {});
        }

        const pageJobs = await extractJobs(page);
        allJobs.push(...pageJobs);

        if (pageIndex === MAX_PAGES - 1) break;
        const advanced = await loadNextPage(page);
        if (!advanced) break;
      }

      const unique = deduplicateJobs(allJobs);
      await fs.promises.mkdir(path.dirname(OUT_PATH), { recursive: true });
      await fs.promises.writeFile(OUT_PATH, JSON.stringify(unique, null, 2), 'utf8');

      await page.screenshot({ path: path.join(SHOTS_DIR, 'indeed-after.png'), fullPage: true }).catch(() => {});
      console.log(`✅ Indeed: extracted ${unique.length} unique jobs → ${OUT_PATH}`);

      await context.close();
      return;
    } catch (error) {
      lastErr = error;
      const dumpPath = path.join(path.dirname(HTML_DUMP_PATH), `indeed-error-attempt-${attempt + 1}.html`);
      await fs.promises
        .writeFile(dumpPath, await page.content().catch(() => '<!-- failed to capture HTML -->'), 'utf8')
        .catch(() => {});
      await page
        .screenshot({ path: path.join(SHOTS_DIR, `indeed-failure-attempt-${attempt + 1}.png`), fullPage: true })
        .catch(() => {});
      console.warn(`Attempt ${attempt + 1} failed: ${String(error)}. Retrying…`);
      await context.close().catch(() => {});
    }
  }

  throw lastErr ?? new Error('Indeed scrape failed after retries');
});
