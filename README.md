# ToonCloud Deportes - Scraping Automatico

Web de deportes con datos actualizados automaticamente desde:
- **streamx550.com** - Partidos y canales de transmision
- **es.besoccer.com** - Escudos de equipos

## Como usar en GitHub

### 1. Crear repositorio
1. Ve a GitHub y crea un nuevo repositorio
2. Sube todos estos archivos al repositorio

### 2. Activar GitHub Pages
1. En el repositorio, ve a **Settings > Pages**
2. En **Source** selecciona **Deploy from a branch**
3. Selecciona la rama **main** y carpeta **root**
4. Guarda los cambios

### 3. Configurar permisos de Actions
1. Ve a **Settings > Actions > General**
2. En **Workflow permissions** selecciona **Read and write permissions**
3. Guarda los cambios

### 4. Ejecutar el workflow
1. Ve a la pestana **Actions** del repositorio
2. Selecciona el workflow **Scraping Automatico de Partidos y Escudos**
3. Haz click en **Run workflow** para ejecutarlo manualmente

El workflow se ejecuta automaticamente **cada 30 minutos**.

### 5. Ver la web
Una vez que el workflow termine, la web estara disponible en:
```
https://TU-USUARIO.github.io/NOMBRE-REPOSITORIO/
```

## Estructura del proyecto

```
.
├── .github/workflows/scrape.yml   # Workflow de GitHub Actions
├── scripts/
│   ├── scrape-partidos.js        # Scraping de streamx550.com
│   ├── scrape-escudos.js         # Scraping de es.besoccer.com
│   └── build.js                  # Genera index.html final
├── data/                          # Datos scrapeados (JSON)
│   ├── partidos.json
│   └── escudos.json
├── template.html                  # Plantilla HTML base
├── index.html                     # HTML generado (NO editar manualmente)
├── package.json
└── README.md
```

## Scripts disponibles

```bash
# Scraping individual
npm run scrape:partidos    # Solo partidos
npm run scrape:escudos     # Solo escudos

# Generar HTML
npm run build              # Genera index.html desde template + datos

# Todo junto
npm run scrape:all         # Partidos + Escudos + Build
```

## Ejecutar localmente

### Requisitos
- Node.js 18+
- npm

### Instalacion
```bash
npm install
npx playwright install chromium
```

### Ejecutar scraping
```bash
npm run scrape:all
```

Esto generara `index.html` con los datos mas recientes.

## Notas importantes

- **index.html se sobrescribe** cada vez que se ejecuta el scraping. No edites este archivo manualmente.
- Para modificar el diseno, edita **template.html** y vuelve a ejecutar `npm run build`.
- Los datos se guardan en la carpeta **data/** como JSON.
- Si alguna de las webs cambia su estructura, puede que sea necesario actualizar los scripts de scraping.

## Licencia

Larvas S.A
