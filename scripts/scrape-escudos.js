/**
 * Scraping de escudos desde Flashscore
 * Lee data/partidos.json, busca cada partido en Flashscore via Google,
 * extrae la URL del escudo desde el participantsData de la pagina del partido
 * y guarda en data/escudos.json
 *
 * Mejoras:
 * - Acepta extraccion parcial (si encuentra solo un escudo, lo guarda)
 * - Cache mejorado (no congela null como resultado definitivo)
 * - Mejor deteccion de logos en distintas estructuras
 * - Mas robustez en Flashscore
 *
 * Si falla o no hay partidos:
 * - guarda [] en escudos.json
 * - NO rompe GitHub Actions
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PARTIDOS_PATH = path.join(__dirname, '..', 'data', 'partidos.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');
const GOOGLE_SEARCH_URL = 'https://www.google.com/search?q=';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveEmptyJson() {
  ensureDir(OUTPUT);
  fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2), 'utf-8');
  console.log('[Escudos] JSON vacio guardado');
}

/**
 * Extrae nombres de equipos
 * Ej:
 * "Copa Libertadores: Mirassol vs LDU Quito"
 */
function extractTeamNames(matchText) {
  if (!matchText) return [null, null];

  const withoutCompetition = matchText.replace(/^[^:]+:\s*/, '');
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\.?\s+(.+)/i);

  if (!vsMatch) return [null, null];

  return [vsMatch[1].trim(), vsMatch[2].trim()];
}

/**
 * Limpieza para busqueda
 */
function cleanTeamNameForSearch(name) {
  if (!name) return '';
  return name
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[^\w\s\-áéíóúñü]/gi, '')
    .trim();
}

/**
 * Detecta bloqueo de Google
 */
async function isGoogleBlocked(page) {
  return page.evaluate(() => {
    const title = document.title.toLowerCase();
    const body = document.body?.innerText?.toLowerCase() || '';

    return (
      title.includes('captcha') ||
      title.includes('unusual traffic') ||
      body.includes('captcha') ||
      body.includes('unusual traffic') ||
      body.includes('automated requests') ||
      body.includes("i'm not a robot") ||
      body.includes('no soy un robot') ||
      !!document.querySelector('#captcha') ||
      !!document.querySelector('form[action*="captcha"]')
    );
  });
}

/**
 * Busca URL del partido en Flashscore
 */
async function findFlashscoreMatchUrl(page, homeTeam, awayTeam) {
  const homeClean = cleanTeamNameForSearch(homeTeam);
  const awayClean = cleanTeamNameForSearch(awayTeam);

  const searchQuery = encodeURIComponent(`${homeClean} vs ${awayClean} flashscore`);
  const searchUrl = `${GOOGLE_SEARCH_URL}${searchQuery}`;

  try {
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(2500);

    const blocked = await isGoogleBlocked(page);
    if (blocked) {
      console.log('  [BLOQUEO] Google detecto bot');
      return null;
    }

    const flashscoreUrl = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href]')]
        .map(a => a.href)
        .filter(Boolean);

      // Prioridad 1: match
      for (const href of links) {
        if (
          href.includes('flashscore') &&
          href.includes('/match/') &&
          !href.includes('/odds/') &&
          !href.includes('/h2h/') &&
          !href.includes('/standings/') &&
          !href.includes('/clasificacion/')
        ) {
          return href;
        }
      }

      // Prioridad 2: cualquier pagina util
      for (const href of links) {
        if (
          href.includes('flashscore') &&
          !href.includes('/team/') &&
          !href.includes('/news/')
        ) {
          return href;
        }
      }

      return null;
    });

    return flashscoreUrl;
  } catch (error) {
    console.log(`  [ERROR] Buscando en Google: ${error.message}`);
    return null;
  }
}

/**
 * Extrae JSON balanceado
 */
