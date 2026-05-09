/**
 * Scraping de escudos desde Flashscore - VERSION MEJORADA v2
 * ============================================================
 *
 * Estrategia hibrida de alta tasa de exito:
 * 1. Cache persistente (no busca lo ya encontrado)
 * 2. Busqueda directa en Flashscore por equipo (sin Google)
 * 3. Fallback a Bing (menos CAPTCHA que Google)
 * 4. Normalizacion avanzada de nombres de equipos
 * 5. Reintentos con backoff exponencial
 *
 * Mejoras clave:
 * - Elimina Google como primera opcion (CAPTCHA)
 * - Accede directamente a Flashscore
 * - Usa Bing como fallback (mucho menos CAPTCHA)
 * - Cache persistente en disco entre ejecuciones
 * - Mapeo de 200+ variantes de nombres de equipos
 * - Soporta futbol, NBA, NHL y mas deportes
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PARTIDOS_PATH = path.join(__dirname, '..', 'data', 'partidos.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');
const CACHE_PATH = path.join(__dirname, '..', 'data', '.escudos-cache.json');
const FLASHSCORE_URL = 'https://www.flashscore.com';
const BING_SEARCH = 'https://www.bing.com/search?q=';

// ============================================================================
// CONFIGURACION
// ============================================================================

// Tiempo maximo de espera para paginas (ms)
const PAGE_TIMEOUT = 20000;
// Delay base entre requests (ms)
const BASE_DELAY = 2000;
// Reintentos maximos por equipo
const MAX_RETRIES = 2;

// ============================================================================
// MAPEO DE NOMBRES - Mas de 200 variantes normalizadas
// ============================================================================

const TEAM_NAME_MAP = {
  // === PREMIER LEAGUE ===
  'manchester united': 'manchester united',
  'manchester utd': 'manchester united',
  'man united': 'manchester united',
  'man utd': 'manchester united',
  'man. utd': 'manchester united',
  'manchester city': 'manchester city',
  'man city': 'manchester city',
  'liverpool': 'liverpool',
  'chelsea': 'chelsea',
  'arsenal': 'arsenal',
  'tottenham': 'tottenham',
  'tottenham hotspur': 'tottenham',
  'spurs': 'tottenham',
  'brighton': 'brighton',
  'brighton & hove albion': 'brighton',
  'brighton and hove albion': 'brighton',
  'wolves': 'wolverhampton',
  'wolverhampton': 'wolverhampton',
  'wolverhampton wanderers': 'wolverhampton',
  'fulham': 'fulham',
  'bournemouth': 'bournemouth',
  'afc bournemouth': 'bournemouth',
  'newcastle': 'newcastle united',
  'newcastle united': 'newcastle united',
  'newcastle utd': 'newcastle united',
  'west ham': 'west ham',
  'west ham united': 'west ham',
  'aston villa': 'aston villa',
  'brentford': 'brentford',
  'crystal palace': 'crystal palace',
  'everton': 'everton',
  'nottingham forest': 'nottingham forest',
  'leicester': 'leicester',
  'leicester city': 'leicester',
  'ipswich': 'ipswich',
  'ipswich town': 'ipswich',
  'southampton': 'southampton',
  // === CHAMPIONSHIP ===
  'sunderland': 'sunderland',
  'middlesbrough': 'middlesbrough',
  // === LALIGA ===
  'real madrid': 'real madrid',
  'barcelona': 'barcelona',
  'atletico madrid': 'atletico madrid',
  'atletico': 'atletico madrid',
  'sevilla': 'sevilla',
  'real betis': 'real betis',
  'betis': 'real betis',
  'real sociedad': 'real sociedad',
  'sociedad': 'real sociedad',
  'athletic bilbao': 'athletic club',
  'athletic club': 'athletic club',
  'athletic': 'athletic club',
  'valencia': 'valencia',
  'villarreal': 'villarreal',
  'osasuna': 'osasuna',
  'celta de vigo': 'celta vigo',
  'celta vigo': 'celta vigo',
  'getafe': 'getafe',
  'espanyol': 'espanyol',
  'rcd espanyol': 'espanyol',
  'rayo vallecano': 'rayo vallecano',
  'rayo': 'rayo vallecano',
  'alaves': 'alaves',
  'deportivo alaves': 'alaves',
  'mallorca': 'mallorca',
  'las palmas': 'las palmas',
  'girona': 'girona',
  'cadiz': 'cadiz',
  'granada': 'granada',
  'ud almeria': 'almeria',
  'almeria': 'almeria',
  'elche': 'elche',
  'leganes': 'leganes',
  'levante': 'levante',
  // LaLiga 2
  'burgos': 'burgos',
  'albacete': 'albacete',
  'sporting gijon': 'sporting gijon',
  'real valladolid': 'valladolid',
  'real zaragoza': 'zaragoza',
  'cd castellon': 'castellon',
  'cultural leonesa': 'cultural leonesa',
  // === SERIE A ===
  'inter': 'inter',
  'inter milan': 'inter',
  'ac milan': 'milan',
  'milan': 'milan',
  'juventus': 'juventus',
  'napoli': 'napoli',
  'roma': 'roma',
  'as roma': 'roma',
  'lazio': 'lazio',
  'atalanta': 'atalanta',
  'fiorentina': 'fiorentina',
  'bologna': 'bologna',
  'torino': 'torino',
  'udinese': 'udinese',
  'sassuolo': 'sassuolo',
  'monza': 'monza',
  'empoli': 'empoli',
  'lecce': 'lecce',
  'frosinone': 'frosinone',
  'genoa': 'genoa',
  'cagliari': 'cagliari',
  'verona': 'verona',
  'hellas verona': 'verona',
  'salernitana': 'salernitana',
  'sampdoria': 'sampdoria',
  'parma': 'parma',
  'venezia': 'venezia',
  'como': 'como',
  // === BUNDESLIGA ===
  'bayern munich': 'bayern munich',
  'bayern munchen': 'bayern munich',
  'bayern': 'bayern munich',
  'borussia dortmund': 'dortmund',
  'dortmund': 'dortmund',
  'bayer leverkusen': 'leverkusen',
  'leverkusen': 'leverkusen',
  'rb leipzig': 'rb leipzig',
  'leipzig': 'rb leipzig',
  'eintracht frankfurt': 'frankfurt',
  'frankfurt': 'frankfurt',
  'wolfsburg': 'wolfsburg',
  'stuttgart': 'stuttgart',
  'freiburg': 'freiburg',
  'hoffenheim': 'hoffenheim',
  'augsburg': 'augsburg',
  'mainz': 'mainz',
  'mainz 05': 'mainz',
  'gladbach': 'gladbach',
  'borussia monchengladbach': 'gladbach',
  'b. monchengladbach': 'gladbach',
  "borussia m'gladbach": 'gladbach',
  'borussia mg': 'gladbach',
  'werder bremen': 'werder bremen',
  'bremen': 'werder bremen',
  'heidenheim': 'heidenheim',
  'bochum': 'bochum',
  'darmstadt': 'darmstadt',
  'koln': 'koln',
  'fc koln': 'koln',
  'cologne': 'koln',
  'union berlin': 'union berlin',
  'st. pauli': 'st. pauli',
  'stpauli': 'st. pauli',
  'holstein kiel': 'holstein kiel',
  // === LIGUE 1 ===
  'paris saint germain': 'paris sg',
  'paris saint-germain': 'paris sg',
  'paris sg': 'paris sg',
  'psg': 'paris sg',
  'marseille': 'marseille',
  'olympique marseille': 'marseille',
  'om': 'marseille',
  'lyon': 'lyon',
  'olympique lyon': 'lyon',
  'ol': 'lyon',
  'monaco': 'monaco',
  'as monaco': 'monaco',
  'lille': 'lille',
  'rennes': 'rennes',
  'stade rennes': 'rennes',
  'nice': 'nice',
  'ogc nice': 'nice',
  'lens': 'lens',
  'strasbourg': 'strasbourg',
  'nantes': 'nantes',
  'montpellier': 'montpellier',
  'reims': 'reims',
  'toulouse': 'toulouse',
  'brest': 'brest',
  'metz': 'metz',
  'le havre': 'le havre',
  'angers': 'angers',
  'clermont': 'clermont',
  'lorient': 'lorient',
  // === CHAMPIONS LEAGUE / EUROPA ===
  'benfica': 'benfica',
  'porto': 'porto',
  'sporting cp': 'sporting lisbon',
  'sporting lisbon': 'sporting lisbon',
  'ajax': 'ajax',
  'psv': 'psv',
  'feyenoord': 'feyenoord',
  'club brugge': 'club brugge',
  'anderlecht': 'anderlecht',
  'galatasaray': 'galatasaray',
  'fenerbahce': 'fenerbahce',
  'besiktas': 'besiktas',
  'trabzonspor': 'trabzonspor',
  // === MLS ===
  'inter miami': 'inter miami',
  'inter miami cf': 'inter miami',
  'los angeles fc': 'lafc',
  'lafc': 'lafc',
  'la galaxy': 'la galaxy',
  'seattle sounders': 'seattle sounders',
  'seattle sounders fc': 'seattle sounders',
  'portland timbers': 'portland timbers',
  'sporting kansas city': 'sporting kansas city',
  'columbus crew': 'columbus crew',
  'fc cincinnati': 'fc cincinnati',
  'cincinnati': 'fc cincinnati',
  'orlando city': 'orlando city',
  'orlando city sc': 'orlando city',
  'new york red bulls': 'new york red bulls',
  'ny red bulls': 'new york red bulls',
  'new york rb': 'new york red bulls',
  'new york city fc': 'new york city fc',
  'nycfc': 'new york city fc',
  'atlanta united': 'atlanta united',
  'philadelphia union': 'philadelphia union',
  'nashville sc': 'nashville sc',
  'new england revolution': 'new england revolution',
  'dc united': 'dc united',
  'chicago fire': 'chicago fire',
  'chicago fire fc': 'chicago fire',
  'minnesota united': 'minnesota united',
  'houston dynamo': 'houston dynamo',
  'fc dallas': 'fc dallas',
  'real salt lake': 'real salt lake',
  'colorado rapids': 'colorado rapids',
  'vancouver whitecaps': 'vancouver whitecaps',
  'san jose earthquakes': 'san jose earthquakes',
  'sj earthquakes': 'san jose earthquakes',
  'austin fc': 'austin fc',
  'charlotte fc': 'charlotte fc',
  'st. louis city': 'st louis city',
  'st louis city': 'st louis city',
  'toronto fc': 'toronto fc',
  'cf montreal': 'cf montreal',
  'los angeles galaxy': 'la galaxy',
  // === LIGA MX ===
  'america': 'america',
  'club america': 'america',
  'chivas': 'chivas',
  'guadalajara': 'chivas',
  'cd guadalajara': 'chivas',
  'cruz azul': 'cruz azul',
  'tigres': 'tigres',
  'tigres uanl': 'tigres',
  'rayados': 'monterrey',
  'monterrey': 'monterrey',
  'cf monterrey': 'monterrey',
  'pumas': 'pumas',
  'pumas unam': 'pumas',
  'unam': 'pumas',
  'toluca': 'toluca',
  'santos': 'santos',
  'santos laguna': 'santos',
  'pachuca': 'pachuca',
  'leon': 'leon',
  'atlas': 'atlas',
  'fc juarez': 'juarez',
  'mazatlan': 'mazatlan',
  'necaxa': 'necaxa',
  'queretaro': 'queretaro',
  'puebla': 'puebla',
  'tijuana': 'tijuana',
  // === NBA ===
  'boston celtics': 'boston celtics',
  'celtics': 'boston celtics',
  'los angeles lakers': 'los angeles lakers',
  'lakers': 'los angeles lakers',
  'golden state warriors': 'golden state warriors',
  'warriors': 'golden state warriors',
  'chicago bulls': 'chicago bulls',
  'bulls': 'chicago bulls',
  'miami heat': 'miami heat',
  'heat': 'miami heat',
  'milwaukee bucks': 'milwaukee bucks',
  'bucks': 'milwaukee bucks',
  'phoenix suns': 'phoenix suns',
  'suns': 'phoenix suns',
  'dallas mavericks': 'dallas mavericks',
  'mavericks': 'dallas mavericks',
  'denver nuggets': 'denver nuggets',
  'nuggets': 'denver nuggets',
  'philadelphia 76ers': 'philadelphia 76ers',
  '76ers': 'philadelphia 76ers',
  'new york knicks': 'new york knicks',
  'knicks': 'new york knicks',
  'brooklyn nets': 'brooklyn nets',
  'nets': 'brooklyn nets',
  'toronto raptors': 'toronto raptors',
  'raptors': 'toronto raptors',
  'atlanta hawks': 'atlanta hawks',
  'hawks': 'atlanta hawks',
  'cleveland cavaliers': 'cleveland cavaliers',
  'cavaliers': 'cleveland cavaliers',
  'cavs': 'cleveland cavaliers',
  'detroit pistons': 'detroit pistons',
  'pistons': 'detroit pistons',
  'indiana pacers': 'indiana pacers',
  'pacers': 'indiana pacers',
  'washington wizards': 'washington wizards',
  'wizards': 'washington wizards',
  'orlando magic': 'orlando magic',
  'magic': 'orlando magic',
  'charlotte hornets': 'charlotte hornets',
  'hornets': 'charlotte hornets',
  'minnesota timberwolves': 'minnesota timberwolves',
  'timberwolves': 'minnesota timberwolves',
  'oklahoma city thunder': 'oklahoma city thunder',
  'thunder': 'oklahoma city thunder',
  'memphis grizzlies': 'memphis grizzlies',
  'grizzlies': 'memphis grizzlies',
  'new orleans pelicans': 'new orleans pelicans',
  'pelicans': 'new orleans pelicans',
  'san antonio spurs': 'san antonio spurs',
  'spurs': 'san antonio spurs',
  'houston rockets': 'houston rockets',
  'rockets': 'houston rockets',
  'utah jazz': 'utah jazz',
  'jazz': 'utah jazz',
  'sacramento kings': 'sacramento kings',
  'kings': 'sacramento kings',
  'los angeles clippers': 'los angeles clippers',
  'clippers': 'los angeles clippers',
  'portland trail blazers': 'portland trail blazers',
  'blazers': 'portland trail blazers',
};

// ============================================================================
// MAPEO DE LIGAS A DEPORTES
// ============================================================================

const LEAGUE_SPORT_MAP = {
  'premier league': 'football',
  'championship': 'football',
  'laliga': 'football',
  'laliga 2': 'football',
  'serie a': 'football',
  'bundesliga': 'football',
  'ligue 1': 'football',
  'eredivisie': 'football',
  'super lig': 'football',
  'liga mx': 'football',
  'liga profesional': 'football',
  'brasileirao': 'football',
  'copa libertadores': 'football',
  'copa sudamericana': 'football',
  'champions league': 'football',
  'europa league': 'football',
  'conference league': 'football',
  'world cup': 'football',
  'nba': 'basketball',
  'nhl': 'ice-hockey',
  'mls': 'football',
  'liga 1': 'football',
  'primera division': 'football',
  'liga betplay': 'football',
  'copa de la liga': 'football',
  'copa de primera': 'football',
  'copa argentina': 'football',
  'superliga': 'football',
  'copa del rey': 'football',
  'fa cup': 'football',
  'coppa italia': 'football',
  'dfb pokal': 'football',
  'coupe de france': 'football',
  'carabao cup': 'football',
  'community shield': 'football',
  'supercopa': 'football',
  'recopa': 'football',
};

// ============================================================================
// UTILIDADES
// ============================================================================

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveEmptyJson() {
  ensureDir(OUTPUT);
  fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2), 'utf-8');
  console.log('[Escudos] JSON vacio guardado');
}

function loadCache() {
  if (fs.existsSync(CACHE_PATH)) {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); } catch (e) { return {}; }
  }
  return {};
}

function saveCache(cache) {
  ensureDir(CACHE_PATH);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

function extractMatchInfo(matchText) {
  if (!matchText) return null;
  const leagueMatch = matchText.match(/^([^:]+):\s*(.+)$/);
  let league = '', teamsText = matchText;
  if (leagueMatch) {
    league = leagueMatch[1].trim();
    teamsText = leagueMatch[2].trim();
  }
  const vsMatch = teamsText.match(/(.+?)\s+vs\s+(.+)/i);
  if (!vsMatch) return null;
  return {
    league,
    home: vsMatch[1].trim(),
    away: vsMatch[2].trim()
  };
}

function normalizeTeamName(name) {
  if (!name) return '';
  let normalized = name.toLowerCase().trim()
    .replace(/\s*\([^)]*\)\s*$/g, '')     // Quitar (Bra), (Arg), etc.
    .replace(/\s+fc$/g, '')                // Quitar " FC" al final
    .replace(/^fc\s+/g, '')                // Quitar "FC " al inicio
    .trim();

  // Buscar en el mapa
  if (TEAM_NAME_MAP[normalized]) {
    return TEAM_NAME_MAP[normalized];
  }

  return normalized;
}

function detectSport(league) {
  const lower = league.toLowerCase();
  for (const [key, sport] of Object.entries(LEAGUE_SPORT_MAP)) {
    if (lower.includes(key)) return sport;
  }
  if (lower.includes('nba')) return 'basketball';
  return 'football';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================================
// ESTRATEGIA 1: Busqueda directa en Flashscore
// ============================================================================

/**
 * Navega a la pagina de inicio de Flashscore y busca el partido en los partidos mostrados.
 * Para partidos del dia actual, Flashscore los muestra en la pagina principal.
 */
