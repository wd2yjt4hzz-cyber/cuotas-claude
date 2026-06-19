/* ===========================================================================
   MUNDIAL26 AI ANALYTICS — script.js  (REFACTOR v2)
   ===========================================================================
   Este archivo fue reescrito a fondo a partir de los errores reportados por
   el usuario. Resumen de cambios (ver README.md para el detalle completo):

   BUGS CORREGIDOS
   1. El filtro de "Jornada" se reiniciaba al 19/06 cada vez que se pulsaba
      "Actualizar datos". Causa: populateDateFilter() reconstruía el <select>
      y reasignaba App.filters.date en cada carga. Solución: la selección del
      usuario ahora se preserva (ver flag dateFilterInitialized y el
      parámetro preserveSelection de populateDateFilter()).
   2. El calendario embebido solo cubría 4 de los 12 grupos, así que algunos
      días mostraban menos partidos de los que realmente hay (p. ej. el
      20/06 no incluía Alemania-Costa de Marfil ni Países Bajos-Suecia).
      Solución: se ha sustituido por el calendario OFICIAL completo de los
      12 grupos / 72 partidos de fase de grupos (fuente: FIFA / ESPN,
      verificado manualmente, sin inventar cruces ni resultados).
   3. Búsqueda sensible a tildes ("mexico" no encontraba "México").
      Solución: comparación normalizada sin diacríticos.
   4. El selector de mercado y el de fecha no se recalculaban de forma
      coherente entre sí al activar el Modo Seguro. Solución: todo el
      filtrado pasa ahora por una única función getFilteredBets().

   CAMBIOS DE PRODUCTO
   - Sistema de confianza mucho más conservador (ver sección 6): exige el
     acuerdo de varias señales independientes (Elo, forma, xG, H2H) y ya no
     infla la confianza solo por un EV alto.
   - El ranking de apuestas ya NO ordena solo por EV: usa un "valueScore"
     que penaliza fuertemente las probabilidades bajas (favoritos largos /
     sorpresas poco realistas), y un "safeScore" específico para el Modo
     Seguro que prioriza probabilidad y confianza sobre el EV puro.
   - Modo Seguro: limita mercados a los robustos (más de 0.5/1.5 goles,
     doble oportunidad, córners 3.5/4.5, tiros a puerta, BTTS con respaldo
     estadístico) y exige confianza alta.
   - Cada recomendación incluye ahora una caja "RECOMENDACIÓN" con
     probabilidad, confianza y motivos en lenguaje claro.
   - Selector de partido único con análisis completo.
   - Estado de fuentes de datos siempre visible (real / en vivo / estimado).
   ========================================================================= */

