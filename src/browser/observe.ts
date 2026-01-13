import { Page } from "playwright";

export interface InteractiveElement {
  tag: string;
  role: string | null;
  text: string;
  selector: string;
}

export interface PageObservation {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  visibleText: string;
}

export async function observePage(page: Page): Promise<PageObservation> {
  const url = page.url();
  const title = await page.title();

  const interactiveElements = await page.evaluate(() => {
    const selectors = [
      "a",
      "button",
      "input",
      "select",
      "textarea",
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[onclick]',
    ];

    const elements: {
      tag: string;
      role: string | null;
      text: string;
      selector: string;
    }[] = [];

    const seen = new Set<Element>();

    for (const selector of selectors) {
      const found = document.querySelectorAll(selector);
      for (const el of found) {
        if (seen.has(el)) continue;
        seen.add(el);

        const htmlEl = el as HTMLElement;
        if (htmlEl.offsetParent === null && htmlEl.tagName !== "BODY") {
          continue;
        }

        const testId = el.getAttribute("data-testid");
        let selectorStr = testId
          ? `[data-testid="${testId}"]`
          : el.id
            ? `#${el.id}`
            : el.className && typeof el.className === "string"
              ? `${el.tagName.toLowerCase()}.${el.className.split(" ").filter(Boolean).join(".")}`
              : el.tagName.toLowerCase();

        const text =
          htmlEl.innerText?.slice(0, 100) ||
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          "";

        elements.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          text: text.trim(),
          selector: selectorStr,
        });
      }
    }

    return elements.slice(0, 100);
  });

  const visibleText = await page.evaluate(() => {
    return document.body?.innerText?.slice(0, 5000) || "";
  });

  return {
    url,
    title,
    interactiveElements,
    visibleText,
  };
}
