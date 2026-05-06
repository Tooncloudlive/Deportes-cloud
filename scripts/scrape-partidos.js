/**
 * Scraping de partidos desde streamx550.com
 * Extrae: hora, nombre del partido, enlaces de canales
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://streamx550.com/';
const OUTPUT = path.join(__dirname, '..', 'data', 'partidos.json');

// Script que se ejecuta en el navegador (adaptado del userscript del usuario)
const SCRAPE_SCRIPT = () => {
  const eventsData = [];

  document.querySelectorAll('.event').forEach(eventEl => {
    const nameText = eventEl.querySelector('.event-name')?.innerText.trim();
    if (!nameText) return;

    const timeMatch = nameText.match(/^(\d{2}:\d{2})\s*-\s*(.*)$/);
    if (!timeMatch) return;

    const time = timeMatch[1];
    const match = timeMatch[2];

    eventEl.querySelectorAll('.iframe-link').forEach(input => {
      let link = input.value;

      if (link) {
        // Reemplazar global1.php por global2.php para reproduccion automatica
        link = link.replace('global1.php', 'global2.php');

        eventsData.push({
          time: time,
          match: match,
          link: link
        });
      }
    });
  });

  return eventsData;
};

async function scrapePartidos() {
  console.log('[Partidos] Iniciando scraping de', URL);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000); // Esperar carga de contenido dinamico

    // Esperar a que haya eventos
    await page.waitForSelector('.event', { timeout: 30000 });

    // Ejecutar script de scraping en el navegador
    const eventsData = await page.evaluate(SCRAPE_SCRIPT);

    console.log(`[Partidos] Encontrados ${eventsData.length} canales de transmision`);

    // Guardar datos
    const dataDir = path.dirname(OUTPUT);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(OUTPUT, JSON.stringify(eventsData, null, 2), 'utf-8');
    console.log('[Partidos] Datos guardados en', OUTPUT);

    // Log de resumen
    const partidosUnicos = new Set(eventsData.map(e => e.match)).size;
    console.log(`[Partidos] Resumen: ${partidosUnicos} partidos unicos con ${eventsData.length} canales totales`);

  } catch (error) {
    console.error('[Partidos] Error durante scraping:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

scrapePartidos();
