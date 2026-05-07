const SCRAPE_SCRIPT = () => {
  const clean = (s) =>
    (s || '').replace(/\s+/g, ' ').trim();

  const isResfuTeamLogo = (src) =>
    /cdn\.resfu\.com\/img_data\/equipos\/\d+\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(src || '');

  const data = [];
  const seen = new Set();

  // Solo filas reales de partidos
  const rows = [
    ...document.querySelectorAll('#tableMatches a.match-link.match-home[data-cy="match"]')
  ];

  rows.forEach((row) => {
    // Toma solo los nombres de equipo del bloque del partido
    const names = [
      ...row.querySelectorAll('.team-info [itemprop="name"], .team-info .name')
    ]
      .map((el) => clean(el.textContent))
      .filter(Boolean);

    // Toma solo los escudos del bloque del partido
    const logos = [
      ...row.querySelectorAll('img.team-shield')
    ]
      .map((img) =>
        img.currentSrc ||
        img.src ||
        img.getAttribute('data-src') ||
        ''
      )
      .filter(isResfuTeamLogo);

    if (names.length < 2) return;
    if (logos.length < 2) return;

    const homeTeam = names[0];
    const awayTeam = names[1];

    const homeLogo = logos[0];
    const awayLogo = logos[1];

    if (!homeTeam || !awayTeam) return;
    if (!homeLogo || !awayLogo) return;
    if (homeTeam.toLowerCase() === awayTeam.toLowerCase()) return;

    const key = `${homeTeam} vs ${awayTeam}`;
    if (seen.has(key)) return;

    seen.add(key);

    data.push({
      match: key,
      homeLogo,
      awayLogo
    });
  });

  return data;
};
