/**
 * SCRAPER DEFINITIVO DE ESCUDOS
 * Soluciona partidos faltantes con estrategia multinivel:
 *
 * NIVEL 1: Google -> Flashscore partido
 * NIVEL 2: Google -> Flashscore equipo local
 * NIVEL 3: Google -> Flashscore equipo visitante
 * NIVEL 4: Busqueda directa por logos en Google Images (fallback)
 *
 * Mejora enorme para equipos como:
 * - Elche
 * - Cagliari
 * - Ceuta
 * - Castellon
 * - ligas menores
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PARTIDOS_PATH = path.join(__dirname, '..', 'data', 'partidos.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');
const GOOGLE_SEARCH_URL = 'https://www.google.com/search?q=';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveEmptyJson() {
  ensureDir(OUTPUT);
  fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2), 'utf-8');
}

function extractTeamNames(matchText) {
  if (!matchText) return [null, null];

  const withoutCompetition = matchText.replace(/^[^:]+:\s*/, '');
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\.?\s+(.+)/i);

  if (!vsMatch) return [null, null];

  return [vsMatch[1].trim(), vsMatch[2].trim()];
}

function cleanTeamNameForSearch(name) {
  if (!name) return '';

  return name
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[^\w\s\-áéíóúñü]/gi, '')
    .replace(/\bfc\b/gi, '')
    .replace(/\bclub\b/gi, '')
    .trim();
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
      body.includes('automated requests')
    );
  });
}

/**
 * BUSQUEDA GOOGLE GENERICA
 */
async function googleSearch(page, query) {
  const url = `${GOOGLE_SEARCH_URL}${encodeURIComponent(query)}`;

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(2500);

    if (await isGoogleBlocked(page)) return null;

    return true;
  } catch {
    return null;
  }
}

/**
 * Busca partido Flashscore
 */
async function findFlashscoreMatchUrl(page, homeTeam, awayTeam) {
  const success = await googleSearch(
    page,
    `${cleanTeamNameForSearch(homeTeam)} vs ${cleanTeamNameForSearch(
      awayTeam
    )} flashscore`
  );

  if (!success) return null;

  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].map(a => a.href);

    for (const href of links) {
      if (
        href.includes('flashscore') &&
        href.includes('/match/') &&
        !href.includes('/odds/') &&
        !href.includes('/h2h/')
      ) {
        return href;
      }
    }

    return null;
  });
}

/**
 * Busca pagina de equipo Flashscore
 */
async function findTeamFlashscoreUrl(page, teamName) {
  const success = await googleSearch(
    page,
    `${cleanTeamNameForSearch(teamName)} flashscore team`
  );

  if (!success) return null;

  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].map(a => a.href);

    for (const href of links) {
      if (
        href.includes('flashscore') &&
        (href.includes('/team/') || href.includes('/equipo/'))
      ) {
        return href;
      }
    }

    return null;
  });
}

/**
 * Extrae logo desde pagina de equipo
 */
