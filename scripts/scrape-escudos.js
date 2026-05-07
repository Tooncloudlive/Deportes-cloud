const SCRAPE_SCRIPT = () => {
  const results = [];
  const seen = new Set();

  // =========================
  // Helpers
  // =========================

  const cleanText = (text) => {
    return (text || "")
      .replace(/\s+/g, " ")
      .replace(/\u00A0/g, " ")
      .trim();
  };

  const normalizeLogo = (url) => {
    if (!url) return "";

    return url
      .replace(/&amp;/g, "&")
      .replace(/\?.*$/, "")
      .trim();
  };

  const buildLogo = (url) => {
    if (!url) return "";

    const clean = normalizeLogo(url);

    // fuerza formato correcto
    const match = clean.match(
      /https?:\/\/cdn\.resfu\.com\/img_data\/equipos\/(\d+)\.(png|jpg|jpeg|webp)/i
    );

    if (!match) return "";

    const id = match[1];
    const ext = match[2];

    return `https://cdn.resfu.com/img_data/equipos/${id}.${ext}?size=60x&lossy=1`;
  };

  const isValidTeamLogo = (url) => {
    return /^https?:\/\/cdn\.resfu\.com\/img_data\/equipos\/\d+\.(png|jpg|jpeg|webp)/i.test(
      url || ""
    );
  };

  const isValidTeamName = (name) => {
    if (!name) return false;

    const invalidPatterns = [
      /today/i,
      /matches/i,
      /news/i,
      /explore/i,
      /competitions/i,
      /transfers/i,
      /favourites/i,
      /settings/i,
      /languages/i,
      /gambling/i,
      /1-800/i,
      /ft/i,
      /vs user/i,
      /televised/i,
      /more/i,
      /find match/i,
      /most viewed/i,
      /most searched/i
    ];

    return !invalidPatterns.some((r) => r.test(name));
  };

  // =========================
  // Buscar SOLO partidos reales
  // =========================

  const rows = [
    ...document.querySelectorAll(
      '#tableMatches a.match-link.match-home[data-cy="match"]'
    )
  ];

  rows.forEach((row) => {
    try {
      // =========================
      // Obtener SOLO bloques team-info
      // =========================

      let teamBlocks = [
        ...row.querySelectorAll(":scope > .team-info")
      ];

      // fallback
      if (teamBlocks.length < 2) {
        teamBlocks = [...row.querySelectorAll(".team-info")];
      }

      if (teamBlocks.length < 2) return;

      // Tomar solo los primeros 2 equipos
      teamBlocks = teamBlocks.slice(0, 2);

      const parsedTeams = teamBlocks.map((block) => {
        // =========================
        // Nombre
        // =========================

        const nameEl =
          block.querySelector('[itemprop="name"]') ||
          block.querySelector(".team-name") ||
          block.querySelector(".name") ||
          block.querySelector("div");

        const rawName = cleanText(nameEl?.textContent || "");

        // =========================
        // Escudo
        // =========================

        const img =
          block.querySelector("img.team-shield") ||
          block.querySelector("img");

        const rawLogo =
          img?.currentSrc ||
          img?.src ||
          img?.getAttribute("data-src") ||
          img?.getAttribute("src") ||
          "";

        const finalLogo = buildLogo(rawLogo);

        return {
          name: rawName,
          logo: finalLogo
        };
      });

      const home = parsedTeams[0];
      const away = parsedTeams[1];

      // =========================
      // Validaciones ULTRA estrictas
      // =========================

      if (!home || !away) return;

      if (!home.name || !away.name) return;

      if (!isValidTeamName(home.name)) return;
      if (!isValidTeamName(away.name)) return;

      if (home.name.length > 60) return;
      if (away.name.length > 60) return;

      if (home.name === away.name) return;

      if (!home.logo || !away.logo) return;

      if (!isValidTeamLogo(home.logo)) return;
      if (!isValidTeamLogo(away.logo)) return;

      // evitar basura tipo navegación
      if (
        home.name.split(" ").length > 8 ||
        away.name.split(" ").length > 8
      ) {
        return;
      }

      const match = `${home.name} vs ${away.name}`;

      if (seen.has(match)) return;
      seen.add(match);

      results.push({
        match,
        homeLogo: home.logo,
        awayLogo: away.logo
      });
    } catch (err) {
      // ignorar filas rotas
    }
  });

  return results;
};

// Ejecutar
SCRAPE_SCRIPT();
