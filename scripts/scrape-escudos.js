/**
 * scrape-escudos.js
 *
 * Lee data/partidos.json, extrae equipos y busca escudos en Google.
 * - No rompe GitHub Actions si Google falla, bloquea o cambia el DOM.
 * - Guarda resultados parciales.
 * - Si no encuentra un escudo, deja homeLogo/awayLogo vacío.
 * - Si todo falla, escribe [] en escudos.json y termina con exitCode 0.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'data', 'partidos.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');

const GOOGLE_TIMEOUT = 45000;
const PER_TEAM_DELAY_MS = 1200;
const MAX_RETRIES = 2;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function loadJson(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeTeamKey(team) {
  return normalizeText(team)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMatch(match) {
  const text = normalizeText(match);

  // Quita prefijo de competencia si existe: "Copa Libertadores: Mirassol vs LDU Quito"
  const colonIndex = text.indexOf(':');
  if (colonIndex > 0 && colonIndex < 60) {
    return text.slice(colonIndex + 1).trim();
  }

  return text;
}

function parseTeams(match) {
  const clean = normalizeMatch(match);

  const separators = [
    /\s+vs\.?\s+/i,
    /\s+v\s+/i,
    /\s+x\s+/i,
    /\s+-\s+/i,
  ];

  for (const sep of separators) {
    const parts = clean.split(sep).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return {
        homeTeam: parts[0],
        awayTeam: parts.slice(1).join(' vs ').trim(),
      };
    }
  }

  return null;
}

function pickBestUrl(candidates, teamName) {
  const teamKey = normalizeTeamKey(teamName);
  const teamTokens = teamKey.split(' ').filter(Boolean);

  let best = '';
  let bestScore = -Infinity;

  for (const item of candidates) {
    const url = item.url || '';
    const alt = normalizeText(item.alt || '');
    const w = Number(item.width || 0);
    const h = Number(item.height || 0);

    if (!/^https?:\/\//i.test(url)) continue;
    if (url.startsWith('data:')) continue;

    // Evita assets obvios de Google que no suelen ser el escudo
    if (
      /googlelogo|gstatic\.com\/images|favicon|sprite|icon/i.test(url) &&
      !/tbn0\.gstatic\.com/i.test(url)
    ) {
      continue;
    }

    let score = 0;

    // Preferir imágenes con tamaño razonable
    if (w >= 32 && h >= 32) score += 3;
    if (w >= 64 && h >= 64) score += 2;

    // Preferir urls proxy de imagenes de Google si vienen del result image
    if (/encrypted-tbn0\.gstatic\.com/i.test(url)) score += 2;

    // Preferir si alt contiene el nombre del equipo
    if (alt) {
      const altKey = normalizeTeamKey(alt);
      if (altKey.includes(teamKey)) score += 4;

      // Puntuar por tokens del equipo
      let tokenHits = 0;
      for (const token of teamTokens.slice(0, 4)) {
        if (token && altKey.includes(token)) tokenHits += 1;
      }
      score += tokenHits;
    }

    // URLs más cortas suelen ser menos sospechosas, pero no es decisivo
    if (url.length < 120) score += 1;

    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }

  return best || '';
}

async function dismissGoogleConsent(page) {
  const selectors = [
    'button:has-text("Acepto")',
    'button:has-text("ACEPTO")',
    'button:has-text("I agree")',
    'button:has-text("Accept all")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Agree")',
  ];

  for (const selector of selectors) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {
      // ignorar
    }
  }

  return false;
}

async function safeGoto(page, url, timeout = GOOGLE_TIMEOUT) {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

async function scrapeGoogleImageLogo(page, teamName) {
  const queries = [
    `${teamName} escudo`,
    `${teamName} logo`,
    `${teamName} badge`,
  ];

  for (const query of queries) {
    const searchUrl = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;

    const ok = await safeGoto(page, searchUrl);
    if (!ok) continue;

    await dismissGoogleConsent(page);
    await page.waitForTimeout(1800);

    try {
      const candidates = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));

        return imgs.map((img) => {
          const rect = img.getBoundingClientRect();
          return {
            url:
              img.currentSrc ||
              img.src ||
              img.getAttribute('data-src') ||
              img.getAttribute('data-iurl') ||
              '',
            alt: img.alt || img.getAttribute('aria-label') || '',
            width: rect.width || img.width || 0,
            height: rect.height || img.height || 0,
          };
        });
      });

      const best = pickBestUrl(candidates, teamName);
      if (best) return best;
    } catch {
      // seguir con siguiente query
    }

    await page.waitForTimeout(700);
  }

  return '';
}

async function withRetry(fn, retries = MAX_RETRIES) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
  }

  throw lastError;
}

async function scrapeEscudosGoogle() {
  console.log('[Escudos] Leyendo partidos desde', INPUT);

  const partidos = loadJson(INPUT, []);
  if (!partidos.length) {
    saveJson(OUTPUT, []);
    console.log('[Escudos] No hay partidos, se guardó escudos.json vacío');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'es-ES',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });

  const page = await context.newPage();

  const teamLogoCache = new Map();
  const results = [];

  try {
    for (const item of partidos) {
      const parsed = parseTeams(item.match);
      if (!parsed) {
        results.push({
          match: normalizeText(item.match),
          homeLogo: '',
          awayLogo: '',
        });
        continue;
      }

      const { homeTeam, awayTeam } = parsed;
      const matchKey = `${homeTeam} vs ${awayTeam}`;

      const homeKey = normalizeTeamKey(homeTeam);
      const awayKey = normalizeTeamKey(awayTeam);

      let homeLogo = teamLogoCache.get(homeKey);
      let awayLogo = teamLogoCache.get(awayKey);

      if (homeLogo === undefined) {
        homeLogo = '';
        try {
          homeLogo = await withRetry(() => scrapeGoogleImageLogo(page, homeTeam));
        } catch (error) {
          console.warn(`[Escudos] Error buscando ${homeTeam}: ${error.message}`);
          homeLogo = '';
        }
        teamLogoCache.set(homeKey, homeLogo);
        await page.waitForTimeout(PER_TEAM_DELAY_MS);
      }

      if (awayLogo === undefined) {
        awayLogo = '';
        try {
          awayLogo = await withRetry(() => scrapeGoogleImageLogo(page, awayTeam));
        } catch (error) {
          console.warn(`[Escudos] Error buscando ${awayTeam}: ${error.message}`);
          awayLogo = '';
        }
        teamLogoCache.set(awayKey, awayLogo);
        await page.waitForTimeout(PER_TEAM_DELAY_MS);
      }

      results.push({
        match: matchKey,
        homeLogo: homeLogo || '',
        awayLogo: awayLogo || '',
      });

      console.log(
        `[Escudos] ${matchKey} | local: ${homeLogo ? 'OK' : 'NO'} | visitante: ${awayLogo ? 'OK' : 'NO'}`
      );
    }

    // Quitar duplicados por partido
    const unique = new Map();
    for (const row of results) {
      if (!unique.has(row.match)) {
        unique.set(row.match, row);
      }
    }

    const finalData = [...unique.values()];
    saveJson(OUTPUT, finalData);

    console.log(`[Escudos] Guardados ${finalData.length} registros en ${OUTPUT}`);
  } catch (error) {
    console.warn('[Escudos] Error general durante el scraping:', error.message);

    // Guardar lo que se haya podido rescatar
    try {
      const unique = new Map();
      for (const row of results) {
        if (!unique.has(row.match)) unique.set(row.match, row);
      }
      saveJson(OUTPUT, [...unique.values()]);
    } catch {
      saveJson(OUTPUT, []);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

scrapeEscudosGoogle()
  .catch(error => {
    console.warn('[Escudos] Error inesperado final:', error.message);
    try {
      saveJson(OUTPUT, []);
    } catch {}
  })
  .finally(() => {
    // Nunca romper GitHub Actions
    process.exitCode = 0;
  });
