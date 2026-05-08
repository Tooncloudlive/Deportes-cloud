/**
 * Scraping robusto de escudos desde Flashscore
 * Lee data/partidos.json, busca cada partido en Flashscore via Google,
 * extrae la URL del escudo desde multiples fuentes (DOM, participantsData, etc.)
 * y guarda en data/escudos.json
 *
 * Estrategia robusta:
 * 1. Multi-query: busca con fecha actual, con/sin pais, orden invertido
 * 2. Scoring de resultados: evalua todos los resultados de Google, no solo el primero
 * 3. Verificacion: confirma que los equipos en la pagina coincidan con los buscados
 * 4. Deteccion de inversion: detecta si home/away estan al reves
 * 5. Extraccion multi-metodo: intenta DOM > participantsData > INITIAL_STATE
 * 6. Fallback por equipo: si falla todo, busca escudo de cada equipo individualmente
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

// Meses en espanol e ingles para detectar fechas en titulos
const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MONTHS_EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];

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
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\.?\s+(.+)/i);
  if (!vsMatch) return [null, null];

  const home = vsMatch[1].trim();
  const away = vsMatch[2].trim();

  return [home, away];
}

/**
 * Limpia el nombre del equipo para la busqueda.
 * Quita el pais entre parentesis: "Mirassol (Bra)" -> "Mirassol"
 */
function cleanTeamName(name) {
  if (!name) return '';
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Obtiene el codigo de pais del nombre del equipo: "Platense (Arg)" -> "Arg"
 */
function extractCountry(name) {
  if (!name) return null;
  const match = name.match(/\(([^)]+)\)/);
  return match ? match[1] : null;
}

/**
 * Normaliza un nombre de equipo para comparacion (minusculas, sin acentos, sin espacios extra)
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Calcula un score de similitud entre dos nombres (0-1)
 */
function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  // Calcular distancia de Levenshtein simple
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(na, nb);
  return 1 - dist / maxLen;
}

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Obtiene la fecha actual formateada para busquedas
 */
function getCurrentDateParts() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthNameEs = MONTHS_ES[now.getMonth()];
  const monthNameEn = MONTHS_EN[now.getMonth()];
  return { year, month, monthNameEs, monthNameEn, day: now.getDate() };
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
 * Genera multiples queries de busqueda para maximizar chances de encontrar el partido correcto
 */
function generateSearchQueries(homeTeam, awayTeam) {
  const homeClean = cleanTeamName(homeTeam);
  const awayClean = cleanTeamName(awayTeam);
  const homeCountry = extractCountry(homeTeam);
  const awayCountry = extractCountry(awayTeam);
  const { year, monthNameEs, monthNameEn } = getCurrentDateParts();

  const queries = [];

  // 1. Busqueda basica con fecha actual
  queries.push(`${homeClean} vs ${awayClean} flashscore ${year}`);
  // 2. Con mes actual
  queries.push(`${homeClean} vs ${awayClean} flashscore ${monthNameEs} ${year}`);
  // 3. Orden invertido (a veces Flashscore indexa al reves)
  queries.push(`${awayClean} vs ${homeClean} flashscore ${year}`);
  // 4. Con paises
  if (homeCountry && awayCountry) {
    queries.push(`${homeClean} ${homeCountry} vs ${awayClean} ${awayCountry} flashscore`);
  }
  // 5. Solo nombres sin fecha
  queries.push(`${homeClean} vs ${awayClean} flashscore`);

  return queries;
}

/**
 * Extrae todos los resultados de Flashscore de la pagina de Google
 */
