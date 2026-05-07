const SCRAPE_SCRIPT = () => {
  const clean = (s) =>
    (s || '')
      .replace(/\s+/g, ' ')
      .replace(/\n/g, ' ')
      .trim();

  const normalizeTeam = (s) =>
    clean(s)
      .replace(/\b(FT|HT|LIVE|TODAY|TOMORROW)\b/gi, '')
      .replace(/\b\d+\s*[-:]\s*\d+\b/g, '')
      .replace(/\b\d{1,2}\s+[A-Za-z]{3}\.?\s+\d{4}\b/g, '')
      .replace(/\bCBS\b/gi, '')
      .replace(/\bFOX\b/gi, '')
      .replace(/\bbeIN\b/gi, '')
      .replace(/\bESPN\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

  const isTeamLogo = (src) =>
    /cdn\.resfu\.com\/img_data\/equipos\/\d+\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(src || '');

  const invalidWords = [
    'news',
    'login',
    'register',
    'transfers',
    'competitions',
    'players',
    'settings',
    'languages',
    'password',
    'google',
    'facebook',
    'user',
    'explore',
    'favourites',
    'matches',
    'televised'
  ];

  const isBadText = (text) => {
    const t = text.toLowerCase();

    return (
      !t ||
      t.length < 5 ||
      invalidWords.some((w) => t.includes(w))
    );
  };

  const extractMatch = (text) => {
    const t = clean(text);

    // Equipo 1 0-0 Equipo 2
    let m = t.match(
      /([A-Za-zÀ-ÿ0-9\.\-\'\s]{2,60}?)\s+\d+\s*[-:]\s*\d+\s+([A-Za-zÀ-ÿ0-9\.\-\'\s]{2,60})/i
    );

    if (m) {
      return {
        home: normalizeTeam(m[1]),
        away: normalizeTeam(m[2])
      };
    }

    // Equipo 1 vs Equipo 2
    m = t.match(
      /([A-Za-zÀ-ÿ0-9\.\-\'\s]{2,60}?)\s+vs\s+([A-Za-zÀ-ÿ0-9\.\-\'\s]{2,60})/i
    );

    if (m) {
      return {
        home: normalizeTeam(m[1]),
        away: normalizeTeam(m[2])
      };
    }

    return null;
  };

  const data = [];
  const seen = new Set();

  // MUCHO más agresivo:
  // toma cualquier elemento que tenga al menos 2 logos
  const allElements = [
    ...document.querySelectorAll('*')
  ];

  for (const el of allElements) {
    const text = clean(el.innerText || '');

    if (isBadText(text)) continue;

    const logos = [
      ...el.querySelectorAll('img')
    ]
      .map((img) =>
        img.currentSrc ||
        img.src ||
        img.getAttribute('data-src') ||
        ''
      )
      .filter(isTeamLogo);

    if (logos.length < 2) continue;

    // Limpiar duplicados
    const uniqueLogos = [...new Set(logos)];

    if (uniqueLogos.length < 2) continue;

    const match = extractMatch(text);

    if (!match) continue;

    if (
      !match.home ||
      !match.away ||
      match.home.length < 2 ||
      match.away.length < 2
    ) {
      continue;
    }

    // Evitar basura
    if (
      match.home.toLowerCase() === match.away.toLowerCase()
    ) {
      continue;
    }

    const key =
      `${match.home} vs ${match.away}`;

    if (seen.has(key)) continue;

    seen.add(key);

    data.push({
      match: key,
      homeLogo: uniqueLogos[0],
      awayLogo: uniqueLogos[1]
    });

    console.log('[SCRAPE]', key);
  }

  // Eliminar posibles partidos basura
  return data.filter((x) => {
    const t = x.match.toLowerCase();

    return (
      !t.includes('login') &&
      !t.includes('register') &&
      !t.includes('news') &&
      !t.includes('password') &&
      !t.includes('google') &&
      !t.includes('facebook')
    );
  });
};
