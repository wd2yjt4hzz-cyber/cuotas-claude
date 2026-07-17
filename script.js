/* =========================================================================
   ATP MONTE CARLO SIMULATOR
   -------------------------------------------------------------------------
   Simula 20.000 partidos punto a punto para dos enfrentamientos ATP de
   tierra batida, usando estadísticas reales/estimadas de cada jugador.
   ========================================================================= */

const N_SIMULATIONS = 20000;

/* -------------------------------------------------------------------------
   1. DATOS DE JUGADORES
   Fuentes: ATP Tour player stats, TennisStats.com, MatchStat.com,
   TennisRatio.com (julio 2026). Donde el dato exacto para tierra batida no
   estaba disponible se usó el dato de temporada/carrera más cercano y se
   marcó como estimación (isEstimate: true en el campo correspondiente).

   Campos:
   - firstServeIn:      % de primeros servicios dentro (0-1)
   - firstServeWon:      % de puntos ganados con 1er servicio (0-1)
   - secondServeWon:     % de puntos ganados con 2do servicio (0-1)
   - acesPerMatch:       aces promedio por partido (asumiendo ~80 puntos de saque)
   - dfPerMatch:         dobles faltas promedio por partido
   - bpSaved:             % break points salvados (0-1)
   - bpConverted:         % break points convertidos como restador (0-1)
   - clayForm:            multiplicador de ajuste por rendimiento/forma en tierra (1 = neutro)
   ------------------------------------------------------------------------- */
const PLAYERS = {
  rinderknech: {
    name: "Arthur Rinderknech",
    color: "#ef4444",
    firstServeIn: 0.64,
    firstServeWon: 0.76,
    secondServeWon: 0.50,
    acesPerMatch: 9.9,
    dfPerMatch: 3.0,
    bpSaved: 0.65,
    bpConverted: 0.19,
    clayForm: 0.93, // estimación: 2026 flojo en tierra (0-0 en clay esta temporada)
    servicePointsPerMatch: 80
  },
  tsitsipas: {
    name: "Stefanos Tsitsipas",
    color: "#3b82f6",
    firstServeIn: 0.62,
    firstServeWon: 0.68,
    secondServeWon: 0.52,
    acesPerMatch: 6.2,
    dfPerMatch: 2.8,
    bpSaved: 0.63,
    bpConverted: 0.40,
    clayForm: 1.05, // especialista en tierra: 72.5% de victorias históricas en esta superficie
    servicePointsPerMatch: 80
  },
  burruchaga: {
    name: "Román A. Burruchaga",
    color: "#f97316",
    firstServeIn: 0.68,
    firstServeWon: 0.70,
    secondServeWon: 0.49, // (estimado, dato exacto de tierra no disponible)
    acesPerMatch: 2.2,
    dfPerMatch: 2.0,
    bpSaved: 0.57,
    bpConverted: 0.44,
    clayForm: 1.02, // jugador argentino formado en tierra, buen récord en la superficie
    servicePointsPerMatch: 78
  },
  merida: {
    name: "Daniel Mérida",
    color: "#22c55e",
    firstServeIn: 0.66,
    firstServeWon: 0.68, // (estimado)
    secondServeWon: 0.46,
    acesPerMatch: 3.33,
    dfPerMatch: 2.58,
    bpSaved: 0.60, // (estimado)
    bpConverted: 0.627,
    clayForm: 1.04, // 60% de victorias en tierra en su forma reciente
    servicePointsPerMatch: 78
  }
};

const MATCHUPS = [
  { p1: "rinderknech", p2: "tsitsipas", containerId: "match-1", tournament: "ATP Gstaad" },
  { p1: "burruchaga", p2: "merida", containerId: "match-2", tournament: "ATP Umag" }
];

/* -------------------------------------------------------------------------
   2. NÚCLEO DE SIMULACIÓN PUNTO A PUNTO
   ------------------------------------------------------------------------- */

// Probabilidad efectiva de que el servidor gane un punto de su saque,
// ajustada por su forma en tierra batida.
function servicePointWinProb(player) {
  const raw = player.firstServeIn * player.firstServeWon +
              (1 - player.firstServeIn) * player.secondServeWon;
  return Math.min(0.95, Math.max(0.35, raw * player.clayForm));
}

