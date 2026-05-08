/**
 * Scraping robusto de escudos desde Flashscore
 * 
 * Estrategia:
 * 1. Lee data/partidos.json
 * 2. Para cada partido unico, busca en Google con query simple
 * 3. Evalua TODOS los resultados de Google con scoring (no solo el primero)
 * 4. Navega a la pagina del partido en Flashscore
 * 5. Extrae escudos directamente del DOM (img.participant__image)
 * 6. Si falla, busca escudo de cada equipo individualmente
 * 7. Guarda en escudos.json con el mismo formato de "match" que partidos.json
 *    para que el template haga matching correcto
 *
 * Formato de salida:
 * [ { match: "Copa Libertadores: Platense vs Penarol", homeLogo: "...", awayLogo: "..." } ]
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
  console.log('[Escudos] JSON vacio guardado');
}

// Extrae "Equipo A" y "Equipo B" de "Competencia: Equipo A vs Equipo B"
function extractTeamNames(matchText) {
  if (!matchText) return [null, null];
  const clean = matchText.replace(/^[^:]+:\s*/, '').trim();
  const m = clean.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (!m) return [clean, null];
  return [m[1].trim(), m[2].trim()];
}

// Quita pais entre parentesis: "Platense (Arg)" -> "Platense"
function cleanTeamName(name) {
  if (!name) return '';
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Extrae pais: "Platense (Arg)" -> "Arg"
function extractCountry(name) {
  if (!name) return '';
  const m = name.match(/\(([^)]+)\)/);
  return m ? m[1] : '';
}

