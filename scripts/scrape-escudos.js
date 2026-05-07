/**
 * Scraping de escudos desde es.besoccer.com
 * Extrae: nombre del partido, escudo local, escudo visitante
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://es.besoccer.com/';
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');

// Script que se ejecuta en el navegador
const SCRAPE_SCRIPT = () => {
  const logosData = [];
  const seen = new Set();

  // Intentar múltiples selectores porque Besoccer cambia estructura seguido
  const matchSelectors = ['.match-link', '.match', '[data-testid="match"]', '.match-item', '.game-item'];
  let matches = [];

  for (const sel of matchSelectors) {
    matches = document.querySelectorAll(sel);
    if (matches.length > 0) break;
  }

  matches.forEach(matchEl => {
    const teamEls = matchEl.querySelectorAll('.team-name, .team, [class*="team"], [class*="local"], [class*="visitor"]');
    const imgEls = matchEl.querySelectorAll('img');

    if (teamEls.length >= 2) {
      const homeTeam = teamEls[0].innerText.trim();
      const awayTeam = teamEls[1].innerText.trim();
      let homeLogo = '';
      let awayLogo = '';

      imgEls.forEach(img => {
        const src = img.src || img.getAttribute('data-src') || '';
        if (src.includes('resfu.com') || src.includes('shield') || src.includes('escudo') || src.includes('logo')) {
          let cleanSrc = src;
          if (cleanSrc.includes('?')) {
            cleanSrc = cleanSrc.replace(/\?.*$/, '?size=60x&lossy=1');
          } else {
            cleanSrc += '?size=60x&lossy=1';
          }

          if (!homeLogo) {
            homeLogo = cleanSrc;
          } else if (!awayLogo) {
            awayLogo = cleanSrc;
          }
        }
      });

      const matchKey = `${homeTeam} vs ${awayTeam}`;
      if (!seen.has(matchKey)) {
        seen.add(matchKey);
        logosData.push({ match: matchKey, homeLogo, awayLogo });
      }
    }
  });

  return logosData;
};

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping de', URL);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Aceptar cookies
    try {
      const acceptBtn = await page.$('button:has-text("ACEPTO"), button:has-text("Acepto"), button:has-text("ACCEPT")');
      if (acceptBtn) {
        await acceptBtn.click();
        await page.waitForTimeout(1000);
        console.log('[Escudos] Cookies aceptadas');
      }
    } catch (e) {}

    // Esperar a que cargue CUALQUIER cosa del body (no un selector específico que puede cambiar)
    await page.waitForSelector('body', { timeout: 30000 });
    await page.waitForTimeout(3000); // dar tiempo a que JS renderice

    const logosData = await page.evaluate(SCRAPE_SCRIPT);

    console.log(`[Escudos] Encontrados ${logosData.length} partidos con escudos`);

    const dataDir = path.dirname(OUTPUT);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(OUTPUT, JSON.stringify(logosData, null, 2), 'utf-8');
    console.log('[Escudos] Datos guardados en', OUTPUT);

    if (logosData.length > 0) {
      logosData.slice(0, 3).forEach(e => {
        console.log(`  - ${e.match} | Local: ${e.homeLogo ? 'OK' : 'NO'} | Visitante: ${e.awayLogo ? 'OK' : 'NO'}`);
      });
    }

  } catch (error) {
    console.warn('[Escudos] Error durante scraping (se continua sin escudos):', error.message);
    
    // Escribir archivo vacío para que el build no falle
    const dataDir = path.dirname(OUTPUT);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2), 'utf-8');
    console.log('[Escudos] Se guardo escudos.json vacio como fallback');
  } finally {
    await browser.close();
  }
}

scrapeEscudos();
