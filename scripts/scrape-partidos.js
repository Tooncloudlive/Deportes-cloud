const fs = require('fs');
const path = require('path');

// NOTA: Playwright ya no es necesario para este script.
// Se usa fetch nativo (Node >= 18) para consumir JSON estático.

const URL = 'https://la18hd.com/eventos/json/agenda123.json';
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'partidos.json');

// ---------------------------------------------------------------
// Helpers de ruta / salida (mantener exactamente)
// ---------------------------------------------------------------
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveEmptyJson() {
  ensureDir(OUTPUT_PATH);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify([], null, 2));
  console.log('[Partidos] JSON vacío guardado');
}

// ---------------------------------------------------------------
// Helpers de tiempo (mantener exactamente)
// ---------------------------------------------------------------
function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  if (parts.length !== 2) return 0;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return 0;
  return h * 60 + m;
}

const SOURCE_OFFSET = 0;
const TARGET_OFFSET = 0;

function convertTimeToGMT3(timeStr) {
  if (!timeStr) return timeStr;
  const offsetDiff = TARGET_OFFSET - SOURCE_OFFSET;
  if (offsetDiff === 0) return timeStr;

  let totalMinutes = parseTimeToMinutes(timeStr) + offsetDiff;
  totalMinutes = ((totalMinutes % 1440) + 1440) % 1440;

  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

// ---------------------------------------------------------------
// Scraping principal – ahora con fetch nativo (sin Playwright)
// ---------------------------------------------------------------
async function scrapePartidos() {
  console.log('[Partidos] Iniciando descarga de', URL);

  try {
    const response = await fetch(URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://la18hd.com/eventos/'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // La18hd devuelve un array plano de eventos; validamos que sea array
    if (!Array.isArray(data)) {
      console.log('[Partidos] Estructura JSON inesperada: no es un array');
      saveEmptyJson();
      return;
    }

    let eventsData = [];

    // Iterar todos los eventos del array
    for (const evento of data) {
      const time = String(evento?.time || '').trim();
      const match = String(evento?.title || '').trim();
      const link = String(evento?.link || '').trim();

      if (!time || !match || !link) continue;

      // Convertir hora si es necesario (mantener lógica actual)
      const convertedTime = convertTimeToGMT3(time);

      eventsData.push({
        time: convertedTime,
        match,
        link
      });
    }

    if (eventsData.length === 0) {
      console.log('[Partidos] No se encontraron partidos');
      saveEmptyJson();
      return;
    }

    // 1. Deduplicación
    const seen = new Map();
    for (const event of eventsData) {
      const key = `${event.time}-${event.match}-${event.link}`;
      if (!seen.has(key)) {
        seen.set(key, event);
      }
    }
    eventsData = Array.from(seen.values());

    // 2. Ordenamiento por hora
    eventsData.sort((a, b) => a.time.localeCompare(b.time));

    // 3. Logs de resumen
    const uniqueMatches = new Set(eventsData.map(e => e.match));
    console.log('[Partidos] Encontrados', eventsData.length, 'canales');

    // 4. Guardado
    ensureDir(OUTPUT_PATH);
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(eventsData, null, 2));
    console.log('[Partidos] Datos guardados en', OUTPUT_PATH);
    console.log('[Partidos]', uniqueMatches.size, 'partidos únicos');

  } catch (error) {
    console.log('[Partidos] Error durante descarga:', error.message || error);
    saveEmptyJson();
    process.exitCode = 0;
  }
}

// Punto de entrada
scrapePartidos().catch((error) => {
  console.log('[Partidos] Error inesperado:', error.message || error);
  saveEmptyJson();
  process.exitCode = 0;
});