// Normaliza para comparacion
function normalize(str) {
  if (!str) return '';
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  // Levenshtein
  const matrix = [];
  for (let i = 0; i <= nb.length; i++) matrix[i] = [i];
  for (let j = 0; j <= na.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= nb.length; i++) {
    for (let j = 1; j <= na.length; j++) {
      matrix[i][j] = nb[i - 1] === na[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return 1 - matrix[nb.length][na.length] / Math.max(na.length, nb.length);
}

async function isGoogleBlocked(page) {
  return page.evaluate(() => {
    const t = document.title.toLowerCase();
    const b = (document.body?.innerText || '').toLowerCase();
    return t.includes('captcha') || t.includes('unusual traffic') ||
      b.includes('captcha') || b.includes('unusual traffic') || b.includes('automated requests') ||
      b.includes("i'm not a robot") || b.includes('no soy un robot') ||
      !!document.querySelector('form[action*="captcha"], #captcha');
  });
}

/**
 * Busca en Google y devuelve TODOS los enlaces de flashscore con metadata
 */
async function searchGoogle(page, query) {
  const url = `${GOOGLE_SEARCH_URL}${encodeURIComponent(query)}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    if (await isGoogleBlocked(page)) {
      console.log(`    [BLOQUEO] Google bloqueo la query: ${query}`);
      return [];
    }

    return await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="flashscore"]');
      for (const link of links) {
        const href = link.href || '';
        // Solo URLs directas de flashscore
        if (!href.match(/^https?:\/\/[^/]*flashscore\.com/)) continue;

        // Encontrar contenedor para extraer titulo
        let container = link.closest('div[data-ved]') || link.closest('div.g') || link.closest('.gsc-webResult') || link.parentElement?.parentElement;
        let title = '';
        let snippet = '';
        if (container) {
          const h3 = container.querySelector('h3');
          title = h3 ? (h3.textContent || '') : (link.textContent || '');
          const snip = container.querySelector('.VwiC3b, [data-sncf]');
          snippet = snip ? (snip.textContent || '') : '';
        }
        if (!title) title = link.textContent || '';

        const isMatch = href.includes('/match/');
        const isH2h = href.includes('/h2h/');
        const isTeam = href.includes('/team/');
        const isOdds = href.includes('/odds/') || href.includes('/cuotas/');
        const isStandings = href.includes('/standings/') || href.includes('/clasificacion/');
        const isSummary = href.includes('/summary/');

        results.push({ href, title, snippet, isMatch, isH2h, isTeam, isOdds, isStandings, isSummary });
      }
      return results;
    });
  } catch (e) {
    console.log(`    [ERROR] Google search: ${e.message}`);
    return [];
  }
}

/**
 * Scoring de resultados de Google
 */
function scoreResult(result, homeTeam, awayTeam) {
  let score = 0;
  const hClean = cleanTeamName(homeTeam);
  const aClean = cleanTeamName(awayTeam);
  const hNorm = normalize(hClean);
  const aNorm = normalize(aClean);
  const text = (result.title + ' ' + result.snippet).toLowerCase();

  // Prioridad por tipo de pagina
  if (result.isMatch) score += 25;
  else if (result.isSummary) score += 15;
  else if (result.isH2h) score += 5;
  else score += 1;

  // Penalizar paginas no utiles
  if (result.isOdds) score -= 15;
  if (result.isStandings) score -= 15;
  if (result.isTeam) score -= 10;

  // Coincidencia de equipos
  const hasHome = text.includes(hNorm) || similarity(result.title, homeTeam) > 0.7;
  const hasAway = text.includes(aNorm) || similarity(result.title, awayTeam) > 0.7;
  if (hasHome) score += 12;
  if (hasAway) score += 12;
  if (hasHome && hasAway) score += 20;

  // Detectar fecha reciente (patron como "07/05/2026", "07.05.2026", etc.)
  if (/\d{1,2}[/.-]\d{1,2}[/.-](202[5-9]|20[3-9][0-9])/.test(text)) score += 10;

  // Preferir .com principal
  if (/flashscore\.com\//.test(result.href) && !/flashscore\.com\.\w+\//.test(result.href)) score += 5;

  // Penalizar H2H en titulo
  if (/\b(h2h|head to head|historial|enfrentamientos)\b/i.test(text)) score -= 8;

  return score;
}

/**
 * Encuentra la mejor URL de Flashscore para un partido
 */
async function findMatchUrl(page, homeTeam, awayTeam) {
  const hClean = cleanTeamName(homeTeam);
  const aClean = cleanTeamName(awayTeam);
  const hCountry = extractCountry(homeTeam);
  const aCountry = extractCountry(awayTeam);

  // Varias queries a probar
  const queries = [
    `${hClean} ${aClean} flashscore`,
    `${hClean} ${hCountry} ${aClean} ${aCountry} flashscore match`,
    `${aClean} ${hClean} flashscore`,
    `${hClean} ${aClean} flashscore football`,
  ].filter(q => q.trim());

  let best = null;
  let bestScore = -999;

  for (const query of queries) {
    console.log(`    [QUERY] ${query}`);
    const results = await searchGoogle(page, query);

    for (const r of results) {
      const s = scoreResult(r, homeTeam, awayTeam);
      console.log(`      [RESULT] score=${s.toFixed(1)} | ${r.isMatch ? 'MATCH' : r.isH2h ? 'H2H' : 'OTHER'} | ${r.title.substring(0, 70)}`);
      if (s > bestScore) {
        bestScore = s;
        best = r;
      }
    }

    if (bestScore >= 50) {
      console.log(`    [OK] Alto score encontrado, deteniendo busqueda`);
      break;
    }

    await page.waitForTimeout(1000 + Math.random() * 1000);
  }

  if (best) {
    console.log(`  [OK] Mejor URL (score ${bestScore.toFixed(1)}): ${best.href}`);
    return best.href;
  }
  return null;
}

/**
 * Extrae escudos del DOM de Flashscore
 */
async function extractFromDom(page) {
  return page.evaluate(() => {
    // Metodo 1: participant__image dentro de duelParticipant
    const homeImg = document.querySelector('.duelParticipant__home .participant__image');
    const awayImg = document.querySelector('.duelParticipant__away .participant__image');
    if (homeImg && awayImg) {
      return {
        homeLogo: homeImg.src || homeImg.getAttribute('data-src') || null,
        awayLogo: awayImg.src || awayImg.getAttribute('data-src') || null,
        homeName: homeImg.alt || '',
        awayName: awayImg.alt || '',
        source: 'dom-participant',
      };
    }

    // Metodo 2: buscar cualquier img en duelParticipant con src de flashscore
    const section = document.querySelector('.duelParticipant');
    if (section) {
      const imgs = section.querySelectorAll('img[src*="static.flashscore.com"]');
      if (imgs.length >= 2) {
        return {
          homeLogo: imgs[0].src || null,
          awayLogo: imgs[1].src || null,
          homeName: imgs[0].alt || '',
          awayName: imgs[1].alt || '',
          source: 'dom-generic',
        };
      }
    }

    // Metodo 3: buscar en scripts por participantsData
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (text.includes('"participantsData"')) {
        // Extraer JSON usando regex balanceado simple
        const match = text.match(/"participantsData"\s*:\s*(\{[\s\S]*?\}(?=\s*[,}]))/);
        if (match) {
          try {
            const data = JSON.parse(match[1]);
            const home = data.home?.[0];
            const away = data.away?.[0];
            if (home && away) {
              return {
                homeLogo: home.image_path || home.small_image_path || null,
                awayLogo: away.image_path || away.small_image_path || null,
                homeName: home.name || '',
                awayName: away.name || '',
                source: 'participantsData',
              };
            }
          } catch (e) {}
        }
      }
    }

    // Metodo 4: window.__INITIAL_STATE__
    if (window.__INITIAL_STATE__) {
      const p = window.__INITIAL_STATE__.event?.participantsData || window.__INITIAL_STATE__.participantsData;
      if (p) {
        const home = p.home?.[0];
        const away = p.away?.[0];
        if (home && away) {
          return {
            homeLogo: home.image_path || home.small_image_path || null,
            awayLogo: away.image_path || away.small_image_path || null,
            homeName: home.name || '',
            awayName: away.name || '',
            source: 'initialState',
          };
        }
      }
    }

    return null;
  });
}

/**
 * Verifica si la pagina tiene los equipos esperados
 * Retorna: { ok: boolean, inverted: boolean }
 */
async function verifyPage(page, expectedHome, expectedAway) {
  const result = await page.evaluate((expHome, expAway) => {
    function norm(s) {
      if (!s) return '';
      return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    }
    function clean(s) {
      return s.replace(/\([^)]*\)/g, '').trim();
    }

    let ph = '', pa = '';

    // Extraer nombres del DOM
    const homeImg = document.querySelector('.duelParticipant__home .participant__image');
    const awayImg = document.querySelector('.duelParticipant__away .participant__image');
    if (homeImg) ph = homeImg.alt || '';
    if (awayImg) pa = awayImg.alt || '';

    if (!ph || !pa) {
      const hLink = document.querySelector('.duelParticipant__home a[title]');
      const aLink = document.querySelector('.duelParticipant__away a[title]');
      if (hLink) ph = hLink.title || '';
      if (aLink) pa = aLink.title || '';
    }

    if (!ph || !pa) {
      const hName = document.querySelector('.duelParticipant__home .participant__participantName');
      const aName = document.querySelector('.duelParticipant__away .participant__participantName');
      if (hName) ph = hName.textContent || '';
      if (aName) pa = aName.textContent || '';
    }

    // participantsData
    if (!ph || !pa) {
      try {
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          if (s.textContent && s.textContent.includes('"participantsData"')) {
            const m = s.textContent.match(/"participantsData"\s*:\s*(\{[\s\S]*?\}(?=\s*[,}]))/);
            if (m) {
              const d = JSON.parse(m[1]);
              if (d.home?.[0]?.name) ph = d.home[0].name;
              if (d.away?.[0]?.name) pa = d.away[0].name;
              break;
            }
          }
        }
      } catch (e) {}
    }

    const nph = norm(ph);
    const npa = norm(pa);
    const neh = norm(expHome);
    const nea = norm(expAway);
    const nehClean = norm(clean(expHome));
    const neaClean = norm(clean(expAway));

    // Coincidencia normal
    const homeMatchHome = nph.includes(neh) || neh.includes(nph) || nph.includes(nehClean) || nehClean.includes(nph);
    const awayMatchAway = npa.includes(nea) || nea.includes(npa) || npa.includes(neaClean) || neaClean.includes(npa);
    const normalOk = homeMatchHome && awayMatchAway;

    // Coincidencia invertida
    const homeMatchAway = nph.includes(nea) || nea.includes(nph) || nph.includes(neaClean) || neaClean.includes(nph);
    const awayMatchHome = npa.includes(neh) || neh.includes(npa) || npa.includes(nehClean) || nehClean.includes(npa);
    const invertedOk = homeMatchAway && awayMatchHome;

    if (normalOk) return { ok: true, inverted: false, pageHome: ph, pageAway: pa };
    if (invertedOk) return { ok: true, inverted: true, pageHome: ph, pageAway: pa };

    // Si no tenemos datos de la pagina, asumir ok
    if (!ph && !pa) return { ok: true, inverted: false, pageHome: '', pageAway: '' };

    return { ok: false, inverted: false, pageHome: ph, pageAway: pa };
  }, expectedHome, expectedAway);

  return result;
}

/**
 * Busca escudo de un equipo individualmente (fallback)
 */
async function searchTeamLogoFallback(page, teamName) {
  const clean = cleanTeamName(teamName);
  const country = extractCountry(teamName);
  const queries = [
    `${clean} ${country} flashscore team logo`.trim(),
    `${clean} flashscore team`,
  ];

  for (const query of queries) {
    try {
      const results = await searchGoogle(page, query);
      const teamUrl = results.find(r => r.isTeam || (!r.isMatch && !r.isH2h && !r.isOdds && !r.isStandings))?.href;
      if (!teamUrl) continue;

      await page.goto(teamUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      const logo = await page.evaluate(() => {
        const img = document.querySelector('.teamHeader__logo img') ||
                   document.querySelector('.heading__logo img') ||
                   document.querySelector('img[src*="/res/image/data/"]');
        if (img) return img.src || img.getAttribute('data-src') || null;

        if (window.__INITIAL_STATE__) {
          const t = window.__INITIAL_STATE__.team || window.__INITIAL_STATE__.entity;
          if (t) return t.image_path || t.logo || null;
        }
        return null;
      });

      if (logo) return logo;
    } catch (e) {}
    await page.waitForTimeout(1000 + Math.random() * 1000);
  }
  return null;
}

/**
 * Busca escudos para un partido
 */
async function getMatchLogos(page, homeTeam, awayTeam) {
  console.log(`  Buscando: ${homeTeam} vs ${awayTeam}`);

  const url = await findMatchUrl(page, homeTeam, awayTeam);
  if (!url) {
    console.log(`  [WARN] No se encontro URL del partido`);
    return { homeLogo: null, awayLogo: null };
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
  } catch (e) {
    console.log(`  [ERROR] Navegando: ${e.message}`);
    return { homeLogo: null, awayLogo: null };
  }

  // Verificar que es el partido correcto
  const verify = await verifyPage(page, homeTeam, awayTeam);
  console.log(`  [VERIFY] ok=${verify.ok} inverted=${verify.inverted} | pagina: "${verify.pageHome}" vs "${verify.pageAway}"`);

  if (!verify.ok) {
    console.log(`  [WARN] Equipos no coinciden, probando fallback individual`);
    const homeLogo = await searchTeamLogoFallback(page, homeTeam);
    const awayLogo = await searchTeamLogoFallback(page, awayTeam);
    return { homeLogo, awayLogo };
  }

  const shields = await extractFromDom(page);
  if (!shields || (!shields.homeLogo && !shields.awayLogo)) {
    console.log(`  [WARN] No se extrajeron escudos del DOM, probando fallback individual`);
    const homeLogo = await searchTeamLogoFallback(page, homeTeam);
    const awayLogo = await searchTeamLogoFallback(page, awayTeam);
    return { homeLogo, awayLogo };
  }

  console.log(`  [OK] Escudos via ${shields.source} - local: ${shields.homeLogo ? 'SI' : 'NO'}, visita: ${shields.awayLogo ? 'SI' : 'NO'}`);

  // Si estan invertidos, swap
  if (verify.inverted) {
    console.log(`  [SWAP] Intercambiando escudos (equipos invertidos)`);
    return {
      homeLogo: shields.awayLogo,
      awayLogo: shields.homeLogo,
    };
  }

  return {
    homeLogo: shields.homeLogo,
    awayLogo: shields.awayLogo,
  };
}

async function main() {
  console.log('[Escudos] Iniciando scraping de escudos...');

  if (!fs.existsSync(PARTIDOS_PATH)) {
    console.warn('[Escudos] No se encontro partidos.json');
    saveEmptyJson();
    return;
  }

  const partidos = JSON.parse(fs.readFileSync(PARTIDOS_PATH, 'utf-8'));
  if (!partidos || partidos.length === 0) {
    console.log('[Escudos] No hay partidos');
    saveEmptyJson();
    return;
  }

  // Obtener partidos unicos (misma hora + match + link considera canales duplicados)
  const seen = new Set();
  const uniqueMatches = [];
  for (const p of partidos) {
    const key = p.match;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueMatches.push(p);
  }

  console.log(`[Escudos] ${partidos.length} canales, ${uniqueMatches.length} partidos unicos`);

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

  // Bypass cookies
  await page.route('**/*', (route) => {
    route.request().url().includes('consent.google.com') ? route.abort() : route.continue();
  });
  await context.addCookies([
    { name: 'CONSENT', value: 'YES+ES.es+V14+BX', domain: '.google.com', path: '/' },
    { name: 'CONSENT', value: 'YES+ES.es+V14+BX', domain: '.google.es', path: '/' },
  ]);

  const logoCache = new Map();
  const escudos = [];

  try {
    for (let i = 0; i < uniqueMatches.length; i++) {
      const partido = uniqueMatches[i];
      const matchText = partido.match;
      const [homeTeam, awayTeam] = extractTeamNames(matchText);

      if (!homeTeam || !awayTeam) {
        console.log(`[${i + 1}/${uniqueMatches.length}] Saltando: sin equipos en "${matchText}"`);
        continue;
      }

      console.log(`\n[${i + 1}/${uniqueMatches.length}] ${matchText}`);

      // Revisar cache
      let homeLogo = logoCache.get(homeTeam);
      let awayLogo = logoCache.get(awayTeam);

      if (homeLogo !== undefined && awayLogo !== undefined) {
        console.log(`  [CACHE] Usando cache`);
      } else {
        const result = await getMatchLogos(page, homeTeam, awayTeam);
        if (homeLogo === undefined) { homeLogo = result.homeLogo; logoCache.set(homeTeam, homeLogo); }
        if (awayLogo === undefined) { awayLogo = result.awayLogo; logoCache.set(awayTeam, awayLogo); }
      }

      // Guardar con el match EXACTO del partidos.json para que el template haga matching
      if (homeLogo || awayLogo) {
        escudos.push({
          match: matchText,  // <-- MISMO TEXTO que en partidos.json
          homeLogo: homeLogo || '',
          awayLogo: awayLogo || '',
        });
        console.log(`  [OK] Escudo guardado para: ${matchText}`);
      } else {
        console.log(`  [FAIL] Sin escudos para: ${matchText}`);
      }

      if (i < uniqueMatches.length - 1) {
        await page.waitForTimeout(3000 + Math.random() * 2000);
      }
    }

    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(escudos, null, 2), 'utf-8');

    console.log(`\n${'='.repeat(50)}`);
    console.log(`[Escudos] ${escudos.length}/${uniqueMatches.length} partidos con escudos`);
    console.log(`[Escudos] ${escudos.filter(e => e.homeLogo && e.awayLogo).length} con ambos escudos`);
    console.log(`[Escudos] Guardado en: ${OUTPUT}`);
    console.log(`${'='.repeat(50)}`);

  } catch (e) {
    console.warn('[Escudos] Error:', e.message);
    console.warn(e.stack);
    saveEmptyJson();
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.warn('[Escudos] Error inesperado:', e.message);
  saveEmptyJson();
});