async function extractFlashscoreResults(page) {
  return page.evaluate(() => {
    const results = [];
    const allLinks = document.querySelectorAll('a[href*="flashscore"]');

    for (const link of allLinks) {
      const href = link.href || '';
      // Solo enlaces directos a flashscore.com (no ads, no traducciones)
      if (!href.match(/^https?:\/\/[^/]*flashscore\.com/)) continue;

      // Encontrar el titulo del resultado (buscando en ancestros)
      let title = '';
      let container = link.closest('div[data-ved]') || link.closest('div.g') || link.closest('.g') || link.closest('div[class*="gsc-webResult"]') || link.parentElement?.parentElement;
      if (container) {
        const titleEl = container.querySelector('h3') || container.querySelector('a > div > div:first-child') || link;
        title = titleEl ? (titleEl.textContent || titleEl.innerText || '') : '';
      }
      if (!title) title = link.textContent || link.innerText || '';

      // Extraer snippet/descripcion si existe
      let snippet = '';
      if (container) {
        const snippetEl = container.querySelector('div[data-sncf]') || container.querySelector('.VwiC3b') || container.querySelector('span:not([class])');
        snippet = snippetEl ? (snippetEl.textContent || '') : '';
      }

      // Detectar si es pagina de partido
      const isMatchPage = href.includes('/match/');
      const isH2hPage = href.includes('/h2h/');
      const isTeamPage = href.includes('/team/');
      const isOddsPage = href.includes('/odds/') || href.includes('/cuotas/');
      const isStandingsPage = href.includes('/standings/') || href.includes('/clasificacion/');

      results.push({
        href,
        title: title.trim(),
        snippet: snippet.trim(),
        isMatchPage,
        isH2hPage,
        isTeamPage,
        isOddsPage,
        isStandingsPage,
      });
    }

    return results;
  });
}

/**
 * Calcula un score para un resultado de busqueda
 * Mayor score = mas probable que sea el partido correcto
 */
function scoreSearchResult(result, homeTeam, awayTeam) {
  let score = 0;
  const homeClean = cleanTeamName(homeTeam);
  const awayClean = cleanTeamName(awayTeam);
  const homeNorm = normalizeName(homeClean);
  const awayNorm = normalizeName(awayClean);
  const titleLower = result.title.toLowerCase();
  const snippetLower = result.snippet.toLowerCase();
  const combined = titleLower + ' ' + snippetLower;

  // Priorizar paginas de partido sobre H2H, odds, etc.
  if (result.isMatchPage) score += 20;
  else if (result.isH2hPage) score += 5;
  else if (result.isTeamPage) score += 3;
  else score += 1;

  // Penalizar paginas que no son de partidos
  if (result.isOddsPage) score -= 10;
  if (result.isStandingsPage) score -= 10;

  // Detectar si ambos equipos aparecen en el titulo/snippet
  const hasHome = combined.includes(homeNorm) || nameSimilarity(homeClean, result.title) > 0.7;
  const hasAway = combined.includes(awayNorm) || nameSimilarity(awayClean, result.title) > 0.7;

  if (hasHome) score += 10;
  if (hasAway) score += 10;
  if (hasHome && hasAway) score += 15; // Bonus por tener ambos

  // Detectar fecha reciente en el titulo (preferir partidos recientes/futuros)
  const { year } = getCurrentDateParts();
  // Patrones como "07/05/2026", "07.05.2026", "mayo 2026", etc.
  const datePatterns = [
    new RegExp(`\\d{1,2}[/.]\\d{1,2}[/.]${year}`),
    new RegExp(`\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}`),
    new RegExp(`${year}`),
  ];
  for (const pattern of datePatterns) {
    if (pattern.test(combined)) {
      score += 8;
      break;
    }
  }

  // Penalizar resultados que dicen "H2H", "head to head", "historial"
  if (/\b(h2h|head.to.head|historial|enfrentamientos)\b/i.test(combined)) {
    score -= 5;
  }

  // Preferir dominios principales (.com, .es) sobre regionales (.com.ar, .com.br)
  if (/flashscore\.com\//.test(result.href) && !/flashscore\.com\.\w+\//.test(result.href)) {
    score += 3;
  }
  if (/flashscore\.es\//.test(result.href)) {
    score += 2;
  }

  return score;
}

/**
 * Busca en Google el partido en Flashscore y devuelve la MEJOR URL.
 * Evalua multiples resultados y elige el que mejor score tenga.
 */
