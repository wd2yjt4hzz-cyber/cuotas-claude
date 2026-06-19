/* ===========================================================================
   MUNDIAL26 AI ANALYTICS — script.js
   ===========================================================================
   Aplicación 100% frontend (HTML+CSS+JS puro), pensada para GitHub Pages.

   ÍNDICE
   1. CONFIG Y ALMACENAMIENTO LOCAL
   2. UTILIDADES (matemáticas, formato, aleatoriedad determinista)
   3. BASE DE DATOS DE EQUIPOS Y PARTIDOS (fallback / modo demo)
   4. CAPA DE DATOS (intenta APIs reales, si fallan usa el modo simulado)
   5. MODELO ESTADÍSTICO DE EQUIPOS (forma, xG, tiros, córners, tarjetas...)
   6. MOTOR DE PREDICCIÓN (Poisson + scoring de confianza)
   7. CUOTAS Y VALUE BETS (cuota justa, edge, EV)
   8. ESTADO DE LA APP Y RENDERIZADO (tarjetas, tabla, gráficos, modales)
   9. EVENTOS DE INTERFAZ (buscador, filtros, orden, ajustes, modal)
   10. INICIALIZACIÓN

   NOTA SOBRE FUENTES DE DATOS (leer antes de tocar el código):
   Bet365, SofaScore, Flashscore, FotMob y FBref NO ofrecen una API pública
   para ser consumida desde el navegador: o no tienen API, o la tienen
   protegida por CORS, o prohíben el scraping en sus términos de servicio.
   Por eso esta app:
     a) Intenta usar APIs públicas reales y gratuitas (The Odds API y
        football-data.org) SI el usuario aporta su propia clave gratuita
        en el panel de Configuración.
     b) Si no hay clave, o la petición falla (CORS, límite, red, etc.),
        usa automáticamente un MOTOR DE SIMULACIÓN ESTADÍSTICA propio,
        calibrado con el nivel real de cada selección, que genera datos
        coherentes (forma, xG, tiros, córners, tarjetas, cuotas...) para
        que la aplicación sea 100% funcional sin backend ni claves.
   Todo dato simulado se marca visualmente como tal en la interfaz.
   =========================================================================== */

