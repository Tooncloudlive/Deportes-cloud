/**
 * Scraping de escudos desde BeSoccer
 * Lee data/partidos.json, busca cada partido en BeSoccer via Google,
 * extrae la URL del escudo desde la pagina del partido en BeSoccer
 * y guarda en data/escudos.json
 *
 * Estrategia:
 * 1. Para cada partido "Equipo A vs Equipo B", buscar "Equipo A vs Equipo B besoccer"
 * 2. Extraer el primer resultado de Google que apunte a besoccer.com
 * 3. Navegar a la pagina del partido en BeSoccer
 * 4. Extraer los escudos de los elementos .shield img o de los datos estructurados JSON-LD
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
  const withoutCompetition = matchText.replace(/^[^:]+\ */, '');

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
 * Busca en Google el partido en BeSoccer y devuelve la URL de la pagina del partido.
 */
async function findBeSoccerMatchUrl(page, homeTeam, awayTeam) {
  const homeClean = cleanTeamNameForSearch(homeTeam);
  const awayClean = cleanTeamNameForSearch(awayTeam);

  const searchQuery = encodeURIComponent(`${homeClean} vs ${awayClean} besoccer`);
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

    // Extraer el primer resultado que sea de besoccer.com
    const besoccerUrl = await page.evaluate(() => {
      // Buscar todos los enlaces de resultados
      const links = document.querySelectorAll('a[href*="besoccer"]');
      for (const link of links) {
        const href = link.href || '';
        // Solo enlaces a paginas de partidos
        if (
          href.includes('besoccer.com') &&
          (href.includes('/match/') || href.includes('/partido/')) &&
          !href.includes('/livescore/') &&
          !href.includes('/noticias/') &&
          !href.includes('/competiciones/') &&
          !href.includes('/equipos/') &&
          !href.includes('/jugadores/')
        ) {
          return href;
        }
      }

      // Si no encontramos /match/ o /partido/, buscar cualquier enlace de besoccer que parezca un partido
      const allLinks = document.querySelectorAll('a[href*="besoccer"]');
      for (const link of allLinks) {
        const href = link.href || '';
        if (
          href.includes('besoccer.com') &&
          !href.includes('/equipo/') &&
          !href.includes('/livescore/') &&
          !href.includes('/noticias/') &&
          !href.includes('/competiciones/') &&
          !href.includes('/equipos/') &&
          !href.includes('/jugadores/')
        ) {
          return href;
        }
      }

      return null;
    });

    return besoccerUrl;
  } catch (error) {
    console.log(`  [ERROR] Buscando en Google: ${error.message}`);
    return null;
  }
}

/**
 * Extrae los escudos de la pagina del partido en BeSoccer.
 * Los escudos estan en elementos <a class="shield"> con <img> dentro,
 * o en los datos estructurados JSON-LD.
 */