async function extractLogoFromTeamPage(page, teamUrl) {
  if (!teamUrl) return null;

  try {
    await page.goto(teamUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(2500);

    return page.evaluate(() => {
      const selectors = [
        'img.participant__image',
        '.heading img',
        '.teamHeader img',
        'img[alt*="logo"]',
        'img[src*="logo"]',
      ];

      for (const selector of selectors) {
        const img = document.querySelector(selector);

        if (img?.src) return img.src;
      }

      // fallback general
      const allImgs = [...document.querySelectorAll('img')];

      for (const img of allImgs) {
        const src = img.src || '';

        if (
          src.includes('logo') ||
          src.includes('team') ||
          src.includes('participant')
        ) {
          return src;
        }
      }

      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Extrae desde pagina de partido
 */
async function extractShieldsFromMatchPage(page, url) {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(3000);

    return page.evaluate(() => {
      function normalize(side) {
        if (!side) return null;

        const item = Array.isArray(side) ? side[0] : side;

        if (!item) return null;

        return (
          item.image_path ||
          item.small_image_path ||
          item.image ||
          item.logo ||
          null
        );
      }

      const state = window.__INITIAL_STATE__;

      if (state) {
        const participants =
          state.event?.participantsData ||
          state.participantsData ||
          state.match?.participantsData;

        if (participants) {
          return {
            homeLogo: normalize(participants.home),
            awayLogo: normalize(participants.away),
          };
        }
      }

      return null;
    });
  } catch {
    return null;
  }
}

/**
 * FALLBACK Google Images
 */
async function searchLogoByImage(page, teamName) {
  const success = await googleSearch(
    page,
    `${cleanTeamNameForSearch(teamName)} football club logo png`
  );

  if (!success) return null;

  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];

    for (const img of imgs) {
      const src = img.src || '';

      if (
        src.startsWith('http') &&
        !src.includes('google') &&
        !src.includes('gstatic')
      ) {
        return src;
      }
    }

    return null;
  });
}

/**
 * BUSQUEDA MAESTRA
 */
async function searchMatchLogos(page, homeTeam, awayTeam) {
  console.log(`  Buscando: ${homeTeam} vs ${awayTeam}`);

  // NIVEL 1
  const matchUrl = await findFlashscoreMatchUrl(page, homeTeam, awayTeam);

  if (matchUrl) {
    const matchResult = await extractShieldsFromMatchPage(page, matchUrl);

    if (matchResult?.homeLogo || matchResult?.awayLogo) {
      return {
        homeLogo: matchResult.homeLogo || null,
        awayLogo: matchResult.awayLogo || null,
      };
    }
  }

  console.log('  [Fallback] Busqueda por equipos individuales');

  // NIVEL 2
  let homeLogo = null;
  let awayLogo = null;

  const homeTeamUrl = await findTeamFlashscoreUrl(page, homeTeam);
  if (homeTeamUrl) {
    homeLogo = await extractLogoFromTeamPage(page, homeTeamUrl);
  }

  // NIVEL 3
  const awayTeamUrl = await findTeamFlashscoreUrl(page, awayTeam);
  if (awayTeamUrl) {
    awayLogo = await extractLogoFromTeamPage(page, awayTeamUrl);
  }

  // NIVEL 4
  if (!homeLogo) {
    console.log(`  [Google Images] ${homeTeam}`);
    homeLogo = await searchLogoByImage(page, homeTeam);
  }

  if (!awayLogo) {
    console.log(`  [Google Images] ${awayTeam}`);
    awayLogo = await searchLogoByImage(page, awayTeam);
  }

  return {
    homeLogo: homeLogo || null,
    awayLogo: awayLogo || null,
  };
}

/**
 * MAIN
 */
async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping...');

  if (!fs.existsSync(PARTIDOS_PATH)) {
    saveEmptyJson();
    return;
  }

  const partidos = JSON.parse(fs.readFileSync(PARTIDOS_PATH, 'utf-8'));

  if (!partidos?.length) {
    saveEmptyJson();
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
    locale: 'es-ES',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1600, height: 900 },
  });

  const page = await context.newPage();

  await context.addCookies([
    {
      name: 'CONSENT',
      value: 'YES+',
      domain: '.google.com',
      path: '/',
    },
  ]);

  const logoCache = new Map();
  const escudos = [];

  try {
    for (let i = 0; i < partidos.length; i++) {
      const matchText = partidos[i].match;

      const [homeTeam, awayTeam] = extractTeamNames(matchText);

      if (!homeTeam || !awayTeam) continue;

      console.log(`\n[${i + 1}/${partidos.length}] ${homeTeam} vs ${awayTeam}`);

      let homeLogo = logoCache.get(homeTeam) || null;
      let awayLogo = logoCache.get(awayTeam) || null;

      if (!homeLogo || !awayLogo) {
        const result = await searchMatchLogos(page, homeTeam, awayTeam);

        if (!homeLogo && result.homeLogo) {
          homeLogo = result.homeLogo;
          logoCache.set(homeTeam, homeLogo);
        }

        if (!awayLogo && result.awayLogo) {
          awayLogo = result.awayLogo;
          logoCache.set(awayTeam, awayLogo);
        }
      }

      escudos.push({
        match: `${homeTeam} vs ${awayTeam}`,
        homeLogo: homeLogo || '',
        awayLogo: awayLogo || '',
      });

      await page.waitForTimeout(1500 + Math.random() * 1500);
    }

    ensureDir(OUTPUT);

    fs.writeFileSync(
      OUTPUT,
      JSON.stringify(escudos, null, 2),
      'utf-8'
    );

    console.log(`\n[Escudos] Guardados ${escudos.length} partidos`);
  } catch (error) {
    console.warn('[Escudos] Error:', error.message);
    saveEmptyJson();
  } finally {
    await browser.close();
  }
}

scrapeEscudos().catch(error => {
  console.warn('[Escudos] Fatal:', error.message);
  saveEmptyJson();
});
