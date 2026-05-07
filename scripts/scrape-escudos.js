/**
 * Scraping de escudos desde Google Images
 * Lee data/partidos.json, busca cada equipo en Google Images,
 * extrae la URL del escudo y guarda en data/escudos.json
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
const GOOGLE_IMAGES_URL = 'https://www.google.com/search?tbm=isch&q=';
const DUCKDUCKGO_IMAGES_URL = 'https://duckduckgo.com/?iax=images&ia=images&q=';
const BING_IMAGES_URL = 'https://www.bing.com/images/search?q=';

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

  // Separar por "vs" o "vs." (case insensitive)
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\s+(.+)/i);
  if (!vsMatch) return [null, null];

  const home = vsMatch[1].trim();
  const away = vsMatch[2].trim();

  return [home, away];
}

/**
 * Limpia el nombre del equipo para buscar el escudo.
 * Remueve acentos, caracteres especiales, etc.
 */
function cleanTeamName(name) {
  if (!name) return '';

  // Mapeo de nombres comunes para mejorar resultados de busqueda
  const knownTeams = {
    'LDU Quito': 'LDU Quito escudo',
    'LDU': 'LDU Quito escudo',
    'River Plate': 'River Plate escudo',
    'Boca Juniors': 'Boca Juniors escudo',
    'Barcelona SC': 'Barcelona SC Ecuador escudo',
    'Atletico': 'Atletico escudo',
    'Atletico Nacional': 'Atletico Nacional escudo',
    'Nacional': 'Nacional Uruguay escudo',
    'Penarol': 'Penarol escudo',
    'Flamengo': 'Flamengo escudo',
    'Palmeiras': 'Palmeiras escudo',
    'Corinthians': 'Corinthians escudo',
    'Sao Paulo': 'Sao Paulo escudo',
    'Santos': 'Santos escudo',
    'Gremio': 'Gremio escudo',
    'Internacional': 'Internacional RS escudo',
    'Cruzeiro': 'Cruzeiro escudo',
    'Atletico Mineiro': 'Atletico Mineiro escudo',
    'Botafogo': 'Botafogo escudo',
    'Vasco': 'Vasco da Gama escudo',
    'Fluminense': 'Fluminense escudo',
    'Independiente': 'Independiente escudo',
    'Racing': 'Racing Club escudo',
    'San Lorenzo': 'San Lorenzo escudo',
    'Velez': 'Velez Sarsfield escudo',
    'Estudiantes': 'Estudiantes de La Plata escudo',
    'Newells': 'Newells Old Boys escudo',
    'Rosario Central': 'Rosario Central escudo',
    'Union': 'Union Santa Fe escudo',
    'Talleres': 'Talleres Cordoba escudo',
    'Lanus': 'Lanus escudo',
    'Colon': 'Colon Santa Fe escudo',
    'Banfield': 'Banfield escudo',
    'Gimnasia': 'Gimnasia La Plata escudo',
    'Argentinos': 'Argentinos Juniors escudo',
    'Huracan': 'Huracan escudo',
    'Godoy Cruz': 'Godoy Cruz escudo',
    'Sarmiento': 'Sarmiento Junin escudo',
    'Platense': 'Platense escudo',
    'Central Cordoba': 'Central Cordoba Santiago del Estero escudo',
    'Instituto': 'Instituto Cordoba escudo',
    'Belgrano': 'Belgrano Cordoba escudo',
    'Tigre': 'Tigre escudo',
    'Barracas Central': 'Barracas Central escudo',
    'Arsenal': 'Arsenal Sarandi escudo',
    'Defensa': 'Defensa y Justicia escudo',
    'Independiente Rivadavia': 'Independiente Rivadavia escudo',
  };

  // Si conocemos el equipo, usar el termino optimizado
  if (knownTeams[name]) {
    return knownTeams[name];
  }

  return `${name} escudo futbol`;
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
 * Extrae URLs de imagenes de Google Images desde la pagina.
 * Google Images carga thumbnails como data:image pero las URLs reales
 * estan en atributos data o en JSON dentro del HTML.
 */
async function extractFromGoogle(page) {
  return page.evaluate(() => {
    const results = [];

    // Estrategia 1: m phased - URLs de imagen reales en los data attributes
    const tiles = document.querySelectorAll('a[jsname]');
    for (const tile of tiles) {
      const href = tile.href || '';
      // Los href de Google Images contienen la URL real codificada
      // Ej: /imgres?imgurl=REAL_URL&tbnid=...
      const urlMatch = href.match(/[?&]imgurl=([^&]+)/);
      if (urlMatch) {
        try {
          const decoded = decodeURIComponent(urlMatch[1]);
          if (decoded.startsWith('http') && decoded.length > 20) {
            results.push(decoded);
          }
        } catch (e) {
          // ignorar errores de decode
        }
      }
    }

    // Estrategia 2: Buscar en elementos de imagen
    const images = document.querySelectorAll('img');
    for (const img of images) {
      const src = img.getAttribute('data-src') || img.getAttribute('data-iurl');
      if (src && src.startsWith('http') && !src.includes('gstatic.com') && src.length > 30) {
        results.push(src);
      }
    }

    // Estrategia 3: Buscar en el HTML por patrones de URL de imagen
    const bodyHtml = document.body?.innerHTML || '';
    const urlPattern = /(https?:\/\/[^\s"<>]+\.(?:png|jpg|jpeg|webp))/gi;
    const matches = bodyHtml.match(urlPattern);
    if (matches) {
      for (const match of matches) {
        if (
          match.length > 30 &&
          !match.includes('gstatic.com') &&
          !match.includes('google.com') &&
          !match.includes('googleusercontent') &&
          !match.includes('w3.org')
        ) {
          results.push(match);
        }
      }
    }

    return results;
  });
}

/**
 * Extrae URLs de imagenes de Bing Images.
 */
async function extractFromBing(page) {
  return page.evaluate(() => {
    const results = [];

    // Bing usa murl para la URL real de la imagen
    const images = document.querySelectorAll('a[m*="murl"]');
    for (const a of images) {
      const murl = a.getAttribute('m');
      if (murl) {
        const murlMatch = murl.match(/"murl":"([^"]+)"/);
        if (murlMatch) {
          results.push(murlMatch[1]);
        }
      }
    }

    // Fallback: buscar en img tags
    if (results.length === 0) {
      const imgs = document.querySelectorAll('.iusc img, .mimg img');
      for (const img of imgs) {
        const src = img.src || img.getAttribute('data-src');
        if (src && src.startsWith('http') && src.length > 30) {
          results.push(src);
        }
      }
    }

    return results;
  });
}

/**
 * Extrae URLs de imagenes de DuckDuckGo Images.
 */
async function extractFromDuckDuckGo(page) {
  return page.evaluate(() => {
    const results = [];

    // DuckDuckGo pone las URLs en data-src o en enlaces
    const tiles = document.querySelectorAll('.tile--img__img, .tile__media__img');
    for (const tile of tiles) {
      const src =
        tile.getAttribute('data-src') ||
        tile.getAttribute('src') ||
        tile.src;
      if (src && src.startsWith('http') && src.length > 20) {
        results.push(src);
      }
    }

    // Fallback: cualquier imagen grande en resultados
    if (results.length === 0) {
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (
          src.startsWith('http') &&
          !src.includes('duckduckgo.com') &&
          !src.includes('icons') &&
          src.length > 30
        ) {
          results.push(src);
        }
      }
    }

    return results;
  });
}

/**
 * Busca el escudo de un equipo usando multiples fuentes.
 * Orden: Google Images -> Bing Images -> DuckDuckGo Images
 */
async function searchTeamLogo(page, teamName, matchContext) {
  if (!teamName) return null;

  const searchTerm = cleanTeamName(teamName);
  const searchQuery = encodeURIComponent(searchTerm);

  // --- Intento 1: Google Images ---
  try {
    const searchUrl = `${GOOGLE_IMAGES_URL}${searchQuery}`;
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3500);

    // Verificar si nos bloquearon
    const blocked = await isGoogleBlocked(page);
    if (!blocked) {
      const results = await extractFromGoogle(page);
      if (results.length > 0) {
        const bestResult = results.find(
          (url) =>
            !url.includes('wikipedia') || // preferir no-wikipedia pero aceptar
            url.length > 20
        ) || results[0];
        console.log(`  [OK Google] ${teamName}`);
        return bestResult;
      }
    } else {
      console.log(`  [BLOQUEO] Google detecto bot, probando alternativas...`);
    }
  } catch (error) {
    // Silenciosamente pasar a la siguiente fuente
  }

  // --- Intento 2: Bing Images ---
  try {
    const searchUrl = `${BING_IMAGES_URL}${searchQuery}`;
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3500);

    const results = await extractFromBing(page);
    if (results.length > 0) {
      console.log(`  [OK Bing] ${teamName}`);
      return results[0];
    }
  } catch (error) {
    // Silenciosamente pasar a la siguiente fuente
  }

  // --- Intento 3: DuckDuckGo Images ---
  try {
    const searchUrl = `${DUCKDUCKGO_IMAGES_URL}${searchQuery}`;
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const results = await extractFromDuckDuckGo(page);
    if (results.length > 0) {
      console.log(`  [OK DuckDuckGo] ${teamName}`);
      return results[0];
    }
  } catch (error) {
    // Se agotaron las opciones
  }

  console.log(`  [WARN] No se encontro escudo para: ${teamName}`);
  return null;
}

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping de escudos desde Google Images...');

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

      console.log(`[${i + 1}/${partidos.length}] Buscando escudos para: ${matchKey}`);

      // Buscar escudo local (con cache)
      let homeLogo = logoCache.get(homeTeam);
      if (homeLogo === undefined) {
        homeLogo = await searchTeamLogo(page, homeTeam, matchText);
        logoCache.set(homeTeam, homeLogo);
      }

      // Buscar escudo visitante (con cache)
      let awayLogo = logoCache.get(awayTeam);
      if (awayLogo === undefined) {
        awayLogo = await searchTeamLogo(page, awayTeam, matchText);
        logoCache.set(awayTeam, awayLogo);
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

    console.log(`[Escudos] ${escudos.length} escudos guardados en ${OUTPUT}`);

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