async function extractShieldsFromBeSoccer(page) {
  return page.evaluate(() => {
    try {
      // Metodo 1: Buscar en los datos estructurados JSON-LD (application/ld+json)
      const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          // Puede ser un objeto individual o un array
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            // Buscar SportsEvent que contiene los equipos
            if (item['@type'] === 'SportsEvent' && item.homeTeam && item.awayTeam) {
              const homeLogo = item.homeTeam.image || item.homeTeam.logo || null;
              const awayLogo = item.awayTeam.image || item.awayTeam.logo || null;
              const homeName = item.homeTeam.name || null;
              const awayName = item.awayTeam.name || null;

              if (homeLogo || awayLogo) {
                return {
                  homeLogo: homeLogo,
                  awayLogo: awayLogo,
                  homeName: homeName,
                  awayName: awayName,
                  source: 'json-ld-SportsEvent'
                };
              }
            }
            // Tambien buscar en homeTeam y awayTeam directamente
            if (item.homeTeam && item.awayTeam) {
              const homeLogo = item.homeTeam.image || item.homeTeam.logo || null;
              const awayLogo = item.awayTeam.image || item.awayTeam.logo || null;
              if (homeLogo || awayLogo) {
                return {
                  homeLogo: homeLogo,
                  awayLogo: awayLogo,
                  homeName: item.homeTeam.name || null,
                  awayName: item.awayTeam.name || null,
                  source: 'json-ld-generic'
                };
              }
            }
          }
        } catch (e) {
          // Ignorar error de parseo, intentar siguiente
        }
      }

      // Metodo 2: Buscar en los elementos .shield img (vista estandar)
      const shieldLinks = document.querySelectorAll('a.shield');
      if (shieldLinks.length >= 2) {
        const homeImg = shieldLinks[0].querySelector('img');
        const awayImg = shieldLinks[1].querySelector('img');

        if (homeImg || awayImg) {
          return {
            homeLogo: homeImg ? homeImg.src : null,
            awayLogo: awayImg ? awayImg.src : null,
            homeName: homeImg ? homeImg.alt || null : null,
            awayName: awayImg ? awayImg.alt || null : null,
            source: 'shield-img'
          };
        }
      }

      // Metodo 3: Buscar img dentro de contenedores de equipo local/visitante
      // BeSoccer usa estructuras como .team.match-team.left y .team.match-team.right
      const homeTeamContainer = document.querySelector('.team.match-team.left, .match-team-left, .team--home, [class*="home"]');
      const awayTeamContainer = document.querySelector('.team.match-team.right, .match-team-right, .team--away, [class*="away"]');

      if (homeTeamContainer || awayTeamContainer) {
        const homeImg = homeTeamContainer ? homeTeamContainer.querySelector('img') : null;
        const awayImg = awayTeamContainer ? awayTeamContainer.querySelector('img') : null;

        if (homeImg || awayImg) {
          return {
            homeLogo: homeImg ? homeImg.src : null,
            awayLogo: awayImg ? awayImg.src : null,
            homeName: homeImg ? homeImg.alt || null : null,
            awayName: awayImg ? homeImg.alt || null : null,
            source: 'team-container-img'
          };
        }
      }

      // Metodo 4: Buscar todas las imagenes que parezcan escudos (contengan cdn.resfu.com o equipos/)
      const allImages = document.querySelectorAll('img');
      const shieldImages = [];
      for (const img of allImages) {
        const src = img.src || '';
        if (src.includes('cdn.resfu.com') || src.includes('/equipos/') || src.includes('shield') || src.includes('escudo') || src.includes('logo')) {
          shieldImages.push(img);
        }
      }

      // Filtrar imagenes muy pequenas (iconos, etc) y tomar las 2 primeras que sean escudos
      const validShieldImages = shieldImages.filter(img => {
        // Filtrar iconos muy pequenos y publicidad
        return img.width > 30 || img.naturalWidth > 30 || !img.width;
      });

      if (validShieldImages.length >= 2) {
        return {
          homeLogo: validShieldImages[0].src,
          awayLogo: validShieldImages[1].src,
          homeName: validShieldImages[0].alt || null,
          awayName: validShieldImages[1].alt || null,
          source: 'resfu-img'
        };
      }

      // Metodo 5: Buscar en metadatos og:image o twitter:image
      const ogImages = document.querySelectorAll('meta[property="og:image"]');
      if (ogImages.length > 0) {
        // A veces hay imagenes separadas para cada equipo
        const images = Array.from(ogImages).map(meta => meta.content).filter(Boolean);
        if (images.length >= 2) {
          return {
            homeLogo: images[0],
            awayLogo: images[1],
            homeName: null,
            awayName: null,
            source: 'og-image'
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
 * Extrae datos adicionales del equipo como respaldo (nombres corregidos, etc.)
 */
async function extractTeamNamesFromBeSoccer(page) {
  return page.evaluate(() => {
    try {
      // Intentar obtener nombres de los elementos de equipo
      const homeNameEl = document.querySelector('.team.match-team.left .name, .match-team-left .team-name, .team--home .name');
      const awayNameEl = document.querySelector('.team.match-team.right .name, .match-team-right .team-name, .team--away .name');

      if (homeNameEl || awayNameEl) {
        return {
          homeName: homeNameEl ? homeNameEl.textContent.trim() : null,
          awayName: awayNameEl ? awayNameEl.textContent.trim() : null
        };
      }

      // Alternativa: buscar en el titulo del partido
      const titleEl = document.querySelector('h1');
      if (titleEl) {
        const titleText = titleEl.textContent;
        // Formato tipico: "Equipo A vs Equipo B"
        const vsMatch = titleText.match(/(.+?)\s+[-v]+\s+(.+)/i);
        if (vsMatch) {
          return {
            homeName: vsMatch[1].trim(),
            awayName: vsMatch[2].trim()
          };
        }
      }

      return { homeName: null, awayName: null };
    } catch (e) {
      return { homeName: null, awayName: null };
    }
  });
}

/**
 * Busca los escudos de ambos equipos buscando el partido en BeSoccer.
 */
async function searchMatchLogos(page, homeTeam, awayTeam) {
  console.log(`  Buscando partido: ${homeTeam} vs ${awayTeam}`);

  // Paso 1: Buscar en Google el partido en BeSoccer
  const besoccerUrl = await findBeSoccerMatchUrl(page, homeTeam, awayTeam);

  if (!besoccerUrl) {
    console.log(`  [WARN] No se encontro el partido en BeSoccer`);
    return { homeLogo: null, awayLogo: null };
  }

  console.log(`  [OK] URL BeSoccer encontrada: ${besoccerUrl}`);

  // Paso 2: Navegar a la pagina del partido en BeSoccer
  try {
    await page.goto(besoccerUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
  } catch (error) {
    console.log(`  [ERROR] Navegando a BeSoccer: ${error.message}`);
    return { homeLogo: null, awayLogo: null };
  }

  // Paso 3: Extraer los escudos de la pagina
  const shields = await extractShieldsFromBeSoccer(page);

  if (shields && (shields.homeLogo || shields.awayLogo)) {
    console.log(`  [OK] Escudos extraidos via ${shields.source} - Local: ${shields.homeLogo ? 'SI' : 'NO'}, Visitante: ${shields.awayLogo ? 'SI' : 'NO'}`);

    // Si no tenemos nombres, intentar extraerlos por separado
    if (!shields.homeName || !shields.awayName) {
      const teamNames = await extractTeamNamesFromBeSoccer(page);
      shields.homeName = shields.homeName || teamNames.homeName;
      shields.awayName = shields.awayName || teamNames.awayName;
    }

    return {
      homeLogo: shields.homeLogo,
      awayLogo: shields.awayLogo,
      homeName: shields.homeName,
      awayName: shields.awayName
    };
  }

  console.log(`  [WARN] No se pudieron extraer escudos de la pagina`);
  return { homeLogo: null, awayLogo: null };
}

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping de escudos desde BeSoccer...');

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
        // Buscar el partido en BeSoccer
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