async function findFlashscoreMatchUrl(page, homeTeam, awayTeam) {
  const queries = generateSearchQueries(homeTeam, awayTeam);
  let bestResult = null;
  let bestScore = -Infinity;

  for (const query of queries) {
    const searchUrl = `${GOOGLE_SEARCH_URL}${encodeURIComponent(query)}`;

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      if (await isGoogleBlocked(page)) {
        console.log(`  [BLOQUEO] Google detecto bot en query: ${query}`);
        continue;
      }

      const results = await extractFlashscoreResults(page);

      if (results.length === 0) {
        console.log(`  [INFO] Sin resultados para query: ${query}`);
        continue;
      }

      for (const result of results) {
        const score = scoreSearchResult(result, homeTeam, awayTeam);
        console.log(`    [RESULT] Score ${score.toFixed(1)} | ${result.isMatchPage ? 'MATCH' : 'OTHER'} | ${result.title.substring(0, 80)}`);

        if (score > bestScore) {
          bestScore = score;
          bestResult = result;
        }
      }

      // Si encontramos un resultado con score muy alto, podemos parar temprano
      if (bestScore >= 45) {
        console.log(`  [OK] Resultado de alto score encontrado, deteniendo busqueda`);
        break;
      }

    } catch (error) {
      console.log(`  [ERROR] Buscando query "${query}": ${error.message}`);
    }

    // Esperar entre queries
    await page.waitForTimeout(1500 + Math.random() * 1500);
  }

  if (bestResult) {
    console.log(`  [OK] Mejor resultado (score ${bestScore.toFixed(1)}): ${bestResult.href}`);
    return bestResult.href;
  }

  return null;
}

/**
 * Verifica que la pagina cargada tenga los equipos esperados.
 * Retorna: { valid: boolean, isInverted: boolean, pageHomeTeam: string, pageAwayTeam: string }
 */
async function verifyTeamsOnPage(page, expectedHome, expectedAway) {
  return page.evaluate((expHome, expAway) => {
    function normalize(str) {
      if (!str) return '';
      return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '').trim();
    }

    // Intentar extraer nombres de equipos de multiples fuentes
    let pageHome = null;
    let pageAway = null;

    // Metodo 1: Del participantsData si esta disponible
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        if (script.textContent && script.textContent.includes('"participantsData"')) {
          const match = script.textContent.match(/"participantsData"\s*:\s*(\{[\s\S]*?\}(?=\s*[,}]))/);
          if (match) {
            const data = JSON.parse(match[1]);
            if (data.home && data.home[0]) pageHome = data.home[0].name || '';
            if (data.away && data.away[0]) pageAway = data.away[0].name || '';
            break;
          }
        }
      }
    } catch (e) { /* ignore */ }

    // Metodo 2: De window.__INITIAL_STATE__
    if (!pageHome && window.__INITIAL_STATE__) {
      try {
        const parts = window.__INITIAL_STATE__.event?.participantsData || window.__INITIAL_STATE__.participantsData;
        if (parts) {
          if (parts.home && parts.home[0]) pageHome = parts.home[0].name || '';
          if (parts.away && parts.away[0]) pageAway = parts.away[0].name || '';
        }
      } catch (e) { /* ignore */ }
    }

    // Metodo 3: Del DOM directo (img alt attributes)
    if (!pageHome) {
      const homeImg = document.querySelector('.duelParticipant__home .participant__image');
      const awayImg = document.querySelector('.duelParticipant__away .participant__image');
      if (homeImg) pageHome = homeImg.alt || '';
      if (awayImg) pageAway = awayImg.alt || '';
    }

    // Metodo 4: De los links de equipo
    if (!pageHome) {
      const homeLink = document.querySelector('.duelParticipant__home a[title]');
      const awayLink = document.querySelector('.duelParticipant__away a[title]');
      if (homeLink) pageHome = homeLink.title || '';
      if (awayLink) pageAway = awayLink.title || '';
    }

    // Metodo 5: De los textos de nombres de participantes
    if (!pageHome) {
      const homeName = document.querySelector('.duelParticipant__home .participant__participantName');
      const awayName = document.querySelector('.duelParticipant__away .participant__participantName');
      if (homeName) pageHome = homeName.textContent || '';
      if (awayName) pageAway = awayName.textContent || '';
    }

    // Normalizar
    const ph = normalize(pageHome || '');
    const pa = normalize(pageAway || '');
    const eh = normalize(expHome || '');
    const ea = normalize(expAway || '');

    // Verificar coincidencia
    const homeMatchesHome = ph.includes(eh) || eh.includes(ph) || ph === eh;
    const homeMatchesAway = ph.includes(ea) || ea.includes(ph) || ph === ea;
    const awayMatchesAway = pa.includes(ea) || ea.includes(pa) || pa === ea;
    const awayMatchesHome = pa.includes(eh) || eh.includes(pa) || pa === eh;

    // Detectar inversion
    const isNormal = (homeMatchesHome && awayMatchesAway) || (!ph || !pa);
    const isInverted = homeMatchesAway && awayMatchesHome;

    // Si no tenemos datos de la pagina, asumir valido
    if (!ph && !pa) return { valid: true, isInverted: false, pageHomeTeam: pageHome, pageAwayTeam: pageAway };

    // Si al menos un equipo coincide, considerarlo valido
    const valid = homeMatchesHome || homeMatchesAway || awayMatchesHome || awayMatchesAway;

    return { valid, isInverted, pageHomeTeam: pageHome, pageAwayTeam: pageAway };
  }, expectedHome, expectedAway);
}

