/**
 * Scraping de partidos desde streamx550.com
 * Extrae: hora GMT-3, nombre del partido, enlaces de canales
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://streamx550.com/';
const OUTPUT = path.join(__dirname, '..', 'data', 'partidos.json');

// ===============================
// CONFIGURACION HORARIA
// ===============================

// Cambia esto si la web usa otra zona horaria
// Ejemplo:
// UTC = 0
// GMT+1 = 1
// GMT-3 = -3
const SOURCE_TIMEZONE = 0; // horario original de la web
const TARGET_TIMEZONE = -3; // GMT-3 (Argentina)

// Convertir hora entre zonas horarias
function convertTimezone(timeStr, fromTZ, toTZ) {
  try {
    const [hours, minutes] = timeStr.split(':').map(Number);

    // Crear fecha UTC base
    const date = new Date(Date.UTC(2025, 0, 1, hours - fromTZ, minutes));

    // Ajustar a nueva zona horaria
    date.setUTCHours(date.getUTCHours() + toTZ);

    const finalHours = String(date.getUTCHours()).padStart(2, '0');
    const finalMinutes = String(date.getUTCMinutes()).padStart(2, '0');

    return `${finalHours}:${finalMinutes}`;
  } catch {
    return timeStr;
  }
}

// Script que se ejecuta en el navegador
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
        // Reemplazar global1.php por global2.php
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

    // Esperar contenido dinámico
    await page.waitForSelector('.event', {
      timeout: 30000
    });

    await page.waitForTimeout(5000);

    // Ejecutar scraping
    let eventsData = await page.evaluate(SCRAPE_SCRIPT);

    // Convertir horarios a GMT-3
    eventsData = eventsData.map(event => ({
      ...event,
      time: convertTimezone(
        event.time,
        SOURCE_TIMEZONE,
        TARGET_TIMEZONE
      )
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

    console.log(
      `[Partidos] Encontrados ${eventsData.length} canales de transmisión`
    );

    // Crear carpeta
    const dataDir = path.dirname(OUTPUT);

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Guardar JSON
    fs.writeFileSync(
      OUTPUT,
      JSON.stringify(eventsData, null, 2),
      'utf-8'
    );

    console.log('[Partidos] Datos guardados en', OUTPUT);

    // Resumen
    const partidosUnicos = new Set(
      eventsData.map(e => e.match)
    ).size;

    console.log(
      `[Partidos] Resumen: ${partidosUnicos} partidos únicos con ${eventsData.length} canales`
    );

  } catch (error) {
    console.error('[Partidos] Error durante scraping:', error);

    // Screenshot para debug en GitHub Actions
    try {
      await page.screenshot({
        path: 'error-partidos.png',
        fullPage: true
      });

      console.log('[Partidos] Screenshot guardado');
    } catch {}

    process.exit(1);

  } finally {
    await browser.close();
  }
}

scrapePartidos();