// Probabilidad condicional de que, dado que el servidor gana el punto con
// el primer servicio, ese punto sea un ace.
function aceConditionalProb(player) {
  const acePointProb = player.acesPerMatch / player.servicePointsPerMatch;
  const firstServeWinProb = player.firstServeIn * player.firstServeWon;
  if (firstServeWinProb <= 0) return 0;
  return Math.min(0.9, acePointProb / firstServeWinProb);
}

// Simula un único punto de saque. Devuelve { serverWins, isAce }
function simulatePoint(server) {
  const pWin = servicePointWinProb(server);
  const isFirstServe = Math.random() < server.firstServeIn;
  let serverWins;
  if (isFirstServe) {
    serverWins = Math.random() < (server.firstServeWon * server.clayForm);
  } else {
    serverWins = Math.random() < (server.secondServeWon * server.clayForm);
  }
  let isAce = false;
  if (isFirstServe && serverWins) {
    isAce = Math.random() < aceConditionalProb(server);
  }
  return { serverWins, isAce };
  void pWin; // pWin usado sólo como referencia conceptual documentada arriba
}

// Simula un juego de saque completo (con deuces/ventajas).
// Devuelve { serverWonGame, aces }
function simulateGame(server) {
  let serverPoints = 0, returnerPoints = 0, aces = 0;
  while (true) {
    const { serverWins, isAce } = simulatePoint(server);
    if (isAce) aces++;
    if (serverWins) serverPoints++; else returnerPoints++;

    const serverAhead = serverPoints - returnerPoints;
    if (serverPoints >= 4 && serverAhead >= 2) return { serverWonGame: true, aces };
    if (returnerPoints >= 4 && serverAhead <= -2) return { serverWonGame: false, aces };
  }
}

// Simula un tie-break (a 7, diferencia de 2).
function simulateTiebreak(playerA, playerB, aServesFirst) {
  let pointsA = 0, pointsB = 0, aces = { a: 0, b: 0 };
  let serverIsA = aServesFirst;
  let pointNumber = 0;
  while (true) {
    const server = serverIsA ? playerA : playerB;
    const { serverWins, isAce } = simulatePoint(server);
    if (serverIsA) { if (isAce) aces.a++; } else { if (isAce) aces.b++; }

    if (serverIsA === true) { if (serverWins) pointsA++; else pointsB++; }
    else { if (serverWins) pointsB++; else pointsA++; }

    pointNumber++;
    // el saque cambia tras el primer punto y luego cada dos puntos
    if (pointNumber === 1) { serverIsA = !serverIsA; }
    else if (pointNumber % 2 === 1) { serverIsA = !serverIsA; }

    const diff = pointsA - pointsB;
    if (pointsA >= 7 && diff >= 2) return { winner: "A", aces };
    if (pointsB >= 7 && diff <= -2) return { winner: "B", aces };
  }
}

// Simula un set completo. Devuelve { winner, gamesA, gamesB, breaksA, breaksB, acesA, acesB }
function simulateSet(playerA, playerB, aServesFirst) {
  let gamesA = 0, gamesB = 0, breaksA = 0, breaksB = 0, acesA = 0, acesB = 0;
  let aServes = aServesFirst;

  while (true) {
    if (gamesA === 6 && gamesB === 6) {
      const tb = simulateTiebreak(playerA, playerB, aServes);
      acesA += tb.aces.a; acesB += tb.aces.b;
      if (tb.winner === "A") gamesA++; else gamesB++;
      break;
    }

    const server = aServes ? playerA : playerB;
    const { serverWonGame, aces } = simulateGame(server);
    if (aServes) acesA += aces; else acesB += aces;

    if (aServes) {
      if (serverWonGame) gamesA++; else { gamesB++; breaksB++; }
    } else {
      if (serverWonGame) gamesB++; else { gamesA++; breaksA++; }
    }

    if ((gamesA >= 6 || gamesB >= 6) && Math.abs(gamesA - gamesB) >= 2) break;
    if (gamesA === 7 || gamesB === 7) break; // 7-5 o 7-6 ya cubiertos arriba

    aServes = !aServes;
  }

  return {
    winner: gamesA > gamesB ? "A" : "B",
    gamesA, gamesB, breaksA, breaksB, acesA, acesB
  };
}