/**
 * Extrae un objeto JSON balanceado de un string comenzando desde el offset dado.
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
 * Extrae los escudos de la pagina de Flashscore usando multiples metodos.
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
        if (escapeNext) { escapeNext = false; continue; }
        if (char === '\\') { escapeNext = true; continue; }
        if (char === '"' && !inString) { inString = true; continue; }
        if (char === '"' && inString) { inString = false; continue; }
        if (!inString) {
          if (char === '{') { if (depth === 0) startIdx = i; depth++; }
          else if (char === '}') { depth--; if (depth === 0 && startIdx !== -1) return text.substring(startIdx, i + 1); }
        }
      }
      return null;
    }

    // ===== METODO 1: Extraer directamente del DOM (img tags) =====
    // Este es el metodo mas confiable segun la estructura actual de Flashscore
    try {
      const homeImg = document.querySelector('.duelParticipant__home .participant__image');
      const awayImg = document.querySelector('.duelParticipant__away .participant__image');

      if (homeImg && awayImg) {
        const homeSrc = homeImg.src || homeImg.getAttribute('data-src') || '';
        const awaySrc = awayImg.src || awayImg.getAttribute('data-src') || '';
        const homeAlt = homeImg.alt || '';
        const awayAlt = awayImg.alt || '';

        if (homeSrc && awaySrc) {
          return {
            homeLogo: homeSrc,
            awayLogo: awaySrc,
            homeName: homeAlt,
            awayName: awayAlt,
            source: 'dom-img',
          };
        }
      }
    } catch (e) { /* ignore */ }

    // ===== METODO 2: Buscar en todos los scripts por participantsData =====
    try {
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
                    source: 'participantsData',
                  };
                }
              } catch (e) { /* ignore */ }
            }
          }
        }
      }
    } catch (e) { /* ignore */ }

    // ===== METODO 3: Buscar en window.__INITIAL_STATE__ =====
    try {
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
              source: 'initialState',
            };
          }
        }
      }
    } catch (e) { /* ignore */ }

    // ===== METODO 4: Buscar en window.environment =====
    try {
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
            source: 'environment',
          };
        }
      }
    } catch (e) { /* ignore */ }

    // ===== METODO 5: Buscar cualquier img con src de static.flashscore.com en el header del partido =====
    try {
      const participantSection = document.querySelector('.duelParticipant');
      if (participantSection) {
        const imgs = participantSection.querySelectorAll('img');
        if (imgs.length >= 2) {
          return {
            homeLogo: imgs[0].src || imgs[0].getAttribute('data-src') || null,
            awayLogo: imgs[1].src || imgs[1].getAttribute('data-src') || null,
            homeName: imgs[0].alt || '',
            awayName: imgs[1].alt || '',
            source: 'dom-generic-img',
          };
        }
      }
    } catch (e) { /* ignore */ }

    return null;
  });
}

/**
 * Fallback: busca el escudo de un equipo individualmente en Flashscore
 */
