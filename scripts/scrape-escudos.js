/**
 * Scraping de escudos desde Flashscore
 * Lee data/partidos.json, busca cada partido en Flashscore via Google,
 * extrae la URL del escudo desde el participantsData de la pagina del partido
 * y guarda en data/escudos.json
 *
 * Estrategia mejorada:
 * 1. Para cada partido "Equipo A vs Equipo B", buscar "Equipo A vs Equipo B flashscore"
 * 2. Extraer TODOS los resultados de Google que apunten a flashscore.com/match/
 * 3. Probar cada resultado hasta encontrar uno que coincida con los equipos buscados
 * 4. Al extraer los escudos, verificar si el orden de los equipos en Flashscore coincide
 *    con el orden buscado. Si estan invertidos, invertir los escudos automaticamente.
 * 5. Si ningun resultado funciona con orden normal, intenta busqueda invertida.
 * 6. Obtener image_path de home y away
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
 * Extrae los nombres de los equipos de un string de partido.
 * Ej: "Copa Libertadores: Mirassol vs LDU Quito" -> ["Mirassol", "LDU Quito"]
 */
function extractTeamNames(matchText) {
  if (!matchText) return [null, null];
  const withoutCompetition = matchText.replace(/^[^:]+:\s*/, '');
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\s+(.+)/i);
  if (!vsMatch) return [null, null];
  return [vsMatch[1].trim(), vsMatch[2].trim()];
}

/**
 * Quita el pais entre parentesis para la busqueda.
 */
function cleanTeamNameForSearch(name) {
  if (!name) return '';
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Normaliza un nombre de equipo para comparacion flexible.
 */
function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calcula el score de coincidencia entre dos nombres (0 a 1).
 */
function nameMatchScore(name1, name2) {
  const n1 = normalizeTeamName(name1);
  const n2 = normalizeTeamName(name2);
  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1;
  if (n1.includes(n2) || n2.includes(n1)) return 0.9;

  const words1 = n1.split(/\s+/).filter(w => w.length > 2);
  const words2 = n2.split(/\s+/).filter(w => w.length > 2);
  let matchingWords = 0;
  for (const w1 of words1) {
    for (const w2 of words2) {
      if (w1 === w2 || w1.includes(w2) || w2.includes(w1)) {
        matchingWords++;
      }
    }
  }
  const maxWords = Math.max(words1.length, words2.length);
  return maxWords === 0 ? 0 : matchingWords / maxWords;
}

/**
 * Verifica si los equipos extraidos de Flashscore coinciden con los buscados.
 * Devuelve: 'direct' | 'inverted' | 'partial' | 'none'
 */
function verifyTeamMatch(extractedHome, extractedAway, searchedHome, searchedAway) {
  const hh = nameMatchScore(extractedHome, searchedHome);
  const ha = nameMatchScore(extractedHome, searchedAway);
  const ah = nameMatchScore(extractedAway, searchedHome);
  const aa = nameMatchScore(extractedAway, searchedAway);

  const directScore = (hh + aa) / 2;
  const invertedScore = (ha + ah) / 2;

  if (directScore >= 0.6 && directScore > invertedScore) {
    return { matchType: 'direct', confidence: directScore };
  }
  if (invertedScore >= 0.6 && invertedScore > directScore) {
    return { matchType: 'inverted', confidence: invertedScore };
  }
  if (Math.max(hh, ha, ah, aa) >= 0.4) {
    return { matchType: 'partial', confidence: Math.max(hh, ha, ah, aa) };
  }
  return { matchType: 'none', confidence: 0 };
}

/**
 * Detecta si Google esta mostrando un CAPTCHA o bloqueo.
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
      !!document.querySelector('form[action*="captcha"]') ||
      !!document.querySelector('#captcha')
    );
  });
}

/**
 * Busca en Google y devuelve TODAS las URLs candidatas de flashscore.com/match/
 */
async function findFlashscoreMatchUrls(page, homeTeam, awayTeam) {
  const homeClean = cleanTeamNameForSearch(homeTeam);
  const awayClean = cleanTeamNameForSearch(awayTeam);
  const searchUrl = `${GOOGLE_SEARCH_URL}${encodeURIComponent(`${homeClean} vs ${awayClean} flashscore`)}`;
  const urls = [];

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const blocked = await isGoogleBlocked(page);
    if (blocked) {
      console.log('  [BLOQUEO] Google detecto bot');
      return urls;
    }

    const flashscoreUrls = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="flashscore"]');
      for (const link of links) {
        const href = link.href || '';
        if (
          href.includes('flashscore.com') &&
          href.includes('/match/') &&
          !href.includes('/standings/') &&
          !href.includes('/odds/') &&
          !href.includes('/h2h/') &&
          !href.includes('/cuotas/') &&
          !href.includes('/clasificacion/')
        ) {
          results.push(href);
        }
      }
      return results;
    });

    const seen = new Set();
    for (const url of flashscoreUrls) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  } catch (error) {
    console.log(`  [ERROR] Buscando en Google: ${error.message}`);
  }
  return urls;
}