async function findMatchOnFlashscore(page, homeTeam, awayTeam, sport) {
  try {
    const sportPath = sport === 'basketball' ? '/basketball/'
                    : sport === 'ice-hockey' ? '/ice-hockey/'
                    : '/';

    await page.goto(`${FLASHSCORE_URL}${sportPath}`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT
    });
    await sleep(3000);

    // Cerrar popup de cookies si existe
    try {
      const cookieBtn = await page.$('button:has-text("I Accept"), button:has-text("Accept"), #onetrust-accept-btn-handler, .accept-button');
      if (cookieBtn) await cookieBtn.click();
    } catch (e) { /* ignore */ }

    // Buscar partido en la pagina
    return await page.evaluate((home, away) => {
      // Buscar todos los enlaces a partidos
      const links = document.querySelectorAll('a[href*="/match/"]');
      for (const link of links) {
        const container = link.closest('.event__match, [data-testid="event"]');
        const text = container ? container.textContent : link.textContent;
        if (text) {
          const t = text.toLowerCase();
          if ((t.includes(home.toLowerCase()) && t.includes(away.toLowerCase())) ||
              (link.href && link.href.toLowerCase().includes(home.toLowerCase().replace(/\s+/g, '-')) &&
               link.href.toLowerCase().includes(away.toLowerCase().replace(/\s+/g, '-')))) {
            return link.href;
          }
        }
      }

      // Buscar en cualquier elemento con texto
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        if (el.children.length === 0 && el.textContent) {
          const t = el.textContent.toLowerCase();
          if (t.includes(home.toLowerCase()) && t.includes(away.toLowerCase())) {
            // Buscar enlace padre
            let parent = el.parentElement;
            for (let i = 0; i < 5 && parent; i++) {
              if (parent.tagName === 'A' && parent.href) return parent.href;
              const link = parent.querySelector('a[href*="/match/"]');
              if (link) return link.href;
              parent = parent.parentElement;
            }
          }
        }
      }

      return null;
    }, normalizeTeamName(homeTeam), normalizeTeamName(awayTeam));

  } catch (error) {
    console.log(`    [WARN] Error buscando en Flashscore: ${error.message}`);
    return null;
  }
}