async function searchTeamLogo(page, teamName) {
  const cleanName = cleanTeamName(teamName);
  const country = extractCountry(teamName);

  const queries = [
    `${cleanName} ${country || ''} flashscore team logo`.trim(),
    `${cleanName} flashscore team`,
    `${cleanName} ${country || ''} flashscore equipo`.trim(),
  ];

  for (const query of queries) {
    const searchUrl = `${GOOGLE_SEARCH_URL}${encodeURIComponent(query)}`;

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      if (await isGoogleBlocked(page)) continue;

      // Buscar un enlace a la pagina del equipo en Flashscore
      const teamUrl = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="flashscore"]');
        for (const link of links) {
          const href = link.href || '';
          if (href.includes('/team/') && !href.includes('/match/')) {
            return href;
          }
        }
        // Tambien buscar en resultados que no sean /team/ pero contengan el nombre del equipo
        for (const link of links) {
          const href = link.href || '';
          if (href.match(/^https?:\/\/[^/]*flashscore\.com/) && !href.includes('/match/')) {
            return href;
          }
        }
        return null;
      });

      if (teamUrl) {
        // Navegar a la pagina del equipo
        await page.goto(teamUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Extraer el logo de la pagina del equipo
        const logo = await page.evaluate(() => {
          // Buscar la imagen del logo en la pagina del equipo
          const logoImg = document.querySelector('.teamHeader__logo img') ||
                         document.querySelector('.heading__logo img') ||
                         document.querySelector('img[src*="/res/image/data/"]');
          if (logoImg) return logoImg.src || logoImg.getAttribute('data-src') || null;

          // Buscar en participantsData o INITIAL_STATE
          const scripts = document.querySelectorAll('script');
          for (const script of scripts) {
            if (script.textContent) {
              const imgMatch = script.textContent.match(/"image_path"\s*:\s*"([^"]+)"/);
              if (imgMatch) return imgMatch[1];
            }
          }

          if (window.__INITIAL_STATE__) {
            const teamData = window.__INITIAL_STATE__.team || window.__INITIAL_STATE__.entity;
            if (teamData) {
              return teamData.image_path || teamData.logo || null;
            }
          }

          return null;
        });

        if (logo) return logo;
      }
    } catch (error) {
      console.log(`  [ERROR] Buscando logo individual: ${error.message}`);
    }

    await page.waitForTimeout(1500 + Math.random() * 1500);
  }

  return null;
}

/**
 * Busca los escudos de ambos equipos buscando el partido en Flashscore.
 * Ahora con verificacion de equipos y deteccion de inversion.
 */
