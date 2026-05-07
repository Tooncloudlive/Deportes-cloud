(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Scroll para cargar todo
  for (let i = 0; i < 10; i++) {
    const count = document.querySelectorAll('a[href*="/partido/"]').length;
    if (count > 5 && i > 2) break;
    window.scrollBy(0, window.innerHeight * 2);
    await sleep(1200);
  }

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const data = [...document.querySelectorAll('a[href*="/partido/"]')].map((card) => {
    // Nombres: divs con texto dentro del <a>
    const teamDivs = [...card.querySelectorAll(':scope > div')].filter(d => {
      const t = clean(d.textContent);
      return t.length > 0 && t.length < 60 && isNaN(t);
    });
    
    const names = teamDivs.map(el => clean(el.textContent));
    
    // Escudos: buscar en divs vacíos + imgs
    const getSrc = (div) => {
      const img = div?.querySelector('img');
      if (img) return img.src || img.dataset?.src || '';
      const style = window.getComputedStyle(div);
      const bg = style.backgroundImage;
      if (bg && bg !== 'none') return bg.replace(/url\(["']?/, '').replace(/["']?\)/, '');
      return '';
    };
    
    const emptyDivs = [...card.querySelectorAll(':scope > div')].filter(d => clean(d.textContent) === '');
    const homeLogo = emptyDivs[0] ? getSrc(emptyDivs[0]) : '';
    const awayLogo = emptyDivs[1] ? getSrc(emptyDivs[1]) : '';

    return {
      match: names.length >= 2 ? `${names[0]} vs ${names[1]}` : clean(card.textContent).slice(0, 120),
      homeLogo,
      awayLogo,
    };
  }).filter((x) => x.match.includes('vs'));

  console.table(data);
  console.log(`${data.length} partidos con escudos encontrados`);
  return data;
})();
