/**
 * Scraping de escudos desde Flashscore v2.0
 *
 * Estrategia mejorada:
 * 1. DuckDuckGo HTML search (evita bloqueos anti-bot de Google)
 * 2. Extrae URLs de redireccion ?uddg= (Flashscore usa varios TLDs)
 * 3. Fallback: busqueda directa via flashscore.com/search/
 * 4. Extrae participantsData del HTML de la pagina del partido
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PARTIDOS_PATH = path.join(__dirname, '..', 'data', 'partidos.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveEmptyJson() {
  ensureDir(OUTPUT);
  fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2), 'utf-8');
  console.log('[Escudos] JSON vacio guardado');
}

function extractTeamNames(matchText) {
  if (!matchText) return [null, null];
  const withoutCompetition = matchText.replace(/^[^:]+:\s*/, '');
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\b\s*(.+)/i);
  if (!vsMatch) return [null, null];
  return [vsMatch[1].trim(), vsMatch[2].trim()];
}

function cleanTeamName(name) {
  if (!name) return '';
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function decodeDdgUrl(rawHref) {
  try {
    // Extraer parametro uddg de enlaces tipo:
    // //duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.flashscore.com%2F...&rut=...
    const uddg = rawHref.match(/[?&]uddg=([^&]+)/);
    return uddg ? decodeURIComponent(uddg[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Estrategia 1: DuckDuckGo HTML search
 */
async function findViaDuckDuckGo(page, homeTeam, awayTeam) {
  const homeClean = cleanTeamName(homeTeam);
  const awayClean = cleanTeamName(awayTeam);
  const query = encodeURIComponent(`${homeClean} ${awayClean} flashscore`);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${query}`;

  console.log(`  [DDG] Buscando: ${homeClean} ${awayClean} flashscore`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);

    // Extraer TODOS los href de la pagina que contengan uddg + flashscore + /match/
    const candidates = await page.evaluate(() => {
      const urls = [];
      for (const a of document.querySelectorAll('a[href*="uddg"]')) {
        if (a.href) urls.push(a.href);
      }
      return urls;
    });

    console.log(`  [DDG] ${candidates.length} enlaces con uddg encontrados`);

    for (const href of candidates) {
      const decoded = decodeDdgUrl(href);
      if (decoded && /flashscore\.[a-z.]+\/match\//.test(decoded)) {
        // Normalizar a .com para consistencia
        const normalized = decoded.replace(/flashscore\.[a-z.]+\//, 'flashscore.com/');
        console.log(`  [DDG] Match URL: ${normalized}`);
        return normalized;
      }
    }

    console.log(`  [DDG] Ningun resultado contiene /match/`);
    return null;
  } catch (err) {
    console.log(`  [DDG] Error: ${err.message}`);
    return null;
  }
}

/**
 * Estrategia 2: Busqueda directa en flashscore.com/search/
 * DuckDuckGo devuelve URLs en distintos TLDs (.com, .cl, .com.au, etc).
 * Buscamos via el search box de Flashscore y tomamos el primer resultado que sea /match/.
 */
async function findViaFlashscoreSearch(page, homeTeam, awayTeam) {
  const homeClean = cleanTeamName(homeTeam);
  const awayClean = cleanTeamName(awayTeam);

  console.log(`  [FS] Buscando directamente en Flashscore: ${homeClean}`);

  try {
    const query = encodeURIComponent(homeClean);
    const searchUrl = `https://www.flashscore.com/search/?q=${query}`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(4000);

    // Buscar tab de "Matches" y hacer click si existe
    const matchTab = await page.$('a:has-text("Matches"), a:has-text("Matches"), [data-tabid="matches"]');
    if (matchTab) {
      await matchTab.click();
      await page.waitForTimeout(3000);
    }

    // Extraer enlaces a partidos
    const matchLinks = await page.evaluate((awayClean) => {
      const results = [];
      const awayLower = awayClean.toLowerCase();

      // Buscar enlaces que contengan /match/ o /detalle-del-partido/
      for (const a of document.querySelectorAll('a[href*="/match/"], a[href*="/detalle-del-partido/"], a[href*="/partido/"]')) {
        const href = a.href || '';
        const text = (a.textContent || '').toLowerCase();
        // Incluir si menciona al equipo visitante
        if (text.includes(awayLower) && href.includes('flashscore')) {
          results.push({ href, text: a.textContent });
        }
      }

      // Si no hay match con away, tomar cualquier /match/ que veamos
      if (results.length === 0) {
        for (const a of document.querySelectorAll('a[href*="/match/"]')) {
          const href = a.href || '';
          if (href.includes('flashscore')) {
            results.push({ href, text: a.textContent });
          }
        }
      }

      return results;
    }, awayClean);

    if (matchLinks.length > 0) {
      // Normalizar URL a .com
      const url = matchLinks[0].href;
      const normalized = url.replace(/flashscore\.[a-z.]+\//, 'flashscore.com/');
      console.log(`  [FS] Match encontrado: ${normalized} (${matchLinks[0].text?.trim()})`);
      return normalized;
    }

    console.log(`  [FS] Sin resultados en search`);
    return null;
  } catch (err) {
    console.log(`  [FS] Error: ${err.message}`);
    return null;
  }
}

/**
 * Estrategia 3: Para NBA/baloncesto, Flashscore usa /basketball/ en la URL.
 * Probamos la URL de busqueda de basketball.
 */
async function findViaBasketballSearch(page, homeTeam, awayTeam) {
  const homeClean = cleanTeamName(homeTeam);
  const awayClean = cleanTeamName(awayTeam);

  console.log(`  [NBA] Buscando en Flashscore Basketball: ${homeClean} vs ${awayClean}`);

  try {
    // Buscar en la seccion de basketball
    const query = encodeURIComponent(`${homeClean} ${awayClean}`);
    const searchUrl = `https://www.flashscore.com/basketball/?q=${query}`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(4000);

    // Buscar enlaces que contengan ambos equipos
    const matchLinks = await page.evaluate((homeLower, awayLower) => {
      const results = [];
      for (const a of document.querySelectorAll('a[href*="/match/basketball/"]')) {
        const href = a.href || '';
        const text = (a.textContent || '').toLowerCase();
        if ((text.includes(homeLower) || text.includes(awayLower)) && href.includes('flashscore')) {
          results.push(href);
        }
      }
      return results;
    }, homeClean.toLowerCase(), awayClean.toLowerCase());

    if (matchLinks.length > 0) {
      const normalized = matchLinks[0].replace(/flashscore\.[a-z.]+\//, 'flashscore.com/');
      console.log(`  [NBA] Encontrado: ${normalized}`);
      return normalized;
    }

    console.log(`  [NBA] Sin resultados`);
    return null;
  } catch (err) {
    console.log(`  [NBA] Error: ${err.message}`);
    return null;
  }
}

/**
 * Extrae participantsData del HTML de Flashscore.
 */
async function extractShields(page) {
  return page.evaluate(() => {
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        if (!script.textContent || !script.textContent.includes('"participantsData"')) continue;

        const text = script.textContent;
        const keyIdx = text.indexOf('"participantsData"');
        const colonIdx = text.indexOf(':', keyIdx);
        if (colonIdx === -1) continue;

        // Extraer JSON balanceado manualmente
        let depth = 0, inStr = false, esc = false, sIdx = -1;
        for (let i = colonIdx + 1; i < text.length; i++) {
          const c = text[i];
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (!inStr) {
            if (c === '{') { if (depth === 0) sIdx = i; depth++; }
            else if (c === '}') { depth--; if (depth === 0 && sIdx !== -1) {
              try {
                const data = JSON.parse(text.substring(sIdx, i + 1));
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
              } catch { /* next script */ }
              break;
            }}
          }
        }
      }

      // Fallback: window.__INITIAL_STATE__
      if (window.__INITIAL_STATE__) {
        const parts = window.__INITIAL_STATE__.event?.participantsData || window.__INITIAL_STATE__.participantsData;
        if (parts) {
          const home = parts.home?.[0];
          const away = parts.away?.[0];
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

      return null;
    } catch (e) {
      return null;
    }
  });
}

/**
 * Orquesta las 3 estrategias de busqueda.
 */
async function findMatchUrl(page, homeTeam, awayTeam, competition) {
  const isBasketball = /\b(nba|basketball|euroleague)\b/i.test(competition || '');

  // Estrategia 1: DuckDuckGo
  let url = await findViaDuckDuckGo(page, homeTeam, awayTeam);

  // Estrategia 2: Flashscore search
  if (!url) {
    url = await findViaFlashscoreSearch(page, homeTeam, awayTeam);
  }

  // Estrategia 3: Basketball-specific search
  if (!url && isBasketball) {
    url = await findViaBasketballSearch(page, homeTeam, awayTeam);
  }

  return url;
}

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping de escudos desde Flashscore v2.0...');

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

  console.log(`[Escudos] ${partidos.length} canales/partidos encontrados`);

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
  });

  const page = await context.newPage();

  // Aceptar cookies de DuckDuckGo via header
  await context.addCookies([
    { name: 'cookie_consent', value: 'agreed', domain: '.duckduckgo.com', path: '/' },
    { name: 'cookie_consent', value: 'agreed', domain: 'html.duckduckgo.com', path: '/' },
  ]);

  const logoCache = new Map();
  const escudos = [];
  const seenMatches = new Set();
  let successCount = 0;
  let failCount = 0;

  try {
    for (let i = 0; i < partidos.length; i++) {
      const partido = partidos[i];
      const matchText = partido.match;
      if (!matchText) continue;

      const [homeTeam, awayTeam] = extractTeamNames(matchText);
      if (!homeTeam || !awayTeam) {
        console.log(`\n[${i + 1}/${partidos.length}] Saltando: sin equipos en "${matchText}"`);
        continue;
      }

      const matchKey = `${homeTeam} vs ${awayTeam}`;
      if (seenMatches.has(matchKey)) continue;
      seenMatches.add(matchKey);

      console.log(`\n[${i + 1}/${partidos.length}] Procesando: ${matchKey}`);

      let homeLogo = logoCache.get(homeTeam);
      let awayLogo = logoCache.get(awayTeam);

      if (homeLogo !== undefined && awayLogo !== undefined) {
        console.log(`  [CACHE] Usando escudos cacheados`);
      } else {
        const competition = partido.competition || '';
        const url = await findMatchUrl(page, homeTeam, awayTeam, competition);

        if (!url) {
          console.log(`  [WARN] No se encontro URL para ${matchKey}`);
          if (homeLogo === undefined) { homeLogo = null; logoCache.set(homeTeam, null); }
          if (awayLogo === undefined) { awayLogo = null; logoCache.set(awayTeam, null); }
          failCount++;
          continue;
        }

        // Navegar al partido
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await page.waitForTimeout(4000);
        } catch (err) {
          console.log(`  [ERROR] Navegando: ${err.message}`);
          if (homeLogo === undefined) { homeLogo = null; logoCache.set(homeTeam, null); }
          if (awayLogo === undefined) { awayLogo = null; logoCache.set(awayTeam, null); }
          failCount++;
          continue;
        }

        const shields = await extractShields(page);

        if (shields) {
          console.log(`  [OK] ${shields.homeName} vs ${shields.awayName}`);
          if (homeLogo === undefined) { homeLogo = shields.homeLogo; logoCache.set(homeTeam, homeLogo); }
          if (awayLogo === undefined) { awayLogo = shields.awayLogo; logoCache.set(awayTeam, awayLogo); }
          successCount++;
        } else {
          console.log(`  [WARN] No se encontraron escudos en la pagina`);
          if (homeLogo === undefined) { homeLogo = null; logoCache.set(homeTeam, null); }
          if (awayLogo === undefined) { awayLogo = null; logoCache.set(awayTeam, null); }
          failCount++;
        }
      }

      if (homeLogo || awayLogo) {
        escudos.push({
          match: matchKey,
          homeLogo: homeLogo || '',
          awayLogo: awayLogo || '',
        });
      }

      // Delay entre peticiones
      if (i < partidos.length - 1) {
        await page.waitForTimeout(3000 + Math.random() * 2000);
      }
    }

    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(escudos, null, 2), 'utf-8');

    const allTeams = new Set();
    for (const p of partidos) {
      const [h, a] = extractTeamNames(p.match);
      if (h) allTeams.add(h);
      if (a) allTeams.add(a);
    }
    const foundCount = [...logoCache.values()].filter(Boolean).length;

    console.log(`\n========================================`);
    console.log(`[Escudos] ${escudos.length} partidos con escudos guardados`);
    console.log(`[Escudos] Equipos unicos: ${allTeams.size}`);
    console.log(`[Escudos] Escudos encontrados: ${foundCount}/${allTeams.size}`);
    console.log(`[Escudos] Busquedas exitosas: ${successCount}, Fallidas: ${failCount}`);
    console.log(`========================================`);

  } catch (error) {
    console.warn('[Escudos] Error:', error.message);
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