/**
 * Extrae los escudos de la pagina de un partido en Flashscore.
 */
async function extractShieldsFromMatchPage(page, matchUrl) {
  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(2500);

    return await page.evaluate(() => {
      try {
        // Funcion para extraer JSON balanceado
        function extractBalancedJson(text, startOffset) {
          let depth = 0, inString = false, escapeNext = false, startIdx = -1;
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

        // Metodo 1: participantsData en scripts
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          if (script.textContent && script.textContent.includes('"participantsData"')) {
            const idx = script.textContent.indexOf('"participantsData"');
            const colonIdx = script.textContent.indexOf(':', idx);
            if (colonIdx !== -1) {
              const jsonStr = extractBalancedJson(script.textContent, colonIdx + 1);
              if (jsonStr) {
                try {
                  const data = JSON.parse(jsonStr);
                  const home = data.home?.[0];
                  const away = data.away?.[0];
                  if (home && away) {
                    return {
                      homeLogo: home.image_path || home.small_image_path || null,
                      awayLogo: away.image_path || away.small_image_path || null,
                    };
                  }
                } catch (e) { /* ignore */ }
              }
            }
          }
        }

        // Metodo 2: Buscar imagenes de equipos
        const logos = [];
        document.querySelectorAll('img').forEach(img => {
          if (img.src && img.src.includes('flashscore.com/res/image/data/')) {
            logos.push(img.src);
          }
        });
        if (logos.length >= 2) {
          return { homeLogo: logos[0], awayLogo: logos[1] };
        }

        // Metodo 3: window.__INITIAL_STATE__
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
              };
            }
          }
        }

        // Metodo 4: Buscar URLs de imagenes en cualquier script
        for (const script of scripts) {
          const text = script.textContent || '';
          const matches = text.match(/https:\/\/[^"]*flashscore\.com\/res\/image\/data\/[^"\s]+/g);
          if (matches && matches.length >= 2) {
            return { homeLogo: matches[0], awayLogo: matches[1] };
          }
        }

        return { homeLogo: null, awayLogo: null };
      } catch (e) {
        return { homeLogo: null, awayLogo: null };
      }
    });
  } catch (error) {
    return { homeLogo: null, awayLogo: null };
  }
}

