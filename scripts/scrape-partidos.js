/**
 * Scraping de partidos desde streamx550.com
 * Extrae: hora en GMT-3, nombre del partido, enlaces de canales
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://streamx550.com/';
const OUTPUT = path.join(__dirname, '..', 'data', 'partidos.json');

// La web muestra la hora en UTC/GMT+0.
// Argentina = GMT-3.
const SOURCE_OFFSET = 0;
const TARGET_OFFSET = -3;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseTimeToMinutes(timeStr) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr).trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return hours * 60 + minutes;
}

function convertTimeToGMT3(timeStr) {
  const minutes = parseTimeToMinutes(timeStr);
  if (minutes === null) return timeStr;

  const offsetDiff = TARGET_OFFSET - SOURCE_OFFSET; // -3
  let converted = minutes + offsetDiff * 60;

  converted = ((converted % 1440) + 1440) % 1440;

  const hours = Math.floor(converted / 60);
  const mins = converted % 60;

  return `${pad2(hours)}:${pad2(mins)}`;
}

// Script que se ejecuta en el navegador
const SCRAPE_SCRIPT = () => {
  const eventsData = [];

  document.querySelectorAll('.event').forEach(eventEl => {
    const nameText = eventEl.querySelector('.event-name')?.innerText.trim();
    if (!nameText) return;

    const timeMatch = nameText.match(/^(\d{1,2}:\d{2})\s*-\s*(.*)$/);
    if (!timeMatch) return;

    const time = timeMatch[1];
    const match = timeMatch[2].trim();

    eventEl.querySelectorAll('.iframe-link').forEach(input => {
      let link = input.value;

      if (link) {
        link = link.replace('global1.php', 'global2.php');

        eventsData.push({
          time,
          match,
          link
        });
      }
    });
  });

  return eventsData;
};

async function scrapePartidos() {
  console.log('[Partidos] Iniciando scraping de', URL);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const context = await browser.newContext({
    timezoneId: 'America/Argentina/Buenos_Aires',
    locale: 'es-AR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    await page.goto(URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForSelector('.event', { timeout: 30000 });
    await page.waitForTimeout(5000);

    let eventsData = await page.evaluate(SCRAPE_SCRIPT);

    // Convertir horarios a GMT-3
    eventsData = eventsData.map(event => ({
      ...event,
      time: convertTimeToGMT3(event.time)
    }));

    // Eliminar duplicados
    const uniqueMap = new Map();
    for (const event of eventsData) {
      const key = `${event.time}-${event.match}-${event.link}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, event);
      }
    }

    eventsData = [...uniqueMap.values()];

    // Ordenar por hora
    eventsData.sort((a, b) => a.time.localeCompare(b.time));

    console.log(`[Partidos] Encontrados ${eventsData.length} canales de transmisión`);

    // Crear carpeta de salida
    const dataDir = path.dirname(OUTPUT);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Guardar JSON
    fs.writeFileSync(OUTPUT, JSON.stringify(eventsData, null, 2), 'utf-8');
    console.log('[Partidos] Datos guardados en', OUTPUT);

    // Resumen
    const partidosUnicos = new Set(eventsData.map(e => e.match)).size;
    console.log(
      `[Partidos] Resumen: ${partidosUnicos} partidos únicos con ${eventsData.length} canales`
    );
  } catch (error) {
    console.error('[Partidos] Error durante scraping:', error);
    try {
      await page.screenshot({
        path: 'error-partidos.png',
        fullPage: true
      });
      console.log('[Partidos] Screenshot guardado en error-partidos.png');
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

scrapePartidos();
