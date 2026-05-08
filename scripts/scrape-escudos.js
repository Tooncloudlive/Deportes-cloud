/**
 * Scraping de escudos desde Flashscore v2
 * Usa la API interna de Flashscore (ls.sportradar.com) para obtener datos de partidos
 * y construye las URLs de escudos directamente desde los IDs de equipos.
 *
 * Estrategia:
 * 1. Lee data/partidos.json
 * 2. Extrae nombres de equipos
 * 3. Busca partidos en la API de Flashscore por fecha
 * 4. Hace fuzzy match entre nombres de equipos
 * 5. Construye URLs de escudos: https://www.flashscore.com/res/image/data/{teamId}
 *
 * Si falla:
 * - guarda [] en escudos.json
 * - NO rompe GitHub Actions
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PARTIDOS_PATH = path.join(__dirname, '..', 'data', 'partidos.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');

// API endpoints de Flashscore (Sportradar)
const FLASHSCORE_API = 'https://ls.sportradar.com/flashscore/en/europe';
const FLASHSCORE_IMAGE_BASE = 'https://www.flashscore.com/res/image/data';

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
 */
function extractTeamNames(matchText) {
  if (!matchText) return [null, null];
  const withoutCompetition = matchText.replace(/^[^:]+:\ */, '');
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\s+(.+)/i);
  if (!vsMatch) return [null, null];
  return [vsMatch[1].trim(), vsMatch[2].trim()];
}

function cleanTeamName(name) {
  if (!name) return '';
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

/**
 * HTTP GET con promesas
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.flashscore.com/',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

/**
 * Obtiene partidos del dia desde la API de Flashscore
 */
async function getTodayMatches() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  
  // Intentar multiples endpoints de la API
  const endpoints = [
    `https://www.flashscore.com/api/matches/live/`,
    `https://ls.sportradar.com/flashscore/en/europe/1/2025-2026/schedule.json`,
  ];

  for (const url of endpoints) {
    try {
      console.log(`  [API] Intentando: ${url}`);
      const data = await httpGet(url);
      if (data && (data.events || data.matches || data.data)) {
        return data;
      }
    } catch (e) {
      console.log(`  [API] Fallo ${url}: ${e.message}`);
    }
  }
  return null;
}

/**
 * Busca en la API de Flashscore los partidos y extrae escudos
 */
async function fetchFlashscoreData() {
  try {
    // La API de Flashscore para partidos en vivo
    const url = 'https://www.flashscore.com/api/matches/live/';
    const data = await httpGet(url);
    return data;
  } catch (e) {
    console.log(`  [API] Error: ${e.message}`);
    return null;
  }
}

/**
 * Calcula similitud entre dos strings (Levenshtein simplificado)
 */
function similarity(s1, s2) {
  s1 = cleanTeamName(s1);
  s2 = cleanTeamName(s2);
  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  // Jaccard similarity de palabras
  const set1 = new Set(s1.split(/\s+/));
  const set2 = new Set(s2.split(/\s+/));
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

/**
 * Extrae escudos de la respuesta de Flashscore API
 */
function extractLogosFromApiResponse(apiData, homeTeam, awayTeam) {
  if (!apiData) return null;

  // La API de Flashscore live devuelve eventos con participants
  const events = apiData.events || apiData.matches || apiData.data || [];
  
  for (const event of events) {
    const participants = event.participants || event.teams || event.participantsData;
    if (!participants) continue;

    const home = participants.home?.[0] || participants[0];
    const away = participants.away?.[0] || participants[1];
    
    if (!home || !away) continue;

    const homeName = home.name || home.shortName || '';
    const awayName = away.name || away.shortName || '';

    const homeSim = similarity(homeName, homeTeam);
    const awaySim = similarity(awayName, awayTeam);

    // Si ambos equipos coinciden con > 0.6 de similitud
    if (homeSim > 0.6 && awaySim > 0.6) {
      const homeId = home.id || home._id || home.teamId;
      const awayId = away.id || away._id || away.teamId;
      
      return {
        homeLogo: homeId ? `${FLASHSCORE_IMAGE_BASE}/${homeId}` : null,
        awayLogo: awayId ? `${FLASHSCORE_IMAGE_BASE}/${awayId}` : null,
        homeName: homeName,
        awayName: awayName,
      };
    }
  }

  return null;
}

/**
 * Fallback: busca escudos usando la pagina de busqueda de Flashscore
 * sin necesidad de navegador, via fetch a su API de busqueda
 */
async function searchTeamLogo(teamName) {
  try {
    const searchUrl = `https://www.flashscore.com/api/search/?q=${encodeURIComponent(teamName)}&s=1`;
    const data = await httpGet(searchUrl);
    
    if (data && data.results && data.results.length > 0) {
      const team = data.results.find(r => r.type === 'team') || data.results[0];
      if (team && team.id) {
        return `${FLASHSCORE_IMAGE_BASE}/${team.id}`;
      }
    }
  } catch (e) {
    // Silencioso
  }
  return null;
}

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping de escudos desde Flashscore API...');

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

  // Obtener datos de la API de Flashscore
  const apiData = await fetchFlashscoreData();
  
  const escudos = [];
  const seenMatches = new Set();
  const logoCache = new Map();

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

    // Si ambos en cache, saltar
    if (homeLogo !== undefined && awayLogo !== undefined) {
      console.log(`  [CACHE] Usando escudos en cache`);
    } else {
      // Intentar extraer de la API de partidos
      const apiResult = apiData ? extractLogosFromApiResponse(apiData, homeTeam, awayTeam) : null;
      
      if (apiResult) {
        console.log(`  [API] Match encontrado en API: ${apiResult.homeName} vs ${apiResult.awayName}`);
        if (homeLogo === undefined) {
          homeLogo = apiResult.homeLogo;
          logoCache.set(homeTeam, homeLogo);
        }
        if (awayLogo === undefined) {
          awayLogo = apiResult.awayLogo;
          logoCache.set(awayTeam, awayLogo);
        }
      } else {
        // Fallback: buscar por equipo individual
        console.log(`  [API] No encontrado en API live, buscando individualmente...`);
        if (homeLogo === undefined) {
          homeLogo = await searchTeamLogo(homeTeam);
          logoCache.set(homeTeam, homeLogo);
        }
        if (awayLogo === undefined) {
          awayLogo = await searchTeamLogo(awayTeam);
          logoCache.set(awayTeam, awayLogo);
        }
      }
    }

    if (homeLogo || awayLogo) {
      escudos.push({
        match: matchKey,
        homeLogo: homeLogo || '',
        awayLogo: awayLogo || '',
      });
      console.log(`  [OK] Escudos - Local: ${homeLogo ? 'SI' : 'NO'}, Visitante: ${awayLogo ? 'SI' : 'NO'}`);
    } else {
      console.log(`  [WARN] No se encontraron escudos`);
    }

    // Delay para no saturar
    if (i < partidos.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Guardar resultados
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
}

scrapeEscudos().catch((error) => {
  console.warn('[Escudos] Error inesperado:', error.message);
  saveEmptyJson();
  process.exitCode = 0;
});