(() => {
  'use strict';

  /* =========================================================================
     1. CONFIG Y ALMACENAMIENTO LOCAL
     ========================================================================= */
  const STORAGE_KEYS = {
    oddsApiKey: 'm26_odds_api_key',
    footballDataApiKey: 'm26_football_data_api_key',
    liveMode: 'm26_live_mode',
    safeMode: 'm26_safe_mode'
  };

  const Settings = {
    get oddsApiKey() { return localStorage.getItem(STORAGE_KEYS.oddsApiKey) || ''; },
    get footballDataApiKey() { return localStorage.getItem(STORAGE_KEYS.footballDataApiKey) || ''; },
    get liveMode() { return localStorage.getItem(STORAGE_KEYS.liveMode) === '1'; },
    get safeMode() {
      const v = localStorage.getItem(STORAGE_KEYS.safeMode);
      return v === null ? true : v === '1'; // Modo Seguro activado por defecto
    },
    save(odds, fd, live) {
      localStorage.setItem(STORAGE_KEYS.oddsApiKey, odds || '');
      localStorage.setItem(STORAGE_KEYS.footballDataApiKey, fd || '');
      localStorage.setItem(STORAGE_KEYS.liveMode, live ? '1' : '0');
    },
    setSafeMode(v) { localStorage.setItem(STORAGE_KEYS.safeMode, v ? '1' : '0'); },
    clear() {
      localStorage.removeItem(STORAGE_KEYS.oddsApiKey);
      localStorage.removeItem(STORAGE_KEYS.footballDataApiKey);
      localStorage.removeItem(STORAGE_KEYS.liveMode);
    }
  };

  const MODEL = {
    LEAGUE_AVG_XG: 1.35,
    HOST_ADV: 1.08,        // ventaja de localía SOLO para el país anfitrión jugando en su territorio
    MAX_GOALS: 6,
    BOOK_MARGIN: 1.07,     // overround típico de una casa de apuestas (~7%), algo más realista que v1
    MIN_PROB_SURFACE: 0.15 // ninguna recomendación se muestra si su probabilidad real es menor a esto
  };

  // Países anfitriones y las ciudades de cada uno (para aplicar localía real,
  // no localía "de etiqueta" como en la v1)
  const HOST_CITIES = {
    'México': ['Ciudad de México', 'Guadalajara', 'Monterrey'],
    'Estados Unidos': ['San Francisco', 'Nueva York/Nueva Jersey', 'Boston', 'Seattle', 'Filadelfia',
      'Los Ángeles', 'Miami', 'Atlanta', 'Houston', 'Kansas City', 'Dallas'],
    'Canadá': ['Toronto', 'Vancouver']
  };

  /* =========================================================================
     2. UTILIDADES
     ========================================================================= */
  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rngFor(...parts) { return mulberry32(hashString(parts.join('|'))); }
  function randRange(rng, min, max) { return min + rng() * (max - min); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function normalizeStr(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }

  const FACTORIALS = [1];
  for (let i = 1; i <= 12; i++) FACTORIALS.push(FACTORIALS[i - 1] * i);
  function poissonPMF(k, lambda) { return (Math.exp(-lambda) * Math.pow(lambda, k)) / FACTORIALS[k]; }
  function poissonOverProb(lambda, threshold) {
    let pUnder = 0;
    for (let k = 0; k <= Math.floor(threshold); k++) pUnder += poissonPMF(k, lambda);
    return clamp(1 - pUnder, 0.01, 0.99);
  }

  function fmtPct(v) { return `${Math.round(v * 100)}%`; }
  function fmtOdds(v) { return v.toFixed(2); }
  function fmtSigned(v, suffix = '') { return `${v >= 0 ? '+' : ''}${round1(v)}${suffix}`; }
  function formatKickoff(iso) {
    return new Date(iso).toLocaleString('es-ES', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function dateKey(iso) {
    return new Date(iso).toLocaleDateString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  /* =========================================================================
     3. BASE DE DATOS DE EQUIPOS Y PARTIDOS
     -------------------------------------------------------------------------
     Calendario OFICIAL completo de la fase de grupos del Mundial 2026 (12
     grupos, 72 partidos). Es la fuente de respaldo cuando no hay clave de
     football-data.org o la petición en vivo falla; NO es un calendario
     inventado ni parcial. Dos cruces de play-off intercontinental aún no
     resueltos en las fuentes consultadas se marcan explícitamente como
     "Repechaje Intercontinental 1/2" en lugar de adivinar el equipo.
     ========================================================================= */
  const TEAM_META = {
    'México': { code: 'MEX', flag: '🇲🇽', rating: { att: 72, def: 66, elo: 71 }, players: [['Santiago Giménez', 0.30], ['Hirving Lozano', 0.18], ['Raúl Jiménez', 0.16]] },
    'Sudáfrica': { code: 'RSA', flag: '🇿🇦', rating: { att: 54, def: 58, elo: 50 }, players: [['Percy Tau', 0.27], ['Lyle Foster', 0.20]] },
    'Corea del Sur': { code: 'KOR', flag: '🇰🇷', rating: { att: 69, def: 63, elo: 66 }, players: [['Son Heung-min', 0.34], ['Cho Gue-sung', 0.18]] },
    'Chequia': { code: 'CZE', flag: '🇨🇿', rating: { att: 65, def: 68, elo: 67 }, players: [['Patrik Schick', 0.30], ['Adam Hložek', 0.16]] },
    'Canadá': { code: 'CAN', flag: '🇨🇦', rating: { att: 68, def: 64, elo: 66 }, players: [['Jonathan David', 0.33], ['Alphonso Davies', 0.18]] },
    'Bosnia': { code: 'BIH', flag: '🇧🇦', rating: { att: 63, def: 62, elo: 64 }, players: [['Amar Rahmanović', 0.22], ['Benjamin Tahirović', 0.16]] },
    'Catar': { code: 'QAT', flag: '🇶🇦', rating: { att: 53, def: 56, elo: 49 }, players: [['Akram Afif', 0.31], ['Almoez Ali', 0.22]] },
    'Suiza': { code: 'SUI', flag: '🇨🇭', rating: { att: 70, def: 76, elo: 72 }, players: [['Breel Embolo', 0.26], ['Dan Ndoye', 0.20], ['Ruben Vargas', 0.15]] },
    'Brasil': { code: 'BRA', flag: '🇧🇷', rating: { att: 91, def: 77, elo: 90 }, players: [['Vinícius Júnior', 0.34], ['Rodrygo', 0.21], ['Raphinha', 0.19]] },
    'Marruecos': { code: 'MAR', flag: '🇲🇦', rating: { att: 75, def: 78, elo: 76 }, players: [['Brahim Díaz', 0.23], ['Achraf Hakimi', 0.17], ['Youssef En-Nesyri', 0.21]] },
    'Haití': { code: 'HAI', flag: '🇭🇹', rating: { att: 47, def: 49, elo: 43 }, players: [['Duckens Nazon', 0.25], ['Frantzdy Pierrot', 0.20]] },
    'Escocia': { code: 'SCO', flag: '🏴', rating: { att: 61, def: 66, elo: 62 }, players: [['Che Adams', 0.24], ['Lyndon Dykes', 0.19], ['Scott McTominay', 0.18]] },
    'Estados Unidos': { code: 'USA', flag: '🇺🇸', rating: { att: 74, def: 71, elo: 74 }, players: [['Christian Pulisic', 0.32], ['Folarin Balogun', 0.20]] },
    'Paraguay': { code: 'PAR', flag: '🇵🇾', rating: { att: 57, def: 63, elo: 56 }, players: [['Antonio Sanabria', 0.23], ['Miguel Almirón', 0.20]] },
    'Australia': { code: 'AUS', flag: '🇦🇺', rating: { att: 60, def: 64, elo: 59 }, players: [['Mitchell Duke', 0.22], ['Craig Goodwin', 0.16]] },
    'Turquía': { code: 'TUR', flag: '🇹🇷', rating: { att: 72, def: 66, elo: 70 }, players: [['Arda Güler', 0.23], ['Kerem Aktürkoğlu', 0.22]] },
    'Alemania': { code: 'GER', flag: '🇩🇪', rating: { att: 83, def: 75, elo: 85 }, players: [['Jamal Musiala', 0.28], ['Florian Wirtz', 0.22]] },
    'Curazao': { code: 'CUR', flag: '🇨🇼', rating: { att: 46, def: 50, elo: 48 }, players: [['Leandro Bacuna', 0.20], ['Shanon Cijntje', 0.14]] },
    'Costa de Marfil': { code: 'CIV', flag: '🇨🇮', rating: { att: 73, def: 66, elo: 71 }, players: [['Sébastien Haller', 0.26], ['Franck Kessié', 0.14]] },
    'Ecuador': { code: 'ECU', flag: '🇪🇨', rating: { att: 67, def: 70, elo: 70 }, players: [['Enner Valencia', 0.24], ['Kevin Rodríguez', 0.20]] },
    'Países Bajos': { code: 'NED', flag: '🇳🇱', rating: { att: 80, def: 74, elo: 83 }, players: [['Cody Gakpo', 0.26], ['Memphis Depay', 0.20]] },
    'Japón': { code: 'JPN', flag: '🇯🇵', rating: { att: 73, def: 72, elo: 74 }, players: [['Takefusa Kubo', 0.24], ['Kaoru Mitoma', 0.20]] },
    'Suecia': { code: 'SWE', flag: '🇸🇪', rating: { att: 67, def: 67, elo: 68 }, players: [['Alexander Isak', 0.34], ['Viktor Gyökeres', 0.26]] },
    'Túnez': { code: 'TUN', flag: '🇹🇳', rating: { att: 62, def: 66, elo: 64 }, players: [['Hannibal Mejbri', 0.18], ['Issam Jebali', 0.20]] },
    'Irán': { code: 'IRN', flag: '🇮🇷', rating: { att: 61, def: 64, elo: 63 }, players: [['Mehdi Taremi', 0.30], ['Sardar Azmoun', 0.20]] },
    'Nueva Zelanda': { code: 'NZL', flag: '🇳🇿', rating: { att: 52, def: 56, elo: 54 }, players: [['Chris Wood', 0.30], ['Max Mata', 0.16]] },
    'Bélgica': { code: 'BEL', flag: '🇧🇪', rating: { att: 79, def: 73, elo: 82 }, players: [['Romelu Lukaku', 0.28], ['Kevin De Bruyne', 0.18]] },
    'Egipto': { code: 'EGY', flag: '🇪🇬', rating: { att: 68, def: 68, elo: 70 }, players: [['Mohamed Salah', 0.34], ['Omar Marmoush', 0.20]] },
    'España': { code: 'ESP', flag: '🇪🇸', rating: { att: 87, def: 82, elo: 90 }, players: [['Lamine Yamal', 0.30], ['Nico Williams', 0.18]] },
    'Cabo Verde': { code: 'CPV', flag: '🇨🇻', rating: { att: 56, def: 60, elo: 58 }, players: [['Ryan Mendes', 0.22], ['Jamiro Monteiro', 0.16]] },
    'Arabia Saudita': { code: 'KSA', flag: '🇸🇦', rating: { att: 58, def: 60, elo: 60 }, players: [['Salem Al-Dawsari', 0.26], ['Firas Al-Buraikan', 0.18]] },
    'Uruguay': { code: 'URU', flag: '🇺🇾', rating: { att: 74, def: 77, elo: 78 }, players: [['Darwin Núñez', 0.30], ['Federico Valverde', 0.18]] },
    'Francia': { code: 'FRA', flag: '🇫🇷', rating: { att: 90, def: 80, elo: 92 }, players: [['Kylian Mbappé', 0.36], ['Ousmane Dembélé', 0.18]] },
    'Senegal': { code: 'SEN', flag: '🇸🇳', rating: { att: 74, def: 71, elo: 75 }, players: [['Sadio Mané', 0.28], ['Nicolas Jackson', 0.20]] },
    'Noruega': { code: 'NOR', flag: '🇳🇴', rating: { att: 75, def: 64, elo: 72 }, players: [['Erling Haaland', 0.42], ['Martin Ødegaard', 0.16]] },
    'Argentina': { code: 'ARG', flag: '🇦🇷', rating: { att: 86, def: 81, elo: 90 }, players: [['Julián Álvarez', 0.32], ['Lautaro Martínez', 0.22]] },
    'Argelia': { code: 'ALG', flag: '🇩🇿', rating: { att: 67, def: 63, elo: 66 }, players: [['Riyad Mahrez', 0.28], ['Baghdad Bounedjah', 0.18]] },
    'Austria': { code: 'AUT', flag: '🇦🇹', rating: { att: 70, def: 68, elo: 70 }, players: [['Marcel Sabitzer', 0.20], ['Michael Gregoritsch', 0.18]] },
    'Jordania': { code: 'JOR', flag: '🇯🇴', rating: { att: 50, def: 55, elo: 52 }, players: [['Yazan Al-Naimat', 0.22], ['Mousa Al-Tamari', 0.20]] },
    'Portugal': { code: 'POR', flag: '🇵🇹', rating: { att: 84, def: 76, elo: 86 }, players: [['Cristiano Ronaldo', 0.22], ['Rafael Leão', 0.20]] },
    'Uzbekistán': { code: 'UZB', flag: '🇺🇿', rating: { att: 54, def: 58, elo: 56 }, players: [['Eldor Shomurodov', 0.26], ['Jasurbek Yakhshiboev', 0.18]] },
    'Colombia': { code: 'COL', flag: '🇨🇴', rating: { att: 76, def: 70, elo: 77 }, players: [['Luis Díaz', 0.28], ['James Rodríguez', 0.18]] },
    'Inglaterra': { code: 'ENG', flag: '🏴', rating: { att: 85, def: 79, elo: 89 }, players: [['Harry Kane', 0.34], ['Phil Foden', 0.20]] },
    'Croacia': { code: 'CRO', flag: '🇭🇷', rating: { att: 75, def: 74, elo: 78 }, players: [['Andrej Kramarić', 0.24], ['Luka Modrić', 0.14]] },
    'Ghana': { code: 'GHA', flag: '🇬🇭', rating: { att: 64, def: 60, elo: 62 }, players: [['Mohammed Kudus', 0.28], ['Jordan Ayew', 0.18]] },
    'Panamá': { code: 'PAN', flag: '🇵🇦', rating: { att: 58, def: 62, elo: 60 }, players: [['José Fajardo', 0.20], ['Cecilio Waterman', 0.18]] },
    'Repechaje Intercontinental 1': { code: 'TBD', flag: '🏳️', rating: { att: 58, def: 60, elo: 56 }, players: [] },
    'Repechaje Intercontinental 2': { code: 'TBD', flag: '🏳️', rating: { att: 58, def: 60, elo: 56 }, players: [] }
  };

  const RAW_FIXTURES = [
    // Grupo A
    ['2026-06-11T19:00:00Z', 'A', 'Ciudad de México', 'México', 'Sudáfrica'],
    ['2026-06-12T02:00:00Z', 'A', 'Guadalajara', 'Corea del Sur', 'Chequia'],
    ['2026-06-18T16:00:00Z', 'A', 'Atlanta', 'Chequia', 'Sudáfrica'],
    ['2026-06-19T01:00:00Z', 'A', 'Guadalajara', 'México', 'Corea del Sur'],
    ['2026-06-25T01:00:00Z', 'A', 'Ciudad de México', 'Chequia', 'México'],
    ['2026-06-25T01:00:00Z', 'A', 'Monterrey', 'Sudáfrica', 'Corea del Sur'],
    // Grupo B
    ['2026-06-12T19:00:00Z', 'B', 'Toronto', 'Canadá', 'Bosnia'],
    ['2026-06-13T19:00:00Z', 'B', 'San Francisco', 'Catar', 'Suiza'],
    ['2026-06-18T19:00:00Z', 'B', 'Los Ángeles', 'Suiza', 'Bosnia'],
    ['2026-06-18T22:00:00Z', 'B', 'Vancouver', 'Canadá', 'Catar'],
    ['2026-06-24T19:00:00Z', 'B', 'Vancouver', 'Suiza', 'Canadá'],
    ['2026-06-24T19:00:00Z', 'B', 'Seattle', 'Bosnia', 'Catar'],
    // Grupo C
    ['2026-06-13T22:00:00Z', 'C', 'Nueva York/Nueva Jersey', 'Brasil', 'Marruecos'],
    ['2026-06-14T01:00:00Z', 'C', 'Boston', 'Haití', 'Escocia'],
    ['2026-06-19T22:00:00Z', 'C', 'Boston', 'Escocia', 'Marruecos'],
    ['2026-06-20T01:00:00Z', 'C', 'Filadelfia', 'Brasil', 'Haití'],
    ['2026-06-24T22:00:00Z', 'C', 'Miami', 'Escocia', 'Brasil'],
    ['2026-06-24T22:00:00Z', 'C', 'Atlanta', 'Marruecos', 'Haití'],
    // Grupo D
    ['2026-06-13T01:00:00Z', 'D', 'Los Ángeles', 'Estados Unidos', 'Paraguay'],
    ['2026-06-14T04:00:00Z', 'D', 'Vancouver', 'Australia', 'Turquía'],
    ['2026-06-19T19:00:00Z', 'D', 'Seattle', 'Estados Unidos', 'Australia'],
    ['2026-06-20T04:00:00Z', 'D', 'San Francisco', 'Turquía', 'Paraguay'],
    ['2026-06-26T02:00:00Z', 'D', 'Los Ángeles', 'Turquía', 'Estados Unidos'],
    ['2026-06-26T02:00:00Z', 'D', 'San Francisco', 'Paraguay', 'Australia'],
    // Grupo E
    ['2026-06-14T17:00:00Z', 'E', 'Houston', 'Alemania', 'Curazao'],
    ['2026-06-14T23:00:00Z', 'E', 'Filadelfia', 'Costa de Marfil', 'Ecuador'],
    ['2026-06-20T20:00:00Z', 'E', 'Toronto', 'Alemania', 'Costa de Marfil'],
    ['2026-06-21T00:00:00Z', 'E', 'Kansas City', 'Ecuador', 'Curazao'],
    ['2026-06-25T20:00:00Z', 'E', 'Nueva York/Nueva Jersey', 'Ecuador', 'Alemania'],
    ['2026-06-25T20:00:00Z', 'E', 'Filadelfia', 'Curazao', 'Costa de Marfil'],
    // Grupo F
    ['2026-06-14T20:00:00Z', 'F', 'Dallas', 'Países Bajos', 'Japón'],
    ['2026-06-15T02:00:00Z', 'F', 'Monterrey', 'Suecia', 'Túnez'],
    ['2026-06-20T17:00:00Z', 'F', 'Houston', 'Países Bajos', 'Suecia'],
    ['2026-06-21T04:00:00Z', 'F', 'Monterrey', 'Túnez', 'Japón'],
    ['2026-06-25T23:00:00Z', 'F', 'Dallas', 'Japón', 'Suecia'],
    ['2026-06-25T23:00:00Z', 'F', 'Kansas City', 'Túnez', 'Países Bajos'],
    // Grupo G
    ['2026-06-15T19:00:00Z', 'G', 'Seattle', 'Bélgica', 'Egipto'],
    ['2026-06-16T01:00:00Z', 'G', 'Los Ángeles', 'Irán', 'Nueva Zelanda'],
    ['2026-06-21T19:00:00Z', 'G', 'Los Ángeles', 'Bélgica', 'Irán'],
    ['2026-06-22T01:00:00Z', 'G', 'Vancouver', 'Nueva Zelanda', 'Egipto'],
    ['2026-06-27T03:00:00Z', 'G', 'Seattle', 'Egipto', 'Irán'],
    ['2026-06-27T03:00:00Z', 'G', 'Vancouver', 'Nueva Zelanda', 'Bélgica'],
    // Grupo H
    ['2026-06-15T16:00:00Z', 'H', 'Atlanta', 'España', 'Cabo Verde'],
    ['2026-06-15T22:00:00Z', 'H', 'Miami', 'Arabia Saudita', 'Uruguay'],
    ['2026-06-21T16:00:00Z', 'H', 'Atlanta', 'España', 'Arabia Saudita'],
    ['2026-06-21T22:00:00Z', 'H', 'Miami', 'Uruguay', 'Cabo Verde'],
    ['2026-06-27T00:00:00Z', 'H', 'Houston', 'Cabo Verde', 'Arabia Saudita'],
    ['2026-06-27T00:00:00Z', 'H', 'Guadalajara', 'Uruguay', 'España'],
    // Grupo I
    ['2026-06-16T19:00:00Z', 'I', 'Nueva York/Nueva Jersey', 'Francia', 'Senegal'],
    ['2026-06-16T22:00:00Z', 'I', 'Boston', 'Repechaje Intercontinental 2', 'Noruega'],
    ['2026-06-22T21:00:00Z', 'I', 'Filadelfia', 'Francia', 'Repechaje Intercontinental 2'],
    ['2026-06-23T00:00:00Z', 'I', 'Nueva York/Nueva Jersey', 'Noruega', 'Senegal'],
    ['2026-06-26T19:00:00Z', 'I', 'Boston', 'Noruega', 'Francia'],
    ['2026-06-26T19:00:00Z', 'I', 'Toronto', 'Senegal', 'Repechaje Intercontinental 2'],
    // Grupo J
    ['2026-06-17T01:00:00Z', 'J', 'Kansas City', 'Argentina', 'Argelia'],
    ['2026-06-17T04:00:00Z', 'J', 'San Francisco', 'Austria', 'Jordania'],
    ['2026-06-22T17:00:00Z', 'J', 'Dallas', 'Argentina', 'Austria'],
    ['2026-06-23T03:00:00Z', 'J', 'San Francisco', 'Jordania', 'Argelia'],
    ['2026-06-28T02:00:00Z', 'J', 'Kansas City', 'Argelia', 'Austria'],
    ['2026-06-28T02:00:00Z', 'J', 'Dallas', 'Jordania', 'Argentina'],
    // Grupo K
    ['2026-06-17T17:00:00Z', 'K', 'Houston', 'Portugal', 'Repechaje Intercontinental 1'],
    ['2026-06-18T02:00:00Z', 'K', 'Ciudad de México', 'Uzbekistán', 'Colombia'],
    ['2026-06-23T17:00:00Z', 'K', 'Houston', 'Portugal', 'Uzbekistán'],
    ['2026-06-24T02:00:00Z', 'K', 'Guadalajara', 'Colombia', 'Repechaje Intercontinental 1'],
    ['2026-06-27T23:30:00Z', 'K', 'Miami', 'Colombia', 'Portugal'],
    ['2026-06-27T23:30:00Z', 'K', 'Atlanta', 'Repechaje Intercontinental 1', 'Uzbekistán'],
    // Grupo L
    ['2026-06-17T20:00:00Z', 'L', 'Dallas', 'Inglaterra', 'Croacia'],
    ['2026-06-17T23:00:00Z', 'L', 'Toronto', 'Ghana', 'Panamá'],
    ['2026-06-23T20:00:00Z', 'L', 'Boston', 'Inglaterra', 'Ghana'],
    ['2026-06-23T23:00:00Z', 'L', 'Toronto', 'Panamá', 'Croacia'],
    ['2026-06-27T21:00:00Z', 'L', 'Nueva York/Nueva Jersey', 'Panamá', 'Inglaterra'],
    ['2026-06-27T21:00:00Z', 'L', 'Filadelfia', 'Croacia', 'Ghana']
  ];

  const STADIUM_BY_CITY = {
    'Ciudad de México': 'Estadio Azteca', 'Guadalajara': 'Estadio Akron', 'Monterrey': 'Estadio BBVA',
    'Toronto': 'BMO Field', 'Vancouver': 'BC Place', 'San Francisco': "Levi's Stadium",
    'Nueva York/Nueva Jersey': 'MetLife Stadium', 'Boston': 'Gillette Stadium', 'Seattle': 'Lumen Field',
    'Filadelfia': 'Lincoln Financial Field', 'Los Ángeles': 'SoFi Stadium', 'Miami': 'Hard Rock Stadium',
    'Atlanta': 'Mercedes-Benz Stadium', 'Houston': 'NRG Stadium', 'Kansas City': 'Arrowhead Stadium',
    'Dallas': 'AT&T Stadium'
  };

  const FALLBACK_FIXTURES = RAW_FIXTURES.map(([date, group, city, home, away], i) => ({
    id: `m26-${i + 1}`, date, group, city, stadium: STADIUM_BY_CITY[city] || city, home, away, scheduleSource: 'static-real'
  }));

  function hostAdvantageTeam(fixture) {
    for (const [team, cities] of Object.entries(HOST_CITIES)) {
      if (cities.includes(fixture.city) && (fixture.home === team || fixture.away === team)) return team;
    }
    return null;
  }

  /* =========================================================================
     4. CAPA DE DATOS — APIs reales con estado explícito (no se inventa nada)
     ========================================================================= */

  // Devuelve { data, status }. status: 'live' | 'not-configured' | 'error'
  async function tryFetchLiveFixtures() {
    if (!Settings.liveMode || !Settings.footballDataApiKey) return { data: null, status: 'not-configured' };
    try {
      const res = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
        headers: { 'X-Auth-Token': Settings.footballDataApiKey }
      });
      if (!res.ok) return { data: null, status: 'error' };
      const json = await res.json();
      if (!json.matches || !json.matches.length) return { data: null, status: 'error' };
      const data = json.matches.map((m, i) => ({
        id: `live-${i}`, date: m.utcDate, group: (m.group || '').replace('GROUP_', ''),
        city: m.venue || m.area?.name || '', stadium: m.venue || '',
        home: m.homeTeam?.name || 'Local', away: m.awayTeam?.name || 'Visitante', scheduleSource: 'live-api'
      }));
      return { data, status: 'live' };
    } catch (err) {
      console.warn('[MUNDIAL26] football-data.org no respondió. Se usa el calendario oficial embebido.', err);
      return { data: null, status: 'error' };
    }
  }

  async function tryFetchLiveOdds() {
    if (!Settings.liveMode || !Settings.oddsApiKey) return { data: null, status: 'not-configured' };
    try {
      const url = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${encodeURIComponent(Settings.oddsApiKey)}`;
      const res = await fetch(url);
      if (!res.ok) return { data: null, status: 'error' };
      const json = await res.json();
      const map = {};
      json.forEach(ev => {
        const book = ev.bookmakers.find(b => b.key === 'bet365') || ev.bookmakers[0];
        const market = book?.markets.find(m => m.key === 'h2h');
        if (!market) return;
        const odds = {};
        market.outcomes.forEach(o => {
          if (o.name === ev.home_team) odds.home = o.price;
          else if (o.name === ev.away_team) odds.away = o.price;
          else odds.draw = o.price;
        });
        map[`${ev.home_team}|${ev.away_team}`] = { ...odds, bookmaker: book.title };
      });
      return { data: map, status: 'live' };
    } catch (err) {
      console.warn('[MUNDIAL26] The Odds API no respondió. Se usan cuotas simuladas.', err);
      return { data: null, status: 'error' };
    }
  }

  /* =========================================================================
     5. MODELO ESTADÍSTICO DE EQUIPOS
     -------------------------------------------------------------------------
     IMPORTANTE: ninguna API gratuita y accesible desde un frontend estático
     ofrece xG, tiros, córners, tarjetas, posesión, lesiones o alineaciones de
     selecciones nacionales. Estos valores son SIEMPRE una estimación del
     modelo (determinista, misma selección -> mismos números en cada carga),
     nunca un dato real disfrazado. Se etiquetan como "ESTIMADO" en toda la
     interfaz.
     ========================================================================= */
  const teamStatsCache = new Map();

  function getTeamStats(teamName, jitterSeed = '') {
    const cacheKey = teamName + '::' + jitterSeed;
    if (teamStatsCache.has(cacheKey)) return teamStatsCache.get(cacheKey);

    const meta = TEAM_META[teamName] || { code: teamName.slice(0, 3).toUpperCase(), flag: '🏳️', rating: { att: 60, def: 60, elo: 58 }, players: [] };
    const rng = rngFor('stats', teamName, jitterSeed);
    const { att, def, elo } = meta.rating;

    const xgFor = clamp(0.55 + (att / 100) * 2.05 + randRange(rng, -0.08, 0.08), 0.4, 3.0);
    const xgAgainst = clamp(0.55 + ((100 - def) / 100) * 2.05 + randRange(rng, -0.08, 0.08), 0.35, 2.8);

    // Últimos 10 partidos (oldest -> newest). last5 = los 5 más recientes.
    const last10 = [];
    for (let i = 0; i < 10; i++) {
      const r = rng();
      const winProb = clamp(0.28 + (elo - 50) / 140, 0.08, 0.74);
      const drawProb = 0.25;
      let result, gf, ga;
      if (r < winProb) { result = 'W'; gf = Math.round(randRange(rng, 1, 3)); ga = Math.round(randRange(rng, 0, gf)); }
      else if (r < winProb + drawProb) { result = 'D'; gf = Math.round(randRange(rng, 0, 2)); ga = gf; }
      else { result = 'L'; ga = Math.round(randRange(rng, 1, 3)); gf = Math.round(randRange(rng, 0, ga)); }
      last10.push({ result, gf, ga });
    }
    const last5 = last10.slice(5);
    const sumPts = arr => arr.reduce((s, r) => s + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0);
    const points10 = sumPts(last10), points5 = sumPts(last5);
    const goalsFor10 = last10.reduce((s, r) => s + r.gf, 0), goalsAgainst10 = last10.reduce((s, r) => s + r.ga, 0);
    const goalsFor5 = last5.reduce((s, r) => s + r.gf, 0), goalsAgainst5 = last5.reduce((s, r) => s + r.ga, 0);
    const scoringRate = last10.filter(r => r.gf > 0).length / 10;
    const concedingRate = last10.filter(r => r.ga > 0).length / 10;

    const shotsTotal = clamp(7.5 + (att / 100) * 13.5 + randRange(rng, -1, 1), 6, 23);
    const shotsOnTarget = clamp(shotsTotal * randRange(rng, 0.32, 0.42), 2, 11);
    const corners = clamp(3.2 + (att / 100) * 4.6 + randRange(rng, -0.6, 0.6), 2, 9);
    const cardsAvg = clamp(1.4 + randRange(rng, -0.5, 1.3), 0.8, 4.2);
    const possession = clamp(36 + (att / 100) * 26 + randRange(rng, -3, 3), 32, 68);

    const injuryCount = rng() < 0.35 ? (rng() < 0.5 ? 1 : 2) : 0;
    const injuries = [];
    const statuses = ['Duda (molestia muscular)', 'Baja confirmada', 'Sancionado (acumulación de tarjetas)'];
    for (let i = 0; i < injuryCount; i++) {
      const player = meta.players[i % (meta.players.length || 1)];
      if (player) injuries.push({ name: player[0], status: statuses[Math.floor(rng() * statuses.length)] });
    }

    const stats = {
      code: meta.code, flag: meta.flag, rating: meta.rating, players: meta.players,
      xgFor: round2(xgFor), xgAgainst: round2(xgAgainst),
      last10, last5, points10, points5, goalsFor10, goalsAgainst10, goalsFor5, goalsAgainst5,
      scoringRate, concedingRate,
      shotsTotal: round1(shotsTotal), shotsOnTarget: round1(shotsOnTarget),
      corners: round1(corners), cardsAvg: round1(cardsAvg), possession: round1(possession),
      injuries
    };
    teamStatsCache.set(cacheKey, stats);
    return stats;
  }

  function getH2H(homeName, awayName) {
    const rng = rngFor('h2h', homeName, awayName);
    const n = 2 + Math.floor(rng() * 3);
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
     6. MOTOR DE PREDICCIÓN
     ========================================================================= */
  function buildScoreMatrix(lambdaHome, lambdaAway) {
    const n = MODEL.MAX_GOALS, matrix = [];
    for (let i = 0; i <= n; i++) {
      const row = [];
      for (let j = 0; j <= n; j++) row.push(poissonPMF(i, lambdaHome) * poissonPMF(j, lambdaAway));
      matrix.push(row);
    }
    return matrix;
  }

  function analyzeGoalMarkets(matrix) {
    const n = MODEL.MAX_GOALS;
    let pHome = 0, pDraw = 0, pAway = 0;
    const pZeroZero = matrix[0][0];
    const pOver = { '0.5': 0, '1.5': 0, '2.5': 0, '3.5': 0 };
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
    return { pHome, pDraw, pAway, pOver, pBtts, topScorelines: scorelines.slice(0, 3) };
  }

  function analyzeMatch(fixture, liveOddsMap, refreshSalt, liveDataBonus) {
    const home = getTeamStats(fixture.home, refreshSalt);
    const away = getTeamStats(fixture.away, refreshSalt);

    // --- Localía real: solo el país anfitrión, solo en su propio territorio ---
    const advTeam = hostAdvantageTeam(fixture);
    const homeBoost = advTeam === fixture.home ? MODEL.HOST_ADV : 1;
    const awayBoost = advTeam === fixture.away ? MODEL.HOST_ADV : 1;

    const attHome = home.xgFor / MODEL.LEAGUE_AVG_XG, defHome = home.xgAgainst / MODEL.LEAGUE_AVG_XG;
    const attAway = away.xgFor / MODEL.LEAGUE_AVG_XG, defAway = away.xgAgainst / MODEL.LEAGUE_AVG_XG;
    let lambdaHome = clamp(MODEL.LEAGUE_AVG_XG * attHome * defAway * homeBoost, 0.3, 3.6);
    let lambdaAway = clamp(MODEL.LEAGUE_AVG_XG * attAway * defHome * awayBoost, 0.25, 3.3);

    const matrix = buildScoreMatrix(lambdaHome, lambdaAway);
    const goals = analyzeGoalMarkets(matrix);

    const expCornersHome = round1(home.corners * 1.04), expCornersAway = round1(away.corners * 0.96);
    const totalCornersLambda = expCornersHome + expCornersAway;
    const corners = {
      home: expCornersHome, away: expCornersAway, total: round1(totalCornersLambda),
      over35: poissonOverProb(totalCornersLambda, 3.5), over45: poissonOverProb(totalCornersLambda, 4.5),
      over85: poissonOverProb(totalCornersLambda, 8.5), over95: poissonOverProb(totalCornersLambda, 9.5)
    };

    const totalCardsLambda = home.cardsAvg + away.cardsAvg;
    const cards = { home: home.cardsAvg, away: away.cardsAvg, total: round1(totalCardsLambda), over35: poissonOverProb(totalCardsLambda, 3.5) };

    const scorerPool = [];
    [[home, lambdaHome], [away, lambdaAway]].forEach(([team, lambda]) => {
      team.players.forEach(([name, weight]) => scorerPool.push({ name, team: team.code, prob: clamp(weight * (lambda / 1.4), 0.02, 0.55) }));
    });
    scorerPool.sort((a, b) => b.prob - a.prob);

    const h2h = getH2H(fixture.home, fixture.away);

    const liveKey = `${fixture.home}|${fixture.away}`;
    const live = liveOddsMap && liveOddsMap[liveKey];
    const odds = live
      ? { home: live.home, draw: live.draw, away: live.away, source: live.bookmaker || 'Bet365 (en vivo)', isLive: true }
      : simulateBookOdds({ home: goals.pHome, draw: goals.pDraw, away: goals.pAway }, fixture.id, refreshSalt);

    // --- Señales independientes para el índice de confianza ---
    const predictedOutcome = goals.pHome >= goals.pDraw && goals.pHome >= goals.pAway ? 'home'
      : goals.pAway >= goals.pDraw ? 'away' : 'draw';

    const eloDiff = (home.rating.elo + (homeBoost > 1 ? 3 : 0)) - (away.rating.elo + (awayBoost > 1 ? 3 : 0));
    const eloSignal = eloDiff > 4 ? 'home' : eloDiff < -4 ? 'away' : 'draw';
    const formDiff = (home.points10 / 10) - (away.points10 / 10);
    const formSignal = formDiff > 0.3 ? 'home' : formDiff < -0.3 ? 'away' : 'draw';
    const xgDiff = (home.xgFor - home.xgAgainst) - (away.xgFor - away.xgAgainst);
    const xgSignal = xgDiff > 0.25 ? 'home' : xgDiff < -0.25 ? 'away' : 'draw';
    const h2hHomeWins = h2h.filter(g => g.hg > g.ag).length, h2hAwayWins = h2h.filter(g => g.ag > g.hg).length;
    const h2hSignal = h2hHomeWins > h2hAwayWins ? 'home' : h2hAwayWins > h2hHomeWins ? 'away' : 'draw';
    const signals = [eloSignal, formSignal, xgSignal, h2hSignal];
    const signalAgreement = signals.filter(s => s === predictedOutcome).length / signals.length;

    const sortedProbs = [goals.pHome, goals.pDraw, goals.pAway].sort((a, b) => b - a);
    const marginFactor = sortedProbs[0] - sortedProbs[1];
    const dataQuality = liveDataBonus ? 0.85 : 0.75;
    const bestBookProb = Math.max(1 / odds.home, 1 / odds.draw, 1 / odds.away);
    const oddsAgreement = 1 - clamp(Math.abs(sortedProbs[0] - bestBookProb), 0, 1);

    // Fórmula de confianza deliberadamente conservadora: exige acuerdo entre
    // varias señales, no solo separación de probabilidades. Techo práctico
    // ~92, no 97+ como en la v1.
    const confidence = Math.round(clamp(
      marginFactor * 100 * 0.35 +
      signalAgreement * 100 * 0.35 +
      dataQuality * 100 * 0.15 +
      oddsAgreement * 100 * 0.15,
      5, 92
    ));

    // --- BTTS: solo se marca "respaldo estadístico" si ambos equipos lo sustentan ---
    const bttsBacked = home.scoringRate >= 0.6 && away.concedingRate >= 0.5 && away.scoringRate >= 0.6 && home.concedingRate >= 0.5;

    const valueBets = buildValueBets(fixture, goals, corners, cards, odds, home, away, bttsBacked);
    valueBets.forEach(b => { b.valueScore = computeValueScore(b, confidence); b.safeScoreVal = computeSafeScore(b, confidence); });

    const eligible = b => b.prob >= MODEL.MIN_PROB_SURFACE;
    const bestValueBet = valueBets.filter(eligible).reduce((best, b) => (b.valueScore > (best?.valueScore ?? -Infinity) ? b : best), null);
    const safeCandidates = valueBets.filter(b => b.safe && b.prob >= 0.45 && confidence >= 55);
    const safeRecommendation = safeCandidates.reduce((best, b) => (b.safeScoreVal > (best?.safeScoreVal ?? -Infinity) ? b : best), null);

    let risk;
    if (confidence >= 70 && safeRecommendation) risk = 'low';
    else if (confidence >= 50) risk = 'medium';
    else risk = 'high';

    return {
      fixture, home, away, lambdaHome: round2(lambdaHome), lambdaAway: round2(lambdaAway),
      goals, corners, cards, scorerPool, h2h, odds, valueBets,
      confidence, risk, bestValueBet, safeRecommendation, predictedOutcome,
      signalAgreement, hostAdvantageTeam: advTeam, bttsBacked
    };
  }

  /* =========================================================================
     7. CUOTAS, VALUE BETS Y SISTEMA DE PUNTUACIÓN EQUILIBRADO
     -------------------------------------------------------------------------
     v1 ordenaba "mejores apuestas" solo por EV, lo que sacaba a la luz
     sorpresas matemáticamente atractivas pero poco realistas (favoritos
     largos). v2 introduce dos puntuaciones distintas:
       - valueScore: para el ranking general. Penaliza fuertemente la
         probabilidad baja (probWeightFactor) y pondera por la confianza
         del partido.
       - safeScore: para el Modo Seguro. Prioriza probabilidad y confianza,
         el EV es solo un desempate menor.
     ========================================================================= */
  function simulateBookOdds(modelProbs, matchId, refreshSalt) {
    const rng = rngFor('odds', matchId, refreshSalt);
    const noisy = {}; let sum = 0;
    Object.entries(modelProbs).forEach(([k, p]) => {
      const noise = randRange(rng, 0.95, 1.07); // ruido más contenido que en v1 (menos EV artificial)
      noisy[k] = clamp(p * noise, 0.02, 0.95);
      sum += noisy[k];
    });
    const out = { isLive: false, source: 'Simulado (modo demo)' };
    Object.entries(noisy).forEach(([k, p]) => { out[k] = round2(1 / ((p / sum) * MODEL.BOOK_MARGIN)); });
    return out;
  }

  function impliedProb(odds) { return 1 / odds; }
  function fairOdds(prob) { return prob > 0.001 ? round2(1 / prob) : 99; }
  function calcEdge(modelProb, bookOdds) { return (modelProb - impliedProb(bookOdds)) * 100; }
  function calcEV(modelProb, bookOdds) { return (modelProb * bookOdds - 1) * 100; }

  // Penaliza fuertemente las probabilidades bajas: una "sorpresa" con EV
  // teórico alto pero probabilidad real baja deja de dominar el ranking.
  function probWeightFactor(prob) {
    if (prob < 0.15) return 0.04;
    if (prob < 0.25) return 0.20;
    if (prob < 0.35) return 0.45;
    if (prob < 0.50) return 0.75;
    return 1.0;
  }
  function computeValueScore(bet, confidence) {
    return bet.ev * probWeightFactor(bet.prob) * (0.5 + 0.5 * confidence / 100);
  }
  function computeSafeScore(bet, confidence) {
    return bet.prob * 0.7 + (confidence / 100) * 0.3;
  }

  function buildValueBets(fixture, goals, corners, cards, odds, home, away, bttsBacked) {
    const bets = [];
    const push = (market, selection, prob, bookOdds, safe) => {
      bets.push({ matchId: fixture.id, market, selection, prob, bookOdds, fairOdds: fairOdds(prob), edge: calcEdge(prob, bookOdds), ev: calcEV(prob, bookOdds), safe: !!safe });
    };

    // 1X2 — no se marca "seguro": la victoria directa siempre tiene más riesgo que la doble oportunidad
    push('1X2', `Gana ${fixture.home}`, goals.pHome, odds.home, false);
    push('1X2', 'Empate', goals.pDraw, odds.draw, false);
    push('1X2', `Gana ${fixture.away}`, goals.pAway, odds.away, false);

    // Doble oportunidad — mercado seguro recomendado explícitamente por el brief
    const dc1X = goals.pHome + goals.pDraw, dcX2 = goals.pDraw + goals.pAway, dc12 = goals.pHome + goals.pAway;
    push('double_chance', `${fixture.home} o empate (1X)`, dc1X, round2(1 / (dc1X * MODEL.BOOK_MARGIN)), true);
    push('double_chance', `Empate o ${fixture.away} (X2)`, dcX2, round2(1 / (dcX2 * MODEL.BOOK_MARGIN)), true);
    push('double_chance', `${fixture.home} o ${fixture.away} (12)`, dc12, round2(1 / (dc12 * MODEL.BOOK_MARGIN)), true);

    // Goles — solo 0.5 y 1.5 se consideran "seguros"; 2.5/3.5 son más inciertos
    push('goals', 'Más de 0.5 goles', goals.pOver['0.5'], round2(1 / (goals.pOver['0.5'] * MODEL.BOOK_MARGIN)), true);
    push('goals', 'Más de 1.5 goles', goals.pOver['1.5'], round2(1 / (goals.pOver['1.5'] * MODEL.BOOK_MARGIN)), true);
    push('goals', 'Más de 2.5 goles', goals.pOver['2.5'], round2(1 / (goals.pOver['2.5'] * MODEL.BOOK_MARGIN)), false);
    push('goals', 'Más de 3.5 goles', goals.pOver['3.5'], round2(1 / (goals.pOver['3.5'] * MODEL.BOOK_MARGIN)), false);

    // BTTS — solo "seguro" si hay respaldo estadístico real de ambos equipos
    push('btts', 'Ambos equipos marcan', goals.pBtts, round2(1 / (goals.pBtts * MODEL.BOOK_MARGIN)), bttsBacked);

    // Córners — 3.5/4.5 son líneas muy altas de probabilidad (seguras); 8.5/9.5 son más ajustadas
    push('corners', 'Más de 3.5 córners', corners.over35, round2(1 / (corners.over35 * MODEL.BOOK_MARGIN)), true);
    push('corners', 'Más de 4.5 córners', corners.over45, round2(1 / (corners.over45 * MODEL.BOOK_MARGIN)), true);
    push('corners', 'Más de 8.5 córners (total)', corners.over85, round2(1 / (corners.over85 * MODEL.BOOK_MARGIN)), false);

    // Tiros a puerta por equipo — mercado seguro
    const homeShotsOver = poissonOverProb(home.shotsOnTarget, 3.5);
    const awayShotsOver = poissonOverProb(away.shotsOnTarget, 3.5);
    push('team_shots', `${fixture.home}: más de 3.5 tiros a puerta`, homeShotsOver, round2(1 / (homeShotsOver * MODEL.BOOK_MARGIN)), true);
    push('team_shots', `${fixture.away}: más de 3.5 tiros a puerta`, awayShotsOver, round2(1 / (awayShotsOver * MODEL.BOOK_MARGIN)), true);

    // Tarjetas — no seguro (más variable, depende mucho del árbitro)
    push('cards', 'Más de 3.5 tarjetas', cards.over35, round2(1 / (cards.over35 * MODEL.BOOK_MARGIN)), false);

    // Resultado exacto — explícitamente especulativo, nunca "seguro"
    const topScore = goals.topScorelines[0];
    push('correct_score', `Resultado exacto ${topScore.h}-${topScore.a}`, topScore.p, round2(1 / (topScore.p * MODEL.BOOK_MARGIN)), false);

    return bets;
  }

  /* =========================================================================
     8. MOTIVOS (EXPLICACIÓN DE LA RECOMENDACIÓN)
     ========================================================================= */
  function buildReasons(a, bet) {
    const f = a.fixture, reasons = [];
    if (bet.market === '1X2' || bet.market === 'double_chance') {
      const eloHome = a.home.rating.elo, eloAway = a.away.rating.elo, diff = eloHome - eloAway;
      if (Math.abs(diff) >= 4) reasons.push(`Diferencia de nivel estimada (Elo): ${diff > 0 ? f.home : f.away} +${Math.abs(diff)} sobre ${diff > 0 ? f.away : f.home}.`);
      reasons.push(`Forma (últ. 10 partidos): ${f.home} ${a.home.points10}/30 pts — ${f.away} ${a.away.points10}/30 pts.`);
      reasons.push(`xG neto por partido (estimado): ${f.home} ${round2(a.home.xgFor - a.home.xgAgainst)} — ${f.away} ${round2(a.away.xgFor - a.away.xgAgainst)}.`);
      const hw = a.h2h.filter(g => g.hg > g.ag).length, aw = a.h2h.filter(g => g.ag > g.hg).length;
      reasons.push(`Histórico directo (estimado): ${f.home} ${hw}V — ${f.away} ${aw}V en ${a.h2h.length} precedentes.`);
      reasons.push(`${Math.round(a.signalAgreement * 4)}/4 indicadores del modelo coinciden con esta lectura.`);
      if (a.hostAdvantageTeam) reasons.push(`${a.hostAdvantageTeam} juega como anfitrión en ${f.city}: pequeña ventaja de localía aplicada.`);
    } else if (bet.market === 'goals') {
      reasons.push(`Goles esperados combinados (modelo): ${round2(a.lambdaHome + a.lambdaAway)} por partido.`);
      reasons.push(`${f.home} marcó en el ${Math.round(a.home.scoringRate * 100)}% de sus últimos 10 partidos.`);
      reasons.push(`${f.away} marcó en el ${Math.round(a.away.scoringRate * 100)}% de sus últimos 10 partidos.`);
      reasons.push(`Tiros a puerta combinados (estimado): ${round1(a.home.shotsOnTarget + a.away.shotsOnTarget)} por partido.`);
    } else if (bet.market === 'btts') {
      reasons.push(`${f.home}: marcó en el ${Math.round(a.home.scoringRate * 100)}% y encajó en el ${Math.round(a.home.concedingRate * 100)}% de sus últ. 10 partidos.`);
      reasons.push(`${f.away}: marcó en el ${Math.round(a.away.scoringRate * 100)}% y encajó en el ${Math.round(a.away.concedingRate * 100)}% de sus últ. 10 partidos.`);
      reasons.push(a.bttsBacked ? 'Ambos equipos muestran respaldo estadístico suficiente para este mercado.' : 'Respaldo estadístico limitado: se muestra con cautela, fuera del Modo Seguro.');
    } else if (bet.market === 'corners') {
      reasons.push(`Córners combinados esperados (estimado): ${a.corners.total} por partido.`);
      reasons.push(`${f.home} promedia ${a.corners.home} córners propios; ${f.away} promedia ${a.corners.away}.`);
    } else if (bet.market === 'team_shots') {
      const isHome = bet.selection.startsWith(f.home);
      const team = isHome ? a.home : a.away, name = isHome ? f.home : f.away;
      reasons.push(`${name} promedia (estimado) ${team.shotsOnTarget} tiros a puerta por partido en sus últimos 10 encuentros.`);
      reasons.push(`${name} promedia ${team.shotsTotal} tiros totales por partido.`);
    } else if (bet.market === 'cards') {
      reasons.push(`Media de tarjetas combinada (estimada): ${a.cards.total} por partido.`);
      reasons.push('Mercado de mayor varianza (depende del árbitro): fuera del Modo Seguro.');
    } else {
      reasons.push('Mercado especulativo (probabilidad baja, alta varianza): no se recomienda como apuesta principal.');
    }
    return reasons;
  }

  /* =========================================================================
     9. ESTADO DE LA APP Y RENDERIZADO
     ========================================================================= */
  const App = {
    analyses: [], liveOddsMap: null, refreshSalt: 'v1',
    filters: { market: 'all', date: 'all', search: '', sort: 'confidence' },
    safeMode: Settings.safeMode,
    fixtureStatus: 'not-configured', oddsStatus: 'not-configured',
    dateFilterInitialized: false,
    chartConfidence: null, chartEV: null, chartRisk: null
  };

  async function loadAllData() {
    setRefreshing(true);
    const [fx, od] = await Promise.all([tryFetchLiveFixtures(), tryFetchLiveOdds()]);
    App.fixtureStatus = fx.status; App.oddsStatus = od.status;
    const fixtures = fx.data || FALLBACK_FIXTURES;
    App.liveOddsMap = od.data;
    App.refreshSalt = String(Date.now());

    const liveDataBonus = fx.status === 'live' || od.status === 'live';
    App.analyses = fixtures.map(f => analyzeMatch(f, od.data, App.refreshSalt, liveDataBonus));

    renderSourceStrip();
    populateDateFilter(App.dateFilterInitialized); // BUGFIX #1: preserva la selección del usuario en refrescos posteriores
    App.dateFilterInitialized = true;
    populateMatchSelector();
    renderAll();
    setRefreshing(false);
  }

  function setRefreshing(isLoading) {
    const btn = document.getElementById('refreshBtn');
    btn.classList.toggle('is-loading', isLoading);
    btn.disabled = isLoading;
  }

  function renderSourceStrip() {
    const fxChip = App.fixtureStatus === 'live'
      ? { dot: 'dot-live', text: 'Calendario: <strong>EN VIVO</strong> (football-data.org)' }
      : App.fixtureStatus === 'error'
        ? { dot: 'dot-error', text: 'Calendario en vivo: error de conexión — usando calendario oficial embebido' }
        : { dot: 'dot-static', text: 'Calendario: <strong>REAL</strong> (fase de grupos oficial, verificado, no en vivo)' };

    const odChip = App.oddsStatus === 'live'
      ? { dot: 'dot-live', text: 'Cuotas: <strong>EN VIVO</strong> (' + (App.analyses[0]?.odds?.source || 'The Odds API') + ')' }
      : App.oddsStatus === 'error'
        ? { dot: 'dot-error', text: 'Cuotas en vivo: error de conexión — usando cuotas simuladas' }
        : { dot: 'dot-estimated', text: 'Cuotas: <strong>SIMULADAS</strong> (modelo + margen de casa)' };

    const statsChip = { dot: 'dot-estimated', text: 'xG / tiros / córners / tarjetas: <strong>ESTIMADOS</strong> (sin API gratuita de frontend disponible)' };
    const injChip = { dot: 'dot-estimated', text: 'Lesiones y alineaciones: <strong>ESTIMADAS</strong> (ilustrativo, no oficial)' };

    document.getElementById('sourceStrip').innerHTML = [fxChip, odChip, statsChip, injChip]
      .map(c => `<span class="source-chip"><span class="source-dot ${c.dot}"></span>${c.text}</span>`).join('');
  }

  function populateDateFilter(preserveSelection) {
    const sel = document.getElementById('dateFilter');
    const days = [...new Set(App.analyses.map(a => dateKey(a.fixture.date)))];
    days.sort((a, b) => new Date(App.analyses.find(x => dateKey(x.fixture.date) === a).fixture.date) -
                         new Date(App.analyses.find(x => dateKey(x.fixture.date) === b).fixture.date));
    sel.innerHTML = `<option value="all">Todas las jornadas</option>` +
      days.map(d => {
        const count = App.analyses.filter(a => dateKey(a.fixture.date) === d).length;
        return `<option value="${d}">${d} (${count} partido${count > 1 ? 's' : ''})</option>`;
      }).join('');

    if (preserveSelection && (App.filters.date === 'all' || days.includes(App.filters.date))) {
      // BUGFIX #1: si el usuario ya había elegido una jornada, se respeta tal cual.
      sel.value = App.filters.date;
      return;
    }

    const todayKey = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit' });
    if (days.includes(todayKey)) sel.value = todayKey;
    else {
      const next = App.analyses.filter(a => new Date(a.fixture.date) >= new Date())
        .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date))[0];
      sel.value = next ? dateKey(next.fixture.date) : 'all';
    }
    App.filters.date = sel.value;
  }

  function populateMatchSelector() {
    const sel = document.getElementById('matchSelector');
    const list = App.analyses.slice().sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    sel.innerHTML = `<option value="">▼ Elige un partido para ver su análisis completo…</option>` +
      list.map(a => `<option value="${a.fixture.id}">${formatKickoff(a.fixture.date)} — ${a.fixture.home} vs ${a.fixture.away}</option>`).join('');
  }

  function getFilteredAnalyses() {
    let list = App.analyses.slice();
    if (App.filters.date !== 'all') list = list.filter(a => dateKey(a.fixture.date) === App.filters.date);
    if (App.filters.search) {
      const q = normalizeStr(App.filters.search);
      list = list.filter(a => normalizeStr(a.fixture.home).includes(q) || normalizeStr(a.fixture.away).includes(q));
    }
    const sortKey = App.filters.sort;
    list.sort((a, b) => {
      if (sortKey === 'time') return new Date(a.fixture.date) - new Date(b.fixture.date);
      if (sortKey === 'ev') {
        const scoreA = (App.safeMode ? a.safeRecommendation?.safeScoreVal : a.bestValueBet?.valueScore) ?? -Infinity;
        const scoreB = (App.safeMode ? b.safeRecommendation?.safeScoreVal : b.bestValueBet?.valueScore) ?? -Infinity;
        return scoreB - scoreA;
      }
      return b.confidence - a.confidence;
    });
    return list;
  }

  // Único punto de filtrado de apuestas (corrige inconsistencias entre
  // el filtro de mercado, el Modo Seguro y la tabla de mejores apuestas).
  function getFilteredBets() {
    let bets = App.analyses.flatMap(a => a.valueBets.map(b => ({ ...b, fixture: a.fixture, riskOfMatch: a.risk, matchConfidence: a.confidence })));
    bets = bets.filter(b => b.prob >= MODEL.MIN_PROB_SURFACE);
    if (App.safeMode) bets = bets.filter(b => b.safe && b.prob >= 0.45 && b.matchConfidence >= 55);
    if (App.filters.market !== 'all') bets = bets.filter(b => b.market === App.filters.market);
    bets.sort((a, b) => App.safeMode ? b.safeScoreVal - a.safeScoreVal : b.valueScore - a.valueScore);
    return bets;
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
    const safePicks = App.analyses.filter(a => a.safeRecommendation).length;
    const avgConfidence = list.length ? list.reduce((s, a) => s + a.confidence, 0) / list.length : 0;
    const highConfidenceMatches = list.filter(a => a.confidence >= 70).length;

    const cards = App.safeMode ? [
      { label: 'Partidos analizados', value: list.length, sub: App.filters.date === 'all' ? 'todas las jornadas' : App.filters.date, accent: 'var(--accent-blue)' },
      { label: 'Recomendaciones seguras', value: safePicks, sub: 'con confianza ≥ 55% y prob. ≥ 45%', accent: 'var(--accent-pitch)' },
      { label: 'Partidos de alta confianza', value: highConfidenceMatches, sub: 'confianza del modelo ≥ 70%', accent: 'var(--accent-gold)' },
      { label: 'Confianza media IA', value: `${Math.round(avgConfidence)}%`, sub: 'índice 0-100 (fórmula conservadora)', accent: 'var(--accent-gold)' }
    ] : [
      { label: 'Partidos analizados', value: list.length, sub: App.filters.date === 'all' ? 'todas las jornadas' : App.filters.date, accent: 'var(--accent-blue)' },
      { label: 'Apuestas con prob. ≥ 15%', value: getFilteredBets().length, sub: 'umbral mínimo para ser mostradas', accent: 'var(--accent-pitch)' },
      { label: 'Partidos de alta confianza', value: highConfidenceMatches, sub: 'confianza del modelo ≥ 70%', accent: 'var(--accent-gold)' },
      { label: 'Confianza media IA', value: `${Math.round(avgConfidence)}%`, sub: 'índice 0-100 (fórmula conservadora)', accent: 'var(--accent-gold)' }
    ];

    document.getElementById('dashboardStats').innerHTML = cards.map(c => `
      <div class="stat-card" style="--stat-accent:${c.accent}">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-sub">${c.sub}</div>
      </div>`).join('');
  }

  function renderTicker() {
    const bets = getFilteredBets().slice(0, 12).map(b => ({ ...b, label: `${TEAM_META[b.fixture.home]?.code || b.fixture.home} vs ${TEAM_META[b.fixture.away]?.code || b.fixture.away}` }));
    const track = document.getElementById('tickerTrack');
    if (!bets.length) { track.innerHTML = '<span class="ticker-item">Sin recomendaciones que superen el umbral mínimo de probabilidad en este momento.</span>'; return; }
    const html = bets.map(b => `
      <span class="ticker-item">⚽ ${b.label} — ${b.selection} @ ${fmtOdds(b.bookOdds)} · ${fmtPct(b.prob)}
        <span class="${b.ev >= 0 ? 'tk-ev-pos' : 'tk-ev-neg'}">EV ${fmtSigned(b.ev, '%')}</span>
        <span class="tk-sep">·</span>
      </span>`).join('');
    track.innerHTML = html + html;
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
      const pick = App.safeMode ? a.safeRecommendation : a.bestValueBet;
      return `
      <article class="match-card" data-id="${f.id}">
        <div class="match-card-top">
          <span>${formatKickoff(f.date)} · ${f.stadium}</span>
          <span class="badge-group">
            <span class="badge-tag">Grupo ${f.group}</span>
            ${pick && App.safeMode ? '<span class="badge-tag badge-value">🛡 SEGURA</span>' : ''}
            ${pick && !App.safeMode && pick.ev > 4 ? '<span class="badge-tag badge-value">VALOR</span>' : ''}
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
            <span class="best-pick-label">${App.safeMode ? 'Pick seguro' : 'Mejor apuesta'}</span>
            <span class="best-pick-value">${pick ? pick.selection : 'Sin recomendación clara'}</span>
          </div>
          ${pick ? `<span class="ev-tag ${pick.ev >= 0 ? 'ev-pos' : 'ev-neg'}">${fmtPct(pick.prob)}</span>` : ''}
          <span class="risk-pill risk-${a.risk}">${riskLabel(a.risk)}</span>
        </div>
      </article>`;
    }).join('');

    grid.querySelectorAll('.match-card').forEach(card => card.addEventListener('click', () => openMatchModal(card.dataset.id)));
  }

  function marketDisplayName(key) {
    return {
      '1X2': 'Resultado 1X2', double_chance: 'Doble oportunidad', goals: 'Total goles', btts: 'Ambos marcan',
      corners: 'Córners', team_shots: 'Tiros a puerta', cards: 'Tarjetas', correct_score: 'Resultado exacto'
    }[key] || key;
  }

  function renderBestBets() {
    const bets = getFilteredBets().slice(0, 14);
    document.getElementById('bestBetsPanel').querySelector('h2').textContent = App.safeMode ? '🛡 Apuestas seguras del día' : '🏆 Mejores apuestas del día';
    document.getElementById('bestBetsBody').innerHTML = bets.map(b => `
      <tr class="${b.safe ? 'row-value' : ''}">
        <td>${b.fixture.home} vs ${b.fixture.away}</td>
        <td>${marketDisplayName(b.market)}${b.safe ? '<span class="safe-market-tag">SEGURO</span>' : ''}</td>
        <td>${b.selection}</td>
        <td class="mono">${fmtPct(b.prob)}</td>
        <td class="mono">${fmtOdds(b.bookOdds)}</td>
        <td class="mono">${fmtOdds(b.fairOdds)}</td>
        <td class="mono">${fmtSigned(b.edge, 'pp')}</td>
        <td class="mono ${b.ev >= 0 ? 'ev-pos' : 'ev-neg'}">${fmtSigned(b.ev, '%')}</td>
        <td><span class="risk-pill risk-${b.riskOfMatch}">${riskLabel(b.riskOfMatch)}</span></td>
      </tr>`).join('') || `<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">Sin apuestas que superen el umbral de calidad para este filtro. Prueba a desactivar el Modo Seguro o cambiar de mercado.</td></tr>`;
  }

  function renderCharts(list) {
    if (typeof Chart === 'undefined') return;
    const labels = list.map(a => `${TEAM_META[a.fixture.home]?.code || a.fixture.home}-${TEAM_META[a.fixture.away]?.code || a.fixture.away}`);
    const baseOptions = {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: '#aab2c5', font: { size: 10 } }, grid: { color: '#1a2030' } }, y: { ticks: { color: '#aab2c5', font: { size: 10 } }, grid: { color: '#1a2030' } } }
    };

    App.chartConfidence?.destroy();
    App.chartConfidence = new Chart(document.getElementById('chartConfidence'), {
      type: 'bar',
      data: { labels, datasets: [{ data: list.map(a => a.confidence), backgroundColor: list.map(a => a.confidence >= 70 ? '#14d896' : a.confidence >= 50 ? '#ffb020' : '#ff5468'), borderRadius: 4 }] },
      options: baseOptions
    });

    const topBets = getFilteredBets().slice(0, 8).map(b => ({ ...b, label: `${TEAM_META[b.fixture.home]?.code || ''}-${TEAM_META[b.fixture.away]?.code || ''}: ${b.selection}` }));
    App.chartEV?.destroy();
    App.chartEV = new Chart(document.getElementById('chartEV'), {
      type: 'bar',
      data: { labels: topBets.map(b => b.label), datasets: [{ data: topBets.map(b => round1(App.safeMode ? b.prob * 100 : b.ev)), backgroundColor: topBets.map(b => (App.safeMode ? b.prob >= 0.5 : b.ev >= 0) ? '#14d896' : '#ff5468'), borderRadius: 4 }] },
      options: { ...baseOptions, indexAxis: 'y' }
    });
    document.querySelector('#chartEV').closest('.chart-card').querySelector('h3').textContent = App.safeMode ? 'Top probabilidad (picks seguros)' : 'Top valor por apuesta';

    const riskCounts = { low: 0, medium: 0, high: 0 };
    App.analyses.forEach(a => riskCounts[a.risk]++);
    App.chartRisk?.destroy();
    App.chartRisk = new Chart(document.getElementById('chartRisk'), {
      type: 'doughnut',
      data: { labels: ['Riesgo bajo', 'Riesgo medio', 'Riesgo alto'], datasets: [{ data: [riskCounts.low, riskCounts.medium, riskCounts.high], backgroundColor: ['#14d896', '#ffb020', '#ff5468'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: '#aab2c5', font: { size: 10 } } } } }
    });
  }

  /* =========================================================================
     MODAL DE DETALLE DE PARTIDO
     ========================================================================= */
  function buildRecommendationBox(a) {
    const pick = App.safeMode ? a.safeRecommendation : a.bestValueBet;
    if (!pick) {
      return `<div class="recommendation-box no-pick">
        <div class="rec-title">Sin recomendación ${App.safeMode ? 'segura' : 'clara'} para este partido</div>
        <p style="font-size:0.84rem">Este encuentro está equilibrado o no alcanza los umbrales mínimos de probabilidad/confianza del modelo. ${App.safeMode ? 'Prueba a desactivar el Modo Seguro para ver todas las opciones disponibles.' : ''}</p>
      </div>`;
    }
    const reasons = buildReasons(a, pick);
    return `<div class="recommendation-box">
      <div class="rec-title">RECOMENDACIÓN — ${pick.selection}</div>
      <div class="rec-meta-row">
        <div class="rec-meta-item"><div class="rm-label">Probabilidad</div><div class="rm-value">${fmtPct(pick.prob)}</div></div>
        <div class="rec-meta-item"><div class="rm-label">Confianza del partido</div><div class="rm-value">${a.confidence}%</div></div>
        <div class="rec-meta-item"><div class="rm-label">Cuota</div><div class="rm-value">${fmtOdds(pick.bookOdds)}</div></div>
        ${!App.safeMode ? `<div class="rec-meta-item"><div class="rm-label">EV</div><div class="rm-value" style="color:${pick.ev >= 0 ? 'var(--accent-pitch)' : 'var(--accent-red)'}">${fmtSigned(pick.ev, '%')}</div></div>` : ''}
      </div>
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.4rem">Motivos</div>
      <ul class="rec-reasons">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>
    </div>`;
  }

  function openMatchModal(matchId) {
    const a = App.analyses.find(x => x.fixture.id === matchId);
    if (!a) return;
    const f = a.fixture;
    const homeM = TEAM_META[f.home] || {}; const awayM = TEAM_META[f.away] || {};

    const statRow = (label, hVal, aVal, max) => `
      <div class="stat-compare-row"><div class="v-home">${hVal}</div><div class="v-label">${label}</div><div class="v-away">${aVal}</div></div>
      <div class="bar-track">
        <div class="bar-fill-home" style="width:${(hVal / max) * 50}%;margin-left:${50 - (hVal / max) * 50}%"></div>
        <div class="bar-fill-away" style="width:${(aVal / max) * 50}%"></div>
      </div>`;
    const probRow = (label, prob) => `
      <div class="prob-bar-row"><span class="pb-label">${label}</span>
        <div class="prob-bar-track"><div class="prob-bar-fill" style="width:${prob * 100}%"></div></div>
        <span class="pb-value">${fmtPct(prob)}</span></div>`;
    const marketCard = (title, pick, prob, odds, ev, tag) => `
      <div class="market-card">
        <div class="mc-title">${title}${tag ? `<span class="${tag === 'safe' ? 'safe-market-tag' : 'exotic-market-tag'}">${tag === 'safe' ? 'SEGURO' : 'ESPECULATIVO'}</span>` : ''}</div>
        <div class="mc-pick">${pick}</div>
        <div class="mc-foot"><span>${fmtPct(prob)} · cuota ${fmtOdds(odds)}</span><span class="${ev >= 0 ? 'ev-pos' : 'ev-neg'}">EV ${fmtSigned(ev, '%')}</span></div>
      </div>`;
    const formIcons = (arr) => arr.map(r => `<span class="badge-tag" style="color:${r.result === 'W' ? 'var(--accent-pitch)' : r.result === 'D' ? 'var(--accent-amber)' : 'var(--accent-red)'}">${r.result} ${r.gf}-${r.ga}</span>`).join(' ');
    const findBet = (sel) => a.valueBets.find(b => b.selection === sel);
    const bttsBet = a.valueBets.find(b => b.market === 'btts');
    const scoreBet = a.valueBets.find(b => b.market === 'correct_score');

    document.getElementById('modalContent').innerHTML = `
      <div class="modal-header">
        <div>
          <div class="modal-teams">${homeM.flag || ''} ${f.home} <span style="color:var(--text-muted)">vs</span> ${f.away} ${awayM.flag || ''}</div>
          <div class="modal-meta">${formatKickoff(f.date)} · ${f.stadium}, ${f.city} · Grupo ${f.group} <span class="src-tag ${f.scheduleSource === 'live-api' ? 'src-live' : 'src-real'}">${f.scheduleSource === 'live-api' ? 'CALENDARIO EN VIVO' : 'CALENDARIO REAL'}</span></div>
        </div>
        <div class="confidence-dial" style="--pct:${a.confidence}" data-pct="${a.confidence}"></div>
      </div>

      <div class="tabs">
        <button class="tab-btn active" data-tab="recomendacion">Recomendación</button>
        <button class="tab-btn" data-tab="resumen">Resumen</button>
        <button class="tab-btn" data-tab="stats">Estadísticas</button>
        <button class="tab-btn" data-tab="mercados">Mercados</button>
        <button class="tab-btn" data-tab="h2h">H2H</button>
        <button class="tab-btn" data-tab="plantilla">Plantilla</button>
      </div>

      <div class="tab-panel active" data-panel="recomendacion">${buildRecommendationBox(a)}</div>

      <div class="tab-panel" data-panel="resumen">
        ${probRow(`Gana ${f.home}`, a.goals.pHome)}
        ${probRow('Empate', a.goals.pDraw)}
        ${probRow(`Gana ${f.away}`, a.goals.pAway)}
        <p style="margin-top:0.8rem;font-size:0.85rem;color:var(--text-secondary)">
          Goles esperados (xG modelo): <strong style="color:var(--text-primary)">${a.lambdaHome}</strong> — <strong style="color:var(--text-primary)">${a.lambdaAway}</strong>.
          Resultado exacto más probable: <strong style="color:var(--text-primary)">${a.goals.topScorelines[0].h}-${a.goals.topScorelines[0].a}</strong> (${fmtPct(a.goals.topScorelines[0].p)}).
        </p>
        <p style="margin-top:0.5rem;font-size:0.85rem;color:var(--text-secondary)">Nivel de riesgo: <span class="risk-pill risk-${a.risk}">${riskLabel(a.risk)}</span> · ${Math.round(a.signalAgreement * 4)}/4 señales del modelo coinciden con la predicción.</p>
      </div>

      <div class="tab-panel" data-panel="stats">
        <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.5rem">Últimos 10 partidos <span class="src-tag src-estimado">ESTIMADO</span></p>
        ${statRow('Puntos (últ. 10)', a.home.points10, a.away.points10, 30)}
        ${statRow('Goles a favor (últ. 10)', a.home.goalsFor10, a.away.goalsFor10, 24)}
        ${statRow('Goles en contra (últ. 10)', a.home.goalsAgainst10, a.away.goalsAgainst10, 24)}
        <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin:0.9rem 0 0.5rem">Últimos 5 partidos</p>
        ${statRow('Puntos (últ. 5)', a.home.points5, a.away.points5, 15)}
        ${statRow('Goles a favor (últ. 5)', a.home.goalsFor5, a.away.goalsFor5, 14)}
        ${statRow('Goles en contra (últ. 5)', a.home.goalsAgainst5, a.away.goalsAgainst5, 14)}
        <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin:0.9rem 0 0.5rem">Estadísticas por partido</p>
        ${statRow('xG', a.home.xgFor, a.away.xgFor, 3)}
        ${statRow('xGA', a.home.xgAgainst, a.away.xgAgainst, 3)}
        ${statRow('Tiros totales', a.home.shotsTotal, a.away.shotsTotal, 24)}
        ${statRow('Tiros a puerta', a.home.shotsOnTarget, a.away.shotsOnTarget, 12)}
        ${statRow('Córners', a.home.corners, a.away.corners, 10)}
        ${statRow('Tarjetas', a.home.cardsAvg, a.away.cardsAvg, 5)}
        ${statRow('Posesión (%)', a.home.possession, a.away.possession, 70)}
        <p style="margin-top:0.6rem;font-size:0.78rem;color:var(--text-muted)">Forma (últ. 10) — ${f.home}: ${formIcons(a.home.last10.slice().reverse())}</p>
        <p style="margin-top:0.3rem;font-size:0.78rem;color:var(--text-muted)">Forma (últ. 10) — ${f.away}: ${formIcons(a.away.last10.slice().reverse())}</p>
      </div>

      <div class="tab-panel" data-panel="mercados">
        <div class="market-grid">
          ${marketCard('Más de 0.5 goles', 'Sí', a.goals.pOver['0.5'], findBet('Más de 0.5 goles').bookOdds, findBet('Más de 0.5 goles').ev, 'safe')}
          ${marketCard('Más de 1.5 goles', 'Sí', a.goals.pOver['1.5'], findBet('Más de 1.5 goles').bookOdds, findBet('Más de 1.5 goles').ev, 'safe')}
          ${marketCard('Más de 2.5 goles', 'Sí', a.goals.pOver['2.5'], findBet('Más de 2.5 goles').bookOdds, findBet('Más de 2.5 goles').ev)}
          ${marketCard('Más de 3.5 goles', 'Sí', a.goals.pOver['3.5'], findBet('Más de 3.5 goles').bookOdds, findBet('Más de 3.5 goles').ev)}
          ${marketCard('Doble oportunidad', findBet(`${f.home} o empate (1X)`).prob > findBet(`Empate o ${f.away} (X2)`).prob ? `${f.home} o empate` : `Empate o ${f.away}`, Math.max(findBet(`${f.home} o empate (1X)`).prob, findBet(`Empate o ${f.away} (X2)`).prob), findBet(`${f.home} o empate (1X)`).prob > findBet(`Empate o ${f.away} (X2)`).prob ? findBet(`${f.home} o empate (1X)`).bookOdds : findBet(`Empate o ${f.away} (X2)`).bookOdds, 0, 'safe')}
          ${marketCard('Ambos marcan', 'Sí', a.goals.pBtts, bttsBet.bookOdds, bttsBet.ev, a.bttsBacked ? 'safe' : null)}
          ${marketCard('Córners', 'Más de 3.5', a.corners.over35, findBet('Más de 3.5 córners').bookOdds, findBet('Más de 3.5 córners').ev, 'safe')}
          ${marketCard('Tarjetas totales', 'Más de 3.5', a.cards.over35, findBet('Más de 3.5 tarjetas').bookOdds, findBet('Más de 3.5 tarjetas').ev)}
          ${marketCard('Resultado exacto', `${a.goals.topScorelines[0].h}-${a.goals.topScorelines[0].a}`, a.goals.topScorelines[0].p, scoreBet.bookOdds, scoreBet.ev, 'exotic')}
          ${a.scorerPool[0] ? marketCard('Primer goleador probable', `${a.scorerPool[0].name} (${a.scorerPool[0].team})`, a.scorerPool[0].prob, fairOdds(a.scorerPool[0].prob), 0, 'exotic') : ''}
        </div>
      </div>

      <div class="tab-panel" data-panel="h2h">
        <div class="h2h-list">${a.h2h.map(g => `<div class="h2h-row"><span>${g.year} · ${g.home} vs ${g.away}</span><span class="h2h-score">${g.hg}-${g.ag}</span></div>`).join('')}</div>
        <p style="margin-top:0.7rem;font-size:0.76rem;color:var(--text-muted)">Historial estimado a partir del nivel relativo de ambas selecciones (no son resultados oficiales) <span class="src-tag src-estimado">ESTIMADO</span>.</p>
      </div>

      <div class="tab-panel" data-panel="plantilla">
        <p class="lineup-note">⚠️ Alineaciones, lesiones y sanciones son una estimación ilustrativa del modelo, no la convocatoria oficial confirmada por el cuerpo técnico.</p>
        <h4 style="margin-bottom:0.5rem;font-size:0.9rem">${f.home}</h4>
        ${a.home.players.map(([name, w]) => `<div class="player-row"><span class="player-name">${name}</span><span class="player-meta">Tiros a puerta est. ${round1(w * a.home.shotsOnTarget * 2.2)} · prob. gol ${fmtPct(a.scorerPool.find(s => s.name === name)?.prob || 0)}</span></div>`).join('') || '<p style="font-size:0.8rem;color:var(--text-muted)">Plantilla no disponible (selección pendiente de repechaje).</p>'}
        ${a.home.injuries.map(inj => `<div class="player-row"><span class="player-name" style="color:var(--accent-red)">${inj.name}</span><span class="player-meta">${inj.status}</span></div>`).join('')}
        <h4 style="margin:1rem 0 0.5rem;font-size:0.9rem">${f.away}</h4>
        ${a.away.players.map(([name, w]) => `<div class="player-row"><span class="player-name">${name}</span><span class="player-meta">Tiros a puerta est. ${round1(w * a.away.shotsOnTarget * 2.2)} · prob. gol ${fmtPct(a.scorerPool.find(s => s.name === name)?.prob || 0)}</span></div>`).join('') || '<p style="font-size:0.8rem;color:var(--text-muted)">Plantilla no disponible (selección pendiente de repechaje).</p>'}
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
     10. EVENTOS DE INTERFAZ
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
      App.filters.date = e.target.value; // el usuario toma el control manualmente: a partir de aquí ya no se sobrescribe
      renderAll();
    });

    document.getElementById('matchSelector').addEventListener('change', (e) => {
      if (e.target.value) { openMatchModal(e.target.value); e.target.value = ''; }
    });

    document.getElementById('safeModeToggle').addEventListener('change', (e) => {
      App.safeMode = e.target.checked;
      Settings.setSafeMode(App.safeMode);
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

    document.getElementById('modalClose').addEventListener('click', () => document.getElementById('matchModal').classList.add('hidden'));
    document.getElementById('matchModal').addEventListener('click', (e) => { if (e.target.id === 'matchModal') e.currentTarget.classList.add('hidden'); });

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
      Settings.save(document.getElementById('oddsApiKey').value.trim(), document.getElementById('footballDataApiKey').value.trim(), document.getElementById('liveModeToggle').checked);
      settingsModal.classList.add('hidden');
      loadAllData();
    });
    document.getElementById('clearSettingsBtn').addEventListener('click', () => {
      Settings.clear();
      document.getElementById('oddsApiKey').value = '';
      document.getElementById('footballDataApiKey').value = '';
      document.getElementById('liveModeToggle').checked = false;
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('matchModal').classList.add('hidden');
        settingsModal.classList.add('hidden');
      }
    });
  }

  /* =========================================================================
     11. INICIALIZACIÓN
     ========================================================================= */
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('safeModeToggle').checked = App.safeMode;
    initEvents();
    loadAllData();
  });

})();