/**
 * Extrae un objeto JSON balanceado de un string.
 */
function extractBalancedJson(text, startOffset) {
  let depth = 0, inString = false, escapeNext = false, startIdx = -1;
  for (let i = startOffset; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') { if (depth === 0) startIdx = i; depth++; }
      else if (char === '}') { depth--; if (depth === 0 && startIdx !== -1) return text.substring(startIdx, i + 1); }
    }
  }
  return null;
}

/**
 * Extrae escudos y nombres de equipos de la pagina de Flashscore.
 */
async function extractShieldsFromFlashscore(page) {
  return page.evaluate(() => {
    try {
      function extractBalancedJsonInner(text, startOffset) {
        let depth = 0, inString = false, escapeNext = false, startIdx = -1;
        for (let i = startOffset; i < text.length; i++) {
          const char = text[i];
          if (escapeNext) { escapeNext = false; continue; }
          if (char === '\\') { escapeNext = true; continue; }
          if (char === '"') { inString = !inString; continue; }
          if (!inString) {
            if (char === '{') { if (depth === 0) startIdx = i; depth++; }
            else if (char === '}') { depth--; if (depth === 0 && startIdx !== -1) return text.substring(startIdx, i + 1); }
          }
        }
        return null;
      }

      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        if (script.textContent && script.textContent.includes('"participantsData"')) {
          const idx = script.textContent.indexOf('"participantsData"');
          const colonIdx = script.textContent.indexOf(':', idx);
          if (colonIdx !== -1) {
            const jsonStr = extractBalancedJsonInner(script.textContent, colonIdx + 1);
            if (jsonStr) {
              try {
                const data = JSON.parse(jsonStr);
                const home = data.home?.[0];
                const away = data.away?.[0];
                if (home && away) {
                  return {
                    homeLogo: home.image_path || home.small_image_path || null,
                    awayLogo: away.image_path || away.small_image_path || null,
                    homeName: home.name || null,
                    awayName: away.name || null,
                  };
                }
              } catch (e) {}
            }
          }
        }
      }

      if (window.__INITIAL_STATE__) {
        const state = window.__INITIAL_STATE__;
        const participants = state.event?.participantsData || state.participantsData;
        if (participants) {
          const home = participants.home?.[0];
          const away = participants.away?.[0];
          if (home && away) {
            return {
              homeLogo: home.image_path || home.small_image_path || null,
              awayLogo: away.image_path || away.small_image_path || null,
              homeName: home.name || null,
              awayName: away.name || null,
            };
          }
        }
      }

      if (window.environment?.participantsData) {
        const participants = window.environment.participantsData;
        const home = participants.home?.[0];
        const away = participants.away?.[0];
        if (home && away) {
          return {
            homeLogo: home.image_path || home.small_image_path || null,
            awayLogo: away.image_path || away.small_image_path || null,
            homeName: home.name || null,
            awayName: away.name || null,
          };
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  });
}

/**
 * Intenta extraer escudos de una URL especifica de Flashscore.
 * Verifica coincidencia de nombres y corrige orden invertido automaticamente.
 */
async function tryExtractFromUrl(page, url, searchedHome, searchedAway) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const shields = await extractShieldsFromFlashscore(page);
    if (!shields || (!shields.homeLogo && !shields.awayLogo)) return null;

    if (!shields.homeName || !shields.awayName) {
      console.log('    -> Escudos extraidos (sin nombres para verificar)');
      return shields;
    }

    const verification = verifyTeamMatch(shields.homeName, shields.awayName, searchedHome, searchedAway);
    console.log(`    -> Encontrado: "${shields.homeName}" vs "${shields.awayName}" | Coincidencia: ${verification.matchType} (${(verification.confidence * 100).toFixed(0)}%)`);

    if (verification.matchType === 'direct') {
      return shields;
    }

    if (verification.matchType === 'inverted') {
      console.log('    -> CORRECCION: Escudos invertidos detectados, corrigiendo orden');
      return {
        homeLogo: shields.awayLogo,
        awayLogo: shields.homeLogo,
        homeName: shields.awayName,
        awayName: shields.homeName,
      };
    }

    if (verification.matchType === 'partial') {
      console.log('    -> Coincidencia parcial, analizando orden...');
      const homeMatchesAway = nameMatchScore(shields.homeName, searchedAway);
      const homeMatchesHome = nameMatchScore(shields.homeName, searchedHome);
      if (homeMatchesAway > homeMatchesHome) {
        console.log('    -> CORRECCION: Orden parcialmente invertido, corrigiendo');
        return {
          homeLogo: shields.awayLogo,
          awayLogo: shields.homeLogo,
          homeName: shields.awayName,
          awayName: shields.homeName,
        };
      }
      return shields;
    }

    console.log(`    -> No coincide con "${searchedHome}" vs "${searchedAway}", probando siguiente...`);
    return null;
  } catch (error) {
    console.log(`    -> Error navegando: ${error.message}`);
    return null;
  }
}