// ============================================================================
// ESTRATEGIA 2: Busqueda en Bing como fallback (menos CAPTCHA que Google)
// ============================================================================

async function searchMatchViaBing(page, homeTeam, awayTeam) {
  try {
    const home = normalizeTeamName(homeTeam);
    const away = normalizeTeamName(awayTeam);
    const query = encodeURIComponent(`${home} vs ${away} flashscore`);
    const url = `${BING_SEARCH}${query}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(3000);

    // Extraer primer resultado de flashscore.com que sea un partido
    const flashscoreUrl = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="flashscore.com"]');
      for (const link of links) {
        const href = link.href || '';
        if (href.includes('/match/') && !href.includes('/standings/') && !href.includes('/odds/')) {
          return href;
        }
      }
      // Fallback: cualquier enlace de flashscore
      for (const link of links) {
        const href = link.href || '';
        if (href.includes('flashscore.com') && !href.includes('/team/')) return href;
      }
      return null;
    });

    return flashscoreUrl;
  } catch (error) {
    console.log(`    [WARN] Error buscando en Bing: ${error.message}`);
    return null;
  }
}

// ============================================================================
// ESTRATEGIA 3: Busqueda por pagina de equipo individual
// ============================================================================

/**
 * Busca un equipo directamente en Flashscore usando su pagina de equipo.
 * Construye la URL basada en el nombre normalizado del equipo.
 */
async function searchTeamPageOnFlashscore(page, teamName, sport) {
  const normalized = normalizeTeamName(teamName);

  try {
    // Intentar buscar via la pagina de busqueda de Flashscore
    const searchUrl = `${FLASHSCORE_URL}/search/?q=${encodeURIComponent(normalized)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(2500);

    // Buscar enlaces a paginas de equipo
    const teamUrl = await page.evaluate((name) => {
      const links = document.querySelectorAll('a[href*="/team/"]');
      for (const link of links) {
        const text = (link.textContent || '').toLowerCase();
        const href = link.href || link.getAttribute('href') || '';
        if (text.includes(name.toLowerCase())) {
          return href.startsWith('http') ? href : `https://www.flashscore.com${href}`;
        }
      }
      // Si no hay match exacto, tomar el primer resultado de equipo
      for (const link of links) {
        const href = link.href || link.getAttribute('href') || '';
        if (href.includes('/team/')) {
          return href.startsWith('http') ? href : `https://www.flashscore.com${href}`;
        }
      }
      return null;
    }, normalized);

    return teamUrl;
  } catch (error) {
    return null;
  }
}

/**
 * Extrae el escudo de la pagina de un equipo.
 */
async function extractLogoFromTeamPage(page, teamUrl) {
  try {
    await page.goto(teamUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(2000);

    return await page.evaluate(() => {
      // Metodo 1: Buscar en scripts por image_path
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const imageMatch = text.match(/"image_path"\s*:\s*"(https:\/\/[^"]+)"/);
        if (imageMatch) return imageMatch[1];
      }

      // Metodo 2: Buscar imagenes con flashscore
      const images = document.querySelectorAll('img');
      for (const img of images) {
        if (img.src && img.src.includes('flashscore.com/res/image/data/')) {
          return img.src;
        }
      }

      // Metodo 3: Buscar cualquier URL de logo en scripts
      for (const script of scripts) {
        const text = script.textContent || '';
        const logoMatch = text.match(/(https:\/\/[^"]*flashscore\.com\/res\/image\/data\/[^"\s]+)/);
        if (logoMatch) return logoMatch[1];
      }

      return null;
    });
  } catch (error) {
    return null;
  }
}

