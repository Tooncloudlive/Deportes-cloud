/**
 * Scraper para extraer eventos deportivos de streamx339.cloud
 * Usa Playwright para navegar y extraer los datos
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function scrapeEvents() {
  console.log('🚀 Iniciando scraping de eventos deportivos...');
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    // Navegar a la página
    console.log('📡 Cargando streamx550.com...');
    await page.goto('https://streamx550.com/', { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });
    
    // Esperar a que carguen los eventos
    await page.waitForSelector('.event', { timeout: 30000 });
    
    // Extraer los datos de los eventos
    console.log('📊 Extrayendo datos de eventos...');
    const eventsData = await page.evaluate(() => {
      const events = [];
      
      document.querySelectorAll('.event').forEach(eventEl => {
        const nameText = eventEl.querySelector('.event-name')?.innerText.trim();
        if (!nameText) return;
        
        // Extraer hora y partido del formato "HH:MM - Partido"
        const timeMatch = nameText.match(/^(\d{2}:\d{2})\s*-\s*(.*)$/);
        if (!timeMatch) return;
        
        const time = timeMatch[1];
        const match = timeMatch[2];
        
        // Extraer todos los links de iframe
        eventEl.querySelectorAll('.iframe-link').forEach(input => {
          const link = input.value;
          if (link && link.includes('streamx339.cloud')) {
            events.push({
              time: time,
              match: match,
              link: link
            });
          }
        });
      });
      
      return events;
    });
    
    console.log(`✅ Se encontraron ${eventsData.length} eventos`);
    
    // Eliminar duplicados (mismo partido, mismo canal)
    const uniqueEvents = [];
    const seen = new Set();
    
    eventsData.forEach(event => {
      const key = `${event.time}-${event.match}-${event.link}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueEvents.push(event);
      }
    });
    
    console.log(`✅ ${uniqueEvents.length} eventos únicos después de filtrar duplicados`);
    
    return uniqueEvents;
    
  } catch (error) {
    console.error('❌ Error durante el scraping:', error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

async function updateHTML(eventsData) {
  console.log('📝 Actualizando archivo HTML...');
  
  const htmlPath = path.join(__dirname, 'index.html');
  
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`No se encontró el archivo index.html en ${htmlPath}`);
  }
  
  let htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  
  // Generar el nuevo array de eventos
  const eventsArray = eventsData.map(e => {
    return `  { time: "${e.time}", match: "${e.match}", link: "${e.link}" }`;
  }).join(',\n');
  
  const newEventsData = `let eventsData = [\n${eventsArray}\n];`;
  
  // Reemplazar el array de eventos en el HTML
  // Buscar el patrón: let eventsData = [...];
  const eventsRegex = /let eventsData = \[[\s\S]*?\];/;
  
  if (!eventsRegex.test(htmlContent)) {
    throw new Error('No se encontró el array eventsData en el HTML');
  }
  
  htmlContent = htmlContent.replace(eventsRegex, newEventsData);
  
  // Guardar el archivo actualizado
  fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
  
  console.log('✅ HTML actualizado correctamente');
  console.log(`📄 Se actualizaron ${eventsData.length} eventos`);
}

async function main() {
  try {
    const events = await scrapeEvents();
    
    if (events.length === 0) {
      console.warn('⚠️ No se encontraron eventos. El HTML no se modificará.');
      process.exit(0);
    }
    
    await updateHTML(events);
    
    console.log('\n🎉 ¡Automatización completada exitosamente!');
    console.log(`📅 Fecha: ${new Date().toLocaleString('es-ES')}`);
    
  } catch (error) {
    console.error('\n❌ Error en la automatización:', error.message);
    process.exit(1);
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  main();
}

module.exports = { scrapeEvents, updateHTML };
