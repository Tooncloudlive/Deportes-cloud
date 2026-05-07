const SCRAPE_SCRIPT = () => {
  const clean = (s) =>
    (s || '')
      .replace(/\s+/g, ' ')
      .trim();

  const isTeamLogo = (src) =>
    /cdn\.resfu\.com\/img_data\/equipos\/\d+\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(src || '');

  const isNoiseText = (text) => {
    if (!text) return true;

    const t = text.toLowerCase();

    const noise = [
      'directo',
      'tv',
      'live',
      'stream',
      'resultado',
      'clasificación',
      'explore',
      'competitions',
      'teams',
      'players',
      'transfers',
      'settings',
      'languages',
      'login',
      'matches',
      'news',
      'favourites',
      'favorite',
      'vs user',
      'password',
      'register',
      'continue',
      'facebook',
      'google',
      'onefootball'
    ];

    return noise.some((k) => t.includes(k));
  };

  const normalizeTeam = (s) =>
    clean(s)
      .replace(/\b(FT|HT|LIVE|TODAY|TOMORROW)\b/gi, '')
      .replace(/\b\d{1,2}\s+[A-Za-z]{3}\.?\s+\d{4}\b/g, '')
      .replace(/\b\d{1,2}\s*-\s*\d{1,2}\b/g, '')
      .replace(/\b\d+\s*:\s*\d+\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const extractMatch = (text) => {
    const t = clean(text);

    // Caso tipo: "U. Católica 0 - 0 Cruzeiro 07 May. 2026"
    let m = t.match(
      /^(.{2,80}?)\s+\d+\s*[-:]\s*\d+\s+(.{2,80}?)(?:\s+\d{1,2}\s+[A-Za-z]{3}\.?\s+\d{4}|\s*$)/i
    );

    if (m) {
      const home = normalizeTeam(m[1]);
      const away = normalizeTeam(m[2]);

      if (home && away) return { home, away };
    }

    // Caso tipo: "Equipo A vs Equipo B"
    m = t.match(
      /^(.{2,80}?)\s+vs\s+(.{2,80}?)(?:\s+\d{1,2}\s+[A-Za-z]{3}\.?\s+\d{4}|\s*$)/i
    );

    if (m) {
      const home = normalizeTeam(m[1]);
      const away = normalizeTeam(m[2]);

      if (home && away) return { home, away };
    }

    return null;
  };

  const data = [];
  const seen = new Set();

  const containers = [
    ...document.querySelectorAll('article'),
    ...document.querySelectorAll('section'),
    ...document.querySelectorAll('li'),
    ...document.querySelectorAll('a'),
    ...document.querySelectorAll('div')
  ];

  for (const el of containers) {
    const text = clean(el.innerText || '');
    if (!text || text.length < 8) continue;
    if (isNoiseText(text)) continue;

    const logos = [...el.querySelectorAll('img')]
      .map((img) =>
        img.currentSrc ||
        img.src ||
        img.getAttribute('data-src') ||
        ''
      )
      .filter(isTeamLogo);

    // Necesitamos al menos 2 escudos del mismo bloque
    if (logos.length < 2) continue;

    const match = extractMatch(text);
    if (!match) continue;

    const key = `${match.home} vs ${match.away}`;
    if (seen.has(key)) continue;

    seen.add(key);

    data.push({
      match: key,
      homeLogo: logos[0],
      awayLogo: logos[1]
    });
  }

  return data;
};