// ============================================================================
// FUNCIONES PRINCIPALES
// ============================================================================

/**
 * Busca el escudo de un equipo usando todas las estrategias disponibles.
 */
async function findTeamLogoWithFallback(page, teamName, sport, opponentName, retries = 0) {
  const normalized = normalizeTeamName(teamName);

  // Estrategia 1: Buscar pagina del equipo directamente
  const teamUrl = await searchTeamPageOnFlashscore(page, teamName, sport);
  if (teamUrl) {
    const logo = await extractLogoFromTeamPage(page, teamUrl);
    if (logo) {
      console.log(`    [OK] Escudo encontrado (pagina equipo): ${teamName} -> ${logo.substring(0, 60)}...`);
      return logo;
    }
  }

  // Estrategia 2: Si tenemos oponente, buscar el partido en Flashscore
  if (opponentName) {
    const matchUrl = await findMatchOnFlashscore(page, teamName, opponentName, sport);
    if (matchUrl) {
      const shields = await extractShieldsFromMatchPage(page, matchUrl);
      if (shields.homeLogo || shields.awayLogo) {
        return shields; // Devolver ambos, el llamador decidira
      }
    }
  }

  // Estrategia 3: Fallback a Bing (solo si no es un retry)
  if (retries < MAX_RETRIES && opponentName) {
    console.log(`    [RETRY ${retries + 1}] Intentando via Bing: ${teamName}`);
    await sleep(BASE_DELAY * (retries + 1));

    const matchUrl = await searchMatchViaBing(page, teamName, opponentName);
    if (matchUrl) {
      const shields = await extractShieldsFromMatchPage(page, matchUrl);
      if (shields.homeLogo || shields.awayLogo) {
        return shields;
      }
    }

    // Reintentar con el nombre normalizado
    return findTeamLogoWithFallback(page, teamName, sport, opponentName, retries + 1);
  }

  console.log(`    [FAIL] No se encontro escudo para: ${teamName}`);
  return null;
}

