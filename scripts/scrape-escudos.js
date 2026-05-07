/**
 * Scraping de escudos desde Flashscore
 * Lee data/partidos.json, busca cada partido en Flashscore via Google,
 * extrae la URL del escudo desde el participantsData de la pagina del partido
 * y guarda en data/escudos.json
 *
 * Estrategia:
 * 1. Para cada partido "Equipo A vs Equipo B", buscar "Equipo A vs Equipo B flashscore"
 * 2. Extraer el primer resultado de Google que apunte a flashscore.com
 * 3. Navegar a la pagina del partido en Flashscore
 * 4. Extraer participantsData del script embebido en el HTML
 * 5. Obtener image_path de home y away
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
 *     "Mirassol vs LDU Quito" -> ["Mirassol", "LDU Quito"]
 */
function extractTeamNames(matchText) {
  if (!matchText) return [null, null];

  // Remover prefijo de competencia (todo antes de ": ")
  const withoutCompetition = matchText.replace(/^[^:]+:\ */, '');

  // Separar por " vs " o " vs. " (case insensitive)
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\s+(.+)/i);
  if (!vsMatch) return [null, null];

  const home = vsMatch[1].trim();
  const away = vsMatch[2].trim();

  return [home, away];
}

/**
 * Limpia el nombre del equipo para la busqueda.
 * Quita el pais entre parentesis para la busqueda, ej: "Mirassol (Bra)" -> "Mirassol"
 */
function cleanTeamNameForSearch(name) {
  if (!name) return '';
  // Quitar (XXX) del final, ej: "Mirassol (Bra)" -> "Mirassol"
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
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
      body.includes('i\'m not a robot') ||
      body.includes('no soy un robot') ||
      !!document.querySelector('form[action*="captcha"]') ||
      !!document.querySelector('#captcha')
    );
  });
}

/**
 * Busca en Google el partido en Flashscore y devuelve la URL de la pagina del partido.
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
    await page.waitForTimeout(3000);

    // Verificar si nos bloquearon
    const blocked = await isGoogleBlocked(page);
    if (blocked) {
      console.log(`  [BLOQUEO] Google detecto bot`);
      return null;
    }

    // Extraer el primer resultado que sea de flashscore.com
    const flashscoreUrl = await page.evaluate(() => {
      // Buscar todos los enlaces de resultados
      const links = document.querySelectorAll('a[href*="flashscore live"]');
      for (const link of links) {
        const href = link.href || '';
        // Solo enlaces a paginas de partidos (no a paginas de equipo, odds, etc.)
        if (
          href.includes('flashscore.com') &&
          href.includes('/match/') &&
          !href.includes('/standings/') &&
          !href.includes('/odds/') &&
          !href.includes('/h2h/') &&
          !href.includes('/cuotas/') &&
          !href.includes('/clasificacion/')
        ) {
          return href;
        }
      }

      // Si no encontramos /match/, buscar cualquier enlace de flashscore que parezca un partido
      const allLinks = document.querySelectorAll('a[href*="flashscore"]');
      for (const link of allLinks) {
        const href = link.href || '';
        if (href.includes('flashscore.com') && !href.includes('/team/')) {
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
 * Extrae un objeto JSON balanceado de un string comenzando desde el offset dado.
 * Cuenta las llaves de apertura y cierre para encontrar el final del objeto.
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

    if (char === '\\\\') {
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
        if (depth === 0) {
          startIdx = i;
        }
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
 * Extrae los escudos del participantsData en la pagina del partido de Flashscore.
 * Los escudos estan en window.__INITIAL_STATE__ o en un script con participantsData.
 */
async function extractShieldsFromFlashscore(page) {
  return page.evaluate(() => {
    try {
      // Funcion interna para extraer JSON balanceado
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
              if (depth === 0) {
                startIdx = i;
              }
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

      // Metodo 1: Buscar en todos los scripts por participantsData
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        if (script.textContent && script.textContent.includes('"participantsData"')) {
          const idx = script.textContent.indexOf('"participantsData"');
          // Encontrar el ':' despues de "participantsData"
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
              } catch (e) {
                // Ignorar error de parseo, intentar siguiente metodo
              }
            }
          }
        }
      }

      // Metodo 2: Buscar en window.__INITIAL_STATE__
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

      // Metodo 3: Buscar en window.environment
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

