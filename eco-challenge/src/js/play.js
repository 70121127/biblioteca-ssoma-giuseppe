// Pantalla del participante (celular).
import { configError, rpc, timedRpc } from './supabase.js';
import { h, $, clear, toast, renderConfigError, wasteImage, binBadge, scopeLabel, appUrl } from './ui.js';
import { friendlyError, errorCode, isNetworkError } from './errors.js';
import { ServerClock, roundTimer, formatSeconds } from './clock.js';
import { joinGameChannel } from './realtime.js';
import { attachClassifier } from './dragdrop.js';
import { normalizeAlias, isValidAlias, isValidCode, shuffle } from './validation.js';

const STORAGE_KEY = 'eco.player';
const app = $('#app');
const netBanner = $('#net-status');
const clock = new ServerClock();

let session = loadSession();
let state = null;
let channel = null;
let refreshing = false;
let refreshTimer = null;
let failures = 0;
let screenKey = '';
let board = null;            // referencias del tablero de la ronda actual
const results = new Map();   // item_id -> resultado devuelto por el servidor (ronda actual)
const outbox = new Map();    // item_id -> contenedor pendiente de envío (sin conexión)
let wakeLock = null;

function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null; } catch { return null; }
}
function saveSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* almacenamiento no disponible: la sesión dura lo que la pestaña */ }
}

// ---------------------------------------------------------------------
// Conexión con el servidor
// ---------------------------------------------------------------------
function setNet(ok, text) {
  netBanner.hidden = ok;
  if (!ok) netBanner.textContent = text || 'Sin conexión. Reintentando…';
}

function scheduleRefresh(ms) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

function pollInterval() {
  const status = state?.game?.status;
  const live = channel?.connected;
  if (status === 'running' || status === 'paused') return live ? 8000 : 3000;
  if (status === 'finished') return 20000;
  return live ? 10000 : 4000;
}

async function refresh() {
  if (!session || refreshing) return;
  refreshing = true;
  try {
    const { data, sentAt, receivedAt } = await timedRpc('player_state', { p_token: session.token });
    clock.sample(data.server_now, sentAt, receivedAt);
    failures = 0;
    setNet(true);
    state = data;
    render();
    flushOutbox();
    scheduleRefresh(pollInterval());
  } catch (err) {
    const code = errorCode(err);
    if (code === 'SESION_INVALIDA') {
      leave(friendlyError(err));
      return;
    }
    failures++;
    setNet(false, isNetworkError(err) ? 'Sin conexión. Reintentando…' : friendlyError(err));
    scheduleRefresh(Math.min(10000, 1000 * 2 ** Math.min(failures, 4)));
  } finally {
    refreshing = false;
  }
}

function connectChannel() {
  channel?.close();
  if (!session) return;
  channel = joinGameChannel(session.code, {
    // Los avisos llegan a todos a la vez: se reparte la recarga en el tiempo
    // para no generar un pico de peticiones con 200 participantes.
    onSignal: () => scheduleRefresh(150 + Math.random() * 900),
    onStatus: () => {},
  });
}

function leave(message) {
  saveSession(null);
  channel?.close();
  channel = null;
  state = null;
  screenKey = '';
  clearTimeout(refreshTimer);
  renderJoin(message);
}

