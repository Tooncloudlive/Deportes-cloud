const SCRAPE_SCRIPT = () => {

  const clean = (s) =>
    (s || '')
      .replace(/\s+/g, ' ')
      .trim();

  const data = [];
  const seen = new Set();

  // SOLO tomar los bloques reales de partidos
  const matches = [
    ...document.querySelectorAll('a.match-link')
  ];

  matches.forEach(matchEl => {

    // EQUIPO LOCAL
    const homeTeamEl =
      matchEl.querySelector(
        '.team-info.ta-r .name'
      );

    // EQUIPO VISITANTE
    const awayTeamEl =
      matchEl.querySelector(
        '.team-info .name'
      );

    // ESCUDO LOCAL
    const homeLogoEl =
      matchEl.querySelector(
        '.team-info.ta-r img.team-shield'
      );

    // ESCUDO VISITANTE
    const awayLogoEl =
      matchEl.querySelectorAll(
        'img.team-shield'
      )[1];

    if (
      !homeTeamEl ||
      !awayTeamEl ||
      !homeLogoEl ||
      !awayLogoEl
    ) {
      return;
    }

    const homeTeam =
      clean(homeTeamEl.textContent);

    const awayTeam =
      clean(awayTeamEl.textContent);

    const homeLogo =
      homeLogoEl.src ||
      homeLogoEl.getAttribute('src');

    const awayLogo =
      awayLogoEl.src ||
      awayLogoEl.getAttribute('src');

    // Validaciones
    if (
      !homeTeam ||
      !awayTeam ||
      !homeLogo ||
      !awayLogo
    ) {
      return;
    }

    // Solo escudos reales
    if (
      !homeLogo.includes('/img_data/equipos/') ||
      !awayLogo.includes('/img_data/equipos/')
    ) {
      return;
    }

    const key =
      `${homeTeam} vs ${awayTeam}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    data.push({
      match: key,
      homeLogo,
      awayLogo
    });

    console.log(
      '[SCRAPE]',
      key
    );

  });

  return data;

};
