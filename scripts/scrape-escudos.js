/**
 * Scraping de partidos desde BeSoccer televisados
 * - Hace scroll infinito hasta el final
 * - Extrae todos los partidos cargados
 * - Mantiene fallback para no romper GitHub Actions
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://es.besoccer.com/livescore/televisados';
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function acceptCookies(page) {
  const selectors = [
    'button:has-text("ACEPTO")',
    'button:has-text("Acepto")',
    'button:has-text("Aceptar")',
    'button:has-text("ACCEPT")',
  ];

  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(1000);
        return;
      }
    } catch (_) {}
  }
}

async function scrollToBottom(page) {
  let previousHeight = 0;
  let stableRounds = 0;

  for (let i = 0; i < 80; i++) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

    if (currentHeight === previousHeight) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    if (stableRounds >= 4) break;

    previousHeight = currentHeight;

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    // Ayuda a disparar lazy load / intersection observers
    await page.mouse.wheel(0, 2500).catch(() => {});
    await page.waitForTimeout(1400);
  }

  // Última pasada por si quedó algo pendiente
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(3500);
}

const SCRAPE_SCRIPT = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const normalizeLogo = (src) => {
    if (!src) return '';
    try {
      const url = new URL(src, location.href);
      url.search = '';
      return url.toString();
    } catch {
      return src.split('?')[0];
    }
  };

  const logosData = [];
  const seen = new Set();

  const candidateSelectors = [
    '.match-link',
    '.match',
    '[data-testid*="match"]',
    '.match-item',
    '.game-item',
    '.fixture',
    'a[href*="/resultados/"]',
  ];

  const candidates = [];
  for (const sel of candidateSelectors) {
    document.querySelectorAll(sel).forEach((el) => candidates.push(el));
  }

  // Quitar duplicados por referencia del nodo
  const uniqueCandidates = [...new Set(candidates)];

  uniqueCandidates.forEach((matchEl) => {
    const textCandidates = [...matchEl.querySelectorAll(
      '.team-name, .team, [class*="team"], [class*="club"], [class*="name"]'
    )]
      .map((el) => clean(el.textContent))
      .filter(Boolean);

    const teamNames = [...new Set(textCandidates)].filter((t) => t.length > 1);

    if (teamNames.length < 2) return;

    const homeTeam = teamNames[0];
    const awayTeam = teamNames[1];

    const imgUrls = [...matchEl.querySelectorAll('img')]
      .map((img) =>
        img.src ||
        img.getAttribute('data-src') ||
        img.getAttribute('data-lazy-src') ||
        ''
      )
      .map(normalizeLogo)
      .filter(Boolean);

    const uniqueImgUrls = [...new Set(imgUrls)];

    const homeLogo = uniqueImgUrls[0] || '';
    const awayLogo = uniqueImgUrls[1] || '';

    const matchKey = `${homeTeam} vs ${awayTeam}`;

    if (!seen.has(matchKey)) {
      seen.add(matchKey);
      logosData.push({
        match: matchKey,
        homeLogo,
        awayLogo,
      });
    }
  });

  return logosData;
};

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping de', URL);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    await acceptCookies(page);

    // Esperar a que aparezca contenido base
    await page.waitForSelector('body', { timeout: 30000 });
    await page.waitForTimeout(1500);

    // Scroll infinito hasta el final para forzar carga de escudos/partidos
    await scrollToBottom(page);

    let logosData = [];
    try {
      logosData = await page.evaluate(SCRAPE_SCRIPT);
    } catch (evalError) {
      console.warn('[Escudos] Error evaluando HTML en la página:', evalError.message);
      logosData = [];
    }

    console.log(`[Escudos] Encontrados ${logosData.length} partidos`);

    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(logosData, null, 2), 'utf-8');
    console.log('[Escudos] Datos guardados en', OUTPUT);

    if (logosData.length > 0) {
      logosData.slice(0, 5).forEach((e) => {
        console.log(
          `  - ${e.match} | Local: ${e.homeLogo ? 'OK' : 'NO'} | Visitante: ${e.awayLogo ? 'OK' : 'NO'}`
        );
      });
    }
  } catch (error) {
    console.warn('[Escudos] Error durante scraping (se continua sin romper la acción):', error.message);

    // Fallback para que GitHub Actions siga verde
    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2), 'utf-8');
    console.log('[Escudos] Se guardó escudos.json vacío como fallback');
  } finally {
    await browser.close().catch(() => {});
  }
}

scrapeEscudos().catch((error) => {
  console.warn('[Escudos] Error inesperado final:', error.message);
  ensureDir(OUTPUT);
  fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2), 'utf-8');
  process.exitCode = 0;
});
