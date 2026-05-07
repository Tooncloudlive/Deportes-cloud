/**
 * Scraping de escudos desde BeSoccer
 * Compatible con GitHub Actions
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://es.besoccer.com/livescore/televisados';
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveEmptyJson() {
  ensureDir(OUTPUT);

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify([], null, 2),
    'utf-8'
  );

  console.log('[Escudos] JSON vacío guardado');
}

async function scrollToBottom(page) {

  let previousHeight = 0;
  let stableRounds = 0;

  for (let i = 0; i < 60; i++) {

    const currentHeight = await page.evaluate(() => {
      return document.body.scrollHeight;
    });

    console.log(
      `[Escudos] Scroll ${i + 1} | Height ${currentHeight}`
    );

    if (currentHeight === previousHeight) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }

    if (stableRounds >= 4) {
      console.log('[Escudos] Final detectado');
      break;
    }

    previousHeight = currentHeight;

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    await page.waitForTimeout(1500);
  }
}

const SCRAPE_SCRIPT = () => {

  const clean = (s) =>
    (s || '').replace(/\s+/g, ' ').trim();

  const data = [];
  const seen = new Set();

  const selectors = [
    '.match-link',
    '.match',
    '.match-item',
    '.game-item',
    '[data-testid*="match"]',
    'a[href*="/match/"]'
  ];

  const elements = [];

  selectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      elements.push(el);
    });
  });

  const uniqueElements = [...new Set(elements)];

  uniqueElements.forEach(el => {

    const texts = [
      ...el.querySelectorAll('*')
    ]
      .map(x => clean(x.innerText))
      .filter(Boolean);

    const imgs = [
      ...el.querySelectorAll('img')
    ]
      .map(img =>
        img.src ||
        img.getAttribute('data-src') ||
        ''
      )
      .filter(Boolean);

    if (texts.length < 2) return;
    if (imgs.length < 2) return;

    const homeTeam = texts[0];
    const awayTeam = texts[1];

    const key = `${homeTeam} vs ${awayTeam}`;

    if (seen.has(key)) return;

    seen.add(key);

    data.push({
      match: key,
      homeLogo: imgs[0],
      awayLogo: imgs[1]
    });

  });

  return data;
};

async function scrapeEscudos() {

  console.log('[Escudos] Iniciando scraping');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });

  const context = await browser.newContext({
    viewport: {
      width: 1366,
      height: 768
    },

    locale: 'es-ES',

    timezoneId: 'Europe/Madrid',

    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {

    // Anti detection
    await page.addInitScript(() => {

      Object.defineProperty(
        navigator,
        'webdriver',
        {
          get: () => false
        }
      );

    });

    await page.goto(URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    // IMPORTANTE:
    // NO esperar body visible
    // porque Besoccer devuelve body hidden
    // en GitHub Actions

    const html = await page.content();

    if (
      !html ||
      html.length < 1000
    ) {

      console.log(
        '[Escudos] Página vacía detectada'
      );

      saveEmptyJson();
      return;
    }

    await scrollToBottom(page);

    let data = [];

    try {

      data = await page.evaluate(SCRAPE_SCRIPT);

    } catch (e) {

      console.warn(
        '[Escudos] Error evaluando:',
        e.message
      );

    }

    if (!data || data.length === 0) {

      console.log(
        '[Escudos] No se encontraron partidos'
      );

      saveEmptyJson();
      return;
    }

    ensureDir(OUTPUT);

    fs.writeFileSync(
      OUTPUT,
      JSON.stringify(data, null, 2),
      'utf-8'
    );

    console.log(
      `[Escudos] ${data.length} partidos guardados`
    );

  } catch (error) {

    console.warn(
      '[Escudos] Error:',
      error.message
    );

    saveEmptyJson();

    process.exitCode = 0;

  } finally {

    await browser.close();

  }
}

scrapeEscudos().catch(error => {

  console.warn(
    '[Escudos] Error fatal:',
    error.message
  );

  saveEmptyJson();

  process.exitCode = 0;

});