/**
 * Extrae el participantsData haciendo fetch a la API interna de Flashscore.
 * Algunas paginas de Flashscore cargan los datos via una API separada.
 */
async function extractShieldsFromFlashscoreApi(page, matchUrl) {
  // Intentar extraer el ID del partido de la URL
  // Ej: https://www.flashscore.com/match/football/ldu-quito-xIqORMgg/mirassol-pQ8ryEe7/
  const midMatch = matchUrl.match(/[?&]mid=([^&]+)/);
  if (midMatch) {
    const matchId = midMatch[1];
    try {
      // Flashscore tiene una API para detalles del partido
      const apiUrl = matchUrl.replace(/\?.*/, '').replace('/match/', '/api/match/') + '/summary/';
      // Esto es especulativo, mejor extraer del HTML
    } catch (e) {
      // Ignorar
    }
  }
  return null;
}

/**
 * Busca los escudos de ambos equipos buscando el partido en Flashscore.
 */
async function searchMatchLogos(page, homeTeam, awayTeam) {
  console.log(`  Buscando partido: ${homeTeam} vs ${awayTeam}`);

  // Paso 1: Buscar en Google el partido en Flashscore
  const flashscoreUrl = await findFlashscoreMatchUrl(page, homeTeam, awayTeam);

  if (!flashscoreUrl) {
    console.log(`  [WARN] No se encontro el partido en Flashscore`);
    return { homeLogo: null, awayLogo: null };
  }

  console.log(`  [OK] URL Flashscore encontrada: ${flashscoreUrl}`);

  // Paso 2: Navegar a la pagina del partido en Flashscore
  try {
    await page.goto(flashscoreUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
  } catch (error) {
    console.log(`  [ERROR] Navegando a Flashscore: ${error.message}`);
    return { homeLogo: null, awayLogo: null };
  }

  // Paso 3: Extraer los escudos del participantsData
  const shields = await extractShieldsFromFlashscore(page);

  if (shields && (shields.homeLogo || shields.awayLogo)) {
    console.log(`  [OK] Escudos extraidos - Local: ${shields.homeLogo ? 'SI' : 'NO'}, Visitante: ${shields.awayLogo ? 'SI' : 'NO'}`);
    return shields;
  }

  console.log(`  [WARN] No se pudieron extraer escudos de la pagina`);
  return { homeLogo: null, awayLogo: null };
}

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping de escudos desde Flashscore...');

  // Verificar que existan los partidos
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

  // Bypass del popup de consentimiento de cookies de Google
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('consent.google.com')) {
      route.abort();
    } else {
      route.continue();
    }
  });

  // Configurar bypass de cookies para Google
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

  // Cache de escudos para evitar buscar el mismo equipo multiple veces
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

      // Verificar cache para home
      let homeLogo = logoCache.get(homeTeam);
      // Verificar cache para away
      let awayLogo = logoCache.get(awayTeam);

      // Si ambos estan en cache, usar directamente
      if (homeLogo !== undefined && awayLogo !== undefined) {
        console.log(`  [CACHE] Usando escudos en cache`);
      } else {
        // Buscar el partido en Flashscore
        const result = await searchMatchLogos(page, homeTeam, awayTeam);

        // Actualizar cache y valores
        if (homeLogo === undefined) {
          homeLogo = result.homeLogo;
          logoCache.set(homeTeam, homeLogo);
        }
        if (awayLogo === undefined) {
          awayLogo = result.awayLogo;
          logoCache.set(awayTeam, awayLogo);
        }
      }

      // Solo agregar si al menos un escudo fue encontrado
      if (homeLogo || awayLogo) {
        escudos.push({
          match: matchKey,
          homeLogo: homeLogo || '',
          awayLogo: awayLogo || '',
        });
      }

      // Delay entre busquedas para no ser bloqueado
      if (i < partidos.length - 1) {
        await page.waitForTimeout(2000 + Math.random() * 2000);
      }
    }

    // Guardar resultados
    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(escudos, null, 2), 'utf-8');

    console.log(`\n[Escudos] ${escudos.length} escudos guardados en ${OUTPUT}`);

    // Resumen
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
