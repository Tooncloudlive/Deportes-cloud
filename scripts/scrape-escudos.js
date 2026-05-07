const SCRAPE_SCRIPT = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const normalizeLogo = (src) => {
    if (!src) return '';
    return src
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, '')
      .trim();
  };

  const isResfuTeamLogo = (src) =>
    /^https?:\/\/cdn\.resfu\.com\/img_data\/equipos\/\d+\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(src || '');

  const data = [];
  const seen = new Set();

  // Solo partidos reales dentro del contenedor principal
  const rows = [
    ...document.querySelectorAll('#tableMatches a.match-link.match-home[data-cy="match"]')
  ];

  rows.forEach((row) => {
    // Cada partido tiene 2 bloques .team-info
    const teamInfos = [...row.querySelectorAll(':scope .team-info')];

    if (teamInfos.length < 2) return;

    const teams = teamInfos.map((teamInfo) => {
      const nameEl =
        teamInfo.querySelector('[itemprop="name"]') ||
        teamInfo.querySelector('.team-name') ||
        teamInfo.querySelector('.name');

      const imgEl = teamInfo.querySelector('img.team-shield');

      const name = clean(nameEl?.textContent);
      const logo = normalizeLogo(
        imgEl?.currentSrc ||
        imgEl?.src ||
        imgEl?.getAttribute('data-src') ||
        imgEl?.getAttribute('src') ||
        ''
      );

      return { name, logo };
    });

    const home = teams[0];
    const away = teams[1];

    if (!home.name || !away.name) return;
    if (!home.logo || !away.logo) return;
    if (!isResfuTeamLogo(home.logo) || !isResfuTeamLogo(away.logo)) return;

    const key = `${home.name} vs ${away.name}`;
    if (seen.has(key)) return;
    seen.add(key);

    data.push({
      match: key,
      homeLogo: home.logo,
      awayLogo: away.logo
    });
  });

  return data;
};