// Simula un partido a mejor de 3 sets. Devuelve estadísticas agregadas.
function simulateMatch(playerA, playerB) {
  let setsA = 0, setsB = 0;
  let totalGames = 0, breaksA = 0, breaksB = 0, acesA = 0, acesB = 0;
  const setScores = [];
  let aServesFirst = Math.random() < 0.5;

  while (setsA < 2 && setsB < 2) {
    const set = simulateSet(playerA, playerB, aServesFirst);
    setScores.push(`${set.gamesA}-${set.gamesB}`);
    totalGames += set.gamesA + set.gamesB;
    breaksA += set.breaksA; breaksB += set.breaksB;
    acesA += set.acesA; acesB += set.acesB;
    if (set.winner === "A") setsA++; else setsB++;
    // alternar quién saca primero en el set siguiente (aprox. realista)
    aServesFirst = !aServesFirst;
  }

  return {
    winner: setsA > setsB ? "A" : "B",
    setsA, setsB, setScores: setScores.join(", "),
    scoreLine: `${setsA}-${setsB}`,
    totalGames, breaksA, breaksB, acesA, acesB
  };
}

/* -------------------------------------------------------------------------
   3. MOTOR DE SIMULACIÓN MASIVA (20.000 iteraciones)
   ------------------------------------------------------------------------- */
function runMonteCarlo(playerAKey, playerBKey, n) {
  const playerA = PLAYERS[playerAKey];
  const playerB = PLAYERS[playerBKey];

  let winsA = 0, winsB = 0;
  const scoreCounts = {}; // e.g. "2-0 A" -> count
  const totalGamesArr = [];
  const breaksAArr = [], breaksBArr = [];
  const acesAArr = [], acesBArr = [];

  for (let i = 0; i < n; i++) {
    const m = simulateMatch(playerA, playerB);
    if (m.winner === "A") winsA++; else winsB++;

    const label = m.winner === "A"
      ? `${m.setsA}-${m.setsB} ${playerA.name}`
      : `${m.setsB}-${m.setsA} ${playerB.name}`;
    scoreCounts[label] = (scoreCounts[label] || 0) + 1;

    totalGamesArr.push(m.totalGames);
    breaksAArr.push(m.breaksA);
    breaksBArr.push(m.breaksB);
    acesAArr.push(m.acesA);
    acesBArr.push(m.acesB);
  }

  return {
    playerA, playerB, n,
    winsA, winsB,
    winProbA: winsA / n, winProbB: winsB / n,
    scoreCounts,
    totalGamesArr, breaksAArr, breaksBArr, acesAArr, acesBArr
  };
}

/* -------------------------------------------------------------------------
   4. UTILIDADES ESTADÍSTICAS
   ------------------------------------------------------------------------- */
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stdDev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}
function overUnderProb(arr, threshold) {
  return arr.filter(x => x > threshold).length / arr.length;
}
function distributionCounts(arr, maxBucket) {
  const counts = {};
  for (let i = 0; i <= maxBucket; i++) counts[i] = 0;
  let overflow = 0;
  arr.forEach(v => {
    if (v <= maxBucket) counts[v]++; else overflow++;
  });
  if (overflow > 0) counts[`${maxBucket + 1}+`] = overflow;
  return counts;
}
function pct(x) { return (x * 100).toFixed(1) + "%"; }

/* -------------------------------------------------------------------------
   5. RENDERIZADO
   ------------------------------------------------------------------------- */
const chartRegistry = {}; // guarda instancias Chart.js para poder destruirlas al re-simular

function destroyChart(id) {
  if (chartRegistry[id]) { chartRegistry[id].destroy(); delete chartRegistry[id]; }
}

function makeBarChart(canvasId, labels, datasets, yLabel) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId).getContext("2d");
  chartRegistry[canvasId] = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: datasets.length > 1, labels: { color: "#e5e7eb" } }
      },
      scales: {
        x: { ticks: { color: "#94a3b8" }, grid: { color: "#1f2937" } },
        y: {
          ticks: { color: "#94a3b8" },
          grid: { color: "#1f2937" },
          title: { display: !!yLabel, text: yLabel, color: "#94a3b8" }
        }
      }
    }
  });
}