// ---------------------------------------------------------------------
// Ingreso
// ---------------------------------------------------------------------
function renderJoin(message) {
  screenKey = 'join';
  const params = new URLSearchParams(location.search);
  const code = h('input', { inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: 6, required: true,
    autocomplete: 'off', placeholder: '000000', class: 'code-input', 'aria-label': 'Código de partida',
    value: (params.get('code') || '').replace(/\D/g, '').slice(0, 6) });
  const alias = h('input', { maxlength: 20, required: true, autocomplete: 'nickname', placeholder: 'Tu alias',
    'aria-label': 'Alias', value: '' });
  const err = h('p', { class: 'form-error', role: 'alert' }, message || '');
  const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, '¡Entrar!');

  const form = h('form', { class: 'card join', onsubmit: async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const c = code.value.trim();
    const a = normalizeAlias(alias.value);
    if (!isValidCode(c)) { err.textContent = 'El código tiene 6 dígitos.'; code.focus(); return; }
    if (!isValidAlias(a)) { err.textContent = friendlyError({ message: 'ALIAS_INVALIDO' }); alias.focus(); return; }
    btn.disabled = true;
    try {
      const res = await rpc('join_game', { p_code: c, p_alias: a });
      saveSession({ token: res.token, code: res.code, alias: res.alias, game_id: res.game_id });
      results.clear();
      outbox.clear();
      connectChannel();
      await refresh();
    } catch (e) {
      err.textContent = friendlyError(e);
    } finally {
      btn.disabled = false;
    }
  } },
  h('div', { class: 'brand' }, h('img', { src: appUrl('/img/logo.svg'), alt: '', class: 'brand-logo' }),
    h('div', {}, h('h1', {}, 'SSOMA Eco Challenge'), h('p', { class: 'muted' }, 'Segregación de residuos · NTP 900.058:2019'))),
  h('label', {}, 'Código de partida', code),
  h('label', {}, 'Alias', alias),
  h('p', { class: 'muted small' }, 'Usa un alias: no se solicitan datos personales.'),
  err, btn);

  clear(app).append(form);
  (code.value ? alias : code).focus();
}

// ---------------------------------------------------------------------
// Render por estado
// ---------------------------------------------------------------------
function render() {
  if (!state) return;
  const g = state.game;
  if (state.player.kicked) { leave('El instructor te retiró de la partida.'); return; }
  if (g.status === 'closed') { leave('La partida fue cerrada por el instructor. ¡Gracias por participar!'); return; }

  const r = state.round;
  const inRound = (g.status === 'running' || g.status === 'paused') && r && r.status !== 'ended';
  const key = inRound ? `round:${r.id}` : `${g.status}:${r?.id ?? ''}:${r?.status ?? ''}`;

  if (key !== screenKey) {
    screenKey = key;
    board = null;
    if (inRound) renderBoard();
    else if (g.status === 'lobby') renderLobby();
    else if (g.status === 'finished') renderFinal();
    else renderRoundResults();
  }
  if (board) updateBoard();
}

function header() {
  return h('header', { class: 'player-head' },
    h('span', { class: 'chip' }, `👤 ${state.player.alias}`),
    h('span', { class: 'chip' }, `🔢 ${state.game.code}`),
    h('span', { class: 'chip' }, `📍 ${scopeLabel(state.game.scope)}`));
}

function renderLobby() {
  releaseWakeLock();
  clear(app).append(
    header(),
    h('section', { class: 'card center' },
      h('div', { class: 'big-emoji', 'aria-hidden': 'true' }, '♻️'),
      h('h2', {}, `¡Estás dentro, ${state.player.alias}!`),
      h('p', {}, 'Espera a que el instructor inicie la ronda.'),
      h('p', { class: 'muted' }, `Ámbito ${scopeLabel(state.game.scope)} · ${state.game.total_rounds} ronda(s) · ${state.game.round_duration_s} s por ronda`)),
    h('section', { class: 'card' },
      h('h3', {}, 'Conoce los contenedores'),
      h('div', { class: 'bins-legend' }, state.bins.map((b) => {
        const el = binBadge(b, { cls: 'bin bin-legend' });
        el.append(h('span', { class: 'bin-desc' }, b.description));
        return el;
      }))),
    h('button', { class: 'btn btn-ghost', onclick: () => { if (confirm('¿Salir de la partida?')) leave(); } }, 'Salir'));
}

