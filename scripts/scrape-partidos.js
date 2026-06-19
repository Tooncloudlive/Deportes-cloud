const fs = require('fs');
const path = require('path');

// Cambio principal:
// - Antes consumía https://streamhdx.com/eventos.json
// - Ahora intenta sacar los partidos desde https://la18hd.com/eventos/
//
// Se mantiene exactamente la salida esperada en data/partidos.json:
// [{ time, match, link }, ...]
// para no romper build.js ni el resto del repo.

const SOURCE_URL = 'https://la18hd.com/eventos/';
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'partidos.json');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------
// Helpers de ruta / salida (se mantienen)
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
// Helpers de tiempo (se mantienen)
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
// Helpers de texto / extracción
// ---------------------------------------------------------------
function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
}

function stripHtml(html) {
  return normalizeText(String(html || '').replace(/<[^>]*>/g, ' '));
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqByKey(items) {
  const seen = new Map();
  for (const item of items) {
    const key = `${item.time}-${item.match}-${item.link}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return Array.from(seen.values());
}

function toAbsoluteUrl(href) {
  if (!href) return '';
  const cleaned = String(href).trim();
  if (!cleaned) return '';

  try {
    return new URL(cleaned, SOURCE_URL).toString();
  } catch {
    return '';
  }
}

function pickFirstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function extractLinksFromNode(node) {
  const links = [];
  if (!node || typeof node !== 'object') return links;

  const direct = pickFirstString(node, ['url', 'link', 'href', 'src']);
  if (direct) links.push(direct);

  const arrays = ['canales', 'channels', 'links', 'enlaces'];
  for (const key of arrays) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          links.push(item);
        } else if (item && typeof item === 'object') {
          const nested = pickFirstString(item, ['url', 'link', 'href', 'src']);
          if (nested) links.push(nested);
        }
      }
    }
  }

  return links.filter(Boolean);
}

function looksLikeEventObject(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;

  const time = pickFirstString(node, ['hora', 'time', 'startTime', 'hora_inicio', 'inicio']);
  const title = pickFirstString(node, ['titulo', 'title', 'match', 'nombre', 'evento', 'name']);
  const links = extractLinksFromNode(node);

  return Boolean(time && title && links.length > 0);
}

function pushEventFromNode(node, out) {
  const rawTime = pickFirstString(node, ['hora', 'time', 'startTime', 'hora_inicio', 'inicio']);
  const match = pickFirstString(node, ['titulo', 'title', 'match', 'nombre', 'evento', 'name']);
  const links = extractLinksFromNode(node);

  if (!rawTime || !match || links.length === 0) return;

  const convertedTime = convertTimeToGMT3(rawTime);

  for (const link of links) {
    const absLink = toAbsoluteUrl(link);
    if (!absLink) continue;

    out.push({
      time: convertedTime,
      match,
      link: absLink
    });
  }
}

function collectEventsFromJson(node, out) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const item of node) collectEventsFromJson(item, out);
    return;
  }

  if (typeof node !== 'object') return;

  if (looksLikeEventObject(node)) {
    pushEventFromNode(node, out);
  }

  for (const value of Object.values(node)) {
    collectEventsFromJson(value, out);
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonCandidates(html) {
  const candidates = [];

  const patterns = [
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?/i,
    /window\.__NUXT__\s*=\s*({[\s\S]*?})\s*;?/i,
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  ];

  for (const pattern of patterns) {
    if (pattern.global) {
      let match;
      while ((match = pattern.exec(html))) {
        if (match[1]) candidates.push(match[1]);
      }
    } else {
      const match = html.match(pattern);
      if (match && match[1]) candidates.push(match[1]);
    }
  }

  return candidates;
}

function inferTitleFromChunk(chunk, time) {
  const plain = stripHtml(chunk);
  if (!plain) return '';

  const stopWords = [
    'copiar enlace',
    'enlace copiado',
    'transmisiones',
    'transmisión',
    'ver transmisión',
    'ver partido',
    'ver evento',
    'en vivo',
    '720p',
    'hd',
    'link',
    'abrir',
    'copiado'
  ];

  let cleaned = plain.replace(new RegExp(`\\b${escapeRegExp(time)}\\b`, 'g'), ' ');
  for (const word of stopWords) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(word), 'ig'), ' ');
  }

  cleaned = normalizeText(cleaned);
  if (!cleaned) return '';

  // Corta posibles restos de UI.
  cleaned = cleaned
    .replace(/\b(ver|abrir|copiar|copiado)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Si quedó algo demasiado genérico, no lo usamos.
  if (!cleaned || cleaned.length < 3) return '';
  return cleaned.slice(0, 140);
}

function extractEventsFromHtml(html) {
  const results = [];
  const timeRegex = /\b([01]?\d|2[0-3]):[0-5]\d\b/g;
  const maxWindowBefore = 500;
  const maxWindowAfter = 900;

  let match;
  while ((match = timeRegex.exec(html))) {
    const time = match[0];
    const start = Math.max(0, match.index - maxWindowBefore);
    const end = Math.min(html.length, match.index + maxWindowAfter);
    const chunk = html.slice(start, end);

    const title = inferTitleFromChunk(chunk, time);
    if (!title) continue;

    const hrefs = [...chunk.matchAll(/href=["']([^"']+)["']/gi)]
      .map(m => toAbsoluteUrl(m[1]))
      .filter(Boolean);

    if (hrefs.length === 0) continue;

    for (const link of hrefs) {
      results.push({
        time: convertTimeToGMT3(time),
        match: title,
        link
      });
    }
  }

  return results;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

// ---------------------------------------------------------------
// Scraping principal
// ---------------------------------------------------------------
async function scrapePartidos() {
  console.log('[Partidos] Iniciando descarga de', SOURCE_URL);

  try {
    const html = await fetchText(SOURCE_URL);
    let eventsData = [];

    // 1) Intento JSON embebido (si el sitio usa hydration / state)
    const jsonCandidates = extractJsonCandidates(html);
    for (const candidate of jsonCandidates) {
      const parsed = tryParseJson(candidate);
      if (parsed) {
        collectEventsFromJson(parsed, eventsData);
      }
    }

    // 2) Fallback HTML/DOM-less: buscar tiempos + links cercanos en el markup
    if (eventsData.length === 0) {
      eventsData = extractEventsFromHtml(html);
    }

    // 3) Normalizar y limpiar
    eventsData = eventsData
      .filter(ev => ev && ev.time && ev.match && ev.link)
      .map(ev => ({
        time: String(ev.time).trim(),
        match: String(ev.match).trim(),
        link: String(ev.link).trim()
      }));

    eventsData = uniqByKey(eventsData);
    eventsData.sort((a, b) => a.time.localeCompare(b.time));

    if (eventsData.length === 0) {
      console.log('[Partidos] No se encontraron partidos');
      saveEmptyJson();
      return;
    }

    const uniqueMatches = new Set(eventsData.map(e => e.match));

    console.log('[Partidos] Encontrados', eventsData.length, 'canales');
    console.log('[Partidos]', uniqueMatches.size, 'partidos únicos');

    ensureDir(OUTPUT_PATH);
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(eventsData, null, 2));
    console.log('[Partidos] Datos guardados en', OUTPUT_PATH);
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
