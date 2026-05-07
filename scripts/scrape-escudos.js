/**
 * Scraping de escudos desde Flashscore
 * Lee data/partidos.json, busca cada partido en Flashscore via Google,
 * extrae la URL del escudo desde el participantsData de la pagina del partido
 * y guarda en data/escudos.json
 *
 * Correcciones aplicadas:
 * - Filtro por fecha: solo acepta partidos del DIA ACTUAL
 * - Asignacion por nombre: compara nombres de equipos para evitar escudos cruzados
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

// ============================================
// UTILIDADES DE FECHA
// ============================================

/**
 * Obtiene la fecha de hoy en formato YYYY-MM-DD para comparaciones
 */
function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Obtiene la fecha de hoy en formato legible para la busqueda
 */
function getTodayForSearch() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Compara dos fechas en formato YYYY-MM-DD
 */
function isSameDate(dateStr1, dateStr2) {
  if (!dateStr1 || !dateStr2) return false;
  return dateStr1 === dateStr2;
}

// ============================================
// UTILIDADES DE NOMBRE DE EQUIPO
// ============================================

/**
 * Normaliza un nombre de equipo para comparacion:
 * - minusculas
 * - sin acentos
 * - sin espacios extra
 * - sin parentesis de pais
 */
function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // quitar acentos
    .replace(/\s*\([^)]*\)\s*$/g, '') // quitar (Bra), (Arg), etc.
    .replace(/[^a-z0-9]/g, '')          // solo letras y numeros
    .trim();
}

/**
 * Compara dos nombres de equipo de forma flexible
 */
function teamNamesMatch(name1, name2) {
  const n1 = normalizeTeamName(name1);
  const n2 = normalizeTeamName(name2);
  if (!n1 || !n2) return false;

  // Coincidencia exacta
  if (n1 === n2) return true;

  // Uno contiene al otro (ej: "ldu quito" vs "ldu")
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // Comparar palabras individuales
  const words1 = n1.split(/\s+/).filter(w => w.length > 2);
  const words2 = n2.split(/\s+/).filter(w => w.length > 2);
  if (words1.length > 0 && words2.length > 0) {
    const common = words1.filter(w => words2.includes(w));
    if (common.length >= Math.min(words1.length, words2.length) * 0.5) {
      return true;
    }
  }

  return false;
}

/**
 * Asigna los logos correctamente comparando los nombres de equipos.
 * Flashscore puede tener home/away invertidos respecto a nuestros datos.
 */
function assignLogosByName(expectedHome, expectedAway, flashscoreData) {
  if (!flashscoreData) return { homeLogo: null, awayLogo: null, matchedCorrectly: false };

  const fsHomeName = flashscoreData.homeName || '';
  const fsAwayName = flashscoreData.awayName || '';
  const fsHomeLogo = flashscoreData.homeLogo || null;
  const fsAwayLogo = flashscoreData.awayLogo || null;

  // Caso 1: Flashscore coincide con nuestro orden
  const homeMatchesHome = teamNamesMatch(expectedHome, fsHomeName);
  const awayMatchesAway = teamNamesMatch(expectedAway, fsAwayName);

  if (homeMatchesHome && awayMatchesAway) {
    return {
      homeLogo: fsHomeLogo,
      awayLogo: fsAwayLogo,
      matchedCorrectly: true,
    };
  }

  // Caso 2: Flashscore tiene los equipos invertidos
  const homeMatchesAway = teamNamesMatch(expectedHome, fsAwayName);
  const awayMatchesHome = teamNamesMatch(expectedAway, fsHomeName);

  if (homeMatchesAway && awayMatchesHome) {
    return {
      homeLogo: fsAwayLogo,
      awayLogo: fsHomeLogo,
      matchedCorrectly: true,
    };
  }

  // Caso 3: Coincidencia parcial
  let homeLogo = null;
  let awayLogo = null;

  if (homeMatchesHome) homeLogo = fsHomeLogo;
  else if (homeMatchesAway) homeLogo = fsAwayLogo;

  if (awayMatchesAway) awayLogo = fsAwayLogo;
  else if (awayMatchesHome) awayLogo = fsHomeLogo;

  if (!homeLogo && !awayLogo) {
    return {
      homeLogo: fsHomeLogo,
      awayLogo: fsAwayLogo,
      matchedCorrectly: false,
    };
  }

  return {
    homeLogo,
    awayLogo,
    matchedCorrectly: homeLogo !== null && awayLogo !== null,
  };
}