async function searchMatchLogos(page, homeTeam, awayTeam) {
  console.log(`  Buscando partido: ${homeTeam} vs ${awayTeam}`);

  // Paso 1: Buscar la mejor URL de Flashscore
  const flashscoreUrl = await findFlashscoreMatchUrl(page, homeTeam, awayTeam);

  if (!flashscoreUrl) {
    console.log(`  [WARN] No se encontro URL de Flashscore, intentando fallback individual`);
    return await fallbackIndividualSearch(page, homeTeam, awayTeam);
  }

  console.log(`  [OK] URL Flashscore encontrada: ${flashscoreUrl}`);

  // Paso 2: Navegar a la pagina del partido
  try {
    await page.goto(flashscoreUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
  } catch (error) {
    console.log(`  [ERROR] Navegando a Flashscore: ${error.message}`);
    return await fallbackIndividualSearch(page, homeTeam, awayTeam);
  }

  // Paso 3: Verificar que los equipos en la pagina coincidan
  const verification = await verifyTeamsOnPage(page, cleanTeamName(homeTeam), cleanTeamName(awayTeam));
  console.log(`  [VERIFY] Pagina valida: ${verification.valid}, Invertido: ${verification.isInverted} | Pagina: "${verification.pageHomeTeam}" vs "${verification.pageAwayTeam}"`);

  if (!verification.valid) {
    console.log(`  [WARN] Los equipos en la pagina no coinciden, intentando fallback individual`);
    return await fallbackIndividualSearch(page, homeTeam, awayTeam);
  }

  // Paso 4: Extraer los escudos
  let shields = await extractShieldsFromFlashscore(page);

  if (!shields || (!shields.homeLogo && !shields.awayLogo)) {
    console.log(`  [WARN] No se pudieron extraer escudos de la pagina, intentando fallback`);
    return await fallbackIndividualSearch(page, homeTeam, awayTeam);
  }

  console.log(`  [OK] Escudos extraidos via ${shields.source || 'unknown'} - Local: ${shields.homeLogo ? 'SI' : 'NO'}, Visitante: ${shields.awayLogo ? 'SI' : 'NO'}`);

  // Paso 5: Si los equipos estan invertidos en la pagina, intercambiar los escudos
  if (verification.isInverted) {
    console.log(`  [SWAP] Detectada inversion de equipos, intercambiando escudos`);
    const tempLogo = shields.homeLogo;
    const tempName = shields.homeName;
    shields.homeLogo = shields.awayLogo;
    shields.homeName = shields.awayName;
    shields.awayLogo = tempLogo;
    shields.awayName = tempName;
  }

  return {
    homeLogo: shields.homeLogo,
    awayLogo: shields.awayLogo,
    homeName: shields.homeName,
    awayName: shields.awayName,
  };
}

/**
 * Fallback: busca escudos individualmente si la busqueda del partido falla
 */
async function fallbackIndividualSearch(page, homeTeam, awayTeam) {
  console.log(`  [FALLBACK] Buscando escudos individualmente`);

  const homeLogo = await searchTeamLogo(page, homeTeam);
  const awayLogo = await searchTeamLogo(page, awayTeam);

  return {
    homeLogo,
    awayLogo,
    homeName: cleanTeamName(homeTeam),
    awayName: cleanTeamName(awayTeam),
  };
}

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping robusto de escudos desde Flashscore...');

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

  // Bypass del popup de consentimiento de cookies de Google
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

  // Cache de escudos para evitar buscar el mismo equipo multiple veces
  const logoCache = new Map();
  const escudos = [];
  const seenMatches = new Set();

  // Stats para el resumen
  let successCount = 0;
  let failCount = 0;
  let invertedDetected = 0;

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

        // Tracking de inversiones
        if (result.inverted) invertedDetected++;
      }

      if (homeLogo || awayLogo) {
        escudos.push({
          match: matchKey,
          homeLogo: homeLogo || '',
          awayLogo: awayLogo || '',
        });
        successCount++;
      } else {
        console.log(`  [FAIL] No se encontraron escudos para ${matchKey}`);
        failCount++;
      }

      // Delay entre busquedas
      if (i < partidos.length - 1) {
        await page.waitForTimeout(2500 + Math.random() * 2500);
      }
    }

    // Guardar resultados
    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(escudos, null, 2), 'utf-8');

    console.log(`\n${'='.repeat(60)}`);
    console.log('[Escudos] RESUMEN:');
    console.log(`  - Partidos procesados: ${seenMatches.size}`);
    console.log(`  - Escudos guardados: ${escudos.length}`);
    console.log(`  - Con ambos escudos: ${escudos.filter(e => e.homeLogo && e.awayLogo).length}`);
    console.log(`  - Con solo local: ${escudos.filter(e => e.homeLogo && !e.awayLogo).length}`);
    console.log(`  - Con solo visitante: ${escudos.filter(e => !e.homeLogo && e.awayLogo).length}`);
    console.log(`  - Fallos totales: ${failCount}`);
    console.log(`  - Inversiones detectadas/corregidas: ${invertedDetected}`);

    const totalTeams = new Set();
    for (const p of partidos) {
      const [h, a] = extractTeamNames(p.match);
      if (h) totalTeams.add(h);
      if (a) totalTeams.add(a);
    }
    const foundTeams = [...logoCache.entries()].filter(([, v]) => v).length;
    console.log(`  - Equipos unicos: ${totalTeams.size}`);
    console.log(`  - Escudos encontrados: ${foundTeams}`);
    console.log(`${'='.repeat(60)}`);

  } catch (error) {
    console.warn('[Escudos] Error durante scraping:', error.message);
    console.warn(error.stack);
    saveEmptyJson();
    process.exitCode = 0;
  } finally {
    await browser.close();
  }
}

scrapeEscudos().catch((error) => {
  console.warn('[Escudos] Error inesperado:', error.message);
  console.warn(error.stack);
  saveEmptyJson();
  process.exitCode = 0;
});
