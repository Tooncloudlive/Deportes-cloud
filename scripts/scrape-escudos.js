// scripts/scrape-escudos.mjs
import { chromium } from "playwright";
import fs from "node:fs/promises";

const URL = "https://es.besoccer.com/";
const OUTPUT = "escudos.json";
const MAX_WAIT_MS = 60000;
const MAX_SCROLLS = 12;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryDismissCookies(page) {
  const selectors = [
    "#onetrust-accept-btn-handler",
    'button:has-text("Aceptar")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
  ];

  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      return;
    }
  }
}

async function waitForAnyMatch(page, timeoutMs = MAX_WAIT_MS) {
  const selectors = [
    ".match-link",
    "a.match-link",
    '[data-testid="match-link"]',
  ];

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) return selector;
    }

    await page.mouse.wheel(0, 1800).catch(() => {});
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => {});
    await sleep(1200);
  }

  throw new Error(`No apareció ningún partido con estos selectores: ${selectors.join(", ")}`);
}

async function extractData(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    const getUrlFromMedia = (el) => {
      if (!el) return "";

      const img = el.querySelector("img");
      if (img) {
        return (
          img.getAttribute("src") ||
          img.getAttribute("data-src") ||
          img.getAttribute("data-lazy") ||
          (img.getAttribute("srcset") || "").split(",")[0]?.trim().split(" ")[0] ||
          ""
        );
      }

      return "";
    };

    const cards = Array.from(document.querySelectorAll(".match-link"));

    const rows = cards.map((card) => {
      const names = Array.from(card.querySelectorAll(".team-name"))
        .map((el) => clean(el.textContent))
        .filter(Boolean);

      const logos = Array.from(card.querySelectorAll(".team-shield, figure, picture, img"));

      const homeLogo = getUrlFromMedia(logos[0]);
      const awayLogo = getUrlFromMedia(logos[1]);

      const match =
        names.length >= 2
          ? `${names[0]} vs ${names[1]}`
          : clean(card.textContent).slice(0, 120);

      return {
        match,
        homeLogo,
        awayLogo,
      };
    });

    // Elimina duplicados vacíos
    const seen = new Set();
    return rows.filter((row) => {
      const key = `${row.match}|${row.homeLogo}|${row.awayLogo}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return row.homeLogo || row.awayLogo;
    });
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: process.env.CI ? "new" : false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 2200 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  page.setDefaultTimeout(45000);

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(2500);

    await tryDismissCookies(page);

    const selector = await waitForAnyMatch(page, MAX_WAIT_MS);
    await page.waitForSelector(selector, { state: "attached", timeout: 45000 });

    for (let i = 0; i < MAX_SCROLLS; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
      await sleep(900);
    }

    const data = await extractData(page);

    await fs.writeFile(OUTPUT, JSON.stringify(data, null, 2), "utf8");
    console.log(`OK: ${data.length} registros guardados en ${OUTPUT}`);
  } catch (err) {
    await page.screenshot({ path: "error.png", fullPage: true }).catch(() => {});
    console.error("SCRAPE_ERROR:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