// ============================================
// FUNCIONES AUXILIARES
// ============================================

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

function extractTeamNames(matchText) {
  if (!matchText) return [null, null];
  const withoutCompetition = matchText.replace(/^[^:]+:\s*/, '');
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\s+(.+)/i);
  if (!vsMatch) return [null, null];
  return [vsMatch[1].trim(), vsMatch[2].trim()];
}

function cleanTeamNameForSearch(name) {
  if (!name) return '';
  return name.replace(/\s*\([^)]*\)\s*$/g, '').trim();
}

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

// ============================================
// EXTRACCION DE FECHA DE FLASHSCORE
// ============================================

/**
 * Extrae la fecha del partido de la pagina de Flashscore.
 * Devuelve la fecha en formato YYYY-MM-DD o null.
 */
async function extractMatchDateFromFlashscore(page) {
  return page.evaluate(() => {
    try {
      // Metodo 1: Meta tag
      const metaDate = document.querySelector('meta[property="og:article:published_time"]');
      if (metaDate) {
        const d = new Date(metaDate.content);
        if (!isNaN(d)) {
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
      }

      // Metodo 2: Scripts con startTime o timestamp
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';

        const timeMatch = text.match(/["']startTime["']\s*:\s*["'](\d{4}-\d{2}-\d{2})/);
        if (timeMatch) return timeMatch[1];

        const tsMatch = text.match(/["']startTimestamp["']\s*:\s*(\d{10,})/);
        if (tsMatch) {
          const d = new Date(parseInt(tsMatch[1]) * 1000);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }

        const dateMatch = text.match(/(\d{2})[./](\d{2})[./](\d{4})/);
        if (dateMatch) {
          return `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
        }
      }

      // Metodo 3: Elementos del DOM
      const selectors = '.duelParticipant__startTime, .match__date, [data-testid="match-date"], .event__time, .matchDate';
      const dateElements = document.querySelectorAll(selectors);
      for (const el of dateElements) {
        const text = el.textContent || '';
        const match = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (match) return `${match[3]}-${match[2]}-${match[1]}`;
        const match2 = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (match2) return `${match2[3]}-${match2[2]}-${match2[1]}`;
      }

      // Metodo 4: window.__INITIAL_STATE__
      if (window.__INITIAL_STATE__) {
        const eventDate = window.__INITIAL_STATE__.event?.startTimestamp;
        if (eventDate) {
          const d = new Date(eventDate * 1000);
          if (!isNaN(d)) {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          }
        }
      }

      return null;
    } catch (e) {
      return null;
    }
  });
}

// ============================================
// BUSQUEDA EN GOOGLE (con fecha)
// ============================================

async function findFlashscoreMatchUrl(page, homeTeam, awayTeam) {
  const homeClean = cleanTeamNameForSearch(homeTeam);
  const awayClean = cleanTeamNameForSearch(awayTeam);
  const todayStr = getTodayForSearch();

  // Buscar con fecha incluida para priorizar resultados de hoy
  const searchQuery = encodeURIComponent(`${homeClean} vs ${awayClean} flashscore ${todayStr}`);
  const searchUrl = `${GOOGLE_SEARCH_URL}${searchQuery}`;

  try {
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const blocked = await isGoogleBlocked(page);
    if (blocked) {
      console.log(`  [BLOQUEO] Google detecto bot`);
      return null;
    }

    // Extraer TODOS los enlaces de flashscore que sean de partidos
    const flashscoreUrls = await page.evaluate(() => {
      const urls = [];
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
          urls.push(href);
        }
      }
      if (urls.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="flashscore"]');
        for (const link of allLinks) {
          const href = link.href || '';
          if (href.includes('flashscore.com') && !href.includes('/team/')) {
            urls.push(href);
          }
        }
      }
      return urls;
    });

    return flashscoreUrls.length > 0 ? flashscoreUrls : null;
  } catch (error) {
    console.log(`  [ERROR] Buscando en Google: ${error.message}`);
    return null;
  }
}

// ============================================
// EXTRACCION DE ESCUDOS
// ============================================

/**
 * Extrae los escudos Y los nombres de equipo del participantsData.
 * Devuelve {homeLogo, awayLogo, homeName, awayName}
 */
async function extractShieldsFromFlashscore(page) {
  return page.evaluate(() => {
    try {
      function extractBalancedJsonInner(text, startOffset) {
        let depth = 0;
        let inString = false;
        let escapeNext = false;
        let startIdx = -1;
        for (let i = startOffset; i < text.length; i++) {
          const char = text[i];
          if (escapeNext) { escapeNext = false; continue; }
          if (char === '\\') { escapeNext = true; continue; }
          if (char === '"' && !inString) { inString = true; continue; }
          if (char === '"' && inString) { inString = false; continue; }
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
              } catch (e) { /* ignora */ }
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

      if (window.environment && window.environment.participantsData) {
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

// ============================================
// BUSQUEDA PRINCIPAL CON VALIDACION DE FECHA
// ============================================

async function searchMatchLogos(page, homeTeam, awayTeam) {
  console.log(`  Buscando partido: ${homeTeam} vs ${awayTeam}`);

  const todayStr = getTodayDateString();
  console.log(`  [FECHA] Buscando partidos del: ${todayStr}`);

  const flashscoreUrls = await findFlashscoreMatchUrl(page, homeTeam, awayTeam);

  if (!flashscoreUrls || flashscoreUrls.length === 0) {
    console.log(`  [WARN] No se encontro el partido en Flashscore`);
    return { homeLogo: null, awayLogo: null };
  }

  for (let urlIdx = 0; urlIdx < flashscoreUrls.length; urlIdx++) {
    const flashscoreUrl = flashscoreUrls[urlIdx];
    console.log(`  [URL ${urlIdx + 1}/${flashscoreUrls.length}] ${flashscoreUrl}`);

    try {
      await page.goto(flashscoreUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
    } catch (error) {
      console.log(`  [ERROR] Navegando a Flashscore: ${error.message}`);
      continue;
    }

    // VALIDACION DE FECHA
    const matchDate = await extractMatchDateFromFlashscore(page);
    console.log(`  [FECHA] Pagina: ${matchDate || 'NO DETECTADA'} | Esperada: ${todayStr}`);

    if (matchDate && !isSameDate(matchDate, todayStr)) {
      console.log(`  [SKIP] Partido de fecha ${matchDate} no coincide con hoy (${todayStr})`);
      continue;
    }

    if (!matchDate) {
      console.log(`  [WARN] No se pudo detectar fecha, continuando con precaucion`);
    }

    // Extraer escudos
    const shields = await extractShieldsFromFlashscore(page);

    if (shields && (shields.homeLogo || shields.awayLogo)) {
      console.log(`  [OK] Escudos extraidos - Local(FS): ${shields.homeName}, Visitante(FS): ${shields.awayName}`);

      // ASIGNAR POR NOMBRE (no por posicion home/away cruda)
      const assigned = assignLogosByName(homeTeam, awayTeam, shields);

      if (assigned.matchedCorrectly) {
        console.log(`  [MATCH] Escudos asignados correctamente por nombre de equipo`);
      } else {
        console.log(`  [WARN] Asignacion por nombre no fue precisa, usando mejor coincidencia`);
      }

      return {
        homeLogo: assigned.homeLogo,
        awayLogo: assigned.awayLogo,
      };
    }

    console.log(`  [WARN] No se pudieron extraer escudos de esta pagina, probando siguiente...`);
  }

  console.log(`  [WARN] Se agotaron todas las URLs sin encontrar partido de hoy con escudos`);
  return { homeLogo: null, awayLogo: null };
}

// ============================================
// FUNCION PRINCIPAL
// ============================================

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping de escudos desde Flashscore...');
  console.log(`[Escudos] Fecha de hoy: ${getTodayDateString()}`);

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
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
        console.log(`  [CACHE] Usando escudos en cache`);
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