(() => {
  'use strict';

  /* =========================================================================
     1. CONFIG Y ALMACENAMIENTO LOCAL
     ========================================================================= */
  const STORAGE_KEYS = {
    oddsApiKey: 'm26_odds_api_key',
    footballDataApiKey: 'm26_football_data_api_key',
    liveMode: 'm26_live_mode'
  };

  const Settings = {
    get oddsApiKey() { return localStorage.getItem(STORAGE_KEYS.oddsApiKey) || ''; },
    get footballDataApiKey() { return localStorage.getItem(STORAGE_KEYS.footballDataApiKey) || ''; },
    get liveMode() { return localStorage.getItem(STORAGE_KEYS.liveMode) === '1'; },
    save(odds, fd, live) {
      localStorage.setItem(STORAGE_KEYS.oddsApiKey, odds || '');
      localStorage.setItem(STORAGE_KEYS.footballDataApiKey, fd || '');
      localStorage.setItem(STORAGE_KEYS.liveMode, live ? '1' : '0');
    },
    clear() {
      Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k));
    }
  };

  // Constantes del modelo (fácilmente ajustables)
  const MODEL = {
    LEAGUE_AVG_XG: 1.35,   // goles esperados promedio de un equipo "tipo" por partido
    HOME_ADV: 1.10,        // multiplicador de ventaja para el equipo "local" del fixture
    AWAY_PENALTY: 0.96,    // ligera penalización para el "visitante"
    MAX_GOALS: 6,          // tope de la matriz de marcadores para Poisson
    BOOK_MARGIN: 1.06      // overround típico de una casa de apuestas (~6%)
  };

  /* =========================================================================
     2. UTILIDADES
     ========================================================================= */

  // Hash determinista de una cadena -> entero (para sembrar el RNG)
  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  // PRNG determinista (mulberry32). Misma semilla -> misma secuencia siempre,
  // así cada equipo conserva "personalidad" estadística estable entre cargas.
  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rngFor(...parts) {
    return mulberry32(hashString(parts.join('|')));
  }

  function randRange(rng, min, max) { return min + rng() * (max - min); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round2(v) { return Math.round(v * 100) / 100; }

  // Factoriales precalculados 0..12 para la distribución de Poisson
  const FACTORIALS = [1];
  for (let i = 1; i <= 12; i++) FACTORIALS.push(FACTORIALS[i - 1] * i);

  function poissonPMF(k, lambda) {
    return (Math.exp(-lambda) * Math.pow(lambda, k)) / FACTORIALS[k];
  }

  function fmtPct(v) { return `${Math.round(v * 100)}%`; }
  function fmtOdds(v) { return v.toFixed(2); }
  function fmtSigned(v, suffix = '') { return `${v >= 0 ? '+' : ''}${round1(v)}${suffix}`; }

  function formatKickoff(iso) {
    const d = new Date(iso);
    return d.toLocaleString('es-ES', {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit'
    });
  }
  function dateKey(iso) {
    // Agrupa por día en huso horario local del usuario
    const d = new Date(iso);
    return d.toLocaleDateString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  /* =========================================================================
     3. BASE DE DATOS DE EQUIPOS Y PARTIDOS (fallback / modo demo)
     -------------------------------------------------------------------------
     Calendario real del Mundial 2026 (fase de grupos, partidos ya confirmados
     con ambos equipos definidos). Sirve como conjunto de respaldo cuando no
     hay claves de API o la petición en vivo falla. Las valoraciones de cada
     selección (ataque/defensa/elo) son una estimación propia orientativa,
     usada únicamente para alimentar el motor de simulación estadística.
     ========================================================================= */
  const TEAM_META = {
    'México':          { code: 'MEX', flag: '🇲🇽', rating: { att: 72, def: 66, elo: 71 },
      players: [['Santiago Giménez', 0.30], ['Hirving Lozano', 0.18], ['Raúl Jiménez', 0.16]] },
    'Sudáfrica':        { code: 'RSA', flag: '🇿🇦', rating: { att: 54, def: 58, elo: 50 },
      players: [['Percy Tau', 0.27], ['Lyle Foster', 0.20]] },
    'Catar':            { code: 'QAT', flag: '🇶🇦', rating: { att: 53, def: 56, elo: 49 },
      players: [['Akram Afif', 0.31], ['Almoez Ali', 0.22]] },
    'Suiza':             { code: 'SUI', flag: '🇨🇭', rating: { att: 70, def: 76, elo: 72 },
      players: [['Breel Embolo', 0.26], ['Dan Ndoye', 0.20], ['Ruben Vargas', 0.15]] },
    'Brasil':            { code: 'BRA', flag: '🇧🇷', rating: { att: 91, def: 77, elo: 90 },
      players: [['Vinícius Júnior', 0.34], ['Rodrygo', 0.21], ['Raphinha', 0.19]] },
    'Marruecos':         { code: 'MAR', flag: '🇲🇦', rating: { att: 75, def: 78, elo: 76 },
      players: [['Brahim Díaz', 0.23], ['Achraf Hakimi', 0.17], ['Youssef En-Nesyri', 0.21]] },
    'Haití':             { code: 'HAI', flag: '🇭🇹', rating: { att: 47, def: 49, elo: 43 },
      players: [['Duckens Nazon', 0.25], ['Frantzdy Pierrot', 0.20]] },
    'Escocia':           { code: 'SCO', flag: '🏴', rating: { att: 61, def: 66, elo: 62 },
      players: [['Che Adams', 0.24], ['Lyndon Dykes', 0.19], ['Scott McTominay', 0.18]] },
    'Estados Unidos':    { code: 'USA', flag: '🇺🇸', rating: { att: 74, def: 71, elo: 74 },
      players: [['Christian Pulisic', 0.32], ['Folarin Balogun', 0.20]] },
    'Paraguay':          { code: 'PAR', flag: '🇵🇾', rating: { att: 57, def: 63, elo: 56 },
      players: [['Antonio Sanabria', 0.23], ['Miguel Almirón', 0.20]] },
    'Turquía':           { code: 'TUR', flag: '🇹🇷', rating: { att: 72, def: 66, elo: 70 },
      players: [['Arda Güler', 0.23], ['Kerem Aktürkoğlu', 0.22]] },
    'Australia':         { code: 'AUS', flag: '🇦🇺', rating: { att: 60, def: 64, elo: 59 },
      players: [['Mitchell Duke', 0.22], ['Craig Goodwin', 0.16]] },
    'Corea del Sur':     { code: 'KOR', flag: '🇰🇷', rating: { att: 69, def: 63, elo: 66 },
      players: [['Son Heung-min', 0.34], ['Cho Gue-sung', 0.18]] },
    'Canadá':            { code: 'CAN', flag: '🇨🇦', rating: { att: 68, def: 64, elo: 66 },
      players: [['Jonathan David', 0.33], ['Alphonso Davies', 0.18]] }
  };

  // Fixture = { id, date(ISO UTC), group, city, stadium, home, away }
  const FALLBACK_FIXTURES = [
    { date: '2026-06-11T19:00:00Z', group: 'A', city: 'Ciudad de México', stadium: 'Estadio Azteca', home: 'México', away: 'Sudáfrica' },
    { date: '2026-06-13T01:00:00Z', group: 'D', city: 'Los Ángeles', stadium: 'SoFi Stadium', home: 'Estados Unidos', away: 'Paraguay' },
    { date: '2026-06-13T19:00:00Z', group: 'B', city: 'San Francisco', stadium: "Levi's Stadium", home: 'Catar', away: 'Suiza' },
    { date: '2026-06-13T22:00:00Z', group: 'C', city: 'Nueva Jersey', stadium: 'MetLife Stadium', home: 'Brasil', away: 'Marruecos' },
    { date: '2026-06-14T01:00:00Z', group: 'C', city: 'Boston', stadium: 'Gillette Stadium', home: 'Haití', away: 'Escocia' },
    { date: '2026-06-18T22:00:00Z', group: 'B', city: 'Vancouver', stadium: 'BC Place', home: 'Canadá', away: 'Catar' },
    { date: '2026-06-19T01:00:00Z', group: 'A', city: 'Guadalajara', stadium: 'Estadio Akron', home: 'México', away: 'Corea del Sur' },
    { date: '2026-06-19T19:00:00Z', group: 'D', city: 'Seattle', stadium: 'Lumen Field', home: 'Estados Unidos', away: 'Australia' },
    { date: '2026-06-19T22:00:00Z', group: 'C', city: 'Boston', stadium: 'Gillette Stadium', home: 'Escocia', away: 'Marruecos' },
    { date: '2026-06-20T01:00:00Z', group: 'C', city: 'Filadelfia', stadium: 'Lincoln Financial Field', home: 'Brasil', away: 'Haití' },
    { date: '2026-06-20T04:00:00Z', group: 'D', city: 'San Francisco', stadium: "Levi's Stadium", home: 'Turquía', away: 'Paraguay' },
    { date: '2026-06-24T19:00:00Z', group: 'B', city: 'Vancouver', stadium: 'BC Place', home: 'Suiza', away: 'Canadá' },
    { date: '2026-06-24T22:00:00Z', group: 'C', city: 'Miami', stadium: 'Hard Rock Stadium', home: 'Escocia', away: 'Brasil' },
    { date: '2026-06-24T22:00:00Z', group: 'C', city: 'Atlanta', stadium: 'Mercedes-Benz Stadium', home: 'Marruecos', away: 'Haití' },
    { date: '2026-06-25T01:00:00Z', group: 'A', city: 'Monterrey', stadium: 'Estadio BBVA', home: 'Sudáfrica', away: 'Corea del Sur' },
    { date: '2026-06-26T02:00:00Z', group: 'D', city: 'Los Ángeles', stadium: 'SoFi Stadium', home: 'Turquía', away: 'Estados Unidos' },
    { date: '2026-06-26T02:00:00Z', group: 'D', city: 'San Francisco', stadium: "Levi's Stadium", home: 'Paraguay', away: 'Australia' }
  ].map((f, i) => ({ id: `m26-${i + 1}`, ...f }));

  /* =========================================================================
     4. CAPA DE DATOS — intenta APIs reales, si fallan usa el modo simulado
     ========================================================================= */

  // Intenta obtener el calendario real desde football-data.org (gratis con clave).
  // Devuelve null si falla por cualquier motivo (CORS, red, sin clave, 4xx...).
  async function tryFetchLiveFixtures() {
    if (!Settings.liveMode || !Settings.footballDataApiKey) return null;
    try {
      const res = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
        headers: { 'X-Auth-Token': Settings.footballDataApiKey }
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.matches || !data.matches.length) return null;
      return data.matches.map((m, i) => ({
        id: `live-${i}`,
        date: m.utcDate,
        group: (m.group || '').replace('GROUP_', ''),
        city: m.venue || m.area?.name || '',
        stadium: m.venue || '',
        home: m.homeTeam?.name || 'Local',
        away: m.awayTeam?.name || 'Visitante'
      }));
    } catch (err) {
      console.warn('[MUNDIAL26] No se pudo obtener el calendario en vivo (football-data.org). Usando modo demo.', err);
      return null;
    }
  }

  // Intenta obtener cuotas reales desde The Odds API (incluye Bet365 según la
  // región del usuario). Devuelve un mapa { "Equipo A|Equipo B": {home,draw,away} }
  // con cuotas decimales, o null si falla.
  async function tryFetchLiveOdds() {
    if (!Settings.liveMode || !Settings.oddsApiKey) return null;
    try {
      const url = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${encodeURIComponent(Settings.oddsApiKey)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const map = {};
      data.forEach(ev => {
        const book = ev.bookmakers.find(b => b.key === 'bet365') || ev.bookmakers[0];
        if (!book) return;
        const market = book.markets.find(m => m.key === 'h2h');
        if (!market) return;
        const odds = {};
        market.outcomes.forEach(o => {
          if (o.name === ev.home_team) odds.home = o.price;
          else if (o.name === ev.away_team) odds.away = o.price;
          else odds.draw = o.price;
        });
        map[`${ev.home_team}|${ev.away_team}`] = { ...odds, bookmaker: book.title };
      });
      return map;
    } catch (err) {
      console.warn('[MUNDIAL26] No se pudieron obtener cuotas en vivo (The Odds API). Usando cuotas simuladas.', err);
      return null;
    }
  }

  /* =========================================================================
     5. MODELO ESTADÍSTICO DE EQUIPOS
     -------------------------------------------------------------------------
     A partir de un rating base (ataque/defensa/elo) genera un perfil
     estadístico completo y determinista (mismos resultados en cada carga,
     salvo pequeño "jitter" añadido al refrescar). Esto simula lo que en una
     versión con backend se obtendría agregando SofaScore + FotMob + FBref +
     Understat.
     ========================================================================= */
  const teamStatsCache = new Map();

  function getTeamStats(teamName, jitterSeed = '') {
    const cacheKey = teamName + '::' + jitterSeed;
    if (teamStatsCache.has(cacheKey)) return teamStatsCache.get(cacheKey);

    const meta = TEAM_META[teamName] || { code: teamName.slice(0, 3).toUpperCase(), flag: '🏳️', rating: { att: 60, def: 60, elo: 58 }, players: [] };
    const rng = rngFor('stats', teamName, jitterSeed);
    const { att, def, elo } = meta.rating;

    // xG / xGA por partido, mapeados desde el rating 0-100 a un rango realista
    const xgFor = clamp(0.55 + (att / 100) * 2.05 + randRange(rng, -0.08, 0.08), 0.4, 3.0);
    const xgAgainst = clamp(0.55 + ((100 - def) / 100) * 2.05 + randRange(rng, -0.08, 0.08), 0.35, 2.8);

    // Forma reciente: últimos 5 resultados ponderados por el elo del equipo
    const form = [];
    let goalsFor5 = 0, goalsAgainst5 = 0, points5 = 0;
    for (let i = 0; i < 5; i++) {
      const r = rng();
      const winProb = clamp(0.28 + (elo - 50) / 140, 0.1, 0.75);
      const drawProb = 0.26;
      let result, gf, ga;
      if (r < winProb) {
        result = 'W'; gf = Math.round(randRange(rng, 1, 3)); ga = Math.round(randRange(rng, 0, gf));
        points5 += 3;
      } else if (r < winProb + drawProb) {
        result = 'D'; gf = Math.round(randRange(rng, 0, 2)); ga = gf;
        points5 += 1;
      } else {
        result = 'L'; ga = Math.round(randRange(rng, 1, 3)); gf = Math.round(randRange(rng, 0, ga));
      }
      goalsFor5 += gf; goalsAgainst5 += ga;
      form.push({ result, gf, ga });
    }

    const shotsTotal = clamp(7.5 + (att / 100) * 13.5 + randRange(rng, -1, 1), 6, 23);
    const shotsOnTarget = clamp(shotsTotal * randRange(rng, 0.32, 0.42), 2, 11);
    const corners = clamp(3.2 + (att / 100) * 4.6 + randRange(rng, -0.6, 0.6), 2, 9);
    const cardsAvg = clamp(1.4 + randRange(rng, -0.5, 1.3), 0.8, 4.2);
    const possession = clamp(36 + (att / 100) * 26 + randRange(rng, -3, 3), 32, 68);

    // Lesiones / sanciones simuladas (0-2 jugadores en duda)
    const injuryCount = rng() < 0.35 ? (rng() < 0.5 ? 1 : 2) : 0;
    const injuries = [];
    const statuses = ['Duda (molestia muscular)', 'Baja confirmada', 'Sancionado (acumulación de tarjetas)'];
    for (let i = 0; i < injuryCount; i++) {
      const player = meta.players[i % meta.players.length];
      if (player) injuries.push({ name: player[0], status: statuses[Math.floor(rng() * statuses.length)] });
    }

    const stats = {
      code: meta.code, flag: meta.flag, rating: meta.rating, players: meta.players,
      xgFor: round2(xgFor), xgAgainst: round2(xgAgainst),
      form, goalsFor5, goalsAgainst5, points5,
      shotsTotal: round1(shotsTotal), shotsOnTarget: round1(shotsOnTarget),
      corners: round1(corners), cardsAvg: round1(cardsAvg), possession: round1(possession),
      injuries
    };
    teamStatsCache.set(cacheKey, stats);
    return stats;
  }

  // Historial entre selecciones (H2H) simulado de forma determinista
  function getH2H(homeName, awayName) {
    const rng = rngFor('h2h', homeName, awayName);
    const n = 2 + Math.floor(rng() * 3); // 2 a 4 precedentes
    const results = [];
    const homeElo = (TEAM_META[homeName]?.rating.elo) || 55;
    const awayElo = (TEAM_META[awayName]?.rating.elo) || 55;
    for (let i = 0; i < n; i++) {
      const r = rng();
      const winProbHome = clamp(0.33 + (homeElo - awayElo) / 160, 0.12, 0.72);
      let hg, ag;
      if (r < winProbHome) { hg = Math.ceil(randRange(rng, 1, 3)); ag = Math.floor(randRange(rng, 0, hg)); }
      else if (r < winProbHome + 0.22) { hg = Math.round(randRange(rng, 0, 2)); ag = hg; }
      else { ag = Math.ceil(randRange(rng, 1, 3)); hg = Math.floor(randRange(rng, 0, ag)); }
      const yearsAgo = (n - i) * randRange(rng, 1.5, 4);
      results.push({ year: Math.round(2026 - yearsAgo), home: homeName, away: awayName, hg, ag });
    }
    return results;
  }

  /* =========================================================================
     6. MOTOR DE PREDICCIÓN (distribución de Poisson + scoring de confianza)
     ========================================================================= */

  function buildScoreMatrix(lambdaHome, lambdaAway) {
    const n = MODEL.MAX_GOALS;
    const matrix = [];
    for (let i = 0; i <= n; i++) {
      const row = [];
      for (let j = 0; j <= n; j++) {
        row.push(poissonPMF(i, lambdaHome) * poissonPMF(j, lambdaAway));
      }
      matrix.push(row);
    }
    return matrix;
  }

  function analyzeGoalMarkets(matrix) {
    const n = MODEL.MAX_GOALS;
    let pHome = 0, pDraw = 0, pAway = 0;
    let pZeroZero = matrix[0][0];
    let pOver = { '0.5': 0, '1.5': 0, '2.5': 0, '3.5': 0 };
    const scorelines = [];

    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const p = matrix[i][j];
        if (i > j) pHome += p; else if (i === j) pDraw += p; else pAway += p;
        const total = i + j;
        if (total > 0.5) pOver['0.5'] += p;
        if (total > 1.5) pOver['1.5'] += p;
        if (total > 2.5) pOver['2.5'] += p;
        if (total > 3.5) pOver['3.5'] += p;
        scorelines.push({ h: i, a: j, p });
      }
    }
    const pHomeZero = matrix.reduce((s, row) => s + row[0], 0);
    const pAwayZero = matrix[0].reduce((s, v) => s + v, 0);
    const pBtts = 1 - (pHomeZero + pAwayZero - pZeroZero);

    scorelines.sort((a, b) => b.p - a.p);

    return {
      pHome, pDraw, pAway, pOver, pBtts,
      topScorelines: scorelines.slice(0, 3)
    };
  }

  function poissonOverProb(lambda, threshold) {
    // P(X > threshold) para una variable de Poisson de media lambda
    let pUnder = 0;
    for (let k = 0; k <= Math.floor(threshold); k++) pUnder += poissonPMF(k, lambda);
    return clamp(1 - pUnder, 0.01, 0.99);
  }

  function analyzeMatch(fixture, liveOddsMap, refreshSalt) {
    const home = getTeamStats(fixture.home, refreshSalt);
    const away = getTeamStats(fixture.away, refreshSalt);

    // --- Goles esperados (lambda) ---
    const attHome = home.xgFor / MODEL.LEAGUE_AVG_XG;
    const defHome = home.xgAgainst / MODEL.LEAGUE_AVG_XG;
    const attAway = away.xgFor / MODEL.LEAGUE_AVG_XG;
    const defAway = away.xgAgainst / MODEL.LEAGUE_AVG_XG;

    let lambdaHome = MODEL.LEAGUE_AVG_XG * attHome * defAway * MODEL.HOME_ADV;
    let lambdaAway = MODEL.LEAGUE_AVG_XG * attAway * defHome * MODEL.AWAY_PENALTY;
    lambdaHome = clamp(lambdaHome, 0.3, 3.6);
    lambdaAway = clamp(lambdaAway, 0.25, 3.3);

    const matrix = buildScoreMatrix(lambdaHome, lambdaAway);
    const goals = analyzeGoalMarkets(matrix);

    // --- Córners ---
    const expCornersHome = round1(home.corners * 1.05);
    const expCornersAway = round1(away.corners * 0.95);
    const totalCornersLambda = expCornersHome + expCornersAway;
    const corners = {
      home: expCornersHome, away: expCornersAway, total: round1(totalCornersLambda),
      over85: poissonOverProb(totalCornersLambda, 8.5),
      over95: poissonOverProb(totalCornersLambda, 9.5),
      over105: poissonOverProb(totalCornersLambda, 10.5)
    };

    // --- Tarjetas ---
    const totalCardsLambda = home.cardsAvg + away.cardsAvg;
    const cards = {
      home: home.cardsAvg, away: away.cardsAvg, total: round1(totalCardsLambda),
      over25: poissonOverProb(totalCardsLambda, 2.5),
      over35: poissonOverProb(totalCardsLambda, 3.5),
      over45: poissonOverProb(totalCardsLambda, 4.5)
    };

    // --- Primer goleador probable (combina peso del jugador y goles esperados del equipo) ---
    const scorerPool = [];
    [[home, lambdaHome], [away, lambdaAway]].forEach(([team, lambda]) => {
      team.players.forEach(([name, weight]) => {
        scorerPool.push({ name, team: team.code, prob: clamp(weight * (lambda / 1.4), 0.02, 0.55) });
      });
    });
    scorerPool.sort((a, b) => b.prob - a.prob);

    // --- H2H ---
    const h2h = getH2H(fixture.home, fixture.away);

    // --- Cuotas: en vivo si están disponibles, si no, simuladas con margen de casa ---
    const liveKey = `${fixture.home}|${fixture.away}`;
    const live = liveOddsMap && liveOddsMap[liveKey];
    const odds = live
      ? { home: live.home, draw: live.draw, away: live.away, source: live.bookmaker || 'Bet365 (en vivo)', isLive: true }
      : simulateBookOdds({ home: goals.pHome, draw: goals.pDraw, away: goals.pAway }, fixture.id, refreshSalt);

    // --- Value bets (1X2 + mercados de goles/córners/tarjetas) ---
    const valueBets = buildValueBets(fixture, goals, corners, cards, odds);

    // --- Índice de confianza (0-100) ---
    const sortedProbs = [goals.pHome, goals.pDraw, goals.pAway].sort((a, b) => b - a);
    const margin = sortedProbs[0] - sortedProbs[1];                 // separación entre 1ª y 2ª opción
    const formVariance = formConsistency(home.form) * formConsistency(away.form); // 0-1, más alto = forma más consistente
    const dataQuality = 0.92; // fijo: el modelo siempre dispone del set completo de variables simuladas/reales
    const bestBookProb = Math.max(1 / odds.home, 1 / odds.draw, 1 / odds.away);
    const bestModelProb = sortedProbs[0];
    const oddsAgreement = 1 - clamp(Math.abs(bestModelProb - bestBookProb), 0, 1);

    const confidence = clamp(
      margin * 100 * 0.50 +
      formVariance * 100 * 0.20 +
      dataQuality * 100 * 0.15 +
      oddsAgreement * 100 * 0.15,
      5, 97
    );

    const bestValueBet = valueBets.reduce((best, vb) => (vb.ev > (best?.ev ?? -999) ? vb : best), null);

    let risk;
    if (confidence >= 72 && bestValueBet && bestValueBet.ev > 4) risk = 'low';
    else if (confidence >= 50) risk = 'medium';
    else risk = 'high';

    const predictedOutcome = goals.pHome > goals.pAway
      ? (goals.pHome > goals.pDraw ? 'home' : 'draw')
      : (goals.pAway > goals.pDraw ? 'away' : 'draw');

    return {
      fixture, home, away, lambdaHome: round2(lambdaHome), lambdaAway: round2(lambdaAway),
      goals, corners, cards, scorerPool, h2h, odds, valueBets,
      confidence: Math.round(confidence), risk, bestValueBet, predictedOutcome
    };
  }

  // Consistencia de la forma reciente: 1 = muy consistente (todo victorias o
  // todo derrotas), 0 = totalmente irregular. Usado como proxy de fiabilidad.
  function formConsistency(form) {
    const pts = form.map(f => (f.result === 'W' ? 3 : f.result === 'D' ? 1 : 0));
    const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
    const variance = pts.reduce((a, b) => a + (b - mean) ** 2, 0) / pts.length;
    return clamp(1 - variance / 4.5, 0.15, 1);
  }

  /* =========================================================================
     7. CUOTAS Y VALUE BETS
     ========================================================================= */

  // Simula cuotas de un "bookmaker" a partir de las probabilidades del modelo:
  // añade ruido (la casa no opina exactamente igual que el modelo) y el
  // margen/overround típico de cualquier casa de apuestas real.
  function simulateBookOdds(modelProbs, matchId, refreshSalt) {
    const rng = rngFor('odds', matchId, refreshSalt);
    const noisy = {};
    let sum = 0;
    Object.entries(modelProbs).forEach(([k, p]) => {
      const noise = randRange(rng, 0.90, 1.12);
      noisy[k] = clamp(p * noise, 0.02, 0.95);
      sum += noisy[k];
    });
    const out = { isLive: false, source: 'Simulado (modo demo)' };
    Object.entries(noisy).forEach(([k, p]) => {
      const normalized = (p / sum) * MODEL.BOOK_MARGIN; // reintroduce el margen de la casa
      out[k] = round2(1 / normalized);
    });
    return out;
  }

  function impliedProb(odds) { return 1 / odds; }
  function fairOdds(prob) { return prob > 0.001 ? round2(1 / prob) : 99; }
  function calcEdge(modelProb, bookOdds) { return (modelProb - impliedProb(bookOdds)) * 100; }
  function calcEV(modelProb, bookOdds) { return (modelProb * bookOdds - 1) * 100; }

  function buildValueBets(fixture, goals, corners, cards, odds) {
    const bets = [];
    const push = (market, selection, prob, bookOdds) => {
      bets.push({
        matchId: fixture.id, market, selection,
        prob, bookOdds, fairOdds: fairOdds(prob),
        edge: calcEdge(prob, bookOdds), ev: calcEV(prob, bookOdds)
      });
    };

    push('1X2', `Gana ${fixture.home}`, goals.pHome, odds.home);
    push('1X2', 'Empate', goals.pDraw, odds.draw);
    push('1X2', `Gana ${fixture.away}`, goals.pAway, odds.away);

    // Mercados de goles: cuota simulada propia (overround estándar) ya que
    // no todas las casas publican líneas de goles para fase de grupos.
    ['0.5', '1.5', '2.5', '3.5'].forEach(line => {
      const prob = goals.pOver[line];
      const bookOdds = round2(1 / (prob * MODEL.BOOK_MARGIN));
      push('goals', `Más de ${line} goles`, prob, bookOdds);
    });

    const bttsOdds = round2(1 / (goals.pBtts * MODEL.BOOK_MARGIN));
    push('btts', 'Ambos equipos marcan', goals.pBtts, bttsOdds);

    push('corners', 'Más de 8.5 córners', corners.over85, round2(1 / (corners.over85 * MODEL.BOOK_MARGIN)));
    push('corners', 'Más de 9.5 córners', corners.over95, round2(1 / (corners.over95 * MODEL.BOOK_MARGIN)));

    push('cards', 'Más de 3.5 tarjetas', cards.over35, round2(1 / (cards.over35 * MODEL.BOOK_MARGIN)));

    const topScore = goals.topScorelines[0];
    push('correct_score', `Resultado exacto ${topScore.h}-${topScore.a}`, topScore.p, round2(1 / (topScore.p * MODEL.BOOK_MARGIN)));

    return bets;
  }

  /* =========================================================================
     8. ESTADO DE LA APP Y RENDERIZADO
     ========================================================================= */
  const App = {
    analyses: [],          // resultado de analyzeMatch() por partido
    liveOddsMap: null,
    refreshSalt: 'v1',
    filters: { market: 'all', date: 'all', search: '', sort: 'confidence' },
    chartConfidence: null, chartEV: null, chartRisk: null
  };

  async function loadAllData() {
    setRefreshing(true);
    const [liveFixtures, liveOdds] = await Promise.all([tryFetchLiveFixtures(), tryFetchLiveOdds()]);
    const fixtures = liveFixtures || FALLBACK_FIXTURES;
    App.liveOddsMap = liveOdds;
    App.usingLiveFixtures = !!liveFixtures;
    App.usingLiveOdds = !!liveOdds;
    App.refreshSalt = String(Date.now()); // cada actualización mueve ligeramente las cuotas simuladas

    App.analyses = fixtures.map(f => analyzeMatch(f, liveOdds, App.refreshSalt));
    renderLiveBanner();
    populateDateFilter();
    renderAll();
    setRefreshing(false);
  }

  function setRefreshing(isLoading) {
    const btn = document.getElementById('refreshBtn');
    btn.classList.toggle('is-loading', isLoading);
    btn.disabled = isLoading;
  }

  function renderLiveBanner() {
    const banner = document.getElementById('liveBanner');
    if (App.usingLiveFixtures || App.usingLiveOdds) {
      banner.textContent = `🟢 Datos en vivo activos — ${App.usingLiveFixtures ? 'calendario real (football-data.org)' : ''}${App.usingLiveFixtures && App.usingLiveOdds ? ' · ' : ''}${App.usingLiveOdds ? 'cuotas reales (' + (App.analyses[0]?.odds?.source || 'The Odds API') + ')' : ''}`;
      banner.classList.remove('hidden');
    } else {
      banner.textContent = '🟡 Modo demo: calendario real del Mundial 2026 con estadísticas y cuotas simuladas. Configura tus claves de API gratuitas (⚙) para datos 100% en vivo.';
      banner.classList.remove('hidden');
    }
  }

  function populateDateFilter() {
    const sel = document.getElementById('dateFilter');
    const days = [...new Set(App.analyses.map(a => dateKey(a.fixture.date)))];
    // Ordena por fecha real, no alfabéticamente
    days.sort((a, b) => new Date(App.analyses.find(x => dateKey(x.fixture.date) === a).fixture.date) -
                         new Date(App.analyses.find(x => dateKey(x.fixture.date) === b).fixture.date));
    sel.innerHTML = `<option value="all">Todas las jornadas</option>` +
      days.map(d => {
        const count = App.analyses.filter(a => dateKey(a.fixture.date) === d).length;
        return `<option value="${d}">${d} (${count} partido${count > 1 ? 's' : ''})</option>`;
      }).join('');

    // Selecciona por defecto el día actual si hay partidos, si no el próximo disponible
    const todayKey = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit' });
    if (days.includes(todayKey)) sel.value = todayKey;
    else {
      const next = App.analyses
        .filter(a => new Date(a.fixture.date) >= new Date())
        .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date))[0];
      sel.value = next ? dateKey(next.fixture.date) : 'all';
    }
    App.filters.date = sel.value;
  }

  function getFilteredAnalyses() {
    let list = App.analyses.slice();
    if (App.filters.date !== 'all') list = list.filter(a => dateKey(a.fixture.date) === App.filters.date);
    if (App.filters.search) {
      const q = App.filters.search.toLowerCase();
      list = list.filter(a => a.fixture.home.toLowerCase().includes(q) || a.fixture.away.toLowerCase().includes(q));
    }
    const sortKey = App.filters.sort;
    list.sort((a, b) => {
      if (sortKey === 'time') return new Date(a.fixture.date) - new Date(b.fixture.date);
      if (sortKey === 'ev') return (b.bestValueBet?.ev ?? -999) - (a.bestValueBet?.ev ?? -999);
      return b.confidence - a.confidence;
    });
    return list;
  }

  function renderAll() {
    const list = getFilteredAnalyses();
    renderDashboardStats(list);
    renderTicker();
    renderMatchesGrid(list);
    renderBestBets();
    renderCharts(list);
  }

  function renderDashboardStats(list) {
    const allBets = App.analyses.flatMap(a => a.valueBets);
    const positiveEV = allBets.filter(b => b.ev > 2);
    const avgEV = allBets.length ? allBets.reduce((s, b) => s + b.ev, 0) / allBets.length : 0;
    const avgConfidence = list.length ? list.reduce((s, a) => s + a.confidence, 0) / list.length : 0;

    const cards = [
      { label: 'Partidos analizados', value: list.length, sub: App.filters.date === 'all' ? 'todas las jornadas' : App.filters.date, accent: 'var(--accent-blue)' },
      { label: 'Value bets detectadas', value: positiveEV.length, sub: 'EV > +2% en todo el día', accent: 'var(--accent-pitch)' },
      { label: 'EV medio del mercado', value: fmtSigned(avgEV, '%'), sub: 'sobre todas las apuestas evaluadas', accent: avgEV >= 0 ? 'var(--accent-pitch)' : 'var(--accent-red)' },
      { label: 'Confianza media IA', value: `${Math.round(avgConfidence)}%`, sub: 'índice 0-100 del modelo', accent: 'var(--accent-gold)' }
    ];

    document.getElementById('dashboardStats').innerHTML = cards.map(c => `
      <div class="stat-card" style="--stat-accent:${c.accent}">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-sub">${c.sub}</div>
      </div>`).join('');
  }

  function renderTicker() {
    const allBets = App.analyses.flatMap(a => {
      const f = a.fixture;
      return a.valueBets.map(b => ({ ...b, label: `${TEAM_META[f.home]?.code || f.home} vs ${TEAM_META[f.away]?.code || f.away}` }));
    }).filter(b => Math.abs(b.ev) > 1).sort((a, b) => b.ev - a.ev).slice(0, 14);

    const track = document.getElementById('tickerTrack');
    if (!allBets.length) { track.innerHTML = '<span class="ticker-item">Sin value bets destacadas en este momento.</span>'; return; }
    const itemsHtml = allBets.map(b => `
      <span class="ticker-item">⚽ ${b.label} — ${b.selection} @ ${fmtOdds(b.bookOdds)}
        <span class="${b.ev >= 0 ? 'tk-ev-pos' : 'tk-ev-neg'}">EV ${fmtSigned(b.ev, '%')}</span>
        <span class="tk-sep">·</span>
      </span>`).join('');
    track.innerHTML = itemsHtml + itemsHtml; // duplicado para que el scroll continuo no deje huecos
  }

  function riskLabel(risk) { return { low: 'BAJO', medium: 'MEDIO', high: 'ALTO' }[risk]; }

  function renderMatchesGrid(list) {
    const grid = document.getElementById('matchesGrid');
    document.getElementById('matchCount').textContent = `${list.length} partido${list.length !== 1 ? 's' : ''}`;
    document.getElementById('emptyState').classList.toggle('hidden', list.length > 0);

    grid.innerHTML = list.map(a => {
      const f = a.fixture;
      const homeM = TEAM_META[f.home] || {}; const awayM = TEAM_META[f.away] || {};
      const outcomeLabel = a.predictedOutcome === 'home' ? `Victoria ${f.home}` : a.predictedOutcome === 'away' ? `Victoria ${f.away}` : 'Empate';
      const best = a.bestValueBet;
      return `
      <article class="match-card" data-id="${f.id}">
        <div class="match-card-top">
          <span>${formatKickoff(f.date)} · ${f.stadium}</span>
          <span class="badge-group">
            <span class="badge-tag">Grupo ${f.group}</span>
            ${best && best.ev > 4 ? '<span class="badge-tag badge-value">VALUE</span>' : ''}
          </span>
        </div>

        <div class="teams-row">
          <div class="team-block home">
            <span class="team-flag">${homeM.flag || '🏳️'}</span>
            <span class="team-name">${f.home}</span>
            <span class="team-code">${homeM.code || ''}</span>
          </div>
          <div class="vs-block">
            <div class="confidence-dial" style="--pct:${a.confidence}" data-pct="${a.confidence}"></div>
            <span class="vs-label">IA</span>
          </div>
          <div class="team-block away">
            <span class="team-flag">${awayM.flag || '🏳️'}</span>
            <span class="team-name">${f.away}</span>
            <span class="team-code">${awayM.code || ''}</span>
          </div>
        </div>

        <div class="odds-row">
          <div class="odds-chip"><div class="odds-chip-label">1 · ${homeM.code || ''}</div><div class="odds-chip-value">${fmtOdds(a.odds.home)}</div></div>
          <div class="odds-chip"><div class="odds-chip-label">X</div><div class="odds-chip-value">${fmtOdds(a.odds.draw)}</div></div>
          <div class="odds-chip"><div class="odds-chip-label">2 · ${awayM.code || ''}</div><div class="odds-chip-value">${fmtOdds(a.odds.away)}</div></div>
        </div>

        <div style="font-size:0.82rem;color:var(--text-secondary)">
          Predicción IA: <strong style="color:var(--text-primary)">${outcomeLabel}</strong>
        </div>

        <div class="match-card-footer">
          <div class="best-pick">
            <span class="best-pick-label">Mejor apuesta</span>
            <span class="best-pick-value">${best ? best.selection : '—'}</span>
          </div>
          <span class="ev-tag ${best && best.ev >= 0 ? 'ev-pos' : 'ev-neg'}">${best ? fmtSigned(best.ev, '%') : ''}</span>
          <span class="risk-pill risk-${a.risk}">${riskLabel(a.risk)}</span>
        </div>
      </article>`;
    }).join('');

    grid.querySelectorAll('.match-card').forEach(card => {
      card.addEventListener('click', () => openMatchModal(card.dataset.id));
    });
  }

  function renderBestBets() {
    const marketFilter = App.filters.market;
    let bets = App.analyses.flatMap(a => a.valueBets.map(b => ({ ...b, fixture: a.fixture, riskOfMatch: a.risk })));
    if (marketFilter !== 'all') bets = bets.filter(b => b.market === marketFilter);
    bets.sort((a, b) => b.ev - a.ev);
    bets = bets.slice(0, 12);

    document.getElementById('bestBetsBody').innerHTML = bets.map(b => `
      <tr class="${b.ev > 4 ? 'row-value' : ''}">
        <td>${b.fixture.home} vs ${b.fixture.away}</td>
        <td>${marketDisplayName(b.market)}</td>
        <td>${b.selection}</td>
        <td class="mono">${fmtPct(b.prob)}</td>
        <td class="mono">${fmtOdds(b.bookOdds)}</td>
        <td class="mono">${fmtOdds(b.fairOdds)}</td>
        <td class="mono">${fmtSigned(b.edge, 'pp')}</td>
        <td class="mono ${b.ev >= 0 ? 'ev-pos' : 'ev-neg'}">${fmtSigned(b.ev, '%')}</td>
        <td><span class="risk-pill risk-${b.riskOfMatch}">${riskLabel(b.riskOfMatch)}</span></td>
      </tr>`).join('') || `<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">Sin apuestas para este filtro.</td></tr>`;
  }

  function marketDisplayName(key) {
    return {
      '1X2': 'Resultado 1X2', goals: 'Total goles', btts: 'Ambos marcan',
      corners: 'Córners', cards: 'Tarjetas', correct_score: 'Resultado exacto'
    }[key] || key;
  }

  function renderCharts(list) {
    if (typeof Chart === 'undefined') return; // Chart.js aún cargando vía defer

    const labels = list.map(a => `${TEAM_META[a.fixture.home]?.code || a.fixture.home}-${TEAM_META[a.fixture.away]?.code || a.fixture.away}`);

    const baseOptions = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#aab2c5', font: { size: 10 } }, grid: { color: '#1a2030' } },
        y: { ticks: { color: '#aab2c5', font: { size: 10 } }, grid: { color: '#1a2030' } }
      }
    };

    App.chartConfidence?.destroy();
    App.chartConfidence = new Chart(document.getElementById('chartConfidence'), {
      type: 'bar',
      data: { labels, datasets: [{ data: list.map(a => a.confidence), backgroundColor: list.map(a => a.confidence >= 70 ? '#14d896' : a.confidence >= 50 ? '#ffb020' : '#ff5468'), borderRadius: 4 }] },
      options: baseOptions
    });

    const evBets = App.analyses.flatMap(a => a.valueBets.map(b => ({ ...b, label: `${TEAM_META[a.fixture.home]?.code || ''}-${TEAM_META[a.fixture.away]?.code || ''}: ${b.selection}` })))
      .sort((a, b) => b.ev - a.ev).slice(0, 8);
    App.chartEV?.destroy();
    App.chartEV = new Chart(document.getElementById('chartEV'), {
      type: 'bar',
      data: { labels: evBets.map(b => b.label), datasets: [{ data: evBets.map(b => round1(b.ev)), backgroundColor: evBets.map(b => b.ev >= 0 ? '#14d896' : '#ff5468'), borderRadius: 4 }] },
      options: { ...baseOptions, indexAxis: 'y' }
    });

    const riskCounts = { low: 0, medium: 0, high: 0 };
    App.analyses.forEach(a => riskCounts[a.risk]++);
    App.chartRisk?.destroy();
    App.chartRisk = new Chart(document.getElementById('chartRisk'), {
      type: 'doughnut',
      data: {
        labels: ['Riesgo bajo', 'Riesgo medio', 'Riesgo alto'],
        datasets: [{ data: [riskCounts.low, riskCounts.medium, riskCounts.high], backgroundColor: ['#14d896', '#ffb020', '#ff5468'], borderWidth: 0 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: '#aab2c5', font: { size: 10 } } } } }
    });
  }

  /* =========================================================================
     MODAL DE DETALLE DE PARTIDO
     ========================================================================= */
  function openMatchModal(matchId) {
    const a = App.analyses.find(x => x.fixture.id === matchId);
    if (!a) return;
    const f = a.fixture;
    const homeM = TEAM_META[f.home] || {}; const awayM = TEAM_META[f.away] || {};

    const statRow = (label, hVal, aVal, max) => `
      <div class="stat-compare-row">
        <div class="v-home">${hVal}</div>
        <div class="v-label">${label}</div>
        <div class="v-away">${aVal}</div>
      </div>
      <div class="bar-track">
        <div class="bar-fill-home" style="width:${(hVal / max) * 50}%;margin-left:${50 - (hVal / max) * 50}%"></div>
        <div class="bar-fill-away" style="width:${(aVal / max) * 50}%"></div>
      </div>`;

    const probRow = (label, prob) => `
      <div class="prob-bar-row">
        <span class="pb-label">${label}</span>
        <div class="prob-bar-track"><div class="prob-bar-fill" style="width:${prob * 100}%"></div></div>
        <span class="pb-value">${fmtPct(prob)}</span>
      </div>`;

    const marketCard = (title, pick, prob, odds, ev) => `
      <div class="market-card">
        <div class="mc-title">${title}</div>
        <div class="mc-pick">${pick}</div>
        <div class="mc-foot"><span>${fmtPct(prob)} · cuota ${fmtOdds(odds)}</span><span class="${ev >= 0 ? 'ev-pos' : 'ev-neg'}">EV ${fmtSigned(ev, '%')}</span></div>
      </div>`;

    const formIcons = (form) => form.map(r => `<span class="badge-tag" style="color:${r.result === 'W' ? 'var(--accent-pitch)' : r.result === 'D' ? 'var(--accent-amber)' : 'var(--accent-red)'}">${r.result} ${r.gf}-${r.ga}</span>`).join(' ');

    const findBet = (sel) => a.valueBets.find(b => b.selection === sel);
    const bttsBet = a.valueBets.find(b => b.market === 'btts');
    const scoreBet = a.valueBets.find(b => b.market === 'correct_score');

    document.getElementById('modalContent').innerHTML = `
      <div class="modal-header">
        <div>
          <div class="modal-teams">${homeM.flag || ''} ${f.home} <span style="color:var(--text-muted)">vs</span> ${f.away} ${awayM.flag || ''}</div>
          <div class="modal-meta">${formatKickoff(f.date)} · ${f.stadium}, ${f.city} · Grupo ${f.group}</div>
        </div>
        <div class="confidence-dial" style="--pct:${a.confidence}" data-pct="${a.confidence}"></div>
      </div>

      <div class="tabs">
        <button class="tab-btn active" data-tab="resumen">Resumen</button>
        <button class="tab-btn" data-tab="stats">Estadísticas</button>
        <button class="tab-btn" data-tab="mercados">Mercados</button>
        <button class="tab-btn" data-tab="h2h">H2H</button>
        <button class="tab-btn" data-tab="plantilla">Plantilla</button>
      </div>

      <div class="tab-panel active" data-panel="resumen">
        ${probRow(`Gana ${f.home}`, a.goals.pHome)}
        ${probRow('Empate', a.goals.pDraw)}
        ${probRow(`Gana ${f.away}`, a.goals.pAway)}
        <p style="margin-top:0.8rem;font-size:0.85rem;color:var(--text-secondary)">
          Goles esperados (xG modelo): <strong style="color:var(--text-primary)">${a.lambdaHome}</strong> — <strong style="color:var(--text-primary)">${a.lambdaAway}</strong>.
          Resultado exacto más probable: <strong style="color:var(--text-primary)">${a.goals.topScorelines[0].h}-${a.goals.topScorelines[0].a}</strong> (${fmtPct(a.goals.topScorelines[0].p)}).
        </p>
        <p style="margin-top:0.5rem;font-size:0.85rem;color:var(--text-secondary)">
          Nivel de riesgo de la recomendación: <span class="risk-pill risk-${a.risk}">${riskLabel(a.risk)}</span>
          ${a.bestValueBet ? ` · Mejor value bet: <strong style="color:var(--accent-pitch)">${a.bestValueBet.selection}</strong> (EV ${fmtSigned(a.bestValueBet.ev, '%')})` : ''}
        </p>
      </div>

      <div class="tab-panel" data-panel="stats">
        ${statRow('Forma (últ. 5, pts)', a.home.points5, a.away.points5, 15)}
        ${statRow('Goles a favor (5p)', a.home.goalsFor5, a.away.goalsFor5, 14)}
        ${statRow('Goles en contra (5p)', a.home.goalsAgainst5, a.away.goalsAgainst5, 14)}
        ${statRow('xG por partido', a.home.xgFor, a.away.xgFor, 3)}
        ${statRow('xGA por partido', a.home.xgAgainst, a.away.xgAgainst, 3)}
        ${statRow('Tiros totales', a.home.shotsTotal, a.away.shotsTotal, 24)}
        ${statRow('Tiros a puerta', a.home.shotsOnTarget, a.away.shotsOnTarget, 12)}
        ${statRow('Córners por partido', a.home.corners, a.away.corners, 10)}
        ${statRow('Tarjetas por partido', a.home.cardsAvg, a.away.cardsAvg, 5)}
        ${statRow('Posesión (%)', a.home.possession, a.away.possession, 70)}
        <p style="margin-top:0.6rem;font-size:0.78rem;color:var(--text-muted)">Forma reciente — ${f.home}: ${formIcons(a.home.form)}</p>
        <p style="margin-top:0.3rem;font-size:0.78rem;color:var(--text-muted)">Forma reciente — ${f.away}: ${formIcons(a.away.form)}</p>
      </div>

      <div class="tab-panel" data-panel="mercados">
        <div class="market-grid">
          ${marketCard('Más de 0.5 goles', 'Sí', a.goals.pOver['0.5'], findBet('Más de 0.5 goles').bookOdds, findBet('Más de 0.5 goles').ev)}
          ${marketCard('Más de 1.5 goles', 'Sí', a.goals.pOver['1.5'], findBet('Más de 1.5 goles').bookOdds, findBet('Más de 1.5 goles').ev)}
          ${marketCard('Más de 2.5 goles', 'Sí', a.goals.pOver['2.5'], findBet('Más de 2.5 goles').bookOdds, findBet('Más de 2.5 goles').ev)}
          ${marketCard('Más de 3.5 goles', 'Sí', a.goals.pOver['3.5'], findBet('Más de 3.5 goles').bookOdds, findBet('Más de 3.5 goles').ev)}
          ${marketCard('Ambos marcan', 'Sí', a.goals.pBtts, bttsBet.bookOdds, bttsBet.ev)}
          ${marketCard('Córners totales', 'Más de 8.5', a.corners.over85, findBet('Más de 8.5 córners').bookOdds, findBet('Más de 8.5 córners').ev)}
          ${marketCard('Tarjetas totales', 'Más de 3.5', a.cards.over35, findBet('Más de 3.5 tarjetas').bookOdds, findBet('Más de 3.5 tarjetas').ev)}
          ${marketCard('Resultado exacto', `${a.goals.topScorelines[0].h}-${a.goals.topScorelines[0].a}`, a.goals.topScorelines[0].p, scoreBet.bookOdds, scoreBet.ev)}
          ${marketCard('Primer goleador probable', `${a.scorerPool[0].name} (${a.scorerPool[0].team})`, a.scorerPool[0].prob, fairOdds(a.scorerPool[0].prob), 0)}
        </div>
      </div>

      <div class="tab-panel" data-panel="h2h">
        <div class="h2h-list">
          ${a.h2h.map(g => `<div class="h2h-row"><span>${g.year} · ${g.home} vs ${g.away}</span><span class="h2h-score">${g.hg}-${g.ag}</span></div>`).join('')}
        </div>
        <p style="margin-top:0.7rem;font-size:0.76rem;color:var(--text-muted)">Historial simulado a partir del nivel relativo de ambas selecciones (no son resultados oficiales).</p>
      </div>

      <div class="tab-panel" data-panel="plantilla">
        <p class="lineup-note">⚠️ Alineaciones, lesiones y sanciones son una estimación ilustrativa del modelo, no la convocatoria oficial confirmada por el cuerpo técnico.</p>
        <h4 style="margin-bottom:0.5rem;font-size:0.9rem">${f.home}</h4>
        ${a.home.players.map(([name, w]) => `<div class="player-row"><span class="player-name">${name}</span><span class="player-meta">Tiros a puerta est. ${round1(w * a.home.shotsOnTarget * 2.2)} · prob. gol ${fmtPct(a.scorerPool.find(s => s.name === name)?.prob || 0)}</span></div>`).join('')}
        ${a.home.injuries.map(inj => `<div class="player-row"><span class="player-name" style="color:var(--accent-red)">${inj.name}</span><span class="player-meta">${inj.status}</span></div>`).join('')}
        <h4 style="margin:1rem 0 0.5rem;font-size:0.9rem">${f.away}</h4>
        ${a.away.players.map(([name, w]) => `<div class="player-row"><span class="player-name">${name}</span><span class="player-meta">Tiros a puerta est. ${round1(w * a.away.shotsOnTarget * 2.2)} · prob. gol ${fmtPct(a.scorerPool.find(s => s.name === name)?.prob || 0)}</span></div>`).join('')}
        ${a.away.injuries.map(inj => `<div class="player-row"><span class="player-name" style="color:var(--accent-red)">${inj.name}</span><span class="player-meta">${inj.status}</span></div>`).join('')}
      </div>
    `;

    document.getElementById('modalContent').querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('modalContent').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('modalContent').querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('modalContent').querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`).classList.add('active');
      });
    });

    document.getElementById('matchModal').classList.remove('hidden');
  }

  /* =========================================================================
     9. EVENTOS DE INTERFAZ
     ========================================================================= */
  function initEvents() {
    document.getElementById('refreshBtn').addEventListener('click', loadAllData);

    document.getElementById('searchInput').addEventListener('input', (e) => {
      App.filters.search = e.target.value.trim();
      renderMatchesGrid(getFilteredAnalyses());
    });

    document.getElementById('marketFilter').addEventListener('change', (e) => {
      App.filters.market = e.target.value;
      renderBestBets();
    });

    document.getElementById('dateFilter').addEventListener('change', (e) => {
      App.filters.date = e.target.value;
      renderAll();
    });

    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        App.filters.sort = btn.dataset.sort;
        renderMatchesGrid(getFilteredAnalyses());
      });
    });

    // Modal de partido
    document.getElementById('modalClose').addEventListener('click', () => document.getElementById('matchModal').classList.add('hidden'));
    document.getElementById('matchModal').addEventListener('click', (e) => { if (e.target.id === 'matchModal') e.currentTarget.classList.add('hidden'); });

    // Modal de configuración
    const settingsModal = document.getElementById('settingsModal');
    document.getElementById('settingsBtn').addEventListener('click', () => {
      document.getElementById('oddsApiKey').value = Settings.oddsApiKey;
      document.getElementById('footballDataApiKey').value = Settings.footballDataApiKey;
      document.getElementById('liveModeToggle').checked = Settings.liveMode;
      settingsModal.classList.remove('hidden');
    });
    document.getElementById('settingsClose').addEventListener('click', () => settingsModal.classList.add('hidden'));
    settingsModal.addEventListener('click', (e) => { if (e.target.id === 'settingsModal') settingsModal.classList.add('hidden'); });

    document.getElementById('saveSettingsBtn').addEventListener('click', () => {
      Settings.save(
        document.getElementById('oddsApiKey').value.trim(),
        document.getElementById('footballDataApiKey').value.trim(),
        document.getElementById('liveModeToggle').checked
      );
      settingsModal.classList.add('hidden');
      loadAllData();
    });
    document.getElementById('clearSettingsBtn').addEventListener('click', () => {
      Settings.clear();
      document.getElementById('oddsApiKey').value = '';
      document.getElementById('footballDataApiKey').value = '';
      document.getElementById('liveModeToggle').checked = false;
    });

    // Cerrar modales con Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('matchModal').classList.add('hidden');
        settingsModal.classList.add('hidden');
      }
    });
  }

  /* =========================================================================
     10. INICIALIZACIÓN
     ========================================================================= */
  document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    loadAllData();
  });

})();