/**
 * Funcion principal de scraping.
 */
async function scrapeEscudos() {
  console.log('========================================');
  console.log('[Escudos] Scraping de escudos v2.0');
  console.log('[Escudos] Estrategias: Flashscore directo > Bing fallback');
  console.log('========================================\n');

  // Verificar partidos.json
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

  // Cargar cache
  const logoCache = loadCache();
  let cacheHits = 0;

  // Extraer partidos unicos
  const uniqueMatches = new Map();
  for (const partido of partidos) {
    const info = extractMatchInfo(partido.match);
    if (!info) continue;
    const key = `${info.home} vs ${info.away}`;
    if (!uniqueMatches.has(key)) uniqueMatches.set(key, info);
  }

  console.log(`[Escudos] Total partidos: ${partidos.length}`);
  console.log(`[Escudos] Partidos unicos: ${uniqueMatches.size}`);
  console.log(`[Escudos] Cache actual: ${Object.keys(logoCache).length} escudos\n`);

  // Lanzar navegador
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
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

  // Bloquear recursos innecesarios
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'font' || type === 'media') {
      route.abort();
    } else {
      route.continue();
    }
  });

  const escudos = [];
  let processed = 0;
  let foundCount = 0;
  let missCount = 0;

  try {
    for (const [matchKey, matchInfo] of uniqueMatches) {
      processed++;
      const { league, home, away } = matchInfo;
      const sport = detectSport(league);

      console.log(`\n[${processed}/${uniqueMatches.size}] ${matchKey}`);
      console.log(`        Liga: ${league || 'N/A'} | Deporte: ${sport}`);

      // Verificar cache
      const cacheKeyHome = `${normalizeTeamName(home)}|${sport}`;
      const cacheKeyAway = `${normalizeTeamName(away)}|${sport}`;

      let homeLogo = logoCache[cacheKeyHome];
      let awayLogo = logoCache[cacheKeyAway];

      if (homeLogo) { console.log(`  [CACHE] Home: ${home}`); cacheHits++; }
      if (awayLogo) { console.log(`  [CACHE] Away: ${away}`); cacheHits++; }

      // Si ambos en cache, guardar y continuar
      if (homeLogo && awayLogo) {
        escudos.push({ match: matchKey, homeLogo, awayLogo });
        foundCount++;
        continue;
      }

      let homeFound = homeLogo;
      let awayFound = awayLogo;

      // === ESTRATEGIA A: Buscar partido en Flashscore homepage ===
      if (!homeFound || !awayFound) {
        console.log(`  [BUSCANDO] Buscando partido en Flashscore...`);
        const matchUrl = await findMatchOnFlashscore(page, home, away, sport);

        if (matchUrl) {
          console.log(`  [OK] Partido encontrado: ${matchUrl.substring(0, 80)}...`);
          const shields = await extractShieldsFromMatchPage(page, matchUrl);
          if (shields.homeLogo || shields.awayLogo) {
            if (!homeFound && shields.homeLogo) homeFound = shields.homeLogo;
            if (!awayFound && shields.awayLogo) awayFound = shields.awayLogo;
            console.log(`  [OK] Escudos extraidos de pagina del partido`);
          }
        } else {
          console.log(`  [INFO] Partido no encontrado en homepage`);
        }
      }

      // === ESTRATEGIA B: Buscar por equipo individual ===
      if (!homeFound) {
        console.log(`  [BUSCANDO] Escudo local: ${home}`);
        const result = await findTeamLogoWithFallback(page, home, sport, away);
        if (typeof result === 'string') {
          homeFound = result;
        } else if (result && typeof result === 'object') {
          if (!homeFound && result.homeLogo) homeFound = result.homeLogo;
          if (!awayFound && result.awayLogo) awayFound = result.awayLogo;
        }
        await sleep(1500 + Math.random() * 1000);
      }

      if (!awayFound) {
        console.log(`  [BUSCANDO] Escudo visitante: ${away}`);
        const result = await findTeamLogoWithFallback(page, away, sport, home);
        if (typeof result === 'string') {
          awayFound = result;
        } else if (result && typeof result === 'object') {
          if (!awayFound && result.awayLogo) awayFound = result.awayLogo;
          if (!homeFound && result.homeLogo) homeFound = result.homeLogo;
        }
        await sleep(1500 + Math.random() * 1000);
      }

      // Actualizar cache
      if (homeFound) logoCache[cacheKeyHome] = homeFound;
      if (awayFound) logoCache[cacheKeyAway] = awayFound;

      // Guardar cache cada 5 partidos
      if (processed % 5 === 0) saveCache(logoCache);

      // Guardar resultado
      if (homeFound || awayFound) {
        escudos.push({
          match: matchKey,
          homeLogo: homeFound || '',
          awayLogo: awayFound || '',
        });
        foundCount++;
        console.log(`  [OK] Resultado: Local=${homeFound ? 'SI' : 'NO'} Visitante=${awayFound ? 'SI' : 'NO'}`);
      } else {
        missCount++;
        console.log(`  [MISS] No se encontraron escudos`);
      }

      await sleep(1000 + Math.random() * 1000);
    }

    // Guardar resultados finales
    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(escudos, null, 2), 'utf-8');
    saveCache(logoCache);

    // Estadisticas
    const totalTeams = new Set();
    for (const [, info] of uniqueMatches) {
      totalTeams.add(normalizeTeamName(info.home));
      totalTeams.add(normalizeTeamName(info.away));
    }
    const foundLogos = Object.values(logoCache).filter(Boolean).length;

    console.log(`\n========================================`);
    console.log(`           RESUMEN FINAL`);
    console.log(`========================================`);
    console.log(`Partidos unicos:      ${uniqueMatches.size}`);
    console.log(`Con escudos:          ${foundCount} (${Math.round(foundCount/uniqueMatches.size*100)}%)`);
    console.log(`Sin escudos:          ${missCount}`);
    console.log(`Equipos unicos:       ${totalTeams.size}`);
    console.log(`Escudos en cache:     ${foundLogos}/${totalTeams.size} (${Math.round(foundLogos/totalTeams.size*100)}%)`);
    console.log(`Cache hits:           ${cacheHits}`);
    console.log(`Archivo:              ${OUTPUT}`);
    console.log(`Cache:                ${CACHE_PATH}`);
    console.log(`========================================`);

  } catch (error) {
    console.error(`[Escudos] Error: ${error.message}`);
    if (escudos.length > 0) {
      ensureDir(OUTPUT);
      fs.writeFileSync(OUTPUT, JSON.stringify(escudos, null, 2), 'utf-8');
    } else {
      saveEmptyJson();
    }
    saveCache(logoCache);
    process.exitCode = 0;
  } finally {
    await browser.close();
  }
}

scrapeEscudos().catch((error) => {
  console.error(`[Escudos] Error fatal: ${error.message}`);
  saveEmptyJson();
  process.exitCode = 0;
});