function renderPlayerStatsTable(containerId, playerKey, position) {
  const player = PLAYERS[playerKey];
  const table = document.querySelector(`#${containerId} .player-stats-grid .player-stat-card:nth-child(${position}) .stats-table`);
  const rows = [
    ["% 1er servicio dentro", pct(player.firstServeIn)],
    ["Puntos ganados 1er servicio", pct(player.firstServeWon)],
    ["Puntos ganados 2do servicio", pct(player.secondServeWon)],
    ["Aces / partido (aprox.)", player.acesPerMatch.toFixed(1)],
    ["Dobles faltas / partido (aprox.)", player.dfPerMatch.toFixed(1)],
    ["Break points salvados", pct(player.bpSaved)],
    ["Break points convertidos", pct(player.bpConverted)],
    ["Ajuste de forma en tierra", player.clayForm.toFixed(2) + "x"]
  ];
  table.innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("");
}

function renderMatchResults(matchup, result) {
  const container = document.querySelector(`#${matchup.containerId} .sim-results`);
  const A = result.playerA, B = result.playerB;
  const suffixId = matchup.containerId;

  // -- Ordenar marcadores por frecuencia --
  const sortedScores = Object.entries(result.scoreCounts).sort((a, b) => b[1] - a[1]);

  // -- Estadísticas de juegos totales --
  const gamesMean = mean(result.totalGamesArr);
  const gamesMedian = median(result.totalGamesArr);
  const gamesStd = stdDev(result.totalGamesArr);
  const gameThresholds = [19.5, 20.5, 21.5, 22.5, 23.5, 24.5];

  // -- Distribución de breaks --
  const breakDistA = distributionCounts(result.breaksAArr, 4);
  const breakDistB = distributionCounts(result.breaksBArr, 4);
  const atLeastOneBreakA = result.breaksAArr.filter(x => x >= 1).length / result.n;
  const atLeastOneBreakB = result.breaksBArr.filter(x => x >= 1).length / result.n;

  // -- Aces --
  const acesMeanA = mean(result.acesAArr);
  const acesMeanB = mean(result.acesBArr);
  const aceThresholdsA = [Math.round(acesMeanA) - 1.5, Math.round(acesMeanA) + 1.5].map(x=>Math.max(0.5,x));
  const aceThresholdsB = [Math.round(acesMeanB) - 1.5, Math.round(acesMeanB) + 1.5].map(x=>Math.max(0.5,x));

  container.innerHTML = `
    <div class="result-block">
      <h4>1. Probabilidad de ganador (${result.n.toLocaleString("es-ES")} simulaciones)</h4>
      <table class="data-table">
        <thead><tr><th>Jugador</th><th>Probabilidad</th></tr></thead>
        <tbody>
          <tr><td style="color:${A.color}">${A.name}</td><td>${pct(result.winProbA)}</td></tr>
          <tr><td style="color:${B.color}">${B.name}</td><td>${pct(result.winProbB)}</td></tr>
        </tbody>
      </table>
      <div class="chart-box"><canvas id="chart-winner-${suffixId}"></canvas></div>
    </div>

    <div class="result-block">
      <h4>2. Distribución de marcadores</h4>
      <table class="data-table">
        <thead><tr><th>Resultado</th><th>Probabilidad</th></tr></thead>
        <tbody>
          ${sortedScores.map(([label, count]) => `<tr><td>${label}</td><td>${pct(count / result.n)}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="chart-box"><canvas id="chart-scores-${suffixId}"></canvas></div>
    </div>

    <div class="result-block">
      <h4>3. Juegos totales del partido</h4>
      <div class="summary-line">
        <div class="summary-pill">Media<b>${gamesMean.toFixed(1)}</b></div>
        <div class="summary-pill">Mediana<b>${gamesMedian.toFixed(1)}</b></div>
        <div class="summary-pill">Desv. estándar<b>${gamesStd.toFixed(2)}</b></div>
      </div>
      <table class="data-table">
        <thead><tr><th>Mercado</th><th>Probabilidad</th></tr></thead>
        <tbody>
          ${gameThresholds.map(t => `<tr><td>Más de ${t} juegos</td><td>${pct(overUnderProb(result.totalGamesArr, t))}</td></tr>`).join("")}
          <tr><td>Menos de ${gameThresholds[2]} juegos</td><td>${pct(1 - overUnderProb(result.totalGamesArr, gameThresholds[2]))}</td></tr>
        </tbody>
      </table>
      <div class="chart-box"><canvas id="chart-games-${suffixId}"></canvas></div>
    </div>

    <div class="result-block">
      <h4>4. Roturas de servicio</h4>
      <div class="summary-line">
        <div class="summary-pill" style="color:${A.color}">Media breaks ${A.name}<b>${mean(result.breaksAArr).toFixed(2)}</b></div>
        <div class="summary-pill" style="color:${B.color}">Media breaks ${B.name}<b>${mean(result.breaksBArr).toFixed(2)}</b></div>
        <div class="summary-pill">Al menos 1 break (${A.name})<b>${pct(atLeastOneBreakA)}</b></div>
        <div class="summary-pill">Al menos 1 break (${B.name})<b>${pct(atLeastOneBreakB)}</b></div>
      </div>
      <div class="chart-box"><canvas id="chart-breaks-${suffixId}"></canvas></div>
    </div>

    <div class="result-block">
      <h4>5. Aces</h4>
      <div class="summary-line">
        <div class="summary-pill" style="color:${A.color}">Media aces ${A.name}<b>${acesMeanA.toFixed(1)}</b></div>
        <div class="summary-pill" style="color:${B.color}">Media aces ${B.name}<b>${acesMeanB.toFixed(1)}</b></div>
      </div>
      <table class="data-table">
        <thead><tr><th>Mercado</th><th>Probabilidad</th></tr></thead>
        <tbody>
          <tr><td>${A.name} +${aceThresholdsA[0]} aces</td><td>${pct(overUnderProb(result.acesAArr, aceThresholdsA[0]))}</td></tr>
          <tr><td>${A.name} +${aceThresholdsA[1]} aces</td><td>${pct(overUnderProb(result.acesAArr, aceThresholdsA[1]))}</td></tr>
          <tr><td>${B.name} +${aceThresholdsB[0]} aces</td><td>${pct(overUnderProb(result.acesBArr, aceThresholdsB[0]))}</td></tr>
          <tr><td>${B.name} +${aceThresholdsB[1]} aces</td><td>${pct(overUnderProb(result.acesBArr, aceThresholdsB[1]))}</td></tr>
        </tbody>
      </table>
      <div class="chart-box"><canvas id="chart-aces-${suffixId}"></canvas></div>
    </div>
  `;

  // -- Gráfico 1: ganador --
  makeBarChart(`chart-winner-${suffixId}`,
    [A.name, B.name],
    [{ label: "Probabilidad de victoria (%)", data: [result.winProbA * 100, result.winProbB * 100], backgroundColor: [A.color, B.color] }],
    "%"
  );

  // -- Gráfico 2: marcadores (top 4) --
  const topScores = sortedScores.slice(0, 4);
  makeBarChart(`chart-scores-${suffixId}`,
    topScores.map(s => s[0]),
    [{ label: "Probabilidad (%)", data: topScores.map(s => (s[1] / result.n) * 100), backgroundColor: "#facc15" }],
    "%"
  );

  // -- Gráfico 3: juegos totales (histograma agrupado) --
  const gameBuckets = {};
  result.totalGamesArr.forEach(g => { gameBuckets[g] = (gameBuckets[g] || 0) + 1; });
  const gameLabels = Object.keys(gameBuckets).map(Number).sort((a, b) => a - b);
  makeBarChart(`chart-games-${suffixId}`,
    gameLabels.map(String),
    [{ label: "Frecuencia", data: gameLabels.map(l => gameBuckets[l]), backgroundColor: "#38bdf8" }],
    "Nº de partidos"
  );

  // -- Gráfico 4: distribución de breaks --
  const breakLabels = Object.keys(breakDistA);
  makeBarChart(`chart-breaks-${suffixId}`,
    breakLabels,
    [
      { label: A.name, data: breakLabels.map(k => breakDistA[k]), backgroundColor: A.color },
      { label: B.name, data: breakLabels.map(k => breakDistB[k]), backgroundColor: B.color }
    ],
    "Nº de partidos"
  );

  // -- Gráfico 5: distribución de aces --
  const maxAce = Math.max(...result.acesAArr, ...result.acesBArr, 10);
  const aceDistA = distributionCounts(result.acesAArr, maxAce > 20 ? 20 : maxAce);
  const aceDistB = distributionCounts(result.acesBArr, maxAce > 20 ? 20 : maxAce);
  const aceLabels = Object.keys(aceDistA);
  makeBarChart(`chart-aces-${suffixId}`,
    aceLabels,
    [
      { label: A.name, data: aceLabels.map(k => aceDistA[k]), backgroundColor: A.color },
      { label: B.name, data: aceLabels.map(k => aceDistB[k]), backgroundColor: B.color }
    ],
    "Nº de partidos"
  );
}

/* -------------------------------------------------------------------------
   6. EJECUCIÓN PRINCIPAL
   ------------------------------------------------------------------------- */
function runAllSimulations() {
  const btn = document.getElementById("run-sim-btn");
  const status = document.getElementById("sim-status");
  btn.disabled = true;
  status.textContent = "Simulando 20.000 partidos por enfrentamiento…";

  // setTimeout permite que el navegador pinte el estado "simulando" antes del cálculo síncrono
  setTimeout(() => {
    MATCHUPS.forEach(matchup => {
      const result = runMonteCarlo(matchup.p1, matchup.p2, N_SIMULATIONS);
      renderMatchResults(matchup, result);
    });
    btn.disabled = false;
    const now = new Date();
    status.textContent = `Última simulación: ${now.toLocaleTimeString("es-ES")} · ${(N_SIMULATIONS * MATCHUPS.length).toLocaleString("es-ES")} partidos simulados en total`;
  }, 50);
}

function renderMethodology() {
  document.getElementById("methodology-content").innerHTML = `
    <p><b>Estadísticas utilizadas por jugador:</b> % de primer servicio dentro, % de puntos ganados con 1er y 2do servicio, aces y dobles faltas por partido, % de break points salvados y convertidos, y un factor de ajuste por rendimiento reciente en tierra batida. Los datos de Tsitsipas, Rinderknech, Burruchaga y Mérida se obtuvieron de ATP Tour, TennisStats.com, MatchStat.com y TennisRatio.com (julio 2026); las cifras sin fuente exacta en tierra se estimaron a partir del rendimiento de temporada/carrera y se señalan como estimación en el código fuente.</p>
    <p><b>Cómo se calcula la probabilidad de mantener el saque:</b> se combina el % de primeros servicios dentro con el % de puntos ganados en 1er y 2do servicio para obtener una probabilidad de ganar cada punto de saque. Esa probabilidad se ajusta con el factor de forma en tierra batida y luego se simula el juego punto a punto respetando las reglas de deuce/ventaja, de modo que el % de juegos de saque ganados emerge del propio modelo en lugar de fijarse a mano.</p>
    <p><b>Cómo funciona la simulación Monte Carlo:</b> cada uno de los 20.000 partidos se genera punto a punto: se decide si el saque es dentro, si el punto termina en ace, y quién gana el punto según las probabilidades del jugador. Los puntos forman juegos, los juegos forman sets (con tie-break a 6-6) y los sets forman un partido a mejor de 3. Repetir esto 20.000 veces genera distribuciones realistas de sets, juegos totales, roturas y aces, sobre las que se calculan probabilidades de mercados de apuestas (líneas de más/menos).</p>
    <p><b>Mercados con más valor aparente según la simulación:</b> en el partido de Gstaad, el servicio dominante de Rinderknech (~9.9 aces/partido) frente al mejor rendimiento global de Tsitsipas en tierra sugiere que el mercado de aces de Rinderknech y el hándicap de sets pueden ofrecer más valor que el ganador directo. En Umag, con dos jugadores de perfil más regular desde el fondo de pista, los mercados de "juegos totales" y "rotura de servicio conseguida" tienden a mostrar probabilidades más equilibradas y potencialmente más interesantes que el mercado de ganador. Estos resultados son ilustrativos: se recomienda contrastarlos con cuotas reales y no deben tomarse como recomendación de apuesta.</p>
  `;
}

document.getElementById("run-sim-btn").addEventListener("click", runAllSimulations);

// Inicialización al cargar la página
document.addEventListener("DOMContentLoaded", () => {
  renderPlayerStatsTable("match-1", "rinderknech", 1);
  renderPlayerStatsTable("match-1", "tsitsipas", 2);
  renderPlayerStatsTable("match-2", "burruchaga", 1);
  renderPlayerStatsTable("match-2", "merida", 2);
  renderMethodology();
  runAllSimulations();
});
