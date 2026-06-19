/* ===========================================================================
   MUNDIAL26 AI ANALYTICS — script.js (versión reestructurada)
   ===========================================================================
   - Frontend puro (HTML + CSS + JS), pensado para GitHub Pages.
   - Integración preparada para API tipo SofaScore (fixtures y estadísticas).
   - Análisis ultra-seguro: solo mercados sencillos y probabilidad >= 75%.
   - Interfaz centrada en un único partido seleccionado por <select>.
   =========================================================================== */

(() => {
  'use strict';

  /* =========================================================================
     0. CONFIGURACIÓN GENERAL Y CLAVE DE API
     ========================================================================= */

  // Pon aquí tu clave real de la API de deportes (SofaScore, similar, proxy propio, etc.).
  // Ejemplo: const API_KEY = "abcdef123456";
  // Sustituye "TU_CLAVE_AQUI" por tu clave real cuando la tengas.
  const API_KEY = "TU_CLAVE_AQUI";

  // URL base de la API (ejemplo tipo SofaScore; ajusta al endpoint real que uses).
  const API_BASE_URL = "https://api.tu-proveedor-deportes.com/v1";

  /* =========================================================================
     1. MODELO Y CONSTANTES
     ========================================================================= */

  const MODEL = {
    LEAGUE_AVG_XG: 1.35,
    HOME_ADV: 1.10,
    AWAY_PENALTY: 0.96,
    MAX_GOALS: 6
  };

  /* =========================================================================
     2. UTILIDADES
     ========================================================================= */

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round2(v) { return Math.round(v * 100) / 100; }

  // Factoriales precalculados 0..12 para Poisson
  const FACTORIALS = [1];
  for (let i = 1; i <= 12; i++) FACTORIALS.push(FACTORIALS[i - 1] * i);

  function poissonPMF(k, lambda) {
    return (Math.exp(-lambda) * Math.pow(lambda, k)) / FACTORIALS[k];
  }

  function formatKickoff(iso) {
    const d = new Date(iso);
    return d.toLocaleString('es-ES', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function dateKeyFromDate(d) {
    return d.toLocaleDateString('es-ES', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
  }

  function dateKeyFromISO(iso) {
    return dateKeyFromDate(new Date(iso));
  }

  function starsFromProb(prob) {
    // Probabilidad 0.75–0.80 => 3 estrellas
    // 0.80–0.87 => 4 estrellas
    // >0.87 => 5 estrellas
    if (prob >= 0.87) return '⭐⭐⭐⭐⭐';
    if (prob >= 0.80) return '⭐⭐⭐⭐';
    return '⭐⭐⭐';
  }

  /* =========================================================================
     3. BASE DE DATOS LOCAL (FALLBACK / MODO DEMO)
     ========================================================================= */

  const TEAM_META = {
    'México': {
      code: 'MEX', flag: '🇲🇽',
      rating: { att: 72, def: 66, elo: 71 },
      xgFor: 1.6, xgAgainst: 1.1,
      corners: 5.8, cards: 2.3
    },
    'Sudáfrica': {
      code: 'RSA', flag: '🇿🇦',
      rating: { att: 54, def: 58, elo: 50 },
      xgFor: 1.1, xgAgainst: 1.4,
      corners: 4.2, cards: 2.0
    },
    'Catar': {
      code: 'QAT', flag: '🇶🇦',
      rating: { att: 53, def: 56, elo: 49 },
      xgFor: 1.0, xgAgainst: 1.5,
      corners: 4.0, cards: 2.1
    },
    'Suiza': {
      code: 'SUI', flag: '🇨🇭',
      rating: { att: 70, def: 76, elo: 72 },
      xgFor: 1.5, xgAgainst: 1.0,
      corners: 5.5, cards: 1.9
    },
    'Brasil': {
      code: 'BRA', flag: '🇧🇷',
      rating: { att: 91, def: 77, elo: 90 },
      xgFor: 2.1, xgAgainst: 0.9,
      corners: 6.8, cards: 2.0
    },
    'Marruecos': {
      code: 'MAR', flag: '🇲🇦',
      rating: { att: 75, def: 78, elo: 76 },
      xgFor: 1.4, xgAgainst: 0.9,
      corners: 5.2, cards: 2.4
    },
    'Haití': {
      code: 'HAI', flag: '🇭🇹',
      rating: { att: 47, def: 49, elo: 43 },
      xgFor: 0.9, xgAgainst: 1.7,
      corners: 3.8, cards: 2.6
    },
    'Escocia': {
      code: 'SCO', flag: '🏴',
      rating: { att: 61, def: 66, elo: 62 },
      xgFor: 1.2, xgAgainst: 1.2,
      corners: 4.9, cards: 2.3
    },
    'Estados Unidos': {
      code: 'USA', flag: '🇺🇸',
      rating: { att: 74, def: 71, elo: 74 },
      xgFor: 1.5, xgAgainst: 1.1,
      corners: 5.4, cards: 1.8
    },
    'Paraguay': {
      code: 'PAR', flag: '🇵🇾',
      rating: { att: 57, def: 63, elo: 56 },
      xgFor: 1.1, xgAgainst: 1.3,
      corners: 4.3, cards: 2.5
    },
    'Turquía': {
      code: 'TUR', flag: '🇹🇷',
      rating: { att: 72, def: 66, elo: 70 },
      xgFor: 1.4, xgAgainst: 1.2,
      corners: 5.0, cards: 2.7
    },
    'Australia': {
      code: 'AUS', flag: '🇦🇺',
      rating: { att: 60, def: 64, elo: 59 },
      xgFor: 1.1, xgAgainst: 1.3,
      corners: 4.6, cards: 2.2
    },
    'Corea del Sur': {
      code: 'KOR', flag: '🇰🇷',
      rating: { att: 69, def: 63, elo: 66 },
      xgFor: 1.4, xgAgainst: 1.2,
      corners: 5.1, cards: 2.1
    },
    'Canadá': {
      code: 'CAN', flag: '🇨🇦',
      rating: { att: 68, def: 64, elo: 66 },
      xgFor: 1.3, xgAgainst: 1.2,
      corners: 4.9, cards: 2.0
    }
  };

  const FALLBACK_FIXTURES = [
    { id: 'm26-1', date: '2026-06-11T19:00:00Z', group: 'A', city: 'Ciudad de México', stadium: 'Estadio Azteca', home: 'México', away: 'Sudáfrica' },
    { id: 'm26-2', date: '2026-06-13T01:00:00Z', group: 'D', city: 'Los Ángeles', stadium: 'SoFi Stadium', home: 'Estados Unidos', away: 'Paraguay' },
    { id: 'm26-3', date: '2026-06-13T19:00:00Z', group: 'B', city: 'San Francisco', stadium: "Levi's Stadium", home: 'Catar', away: 'Suiza' },
    { id: 'm26-4', date: '2026-06-13T22:00:00Z', group: 'C', city: 'Nueva Jersey', stadium: 'MetLife Stadium', home: 'Brasil', away: 'Marruecos' },
    { id: 'm26-5', date: '2026-06-14T01:00:00Z', group: 'C', city: 'Boston', stadium: 'Gillette Stadium', home: 'Haití', away: 'Escocia' },
    { id: 'm26-6', date: '2026-06-18T22:00:00Z', group: 'B', city: 'Vancouver', stadium: 'BC Place', home: 'Canadá', away: 'Catar' },
    { id: 'm26-7', date: '2026-06-19T01:00:00Z', group: 'A', city: 'Guadalajara', stadium: 'Estadio Akron', home: 'México', away: 'Corea del Sur' },
    { id: 'm26-8', date: '2026-06-19T19:00:00Z', group: 'D', city: 'Seattle', stadium: 'Lumen Field', home: 'Estados Unidos', away: 'Australia' },
    { id: 'm26-9', date: '2026-06-19T22:00:00Z', group: 'C', city: 'Boston', stadium: 'Gillette Stadium', home: 'Escocia', away: 'Marruecos' },
    { id: 'm26-10', date: '2026-06-20T01:00:00Z', group: 'C', city: 'Filadelfia', stadium: 'Lincoln Financial Field', home: 'Brasil', away: 'Haití' },
    { id: 'm26-11', date: '2026-06-20T04:00:00Z', group: 'D', city: 'San Francisco', stadium: "Levi's Stadium", home: 'Turquía', away: 'Paraguay' },
    { id: 'm26-12', date: '2026-06-24T19:00:00Z', group: 'B', city: 'Vancouver', stadium: 'BC Place', home: 'Suiza', away: 'Canadá' },
    { id: 'm26-13', date: '2026-06-24T22:00:00Z', group: 'C', city: 'Miami', stadium: 'Hard Rock Stadium', home: 'Escocia', away: 'Brasil' },
    { id: 'm26-14', date: '2026-06-24T22:00:00Z', group: 'C', city: 'Atlanta', stadium: 'Mercedes-Benz Stadium', home: 'Marruecos', away: 'Haití' },
    { id: 'm26-15', date: '2026-06-25T01:00:00Z', group: 'A', city: 'Monterrey', stadium: 'Estadio BBVA', home: 'Sudáfrica', away: 'Corea del Sur' },
    { id: 'm26-16', date: '2026-06-26T02:00:00Z', group: 'D', city: 'Los Ángeles', stadium: 'SoFi Stadium', home: 'Turquía', away: 'Estados Unidos' },
    { id: 'm26-17', date: '2026-06-26T02:00:00Z', group: 'D', city: 'San Francisco', stadium: "Levi's Stadium", home: 'Paraguay', away: 'Australia' }
  ];

  /* =========================================================================
     4. CAPA DE DATOS — INTEGRACIÓN CON API + FALLBACK LOCAL
     ========================================================================= */

  async function fetchFixturesFromApiByDate(targetDate) {
    // Esta función está preparada para una API tipo SofaScore.
    // Ajusta la URL, parámetros y parsing según tu proveedor real.
    const dateStr = targetDate.toISOString().slice(0, 10); // YYYY-MM-DD
    const url = `${API_BASE_URL}/football/matches?date=${dateStr}&apiKey=${encodeURIComponent(API_KEY)}`;

    if (!API_KEY || API_KEY === "TU_CLAVE_AQUI") {
      // Sin clave real: devolvemos null para usar fallback local.
      return null;
    }

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Adapta este mapeo a la estructura real de tu API:
      const fixtures = (data.matches || []).map((m, idx) => ({
        id: m.id ? String(m.id) : `api-${idx}`,
        date: m.kickoffTime || m.startTime || m.utcDate,
        group: m.group || '',
        city: m.venue?.city || '',
        stadium: m.venue?.name || '',
        home: m.homeTeam?.name || m.home?.name,
        away: m.awayTeam?.name || m.away?.name
      }));

      return fixtures;
    } catch (err) {
      console.warn('[MUNDIAL26] Error al obtener fixtures desde la API. Usando fallback local.', err);
      return null;
    }
  }

  function getFallbackFixturesForDate(targetDate) {
    const key = dateKeyFromDate(targetDate);
    return FALLBACK_FIXTURES.filter(f => dateKeyFromISO(f.date) === key);
  }

  async function getFixturesForDate(targetDate) {
    // 1) Intentar API real
    const apiFixtures = await fetchFixturesFromApiByDate(targetDate);
    if (apiFixtures && apiFixtures.length) {
      return { fixtures: apiFixtures, usingLive: true };
    }

    // 2) Fallback local
    const fb = getFallbackFixturesForDate(targetDate);
    return { fixtures: fb, usingLive: false };
  }

  function getTeamStats(teamName) {
    const meta = TEAM_META[teamName];
    if (!meta) {
      // Equipo desconocido: valores neutros
      return {
        name: teamName,
        code: teamName.slice(0, 3).toUpperCase(),
        flag: '🏳️',
        xgFor: 1.2,
        xgAgainst: 1.2,
        corners: 4.5,
        cards: 2.2
      };
    }
    return {
      name: teamName,
      code: meta.code,
      flag: meta.flag,
      xgFor: meta.xgFor,
      xgAgainst: meta.xgAgainst,
      corners: meta.corners,
      cards: meta.cards
    };
  }

  /* =========================================================================
     5. MOTOR DE PREDICCIÓN ULTRA-SEGURO
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

  function analyzeGoalsAndResult(matrix) {
    const n = MODEL.MAX_GOALS;
    let pHome = 0, pDraw = 0, pAway = 0;
    let pOver15 = 0, pOver25 = 0, pUnder25 = 0;

    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const p = matrix[i][j];
        const total = i + j;

        if (i > j) pHome += p;
        else if (i === j) pDraw += p;
        else pAway += p;

        if (total > 1.5) pOver15 += p;
        if (total > 2.5) pOver25 += p;
        if (total <= 2.5) pUnder25 += p;
      }
    }

    const p1X = pHome + pDraw;
    const pX2 = pDraw + pAway;

    return {
      pHome, pDraw, pAway,
      pOver15, pOver25, pUnder25,
      p1X, pX2
    };
  }

  function poissonOverProb(lambda, threshold) {
    let pUnder = 0;
    for (let k = 0; k <= Math.floor(threshold); k++) {
      pUnder += poissonPMF(k, lambda);
    }
    return clamp(1 - pUnder, 0.01, 0.99);
  }

  function buildSafeRecommendations(fixture, homeStats, awayStats, goals, corners) {
    const recs = [];

    function pushRec(type, label, prob, explanation) {
      if (prob < 0.75) return; // modo ultra-seguro: solo >= 75%
      recs.push({
        type,
        label,
        prob,
        stars: starsFromProb(prob),
        explanation
      });
    }

    // Mercados de goles (Más/Menos)
    pushRec(
      'goles',
      'Más de 1.5 goles',
      goals.pOver15,
      `El modelo estima una probabilidad del ${(goals.pOver15 * 100).toFixed(1)}% de ver al menos 2 goles. ` +
      `${homeStats.name} promedia ${homeStats.xgFor.toFixed(2)} xG a favor y ${awayStats.name} recibe ${awayStats.xgAgainst.toFixed(2)} xG por partido.`
    );

    pushRec(
      'goles',
      'Menos de 2.5 goles',
      goals.pUnder25,
      `La probabilidad de que haya 2 goles o menos es del ${(goals.pUnder25 * 100).toFixed(1)}%. ` +
      `${homeStats.name} encaja ${homeStats.xgAgainst.toFixed(2)} xG y ${awayStats.name} genera ${awayStats.xgFor.toFixed(2)} xG, lo que sugiere un partido más cerrado.`
    );

    // Doble oportunidad (sin recomendar victorias locas de equipos débiles)
    pushRec(
      'doble oportunidad',
      `1X (Gana ${homeStats.name} o Empate)`,
      goals.p1X,
      `La doble oportunidad 1X cubre victoria local o empate con una probabilidad estimada del ${(goals.p1X * 100).toFixed(1)}%. ` +
      `${homeStats.name} tiene un perfil ofensivo de ${homeStats.xgFor.toFixed(2)} xG a favor, mientras que ${awayStats.name} recibe ${awayStats.xgAgainst.toFixed(2)} xG.`
    );

    pushRec(
      'doble oportunidad',
      `X2 (Empate o Gana ${awayStats.name})`,
      goals.pX2,
      `La doble oportunidad X2 cubre empate o victoria visitante con una probabilidad del ${(goals.pX2 * 100).toFixed(1)}%. ` +
      `${awayStats.name} promedia ${awayStats.xgFor.toFixed(2)} xG a favor y ${homeStats.name} encaja ${homeStats.xgAgainst.toFixed(2)} xG.`
    );

    // Córners (Más/Menos)
    const totalCornersLambda = corners.home + corners.away;
    const pOver85 = poissonOverProb(totalCornersLambda, 8.5);
    const pUnder105 = 1 - poissonOverProb(totalCornersLambda, 10.5);

    pushRec(
      'córners',
      'Más de 8.5 córners',
      pOver85,
      `Se espera un total medio de ${totalCornersLambda.toFixed(1)} córners ( ${homeStats.name}: ${corners.home.toFixed(1)}, ` +
      `${awayStats.name}: ${corners.away.toFixed(1)} ). La probabilidad de superar los 8.5 córners es del ${(pOver85 * 100).toFixed(1)}%.`
    );

    pushRec(
      'córners',
      'Menos de 10.5 córners',
      pUnder105,
      `Con un promedio conjunto de ${totalCornersLambda.toFixed(1)} córners, la probabilidad de quedarse en 10 o menos es del ${(pUnder105 * 100).toFixed(1)}%. ` +
      `Ambos equipos tienen medias de córners relativamente estables, lo que favorece un rango moderado.`
    );

    return recs.sort((a, b) => b.prob - a.prob);
  }

  function analyzeMatch(fixture) {
    const home = getTeamStats(fixture.home);
    const away = getTeamStats(fixture.away);

    // Lambdas de goles esperados
    const attHome = home.xgFor / MODEL.LEAGUE_AVG_XG;
    const defHome = home.xgAgainst / MODEL.LEAGUE_AVG_XG;
    const attAway = away.xgFor / MODEL.LEAGUE_AVG_XG;
    const defAway = away.xgAgainst / MODEL.LEAGUE_AVG_XG;

    let lambdaHome = MODEL.LEAGUE_AVG_XG * attHome * defAway * MODEL.HOME_ADV;
    let lambdaAway = MODEL.LEAGUE_AVG_XG * attAway * defHome * MODEL.AWAY_PENALTY;

    lambdaHome = clamp(lambdaHome, 0.3, 3.6);
    lambdaAway = clamp(lambdaAway, 0.25, 3.3);

    const matrix = buildScoreMatrix(lambdaHome, lambdaAway);
    const goals = analyzeGoalsAndResult(matrix);

    const corners = {
      home: home.corners,
      away: away.corners
    };

    const recommendations = buildSafeRecommendations(fixture, home, away, goals, corners);

    return {
      fixture,
      home,
      away,
      lambdaHome: round2(lambdaHome),
      lambdaAway: round2(lambdaAway),
      goals,
      corners,
      recommendations
    };
  }

  /* =========================================================================
     6. ESTADO DE LA APP
     ========================================================================= */

  const App = {
    currentDate: null,
    fixtures: [],
    analyses: [],
    usingLiveData: false,
    selectedMatchId: null
  };

  /* =========================================================================
     7. RENDERIZADO
     ========================================================================= */

  function renderLiveBanner() {
    const banner = document.getElementById('liveBanner');
    if (!banner) return;

    if (App.usingLiveData) {
      banner.textContent = '🟢 Datos en vivo activos (API externa configurada).';
    } else {
      banner.textContent = '🟡 Modo demo: calendario real del Mundial 2026 con estadísticas simuladas.';
    }
  }

  function populateMatchSelect() {
    const select = document.getElementById('matchSelect');
    if (!select) return;

    select.innerHTML = '';

    if (!App.fixtures.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No hay partidos para esta fecha';
      select.appendChild(opt);
      App.selectedMatchId = null;
      return;
    }

    App.fixtures.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = `${f.home} vs ${f.away} — ${formatKickoff(f.date)}`;
      select.appendChild(opt);
    });

    // Seleccionar el primero por defecto
    App.selectedMatchId = App.fixtures[0].id;
    select.value = App.selectedMatchId;
  }

  function renderSelectedMatch() {
    const container = document.getElementById('analysisContainer');
    if (!container) return;

    container.innerHTML = '';

    if (!App.selectedMatchId) {
      container.textContent = 'Selecciona un partido para ver el análisis.';
      return;
    }

    const analysis = App.analyses.find(a => a.fixture.id === App.selectedMatchId);
    if (!analysis) {
      container.textContent = 'No se encontró el análisis para el partido seleccionado.';
      return;
    }

    const { fixture, home, away, lambdaHome, lambdaAway, recommendations } = analysis;

    const header = document.createElement('div');
    header.className = 'match-header';
    header.innerHTML = `
      <h2>${home.flag} ${home.name} vs ${away.flag} ${away.name}</h2>
      <p class="match-meta">
        ${formatKickoff(fixture.date)} · Grupo ${fixture.group || '-'} · ${fixture.city || ''} · ${fixture.stadium || ''}
      </p>
      <p class="match-xg">
        Goles esperados (modelo): ${home.name} ${lambdaHome.toFixed(2)} — ${lambdaAway.toFixed(2)} ${away.name}
      </p>
    `;

    const recBlock = document.createElement('div');
    recBlock.className = 'recommendations';

    if (!recommendations.length) {
      recBlock.innerHTML = `
        <p>No hay recomendaciones ultra-seguras (≥ 75% de probabilidad) para este partido.</p>
      `;
    } else {
      const list = document.createElement('div');
      list.className = 'recommendation-list';

      recommendations.forEach(rec => {
        const item = document.createElement('div');
        item.className = 'recommendation-item';
        item.innerHTML = `
          <div class="rec-header">
            <span class="rec-type">${rec.type.toUpperCase()}</span>
            <span class="rec-stars">${rec.stars}</span>
          </div>
          <div class="rec-label">${rec.label}</div>
          <div class="rec-prob">Probabilidad estimada: ${(rec.prob * 100).toFixed(1)}%</div>
          <div class="rec-explanation">${rec.explanation}</div>
        `;
        list.appendChild(item);
      });

      recBlock.appendChild(list);
    }

    container.appendChild(header);
    container.appendChild(recBlock);
  }

  /* =========================================================================
     8. CARGA DE DATOS Y EVENTOS DE INTERFAZ
     ========================================================================= */

  async function loadDataForToday() {
    const now = new Date(); // SIEMPRE fecha actual del sistema
    App.currentDate = now;

    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('is-loading');
    }

    const { fixtures, usingLive } = await getFixturesForDate(now);
    App.fixtures = fixtures;
    App.usingLiveData = usingLive;
    App.analyses = fixtures.map(f => analyzeMatch(f));

    renderLiveBanner();
    populateMatchSelect();
    renderSelectedMatch();

    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-loading');
    }
  }

  function attachEventListeners() {
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        // Al pulsar actualizar, siempre se vuelve a tomar la fecha actual del sistema
        loadDataForToday();
      });
    }

    const matchSelect = document.getElementById('matchSelect');
    if (matchSelect) {
      matchSelect.addEventListener('change', (e) => {
        App.selectedMatchId = e.target.value || null;
        renderSelectedMatch();
      });
    }
  }

  /* =========================================================================
     9. INICIALIZACIÓN
     ========================================================================= */

  document.addEventListener('DOMContentLoaded', () => {
    attachEventListeners();
    loadDataForToday();
  });

})();
