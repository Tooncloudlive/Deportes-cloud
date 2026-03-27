/**
 * Script de prueba para verificar que el scraper funciona correctamente
 * Ejecutar localmente antes de subir a GitHub
 */

const { scrapeEvents } = require('./scraper');

async function testScraper() {
  console.log('🧪 Probando scraper de eventos deportivos...\n');
  
  try {
    const events = await scrapeEvents();
    
    console.log('\n📊 Resultados del test:');
    console.log('======================');
    console.log(`✅ Eventos encontrados: ${events.length}`);
    
    if (events.length > 0) {
      console.log('\n📝 Primeros 5 eventos:');
      events.slice(0, 5).forEach((event, index) => {
        console.log(`\n${index + 1}. ${event.match}`);
        console.log(`   🕐 Hora: ${event.time}`);
        console.log(`   🔗 Link: ${event.link.substring(0, 60)}...`);
      });
      
      // Mostrar estadísticas
      const uniqueMatches = new Set(events.map(e => e.match)).size;
      const uniqueChannels = new Set(events.map(e => e.link)).size;
      
      console.log('\n📈 Estadísticas:');
      console.log(`   • Partidos únicos: ${uniqueMatches}`);
      console.log(`   • Canales únicos: ${uniqueChannels}`);
      console.log(`   • Promedio de canales por partido: ${(events.length / uniqueMatches).toFixed(1)}`);
    }
    
    console.log('\n✅ Test completado exitosamente!');
    console.log('🚀 El scraper está listo para usar en GitHub Actions');
    
  } catch (error) {
    console.error('\n❌ Error en el test:', error.message);
    console.error('\n💡 Posibles soluciones:');
    console.error('   1. Verifica tu conexión a internet');
    console.error('   2. Asegúrate de que streamx339.cloud esté accesible');
    console.error('   3. Instala las dependencias: npm install');
    console.error('   4. Instala Playwright: npx playwright install chromium');
    process.exit(1);
  }
}

// Ejecutar test
testScraper();
