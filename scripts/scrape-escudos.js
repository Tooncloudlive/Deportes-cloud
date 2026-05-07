// scrape-escudos.mjs
import { chromium } from "playwright";
import fs from "node:fs/promises";

const URL = "https://es.besoccer.com/";
const MAX_SCROLLS = 12;
const MAX_WAIT_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dismissCookies(page) {
  const selectors = [
    "#onetrust-accept-btn-handler",
    'button:has-text("Aceptar")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("Entendido")',
  ];

  for (const selector of selectors) {
    const btn = page.locator(selector).first();
    const count = await btn.count().catch(() => 0);
    if (count > 0) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      return;
    }
  }
}

async function waitForMatches(page) {
  const started = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    const count = await page.locator(".match-link").count().catch(() => 0);
    if (count > 0) return;

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => {});
    await sleep(1200);
  }

  throw new Error("No aparecieron elementos .match-link dentro del tiempo esperado");
}

async function loadMore(page) {
  for (let i = 0; i < MAX_SCROLLS; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
    await sleep(1000);
  }
}

async function extractMatches(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    const getImgSrc = (img) => {
      if (!img) return "";
      return (
        img.getAttribute("src") ||
        img.getAttribute("data-src") ||
        img.getAttribute("data-lazy") ||
        img.getAttribute("data-original") ||
        (img.getAttribute("srcset") || "").split(",")[0]?.trim().split(" ")[0] ||
        ""
      );
    };

    const cards = Array.from(document.querySelectorAll(".match-link"));
    const result = [];

    for (const card of cards) {
      const teams = Array.from(card.querySelectorAll(".team-name"))
        .map((el) => clean(el.textContent))
        .filter(Boolean);

      const shields = Array.from(card.querySelectorAll(".team-shield img, .team-shield, img"));

      if (teams.length >= 2) {
        const homeLogo = getImgSrc(shields[0]);
        const awayLogo = getImgSrc(shields[1]);

        if (homeLogo || awayLogo) {
          result.push({
            match: `${teams[0]} vs ${teams[1]}`,
            homeLogo,
            awayLogo,
          });
        }
      }
    }

    // quitar duplicados
    const seen = new Set();
    return result.filter((item) => {
      const key = `${item.match}|${item.homeLogo}|${item.awayLogo}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

function buildOutput(logosData) {
  let output = "let logosData = [\n";

  logosData.forEach((e) => {
    output += `  { match: ${JSON.stringify(e.match)}, homeLogo: ${JSON.stringify(e.homeLogo)}, awayLogo: ${JSON.stringify(e.awayLogo)} },\n`;
  });

  output += "];";
  return output;
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

    await dismissCookies(page);
    await waitForMatches(page);
    await loadMore(page);

    const logosData = await extractMatches(page);
    const output = buildOutput(logosData);

    await fs.writeFile("logosData.js", output, "utf8");
    await fs.writeFile("logosData.json", JSON.stringify(logosData, null, 2), "utf8");

    console.log(output);
    console.log(`\nOK: ${logosData.length} registros guardados en logosData.js y logosData.json`);
  } catch (err) {
    await page.screenshot({ path: "error.png", fullPage: true }).catch(() => {});
    console.error("SCRAPE_ERROR:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
