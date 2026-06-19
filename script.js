/* ===========================================================================
   MUNDIAL26 AI ANALYTICS — script.js (modo seguro, manteniendo tu UI original)
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

  const FACTORIALS = [1];
  for (let i = 1; i <= 12; i++) FACTORIALS.push(FACTORIALS[i - 1] * i);

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round2(v) { return Math.round(v * 100) / 100; }

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
    if (prob >= 0.87) return '⭐⭐⭐⭐⭐';
    if (prob >= 0.80) return '⭐⭐⭐⭐';
    return '⭐⭐⭐';
  }

  function poissonOverProb(lambda, threshold) {
    let pUnder = 0;
    for (let k = 0; k <= Math.floor(threshold); k++) {
      pUnder += poissonPMF(k, lambda);
    }
    return clamp(1 - pUnder, 0.01, 0.99);
  }

  /* =========================================================================
     2. BASE DE DATOS LOCAL (FALLBACK / MODO DEMO)
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
     3. CAPA DE DATOS — API + FALLBACK
     ========================================================================= */

  async function fetchFixturesFromApiByDate(targetDate) {
    const dateStr = targetDate.toISOString().slice(0, 10); // YYYY-MM-DD
    const url = `${API_BASE_URL}/football/matches?date=${dateStr}&apiKey=${encodeURIComponent(API_KEY)}`;

    if (!API_KEY || API_KEY === "TU_CLAVE_AQUI") {
      return null;
    }

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

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
    const apiFixtures = await fetchFixturesFromApiByDate(targetDate);
    if (apiFixtures && apiFixtures.length) {
      return { fixtures: apiFixtures, usingLive: true };
    }
    const fb = getFallbackFixturesForDate(targetDate);
    return { fixtures: fb, usingLive: false };
  }

  function getTeamStats(teamName) {
    const meta = TEAM_META[teamName];
    if (!meta) {
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
     4. MOTOR DE PREDICCIÓN ULTRA-SEGURO
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

  function buildSafeRecommendations(fixture, homeStats, awayStats, goals, corners) {
    const recs = [];

    function pushRec(type, label, prob, explanation) {
      if (prob < 0.75) return; // modo ultra-seguro
      recs.push({
        type,
        label,
        prob,
        stars: starsFromProb(prob),
        explanation
      });
    }

    // Goles
    pushRec(
      'goals',
      'Más de 1.5 goles',
      goals.pOver15,
      `El modelo estima una probabilidad del ${(goals.pOver15 * 100).toFixed(1)}% de ver al menos 2 goles. ` +
      `${homeStats.name} promedia ${homeStats.xgFor.toFixed(2)} xG a favor y ${awayStats.name} recibe ${awayStats.xgAgainst.toFixed(2)} xG por partido.`
    );

    pushRec(
      'goals',
      'Menos de 2.5 goles',
      goals.pUnder25,
      `La probabilidad de que haya 2 goles o menos es del ${(goals.pUnder25 * 100).toFixed(1)}%. ` +
      `${homeStats.name} encaja ${homeStats.xgAgainst.toFixed(2)} xG y ${awayStats.name} genera ${awayStats.xgFor.toFixed(2)} xG, lo que sugiere un partido más cerrado.`
    );

    // Doble oportunidad (sin recomendar victorias locas de equipos débiles)
    pushRec(
      'double_chance',
      `1X (Gana ${homeStats.name} o Empate)`,
      goals.p1X,
      `La doble oportunidad 1X cubre victoria local o empate con una probabilidad estimada del ${(goals.p1X * 100).toFixed(1)}%. ` +
      `${homeStats.name} tiene un perfil ofensivo de ${homeStats.xgFor.toFixed(2)} xG a favor, mientras que ${awayStats.name} recibe ${awayStats.xgAgainst.toFixed(2)} xG.`
    );

    pushRec(
      'double_chance',
      `X2 (Empate o Gana ${awayStats.name})`,
      goals.pX2,
      `La doble oportunidad X2 cubre empate o victoria visitante con una probabilidad del ${(goals.pX2 * 100).toFixed(1)}%. ` +
      `${awayStats.name} promedia ${awayStats.xgFor.toFixed(2)} xG a favor y ${homeStats.name} encaja ${homeStats.xgAgainst.toFixed(2)} xG.`
    );

    // Córners
    const totalCornersLambda = corners.home + corners.away;
    const pOver85 = poissonOverProb(totalCornersLambda, 8.5);
    const pUnder105 = 1 - poissonOverProb(totalCornersLambda, 10.5);

    pushRec(
      'corners',
      'Más de 8.5 córners',
      pOver85,
      `Se espera un total medio de ${totalCornersLambda.toFixed(1)} córners ( ${homeStats.name}: ${corners.home.toFixed(1)}, ` +
      `${awayStats.name}: ${corners.away.toFixed(1)} ). La probabilidad de superar los 8.5 córners es del ${(pOver85 * 100).toFixed(1)}%.`
    );

    pushRec(
      'corners',
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

    // Para tu UI original: una “mejor pick” por partido (la más segura)
    const bestPick = recommendations[0] || null;
    const confidence = bestPick ? bestPick.prob : 0.5;

    return {
      fixture,
      home,
      away,
      lambdaHome: round2(lambdaHome),
      lambdaAway: round2(lambdaAway),
      goals,
      corners,
      recommendations,
      bestPick,
      confidence
    };
  }

  /* =========================================================================
     5. ESTADO DE LA APP
     ========================================================================= */

  const App = {
    currentDate: null,
    fixtures: [],
    analyses: [],
    usingLiveData: false,
    sortBy: 'confidence',
    marketFilter: 'all',
    searchTerm: '',
    selectedMatchId: null
  };

  /* =========================================================================
     6. RENDERIZADO UI (RESPETA TU HTML/CSS ORIGINAL)
     ========================================================================= */

  function renderLiveBanner() {
    const banner = document.getElementById('liveBanner');
    if (!banner) return;

    banner.classList.remove('hidden');
    if (App.usingLiveData) {
      banner.textContent = '🟢 Datos en vivo activos (API externa configurada).';
    } else {
      banner.textContent = '🟡 Modo demo: calendario real del Mundial 2026 con estadísticas simuladas.';
    }
  }

  function renderDashboardStats() {
    const statDate = document.getElementById('statDate');
    const statMatches = document.getElementById('statMatches');

    if (statDate && App.currentDate) {
      statDate.textContent = App.currentDate.toLocaleDateString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    }
    if (statMatches) {
      statMatches.textContent = App.fixtures.length.toString();
    }
  }

  function getFilteredAnalyses() {
    let list = [...App.analyses];

    if (App.marketFilter !== 'all') {
      list = list.map(a => ({
        ...a,
        recommendations: a.recommendations.filter(r => {
          if (App.marketFilter === 'goals') return r.type === 'goals';
          if (App.marketFilter === 'corners') return r.type === 'corners';
          if (App.marketFilter === '1x2' || App.marketFilter === 'btts' || App.marketFilter === 'cards' || App.marketFilter === 'scorer' || App.marketFilter === 'correct_score') {
            return false; // no recomendamos estos en modo seguro
          }
          return true;
        })
      }));
    }

    if (App.searchTerm) {
      const term = App.searchTerm.toLowerCase();
      list = list.filter(a =>
        a.home.name.toLowerCase().includes(term) ||
        a.away.name.toLowerCase().includes(term)
      );
    }

    if (App.sortBy === 'time') {
      list.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    } else if (App.sortBy === 'confidence') {
      list.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    }

    return list;
  }

  function renderMatchesGrid() {
    const grid = document.getElementById('matchesGrid');
    const countEl = document.getElementById('matchCount');
    const emptyState = document.getElementById('emptyState');
    if (!grid) return;

    const list = getFilteredAnalyses();

    grid.innerHTML = '';

    if (!list.length) {
      if (emptyState) emptyState.classList.remove('hidden');
      if (countEl) countEl.textContent = '(0 partidos)';
      return;
    } else if (emptyState) {
      emptyState.classList.add('hidden');
    }

    if (countEl) countEl.textContent = `(${list.length} partidos)`;

    list.forEach(a => {
      const { fixture, home, away, bestPick, confidence } = a;
      const pct = Math.round((confidence || 0.5) * 100);

      const card = document.createElement('article');
      card.className = 'match-card';
      card.dataset.matchId = fixture.id;

      card.innerHTML = `
        <div class="match-card-top">
          <div class="badge-group">
            <span class="badge-tag">Grupo ${fixture.group || '-'}</span>
            <span class="badge-tag">${formatKickoff(fixture.date)}</span>
          </div>
          <div class="confidence-dial" style="--pct:${pct};" data-pct="${pct}"></div>
        </div>

        <div class="teams-row">
          <div class="team-block home">
            <span class="team-flag">${home.flag}</span>
            <span class="team-name">${home.name}</span>
            <span class="team-code">${home.code}</span>
          </div>
          <div class="vs-block">
            <span class="vs-label">VS</span>
          </div>
          <div class="team-block away">
            <span class="team-flag">${away.flag}</span>
            <span class="team-name">${away.name}</span>
            <span class="team-code">${away.code}</span>
          </div>
        </div>

        <div class="odds-row">
          <div class="odds-chip">
            <div class="odds-chip-label">xG local</div>
            <div class="odds-chip-value">${a.lambdaHome.toFixed(2)}</div>
          </div>
          <div class="odds-chip">
            <div class="odds-chip-label">xG visitante</div>
            <div class="odds-chip-value">${a.lambdaAway.toFixed(2)}</div>
          </div>
          <div class="odds-chip">
            <div class="odds-chip-label">Confianza</div>
            <div class="odds-chip-value">${pct}%</div>
          </div>
        </div>

        <div class="match-card-footer">
          <div class="best-pick">
            <span class="best-pick-label">Pick seguro</span>
            <span class="best-pick-value">${bestPick ? bestPick.label : 'Sin pick ≥ 75%'}</span>
          </div>
          <span class="risk-pill risk-low">MODO SEGURO</span>
        </div>
      `;

      card.addEventListener('click', () => openMatchModal(a));
      grid.appendChild(card);
    });
  }

  function renderBestBetsTable() {
    const tbody = document.getElementById('bestBetsBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    const rows = [];
    App.analyses.forEach(a => {
      a.recommendations.forEach(rec => {
        rows.push({
          matchLabel: `${a.home.name} vs ${a.away.name}`,
          market: rec.type,
          pick: rec.label,
          prob: rec.prob
        });
      });
    });

    rows.sort((a, b) => b.prob - a.prob);

    rows.slice(0, 20).forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'row-value';
      const fairOdds = 1 / r.prob;

      tr.innerHTML = `
        <td>${r.matchLabel}</td>
        <td>${r.market}</td>
        <td>${r.pick}</td>
        <td class="mono">${(r.prob * 100).toFixed(1)}%</td>
        <td class="mono">—</td>
        <td class="mono">${fairOdds.toFixed(2)}</td>
        <td class="mono">—</td>
        <td class="mono">—</td>
        <td><span class="risk-pill risk-low">Seguro</span></td>
      `;
      tbody.appendChild(tr);
    });
  }

  /* =========================================================================
     7. MODAL DE DETALLE (AQUÍ METEMOS LAS ESTRELLAS Y LA EXPLICACIÓN)
     ========================================================================= */

  const matchModal = document.getElementById('matchModal');
  const modalContent = document.getElementById('modalContent');
  const modalClose = document.getElementById('modalClose');

  function openMatchModal(analysis) {
    if (!matchModal || !modalContent) return;

    const { fixture, home, away, lambdaHome, lambdaAway, recommendations } = analysis;

    const recHtml = recommendations.length
      ? recommendations.map(rec => `
        <div class="market-card">
          <div class="mc-title">${rec.type.toUpperCase()} · ${rec.stars}</div>
          <div class="mc-pick">${rec.label}</div>
          <div class="mc-foot">
            <span>Prob: ${(rec.prob * 100).toFixed(1)}%</span>
          </div>
          <p style="margin-top:0.4rem;font-size:0.82rem;color:#eef0f4;">
            ${rec.explanation}
          </p>
        </div>
      `).join('')
      : `<p>No hay recomendaciones ultra-seguras (≥ 75% de probabilidad) para este partido.</p>`;

    modalContent.innerHTML = `
      <div class="modal-header">
        <div>
          <div class="modal-teams">${home.flag} ${home.name} vs ${away.flag} ${away.name}</div>
          <div class="modal-meta">
            ${formatKickoff(fixture.date)} · Grupo ${fixture.group || '-'} · ${fixture.city || ''} · ${fixture.stadium || ''}
          </div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab-btn active" data-tab="overview">Resumen</button>
        <button class="tab-btn" data-tab="markets">Mercados seguros</button>
      </div>

      <div class="tab-panel active" id="tab-overview">
        <p class="settings-intro">
          Goles esperados (modelo Poisson): <strong>${home.name} ${lambdaHome.toFixed(2)} — ${lambdaAway.toFixed(2)} ${away.name}</strong>.
          El modelo está calibrado para priorizar mercados estables (goles totales, doble oportunidad y córners),
          evitando apuestas locas a ganador de equipos muy débiles.
        </p>
      </div>

      <div class="tab-panel" id="tab-markets">
        <div class="market-grid">
          ${recHtml}
        </div>
      </div>
    `;

    const tabBtns = modalContent.querySelectorAll('.tab-btn');
    const panels = {
      overview: modalContent.querySelector('#tab-overview'),
      markets: modalContent.querySelector('#tab-markets')
    };

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        Object.keys(panels).forEach(k => {
          panels[k].classList.toggle('active', k === tab);
        });
      });
    });

    matchModal.classList.remove('hidden');
  }

  function closeMatchModal() {
    if (matchModal) matchModal.classList.add('hidden');
  }

  if (modalClose && matchModal) {
    modalClose.addEventListener('click', closeMatchModal);
    matchModal.addEventListener('click', (e) => {
      if (e.target === matchModal) closeMatchModal();
    });
  }

  /* =========================================================================
     8. EVENTOS DE INTERFAZ
     ========================================================================= */

  function attachEventListeners() {
    const refreshBtn = document.getElementById('refreshBtn');
    const marketFilter = document.getElementById('marketFilter');
    const sortBtns = document.querySelectorAll('.sort-btn');
    const searchInput = document.getElementById('searchInput');

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        loadDataForToday();
      });
    }

    if (marketFilter) {
      marketFilter.addEventListener('change', (e) => {
        App.marketFilter = e.target.value;
        renderMatchesGrid();
        renderBestBetsTable();
      });
    }

    sortBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        sortBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        App.sortBy = btn.dataset.sort;
        renderMatchesGrid();
      });
    });

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        App.searchTerm = e.target.value.trim();
        renderMatchesGrid();
      });
    }

    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const settingsClose = document.getElementById('settingsClose');

    if (settingsBtn && settingsModal && settingsClose) {
      settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
      settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) settingsModal.classList.add('hidden');
      });
    }
  }

  /* =========================================================================
     9. CARGA DE DATOS
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
    renderDashboardStats();
    renderMatchesGrid();
    renderBestBetsTable();

    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-loading');
    }
  }

  /* =========================================================================
     10. INICIALIZACIÓN
     ========================================================================= */

  document.addEventListener('DOMContentLoaded', () => {
    attachEventListeners();
    loadDataForToday();
  });

})();
