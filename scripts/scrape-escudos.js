/**
 * Scraping de escudos desde Flashscore
 * Lee data/partidos.json, busca cada partido en Flashscore via Google,
 * extrae la URL del escudo desde el participantsData de la pagina del partido
 * y guarda en data/escudos.json
 *
 * Estrategia:
 * 1. Para cada partido "Equipo A vs Equipo B", buscar "Equipo A vs Equipo B flashscore live"
 * 2. Evaluar TODOS los resultados de Google y seleccionar el mejor (priorizando "LIVE")
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
  const withoutCompetition = matchText.replace(/^[^:]+:\s*/, '');

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
 * Normaliza un nombre de equipo para comparacion: quita parentesis, acentos, pasa a minusculas.
 */
function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Calcula un puntaje de coincidencia entre los equipos buscados y el texto del resultado.
 * Retorna un numero: mayor = mejor coincidencia.
 */
function scoreMatchResult(linkText, homeTeam, awayTeam) {
  if (!linkText) return 0;

  const text = linkText.toLowerCase();
  const homeNorm = normalizeTeamName(homeTeam);
  const awayNorm = normalizeTeamName(awayTeam);

  // Extraer nombres del texto del enlace, quitando cosas como "LIVE", fechas, etc.
  const cleanText = text
    .replace(/\b(live|vs\.?|v\.|v|football|hoy|en vivo|resultados|partido|marcadores)\b/g, ' ')
    .replace(/\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}/g, ' ') // fechas
    .replace(/\s+/g, ' ')
    .trim();

  const textNorm = cleanText.replace(/[^a-z0-9]/g, '');

  let score = 0;

  // +100 si contiene "LIVE" (resultado en vivo/reciente)
  if (text.includes('live')) score += 100;

  // +50 si el enlace es de /match/
  if (text.includes('/match/')) score += 50;

  // +30 por cada equipo que aparezca en el texto (comparacion normalizada)
  if (textNorm.includes(homeNorm)) score += 30;
  if (textNorm.includes(awayNorm)) score += 30;

  // +20 por coincidencia parcial (para nombres con espacios)
  const homePartial = homeTeam.toLowerCase().replace(/\s*\([^)]*\)\s*/g, '').trim();
  const awayPartial = awayTeam.toLowerCase().replace(/\s*\([^)]*\)\s*/g, '').trim();
  if (text.includes(homePartial)) score += 20;
  if (text.includes(awayPartial)) score += 20;

  // -50 si es pagina de equipo (/team/)
  if (text.includes('/team/')) score -= 50;

  // -30 si es pagina de standings, odds, h2h
  if (text.includes('/standings/') || text.includes('/odds/') || text.includes('/h2h/') ||
      text.includes('/cuotas/') || text.includes('/clasificacion/')) score -= 30;

  return score;
}

/**
 * Busca en Google el partido en Flashscore y devuelve la URL de la pagina del partido.
 * Estrategia:
 *  1. Agrega "live" a la busqueda para encontrar partidos recientes
 *  2. Evalua TODOS los resultados y selecciona el de mayor puntaje
 *  3. Prioriza resultados marcados como "LIVE" y que coincidan con los equipos
 */
async function findFlashscoreMatchUrl(page, homeTeam, awayTeam) {
  const homeClean = cleanTeamNameForSearch(homeTeam);
  const awayClean = cleanTeamNameForSearch(awayTeam);

  // Busqueda con "live" para encontrar partidos recientes/en vivo
  const searchQuery = encodeURIComponent(`${homeClean} vs ${awayClean} flashscore live`);
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

    // Extraer TODOS los resultados de flashscore con su URL y texto visible
    const candidates = await page.evaluate(() => {
      const results = [];

      // Google muestra los resultados en bloques <a> o dentro de divs con enlaces
      // Buscamos todos los elementos que contengan flashscore
      const allElements = document.querySelectorAll('a, div, span, h3');

      for (const el of allElements) {
        const text = el.textContent || '';
        const href = el.href || '';

        // Solo elementos relacionados con flashscore
        if (!text.toLowerCase().includes('flashscore') && !href.includes('flashscore')) continue;

        // Si es un enlace directo
        if (href && href.includes('flashscore.com')) {
          results.push({
            href: href,
            text: text.trim(),
          });
        }

        // Tambien buscar enlaces dentro del elemento padre (para resultados de Google)
        const links = el.querySelectorAll('a[href*="flashscore"]');
        for (const link of links) {
          const linkHref = link.href || '';
          const linkText = link.textContent || el.textContent || '';
          if (linkHref.includes('flashscore.com')) {
            results.push({
              href: linkHref,
              text: linkText.trim(),
            });
          }
        }
      }

      // Tambien buscar todos los <a> directamente (fallback)
      const directLinks = document.querySelectorAll('a[href*="flashscore.com"]');
      for (const link of directLinks) {
        const linkHref = link.href || '';
        const linkText = link.textContent || '';
        // Evitar duplicados
        if (!results.some(r => r.href === linkHref)) {
          results.push({
            href: linkHref,
            text: linkText.trim(),
          });
        }
      }

      return results;
    });

    if (!candidates || candidates.length === 0) {
      console.log(`  [WARN] No se encontraron resultados de Flashscore`);
      return null;
    }

    // Puntuar cada candidato y seleccionar el mejor
    let bestCandidate = null;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const score = scoreMatchResult(
        candidate.text + ' ' + candidate.href,
        homeTeam,
        awayTeam
      );

      // Log de debug para ver los candidatos
      console.log(`    [CANDIDATO] Score=${score} | ${candidate.text.substring(0, 80)}... | ${candidate.href.substring(0, 60)}`);

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    // Solo aceptar si tiene un puntaje minimo razonable
    if (bestCandidate && bestScore > 0) {
      console.log(`  [OK] Mejor resultado (score=${bestScore}): ${bestCandidate.text.substring(0, 80)}`);
      return bestCandidate.href;
    }

    // Fallback: si no hay buen candidato, tomar el primer /match/ que encuentre
    const fallbackMatch = candidates.find(c => c.href.includes('/match/'));
    if (fallbackMatch) {
      console.log(`  [FALLBACK] Usando primer /match/ encontrado: ${fallbackMatch.text.substring(0, 80)}`);
      return fallbackMatch.href;
    }

    // Ultimo fallback: cualquier enlace de flashscore que no sea /team/
    const fallbackAny = candidates.find(c => !c.href.includes('/team/'));
    if (fallbackAny) {
      console.log(`  [FALLBACK] Usando resultado generico: ${fallbackAny.text.substring(0, 80)}`);
      return fallbackAny.href;
    }

    console.log(`  [WARN] Ningun resultado fue suficientemente bueno (mejor score: ${bestScore})`);
    return null;

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
