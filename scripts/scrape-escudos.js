/**
 * Scraping de escudos desde es.besoccer.com
 * Extrae: nombre del partido, escudo local, escudo visitante
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://es.besoccer.com/';
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');

// Script que se ejecuta en el navegador (adaptado del userscript del usuario)
const SCRAPE_SCRIPT = () => {
  const logosData = [];
  const seen = new Set();

  document.querySelectorAll('.match-link').forEach(matchEl => {
    // Buscar nombres de equipos
    const teamEls = matchEl.querySelectorAll('.team-name');
    // Buscar escudos - los escudos son imagenes dentro del match
    const shieldEls = matchEl.querySelectorAll('img');

    if (teamEls.length >= 2) {
      const homeTeam = teamEls[0].innerText.trim();
      const awayTeam = teamEls[1].innerText.trim();

      // Buscar las imagenes de escudos (generalmente son imgs con src que contiene resfu)
      let homeLogo = '';
      let awayLogo = '';

      shieldEls.forEach(img => {
        const src = img.src || img.getAttribute('data-src') || '';
        if (src.includes('resfu.com') || src.includes('shield') || src.includes('escudo')) {
          // Limpiar URL de escudo
          let cleanSrc = src;
          // Asegurar que tiene el tamano correcto
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

      // Si no se encontraron escudos via img, intentar con background-image
      if (!homeLogo || !awayLogo) {
        const allEls = matchEl.querySelectorAll('*');
        const logoUrls = [];
        allEls.forEach(el => {
          const style = window.getComputedStyle(el);
          const bgImage = style.backgroundImage;
          if (bgImage && bgImage !== 'none' && (bgImage.includes('resfu') || bgImage.includes('shield'))) {
            const url = bgImage.replace(/url\(["']?/, '').replace(/["']?\)/, '');
            if (url && !logoUrls.includes(url)) {
              logoUrls.push(url);
            }
          }
        });
        if (!homeLogo && logoUrls[0]) homeLogo = logoUrls[0];
        if (!awayLogo && logoUrls[1]) awayLogo = logoUrls[1];
      }

      const matchKey = `${homeTeam} vs ${awayTeam}`;

      // Evitar duplicados
      if (!seen.has(matchKey)) {
        seen.add(matchKey);
        logosData.push({
          match: matchKey,
          homeLogo: homeLogo,
          awayLogo: awayLogo
        });
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

    // Aceptar cookies si aparece el banner
    try {
      const acceptBtn = await page.$('button:has-text("ACEPTO")');
      if (acceptBtn) {
        await acceptBtn.click();
        await page.waitForTimeout(1000);
        console.log('[Escudos] Cookies aceptadas');
      }
    } catch (e) {
      // No hay banner de cookies
    }

    // Esperar a que carguen los partidos
    await page.waitForSelector('.match-link', { timeout: 30000 });
    await page.waitForTimeout(2000);

    // Ejecutar script de scraping en el navegador
    const logosData = await page.evaluate(SCRAPE_SCRIPT);

    console.log(`[Escudos] Encontrados ${logosData.length} partidos con escudos`);

    // Guardar datos
    const dataDir = path.dirname(OUTPUT);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(OUTPUT, JSON.stringify(logosData, null, 2), 'utf-8');
    console.log('[Escudos] Datos guardados en', OUTPUT);

    // Mostrar algunos ejemplos
    if (logosData.length > 0) {
      console.log('[Escudos] Primeros 3 partidos encontrados:');
      logosData.slice(0, 3).forEach(e => {
        console.log(`  - ${e.match}`);
        console.log(`    Local: ${e.homeLogo ? 'OK' : 'NO'}`);
        console.log(`    Visitante: ${e.awayLogo ? 'OK' : 'NO'}`);
      });
    }

  } catch (error) {
    console.error('[Escudos] Error durante scraping:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

scrapeEscudos();
