/**
 * Scraping de escudos desde BeSoccer MOBILE
 * Optimizado para GitHub Actions
 * - Scroll infinito
 * - Anti bloqueo básico
 * - Fallback seguro
 * - Nunca rompe el workflow
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://m.besoccer.com/livescore/televisados';

const OUTPUT = path.join(
  __dirname,
  '..',
  'data',
  'escudos.json'
);

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

  console.log('[Escudos] Iniciando scroll');

  for (let i = 0; i < 30; i++) {

    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 2);
    });

    console.log(`[Escudos] Scroll ${i + 1}`);

    await page.waitForTimeout(1200);

  }

}

const SCRAPE_SCRIPT = () => {

  const clean = (s) =>
    (s || '')
      .replace(/\s+/g, ' ')
      .trim();

  const isValidText = (text) => {

    if (!text) return false;

    if (text.length < 2) return false;

    const invalid = [
      'directo',
      'tv',
      'live',
      'stream',
      'resultado',
      'clasificación',
      'vs'
    ];

    return !invalid.includes(
      text.toLowerCase()
    );
  };

  const data = [];
  const seen = new Set();

  const containers = [
    ...document.querySelectorAll('article'),
    ...document.querySelectorAll('section'),
    ...document.querySelectorAll('div'),
    ...document.querySelectorAll('a'),
    ...document.querySelectorAll('li')
  ];

  containers.forEach(el => {

    const imgs = [
      ...el.querySelectorAll('img')
    ]
      .map(img =>
        img.src ||
        img.getAttribute('data-src') ||
        img.getAttribute('srcset') ||
        ''
      )
      .filter(src =>
        src &&
        (
          src.includes('resfu') ||
          src.includes('shield') ||
          src.includes('team') ||
          src.includes('logo')
        )
      );

    // Necesitamos mínimo 2 escudos
    if (imgs.length < 2) return;

    const texts = [
      ...el.querySelectorAll('*')
    ]
      .map(x => clean(x.innerText))
      .filter(isValidText);

    const uniqueTexts = [...new Set(texts)];

    if (uniqueTexts.length < 2) return;

    const homeTeam = uniqueTexts[0];
    const awayTeam = uniqueTexts[1];

    const key =
      `${homeTeam} vs ${awayTeam}`;

    if (seen.has(key)) return;

    seen.add(key);

    data.push({
      match: key,
      homeLogo: imgs[0],
      awayLogo: imgs[1]
    });

    console.log(
      '[SCRAPE]',
      key
    );

  });

  return data;
};

async function scrapeEscudos() {

  console.log(
    '[Escudos] Iniciando scraping de',
    URL
  );

  const browser = await chromium.launch({
    headless: true,

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context =
    await browser.newContext({

      viewport: {
        width: 390,
        height: 844
      },

      isMobile: true,

      hasTouch: true,

      locale: 'es-ES',

      timezoneId: 'Europe/Madrid',

      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    });

  const page = await context.newPage();

  try {

    // Anti webdriver
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

    // DEBUG
    const html =
      await page.content();

    console.log(
      '[Escudos] HTML length:',
      html.length
    );

    // Screenshot para GitHub Actions
    await page.screenshot({
      path: 'besoccer-debug.png',
      fullPage: true
    });

    console.log(
      '[Escudos] Screenshot guardado'
    );

    // Si sigue vacío
    if (html.length < 1000) {

      console.log(
        '[Escudos] Página vacía detectada'
      );

      saveEmptyJson();

      return;
    }

    // Scroll infinito
    await scrollToBottom(page);

    // Scraping
    let data = [];

    try {

      data =
        await page.evaluate(
          SCRAPE_SCRIPT
        );

    } catch (e) {

      console.warn(
        '[Escudos] Error evaluando:',
        e.message
      );

    }

    if (
      !data ||
      data.length === 0
    ) {

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

    // NO romper GitHub Actions
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