// Orden de las tarjetas estable por participante y ronda (mezcla con semilla).
function seededRandom(seedText) {
  let s = 0;
  for (const ch of seedText) s = (Math.imul(31, s) + ch.charCodeAt(0)) | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renderBoard() {
  const r = state.round;
  results.clear();
  for (const a of r.my_answers) results.set(a.item_id, a);
  for (const id of [...outbox.keys()]) if (!r.items.some((i) => i.id === id)) outbox.delete(id);

  const timerText = h('span', { class: 'timer-text' }, '');
  const timerBar = h('div', { class: 'timer-bar' }, h('span'));
  const progress = h('span', { class: 'chip' }, '');
  const score = h('span', { class: 'chip chip-score' }, '');
  const feedback = h('div', { class: 'feedback', role: 'status', 'aria-live': 'polite' },
    'Arrastra cada residuo a su contenedor, o tócalo y luego toca el contenedor.');
  const overlay = h('div', { class: 'overlay', hidden: true });

  const items = shuffle(r.items, seededRandom(session.token + r.id));
  const cards = new Map();
  const grid = h('div', { class: 'waste-grid' }, items.map((it) => {
    const card = h('div', { class: 'waste-card', tabindex: 0, role: 'button', dataset: { item: it.id },
      'aria-label': `${it.name}. Selecciona y elige un contenedor.` },
    wasteImage(it.image_url, it.name),
    h('span', { class: 'waste-name' }, it.name),
    h('span', { class: 'waste-status' }));
    cards.set(it.id, card);
    return card;
  }));

  const bins = h('div', { class: `bins-dock bins-${state.bins.length}` },
    state.bins.map((b) => binBadge(b, { tag: 'button', type: 'button', cls: 'bin bin-target', 'aria-label': `Contenedor ${b.color_name}: ${b.label}` })));

  const boardEl = h('section', { class: 'board' },
    h('div', { class: 'board-head' },
      h('div', { class: 'timer' }, h('span', { class: 'timer-icon', 'aria-hidden': 'true' }, '⏱️'), timerText),
      h('span', { class: 'chip' }, `Ronda ${r.round_no}/${state.game.total_rounds}`),
      progress, score),
    timerBar, feedback, grid, bins, overlay);

  clear(app).append(boardEl);
  board = { r, timerText, timerBar, progress, score, feedback, overlay, cards, el: boardEl, locked: false, lastPhase: null };
  attachClassifier({ board: boardEl, isLocked: () => board?.locked, onClassify: (itemId, bin, card) => sendAnswer(itemId, bin, card) });
  for (const [id, res] of results) markCard(id, res);
  for (const [id, bin] of outbox) markSending(id, bin);
  requestWakeLock();
}

function binByCode(code) {
  return state.bins.find((b) => b.code === code);
}

function markSending(itemId, bin) {
  const card = board?.cards.get(itemId);
  if (!card) return;
  card.classList.add('sending');
  card.querySelector('.waste-status').textContent = `⏳ ${binByCode(bin)?.color_name ?? bin}`;
}

function markCard(itemId, res) {
  const card = board?.cards.get(itemId);
  if (!card) return;
  card.classList.remove('sending', 'selected');
  card.classList.add('done');
  card.removeAttribute('tabindex');
  const status = card.querySelector('.waste-status');
  const chosen = binByCode(res.chosen_bin);
  if (res.is_correct === true) {
    card.classList.add('ok');
    status.textContent = `✅ +${res.points}`;
  } else if (res.is_correct === false) {
    card.classList.add('bad');
    status.textContent = `❌ ${binByCode(res.correct_bin)?.color_name ?? ''}`;
  } else {
    status.textContent = `✔️ ${chosen?.color_name ?? ''}`;
  }
}

async function sendAnswer(itemId, bin) {
  if (!board || results.has(itemId) || outbox.has(itemId)) return;
  outbox.set(itemId, bin);
  markSending(itemId, bin);
  await deliver(itemId, bin, board.r.id);
}

async function deliver(itemId, bin, roundId) {
  try {
    const res = await rpc('submit_answer', { p_token: session.token, p_round_id: roundId, p_item_id: itemId, p_bin: bin });
    outbox.delete(itemId);
    if (!board || board.r.id !== roundId) return;
    results.set(itemId, res);
    markCard(itemId, res);
    showFeedback(res);
    updateBoard();
    if (res.status === 'duplicado') toast('Esa respuesta ya estaba registrada.', 'info', 2000);
  } catch (err) {
    if (isNetworkError(err)) {
      setNet(false);
      return; // queda en la bandeja de salida y se reintenta al reconectar
    }
    outbox.delete(itemId);
    const code = errorCode(err);
    const card = board?.cards.get(itemId);
    if (card) { card.classList.remove('sending'); card.querySelector('.waste-status').textContent = ''; }
    toast(friendlyError(err), 'warn');
    if (['TIEMPO_AGOTADO', 'RONDA_INVALIDA', 'RONDA_PAUSADA', 'AUN_NO_INICIA'].includes(code)) scheduleRefresh(300);
  }
}

function flushOutbox() {
  if (!board) return;
  for (const [itemId, bin] of outbox) deliver(itemId, bin, board.r.id);
}

function showFeedback(res) {
  const f = board.feedback;
  f.className = 'feedback';
  if (res.is_correct === true) {
    f.classList.add('feedback-ok');
    f.textContent = `✅ ¡Correcto! +${res.points} pts. ${res.explanation ?? ''}`;
  } else if (res.is_correct === false) {
    const b = binByCode(res.correct_bin);
    f.classList.add('feedback-bad');
    f.textContent = `❌ Correspondía al contenedor ${b?.color_name ?? ''} (${b?.label ?? ''}). ${res.explanation ?? ''}`;
  } else {
    f.classList.add('feedback-neutral');
    f.textContent = '📝 Respuesta registrada. Verás los resultados al terminar la ronda.';
  }
}

function currentScore() {
  const me = state.me || { score: 0 };
  if (state.game.feedback_mode !== 'inmediata') return me.score;
  // El puntaje del servidor ya incluye las respuestas que conocía; se suman
  // las registradas después del último refresco.
  const known = new Set(state.round?.my_answers.map((a) => a.item_id));
  let extra = 0;
  for (const [id, res] of results) if (!known.has(id) && res.points) extra += res.points;
  return me.score + extra;
}

function updateBoard() {
  if (!board) return;
  const total = board.r.items.length;
  const done = results.size;
  board.progress.textContent = `📦 ${done}/${total}`;
  board.score.textContent = `⭐ ${currentScore()}`;
  tick();
}

function tick() {
  if (!board || !state?.round) return;
  const t = roundTimer(state.round, clock.now());
  const allDone = results.size >= board.r.items.length;
  board.timerText.textContent = formatSeconds(t.remainingMs);
  board.timerBar.firstChild.style.width = `${Math.round(t.fraction * 100)}%`;
  board.timerBar.classList.toggle('low', t.phase === 'running' && t.remainingMs <= 10000);

  let overlay = null;
  if (t.phase === 'leadin') overlay = ['¡Prepárate!', String(Math.ceil(t.leadInMs / 1000))];
  else if (t.phase === 'paused') overlay = ['⏸️ Pausa', 'El instructor pausó la ronda'];
  else if (t.phase === 'ended') overlay = ['⏰ ¡Tiempo!', 'Respuestas bloqueadas. Calculando resultados…'];
  else if (allDone) overlay = ['🎉 ¡Listo!', 'Clasificaste todos los residuos. Espera el final de la ronda.'];

  board.locked = t.phase !== 'running';
  board.el.classList.toggle('locked', board.locked);
  if (overlay) {
    board.overlay.hidden = false;
    clear(board.overlay).append(h('div', { class: 'overlay-box' }, h('strong', {}, overlay[0]), h('span', {}, overlay[1])));
    board.overlay.classList.toggle('overlay-soft', allDone && t.phase === 'running');
  } else {
    board.overlay.hidden = true;
  }

  if (t.phase === 'ended' && board.lastPhase !== 'ended') {
    // El servidor cierra la ronda al vencer el tiempo (+1 s de margen).
    scheduleRefresh(1500);
  }
  if (t.phase === 'running' && board.lastPhase === 'leadin') board.feedback.textContent = '¡Ya! Clasifica los residuos.';
  board.lastPhase = t.phase;
}

function scoreSummary() {
  const me = state.me;
  return h('div', { class: 'score-summary' },
    h('div', {}, h('strong', {}, String(me?.score ?? 0)), h('span', {}, 'puntos')),
    h('div', {}, h('strong', {}, `${me?.pos ?? '-'}°`), h('span', {}, `de ${me?.total_players ?? '-'}`)),
    h('div', {}, h('strong', {}, String(me?.correct ?? 0)), h('span', {}, 'aciertos')));
}

function leaderboardList(rows) {
  return h('ol', { class: 'leaderboard' }, (rows || []).map((r) =>
    h('li', { class: r.alias === state.player.alias ? 'me' : '' },
      h('span', { class: 'pos' }, `${r.pos}°`), h('span', { class: 'alias' }, r.alias),
      h('span', { class: 'pts' }, `${r.score} pts`))));
}

function renderRoundResults() {
  releaseWakeLock();
  const r = state.round;
  const mine = new Map((r?.my_answers || []).map((a) => [a.item_id, a]));
  clear(app).append(
    header(),
    h('section', { class: 'card center' },
      h('h2', {}, r ? `Resultados de la ronda ${r.round_no}` : 'Resultados'),
      scoreSummary(),
      h('p', { class: 'muted' }, state.game.current_round < state.game.total_rounds
        ? 'Espera a que el instructor inicie la siguiente ronda.'
        : 'Espera a que el instructor anuncie al ganador.')),
    r ? h('section', { class: 'card' }, h('h3', {}, 'Revisa tus respuestas'),
      h('ul', { class: 'review' }, r.items.map((it) => {
        const a = mine.get(it.id);
        const correct = binByCode(it.correct_bin);
        const chosen = a ? binByCode(a.chosen_bin) : null;
        return h('li', { class: a?.is_correct ? 'ok' : 'bad' },
          wasteImage(it.image_url, it.name, 'review-img'),
          h('div', {},
            h('strong', {}, `${a?.is_correct ? '✅' : '❌'} ${it.name}`),
            h('p', { class: 'small' }, a ? `Elegiste: ${chosen?.color_name ?? a.chosen_bin}` : 'Sin responder',
              ` · Correcto: ${correct?.color_name ?? ''} (${correct?.label ?? ''})`),
            h('p', { class: 'small muted' }, it.explanation)));
      }))) : null,
    h('section', { class: 'card' }, h('h3', {}, '🏆 Ranking'), leaderboardList(state.leaderboard)));
}

function renderFinal() {
  releaseWakeLock();
  const winners = (state.leaderboard || []).filter((r) => r.pos === 1 && r.score > 0);
  const iWon = winners.some((w) => w.alias === state.player.alias);
  clear(app).append(
    header(),
    h('section', { class: 'card center final' },
      h('div', { class: 'big-emoji', 'aria-hidden': 'true' }, iWon ? '🏆' : '🎉'),
      h('h2', {}, iWon ? '¡Felicitaciones, ganaste!' : 'Partida finalizada'),
      winners.length ? h('p', { class: 'winner' }, `${winners.length > 1 ? 'Ganadores' : 'Ganador'}: ${winners.map((w) => w.alias).join(', ')}`) : null,
      scoreSummary(),
      h('p', { class: 'muted' }, 'Gracias por participar. ¡Segrega correctamente también en tu área de trabajo!')),
    h('section', { class: 'card' }, h('h3', {}, 'Ranking final'), leaderboardList(state.leaderboard)),
    h('button', { class: 'btn btn-ghost', onclick: () => leave() }, 'Salir'));
}

// ---------------------------------------------------------------------
// Pantalla encendida durante la ronda (si el navegador lo permite)
// ---------------------------------------------------------------------
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* opcional */ }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------
if (configError) {
  renderConfigError(app, configError);
} else {
  setInterval(tick, 250);
  window.addEventListener('online', () => { setNet(true); scheduleRefresh(100); });
  window.addEventListener('offline', () => setNet(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { scheduleRefresh(100); if (board) requestWakeLock(); }
  });
  const urlCode = new URLSearchParams(location.search).get('code');
  if (session && (!urlCode || urlCode === session.code)) {
    // Reconexión: se recupera la sesión guardada en este dispositivo.
    connectChannel();
    clear(app).append(h('p', { class: 'center muted' }, 'Reconectando…'));
    refresh();
  } else {
    if (session) saveSession(null);
    renderJoin();
  }
}