function extractBalancedJson(text, startOffset) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let startIdx = -1;

  for (let i = startOffset; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !inString) {
      inString = true;
      continue;
    }

    if (char === '"' && inString) {
      inString = false;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (depth === 0) startIdx = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          return text.substring(startIdx, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Extrae escudos desde pagina Flashscore
 */
async function extractShieldsFromFlashscore(page) {
  return page.evaluate(() => {
    function extractBalancedJsonInner(text, startOffset) {
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let startIdx = -1;

      for (let i = startOffset; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"' && !inString) {
          inString = true;
          continue;
        }

        if (char === '"' && inString) {
          inString = false;
          continue;
        }

        if (!inString) {
          if (char === '{') {
            if (depth === 0) startIdx = i;
            depth++;
          } else if (char === '}') {
            depth--;
            if (depth === 0 && startIdx !== -1) {
              return text.substring(startIdx, i + 1);
            }
          }
        }
      }

      return null;
    }

    function normalizeParticipant(side) {
      if (!side) return null;

      const item = Array.isArray(side) ? side[0] : side;

      if (!item || typeof item !== 'object') return null;

      return {
        logo:
          item.image_path ||
          item.small_image_path ||
          item.image ||
          item.logo ||
          item.images?.[0] ||
          null,
        name: item.name || null,
      };
    }

    function buildResult(home, away) {
      if (!home && !away) return null;

      return {
        homeLogo: home?.logo || null,
        awayLogo: away?.logo || null,
        homeName: home?.name || null,
        awayName: away?.name || null,
      };
    }

    try {
      // Metodo 1: scripts
      const scripts = document.querySelectorAll('script');

      for (const script of scripts) {
        const content = script.textContent || '';

        if (!content.includes('"participantsData"')) continue;

        const idx = content.indexOf('"participantsData"');
        const colonIdx = content.indexOf(':', idx);

        if (colonIdx === -1) continue;

        const jsonStr = extractBalancedJsonInner(content, colonIdx + 1);

        if (!jsonStr) continue;

        try {
          const data = JSON.parse(jsonStr);

          const home = normalizeParticipant(data.home);
          const away = normalizeParticipant(data.away);

          const result = buildResult(home, away);

          if (result) return result;
        } catch (_) {}
      }

      // Metodo 2: INITIAL STATE
      if (window.__INITIAL_STATE__) {
        const state = window.__INITIAL_STATE__;
        const participants =
          state.event?.participantsData ||
          state.participantsData ||
          state.match?.participantsData;

        if (participants) {
          const home = normalizeParticipant(participants.home);
          const away = normalizeParticipant(participants.away);

          const result = buildResult(home, away);

          if (result) return result;
        }
      }

      // Metodo 3: environment
      if (window.environment?.participantsData) {
        const participants = window.environment.participantsData;

        const home = normalizeParticipant(participants.home);
        const away = normalizeParticipant(participants.away);

        const result = buildResult(home, away);

        if (result) return result;
      }

      return null;
    } catch (_) {
      return null;
    }
  });
}

/**
 * Busca logos de partido
 */
async function searchMatchLogos(page, homeTeam, awayTeam) {
  console.log(`  Buscando partido: ${homeTeam} vs ${awayTeam}`);

  const flashscoreUrl = await findFlashscoreMatchUrl(page, homeTeam, awayTeam);

  if (!flashscoreUrl) {
    console.log('  [WARN] No se encontro partido en Flashscore');
    return { homeLogo: null, awayLogo: null };
  }

  console.log(`  [OK] URL encontrada: ${flashscoreUrl}`);

  try {
    await page.goto(flashscoreUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(3500);
  } catch (error) {
    console.log(`  [ERROR] Navegando a Flashscore: ${error.message}`);
    return { homeLogo: null, awayLogo: null };
  }

  const shields = await extractShieldsFromFlashscore(page);

  if (shields) {
    console.log(
      `  [OK] Escudos extraidos - Local: ${
        shields.homeLogo ? 'SI' : 'NO'
      }, Visitante: ${shields.awayLogo ? 'SI' : 'NO'}`
    );

    return shields;
  }

  console.log('  [WARN] No se pudieron extraer escudos');
  return { homeLogo: null, awayLogo: null };
}

/**
 * Main
 */
async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping...');

  if (!fs.existsSync(PARTIDOS_PATH)) {
    console.warn('[Escudos] No existe partidos.json');
    saveEmptyJson();
    return;
  }

  const partidos = JSON.parse(fs.readFileSync(PARTIDOS_PATH, 'utf-8'));

  if (!partidos?.length) {
    console.log('[Escudos] No hay partidos');
    saveEmptyJson();
    return;
  }

  console.log(`[Escudos] ${partidos.length} partidos encontrados`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    locale: 'es-ES',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  await page.route('**/*', route => {
    const url = route.request().url();

    if (url.includes('consent.google.com')) {
      route.abort();
    } else {
      route.continue();
    }
  });

  await context.addCookies([
    {
      name: 'CONSENT',
      value: 'YES+ES.es+V14+BX',
      domain: '.google.com',
      path: '/',
    },
    {
      name: 'CONSENT',
      value: 'YES+ES.es+V14+BX',
      domain: '.google.es',
      path: '/',
    },
  ]);

  const logoCache = new Map();
  const escudos = [];
  const seenMatches = new Set();

  try {
    for (let i = 0; i < partidos.length; i++) {
      const partido = partidos[i];
      const matchText = partido.match;

      if (!matchText) continue;

      const [homeTeam, awayTeam] = extractTeamNames(matchText);

      if (!homeTeam || !awayTeam) {
        console.log(
          `[${i + 1}/${partidos.length}] Saltando: "${matchText}"`
        );
        continue;
      }

      const matchKey = `${homeTeam} vs ${awayTeam}`;

      if (seenMatches.has(matchKey)) continue;
      seenMatches.add(matchKey);

      console.log(`\n[${i + 1}/${partidos.length}] ${matchKey}`);

      let homeLogo = logoCache.get(homeTeam);
      let awayLogo = logoCache.get(awayTeam);

      const needHome = !homeLogo;
      const needAway = !awayLogo;

      if (!needHome && !needAway) {
        console.log('  [CACHE] Ambos escudos encontrados');
      } else {
        const result = await searchMatchLogos(page, homeTeam, awayTeam);

        if (needHome && result.homeLogo) {
          homeLogo = result.homeLogo;
          logoCache.set(homeTeam, homeLogo);
        }

        if (needAway && result.awayLogo) {
          awayLogo = result.awayLogo;
          logoCache.set(awayTeam, awayLogo);
        }
      }

      if (homeLogo || awayLogo) {
        escudos.push({
          match: matchKey,
          homeLogo: homeLogo || '',
          awayLogo: awayLogo || '',
        });
      }

      if (i < partidos.length - 1) {
        await page.waitForTimeout(2000 + Math.random() * 2000);
      }
    }

    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(escudos, null, 2), 'utf-8');

    console.log(`\n[Escudos] ${escudos.length} partidos guardados`);

    const totalTeams = new Set();

    for (const p of partidos) {
      const [h, a] = extractTeamNames(p.match);
      if (h) totalTeams.add(h);
      if (a) totalTeams.add(a);
    }

    const foundTeams = [...logoCache.values()].filter(Boolean).length;

    console.log(
      `[Escudos] Equipos unicos: ${totalTeams.size}, Escudos encontrados: ${foundTeams}`
    );
  } catch (error) {
    console.warn('[Escudos] Error:', error.message);
    saveEmptyJson();
    process.exitCode = 0;
  } finally {
    await browser.close();
  }
}

scrapeEscudos().catch(error => {
  console.warn('[Escudos] Error inesperado:', error.message);
  saveEmptyJson();
  process.exitCode = 0;
});
