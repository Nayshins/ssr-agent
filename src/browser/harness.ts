import { chromium, Browser, BrowserContext, Page } from "playwright";

let browser: Browser | null = null;

export interface BrowserHarness {
  context: BrowserContext;
  page: Page;
}

export async function createBrowserContext(
  headless: boolean = true
): Promise<BrowserHarness> {
  browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

export async function closeBrowserContext(harness: BrowserHarness): Promise<void> {
  await harness.context.close();
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export async function captureScreenshot(
  page: Page,
  path: string
): Promise<void> {
  await page.screenshot({ path, fullPage: true });
}

export async function startTrace(context: BrowserContext): Promise<void> {
  await context.tracing.start({ screenshots: true, snapshots: true });
}

export async function stopTrace(
  context: BrowserContext,
  path: string
): Promise<void> {
  await context.tracing.stop({ path });
}