/**
 * Busca escudos en Flashscore con verificacion de coincidencia y correccion de orden.
 */
async function searchMatchLogos(page, homeTeam, awayTeam) {
  console.log(`  Buscando partido: ${homeTeam} vs ${awayTeam}`);

  const candidateUrls = await findFlashscoreMatchUrls(page, homeTeam, awayTeam);
  if (candidateUrls.length === 0) {
    console.log('  [WARN] No se encontraron resultados en Flashscore');
    return { homeLogo: null, awayLogo: null };
  }
  console.log(`  [OK] ${candidateUrls.length} resultado(s) de Flashscore encontrado(s)`);

  for (let i = 0; i < candidateUrls.length; i++) {
    const url = candidateUrls[i];
    console.log(`  [${i + 1}/${candidateUrls.length}] Probando: ${url}`);
    const result = await tryExtractFromUrl(page, url, homeTeam, awayTeam);
    if (result) return result;
  }

  console.log('  [INFO] Intentando busqueda con equipos invertidos...');
  const invertedUrls = await findFlashscoreMatchUrls(page, awayTeam, homeTeam);
  if (invertedUrls.length > 0) {
    console.log(`  [OK] ${invertedUrls.length} resultado(s) con busqueda invertida`);
    for (let i = 0; i < invertedUrls.length; i++) {
      const url = invertedUrls[i];
      console.log(`  [INV ${i + 1}/${invertedUrls.length}] Probando: ${url}`);
      const result = await tryExtractFromUrl(page, url, homeTeam, awayTeam);
      if (result) return result;
    }
  }

  console.log(`  [WARN] Ningun resultado coincidio con "${homeTeam}" vs "${awayTeam}"`);
  return { homeLogo: null, awayLogo: null };
}

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping de escudos desde Flashscore...');

  if (!fs.existsSync(PARTIDOS_PATH)) {
    console.warn('[Escudos] No se encontro partidos.json');
    saveEmptyJson();
    return;
  }

  const partidos = JSON.parse(fs.readFileSync(PARTIDOS_PATH, 'utf-8'));
  if (!partidos || partidos.length === 0) {
    console.log('[Escudos] No hay partidos para buscar escudos');
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    hasTouch: false,
    javaScriptEnabled: true,
  });

  const page = await context.newPage();

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('consent.google.com')) {
      route.abort();
    } else {
      route.continue();
    }
  });

  await context.addCookies([
    { name: 'CONSENT', value: 'YES+ES.es+V14+BX', domain: '.google.com', path: '/' },
    { name: 'CONSENT', value: 'YES+ES.es+V14+BX', domain: '.google.es', path: '/' },
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
        console.log(`[${i + 1}/${partidos.length}] Saltando: no se pudieron extraer equipos de "${matchText}"`);
        continue;
      }

      const matchKey = `${homeTeam} vs ${awayTeam}`;
      if (seenMatches.has(matchKey)) continue;
      seenMatches.add(matchKey);

      console.log(`\n[${i + 1}/${partidos.length}] Procesando: ${matchKey}`);

      let homeLogo = logoCache.get(homeTeam);
      let awayLogo = logoCache.get(awayTeam);

      if (homeLogo !== undefined && awayLogo !== undefined) {
        console.log('  [CACHE] Usando escudos en cache');
      } else {
        const result = await searchMatchLogos(page, homeTeam, awayTeam);
        if (homeLogo === undefined) {
          homeLogo = result.homeLogo;
          logoCache.set(homeTeam, homeLogo);
        }
        if (awayLogo === undefined) {
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
    console.log(`\n[Escudos] ${escudos.length} escudos guardados en ${OUTPUT}`);

    const totalTeams = new Set();
    for (const p of partidos) {
      const [h, a] = extractTeamNames(p.match);
      if (h) totalTeams.add(h);
      if (a) totalTeams.add(a);
    }
    const foundTeams = [...logoCache.values()].filter(Boolean).length;
    console.log(`[Escudos] Equipos unicos: ${totalTeams.size}, Escudos encontrados: ${foundTeams}`);

  } catch (error) {
    console.warn('[Escudos] Error durante scraping:', error.message);
    saveEmptyJson();
    process.exitCode = 0;
  } finally {
    await browser.close();
  }
}

scrapeEscudos().catch((error) => {
  console.warn('[Escudos] Error inesperado:', error.message);
  saveEmptyJson();
  process.exitCode = 0;
});
