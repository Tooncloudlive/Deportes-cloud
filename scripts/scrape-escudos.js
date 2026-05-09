/**
 * VERSION OPTIMIZADA
 *
 * Flujo:
 * 1. Busca SIEMPRE el partido primero (rápido)
 * 2. Solo si falta home o away:
 *    - Busca individualmente SOLO el equipo faltante
 * 3. Usa cache
 *
 * Resultado:
 * - Mucho más rápido
 * - Mantiene cobertura alta
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

async function googleSearch(page, query) {
  try {
    await page.goto(
      `${GOOGLE_SEARCH_URL}${encodeURIComponent(query)}`,
      {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      }
    );

    await page.waitForTimeout(1800);

    return true;
  } catch {
    return false;
  }
}

/**
 * BUSCAR PARTIDO (PRIORIDAD)
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
 * EXTRAER ESCUDOS DEL PARTIDO
 */
async function extractShieldsFromMatchPage(page, matchUrl) {
  if (!matchUrl) return null;

  try {
    await page.goto(matchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });

    await page.waitForTimeout(2500);

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

      if (!state) return null;

      const participants =
        state.event?.participantsData ||
        state.participantsData ||
        state.match?.participantsData;

      if (!participants) return null;

      return {
        homeLogo: normalize(participants.home),
        awayLogo: normalize(participants.away),
      };
    });
  } catch {
    return null;
  }
}

/**
 * BUSQUEDA INDIVIDUAL SOLO PARA EL FALTANTE
 */
async function findTeamLogo(page, teamName) {
  const success = await googleSearch(
    page,
    `${cleanTeamNameForSearch(teamName)} flashscore team`
  );

  if (!success) return null;

  const teamUrl = await page.evaluate(() => {
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

  if (!teamUrl) return null;

  try {
    await page.goto(teamUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });

    await page.waitForTimeout(1800);

    return page.evaluate(() => {
      const selectors = [
        'img.participant__image',
        '.heading img',
        '.teamHeader img',
        'img[src*="logo"]',
      ];

      for (const selector of selectors) {
        const img = document.querySelector(selector);

        if (img?.src) return img.src;
      }

      return null;
    });
  } catch {
    return null;
  }
}

/**
 * MASTER
 */
async function searchMatchLogos(page, homeTeam, awayTeam, logoCache) {
  let homeLogo = logoCache.get(homeTeam) || null;
  let awayLogo = logoCache.get(awayTeam) || null;

  // Si ambos ya están cacheados, salir rápido
  if (homeLogo && awayLogo) {
    return { homeLogo, awayLogo };
  }

  /**
   * PASO 1:
   * Buscar partido completo
   */
  const matchUrl = await findFlashscoreMatchUrl(page, homeTeam, awayTeam);

  if (matchUrl) {
    const matchLogos = await extractShieldsFromMatchPage(page, matchUrl);

    if (matchLogos) {
      if (!homeLogo && matchLogos.homeLogo) {
        homeLogo = matchLogos.homeLogo;
        logoCache.set(homeTeam, homeLogo);
      }

      if (!awayLogo && matchLogos.awayLogo) {
        awayLogo = matchLogos.awayLogo;
        logoCache.set(awayTeam, awayLogo);
      }
    }
  }

  /**
   * PASO 2:
   * Solo buscar individualmente lo que falte
   */
  if (!homeLogo) {
    console.log(`  [Fallback local] ${homeTeam}`);
    homeLogo = await findTeamLogo(page, homeTeam);

    if (homeLogo) {
      logoCache.set(homeTeam, homeLogo);
    }
  }

  if (!awayLogo) {
    console.log(`  [Fallback visitante] ${awayTeam}`);
    awayLogo = await findTeamLogo(page, awayTeam);

    if (awayLogo) {
      logoCache.set(awayTeam, awayLogo);
    }
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
  console.log('[Escudos] Iniciando scraping optimizado...');

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

      console.log(
        `\n[${i + 1}/${partidos.length}] ${homeTeam} vs ${awayTeam}`
      );

      const result = await searchMatchLogos(
        page,
        homeTeam,
        awayTeam,
        logoCache
      );

      escudos.push({
        match: `${homeTeam} vs ${awayTeam}`,
        homeLogo: result.homeLogo || '',
        awayLogo: result.awayLogo || '',
      });

      await page.waitForTimeout(1000 + Math.random() * 1000);
    }

    ensureDir(OUTPUT);

    fs.writeFileSync(
      OUTPUT,
      JSON.stringify(escudos, null, 2),
      'utf-8'
    );

    console.log(`\n[Escudos] Guardados ${escudos.length} partidos`);
    console.log(
      `[Escudos] Equipos cacheados: ${logoCache.size}`
    );
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
