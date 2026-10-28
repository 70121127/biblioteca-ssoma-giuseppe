// Panel del instructor y pantalla de proyección.
import QRCode from 'qrcode';
import { supabase, configError, rpc, timedRpc, publicSiteUrl } from './supabase.js';
import { h, $, clear, toast, renderConfigError, wasteImage, binBadge, scopeLabel, downloadFile, formatDate, getScopes, THEMES, themeOf } from './ui.js';
import { loadScopes } from './scopes.js';
import { friendlyError, isNetworkError } from './errors.js';
import { ServerClock, roundTimer, formatSeconds } from './clock.js';
import { joinGameChannel } from './realtime.js';
import { currentStaff, renderLogin, logout } from './auth.js';
import { toCsv } from './csv.js';

const GAME_KEY = 'eco.host.game';
const app = $('#app');
const nav = $('#nav');
const clock = new ServerClock();

let staff = null;
let gameId = null;
let hs = null;            // último host_state
let channel = null;
let pollTimer = null;
let busy = false;
let view = null;          // referencias de la vista de partida
let showLiveRanking = false;
let csvSep = ';';

const STATUS_LABEL = {
  lobby: 'Sala de espera', running: 'Ronda en curso', paused: 'En pausa',
  between_rounds: 'Entre rondas', finished: 'Finalizada', closed: 'Cerrada',
};

function savedGame(id) {
  try {
    if (id === undefined) return localStorage.getItem(GAME_KEY);
    if (id) localStorage.setItem(GAME_KEY, id); else localStorage.removeItem(GAME_KEY);
  } catch { /* opcional */ }
  return null;
}

function joinUrl(code) {
  const base = publicSiteUrl ? `${publicSiteUrl}/jugar.html` : new URL('jugar.html', document.baseURI).href;
  return `${base}?code=${encodeURIComponent(code)}`;
}

// ---------------------------------------------------------------------
// Navegación
// ---------------------------------------------------------------------
function renderNav() {
  clear(nav).append(
    h('button', { class: 'btn btn-ghost', onclick: () => openNewGame() }, '➕ Nueva partida'),
    h('button', { class: 'btn btn-ghost', onclick: () => openHistory() }, '🗂️ Historial'),
    h('a', { class: 'btn btn-ghost', href: 'admin.html' }, '🖼️ Banco de preguntas'),
    h('span', { class: 'muted small nav-user' }, `${staff.user.email} · ${staff.role}`),
    h('button', { class: 'btn btn-ghost', onclick: logout }, 'Salir'));
}

function stopGameView() {
  clearTimeout(pollTimer);
  channel?.close();
  channel = null;
  view = null;
  hs = null;
}

// ---------------------------------------------------------------------
// Crear partida
// ---------------------------------------------------------------------
async function openNewGame() {
  stopGameView();
  gameId = null;
  savedGame(null);
  clear(app).append(h('p', { class: 'muted' }, 'Cargando bancos…'));

  const [banksRes, itemsRes, linksRes] = await Promise.all([
    supabase.from('question_banks').select('id, name, scope, description').order('name'),
    supabase.from('waste_items').select('id, scope, status, active'),
    supabase.from('bank_items').select('bank_id, item_id'),
  ]);
  const err = banksRes.error || itemsRes.error || linksRes.error;
  if (err) { clear(app).append(h('p', { class: 'form-error' }, friendlyError(err))); return; }

  await loadScopes();
  const scopes = getScopes();
  const playable = new Set(itemsRes.data.filter((i) => i.active && i.status === 'aprobado').map((i) => i.id));
  const countByScope = Object.fromEntries(scopes.map((sc) => [sc.code, 0]));
  for (const i of itemsRes.data) if (playable.has(i.id)) countByScope[i.scope] = (countByScope[i.scope] || 0) + 1;
  const countByBank = {};
  for (const l of linksRes.data) if (playable.has(l.item_id)) countByBank[l.bank_id] = (countByBank[l.bank_id] || 0) + 1;

  // Tema (residuos sólidos / riesgos críticos) y luego su ámbito o grupo.
  const urlTheme = new URLSearchParams(location.search).get('tema');
  const themes = Object.keys(THEMES).filter((t) => scopes.some((sc) => sc.theme === t));
  const themeInputs = themes.map((t) => h('label', { class: 'radio-card' },
    h('input', { type: 'radio', name: 'theme', value: t, checked: t === (themes.includes(urlTheme) ? urlTheme : themes[0]) }),
    h('strong', {}, `${THEMES[t].icon} ${THEMES[t].name}`),
    h('span', { class: 'small muted' }, t === 'residuos'
      ? 'Clasificar residuos en el contenedor correcto (NTP 900.058:2019).'
      : 'Relacionar cada control con su riesgo crítico.')));
  const scopeRow = h('div', { class: 'radio-row' });
  const scopeLegend = h('legend', {});
  const currentTheme = () => new FormData(form).get('theme') || themes[0];

  function renderScopes() {
    const t = currentTheme();
    scopeLegend.textContent = t === 'residuos' ? 'Ámbito de gestión de residuos (obligatorio)' : 'Grupo de riesgos críticos (obligatorio)';
    clear(scopeRow).append(...scopes.filter((sc) => sc.theme === t).map((sc) => h('label', { class: 'radio-card' },
      h('input', { type: 'radio', name: 'scope', value: sc.code, required: true }),
      h('strong', {}, sc.name),
      h('span', { class: 'small muted' }, sc.description || ''),
      h('span', { class: 'small muted' }, `${countByScope[sc.code] || 0} ${THEMES[t].items} aprobados`))));
    clear(bank).append(h('option', { value: '' }, 'Primero elija el ámbito'));
    bank.disabled = true;
    bankInfo.textContent = '';
  }

  const bank = h('select', { name: 'bank', disabled: true }, h('option', { value: '' }, 'Primero elija el ámbito'));
  const bankInfo = h('p', { class: 'small muted' });
  const num = (name, value, min, max, step = 1) => h('input', { type: 'number', name, value, min, max, step, required: true });
  const fields = {
    title: h('input', { name: 'title', maxlength: 80, placeholder: 'Ej.: Inducción SSOMA – Turno A' }),
    duration: num('duration', 60, 10, 600, 5),
    items: num('items', 8, 1, 30),
    rounds: num('rounds', 3, 1, 20),
    base: num('base', 100, 10, 1000, 10),
    bonus: num('bonus', 50, 0, 50, 5),
    feedback: h('select', { name: 'feedback' },
      h('option', { value: 'inmediata' }, 'Inmediata: el participante ve si acertó'),
      h('option', { value: 'al_final' }, 'Al final de la ronda: sólo "respuesta registrada"')),
  };
  const msg = h('p', { class: 'form-error', role: 'alert' });

  function onScope() {
    const scope = new FormData(form).get('scope');
    clear(bank);
    bank.disabled = false;
    bank.append(h('option', { value: '' }, `Todos los ${THEMES[themeOf(scope)].items} aprobados del ámbito (${countByScope[scope] || 0})`));
    for (const b of banksRes.data.filter((x) => x.scope === scope)) {
      bank.append(h('option', { value: b.id }, `${b.name} (${countByBank[b.id] || 0} aprobados)`));
    }
    onBank();
  }
  function onBank() {
    const scope = new FormData(form).get('scope');
    const n = bank.value ? (countByBank[bank.value] || 0) : (countByScope[scope] || 0);
    const words = THEMES[themeOf(scope)];
    bankInfo.textContent = n
      ? `${n} ${words.items} disponibles para jugar.`
      : `⚠️ No hay ${words.items} aprobados y activos. Un administrador debe validarlos en el banco.`;
  }

  const form = h('form', { class: 'card form-grid', onsubmit: async (ev) => {
    ev.preventDefault();
    msg.textContent = '';
    const fd = new FormData(form);
    try {
      const g = await rpc('create_game', {
        p_scope: fd.get('scope'),
        p_bank_id: bank.value || null,
        p_title: fields.title.value,
        p_round_duration_s: Number(fields.duration.value),
        p_base_points: Number(fields.base.value),
        p_speed_bonus_max: Number(fields.bonus.value),
        p_items_per_round: Number(fields.items.value),
        p_total_rounds: Number(fields.rounds.value),
        p_feedback_mode: fields.feedback.value,
      });
      openGame(g.id);
    } catch (e) {
      msg.textContent = friendlyError(e);
    }
  } },
  h('h2', { class: 'span-2' }, 'Nueva partida'),
  h('fieldset', { class: 'span-2', onchange: renderScopes },
    h('legend', {}, 'Tema de la capacitación'),
    h('div', { class: 'radio-row' }, themeInputs)),
  h('fieldset', { class: 'span-2', onchange: onScope }, scopeLegend, scopeRow),
  h('label', { class: 'span-2' }, 'Banco de preguntas', bank, bankInfo),
  h('label', { class: 'span-2' }, 'Título (opcional)', fields.title),
  h('label', {}, 'Duración de cada ronda (segundos)', fields.duration),
  h('label', {}, 'Tarjetas por ronda', fields.items),
  h('label', {}, 'Número de rondas', fields.rounds),
  h('label', {}, 'Puntos por respuesta correcta', fields.base),
  h('label', {}, 'Bono máximo por rapidez (0–50)', fields.bonus),
  h('label', {}, 'Retroalimentación', fields.feedback),
  msg,
  h('div', { class: 'span-2 actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Crear partida')));
  bank.addEventListener('change', onBank);
  clear(app).append(form);
  renderScopes();
}

// ---------------------------------------------------------------------
// Partida
// ---------------------------------------------------------------------
async function openGame(id) {
  stopGameView();
  gameId = id;
  savedGame(id);
  clear(app).append(h('p', { class: 'muted' }, 'Cargando partida…'));
  await poll();
}

async function poll() {
  clearTimeout(pollTimer);
  if (!gameId) return;
  try {
    const { data, sentAt, receivedAt } = await timedRpc('host_state', { p_game_id: gameId });
    clock.sample(data.server_now, sentAt, receivedAt);
    const prev = hs;
    hs = data;
    if (!channel && hs.game.status !== 'closed') channel = joinGameChannel(hs.game.code, {});
    // Si la ronda se cerró por tiempo, se avisa a los participantes.
    if (prev && prev.game.status !== hs.game.status) signal();
    renderGame();
  } catch (err) {
    if (!isNetworkError(err)) {
      toast(friendlyError(err), 'error');
      if (!hs) { savedGame(null); openHistory(); return; }
    }
  }
  const s = hs?.game.status;
  if (s === 'closed') return;
  pollTimer = setTimeout(poll, s === 'running' || s === 'paused' ? 1500 : 3000);
}

function signal() {
  channel?.send({ t: Date.now(), status: hs?.game.status });
}

async function act(fn, label) {
  if (busy) return;
  busy = true;
  try {
    await rpc(fn, { p_game_id: gameId });
    await poll();
    signal();
    if (label) toast(label, 'ok', 2000);
  } catch (err) {
    toast(friendlyError(err), 'error');
  } finally {
    busy = false;
  }
}

function controls(g, r) {
  const canStart = (g.status === 'lobby' || g.status === 'between_rounds') && g.current_round < g.total_rounds;
  const btns = [];
  if (canStart) {
    btns.push(h('button', { class: 'btn btn-primary btn-lg', onclick: () => act('start_round') },
      g.current_round === 0 ? '▶️ Iniciar ronda 1' : `▶️ Iniciar ronda ${g.current_round + 1}`));
  }
  if (g.status === 'running') btns.push(h('button', { class: 'btn', onclick: () => act('pause_round') }, '⏸️ Pausar'));
  if (g.status === 'paused') btns.push(h('button', { class: 'btn btn-primary', onclick: () => act('resume_round') }, '▶️ Reanudar'));
  if (g.status === 'running' || g.status === 'paused') {
    btns.push(h('button', { class: 'btn', onclick: () => confirm('¿Terminar la ronda ahora? Se bloquearán las respuestas.') && act('end_round') }, '⏹️ Finalizar ronda'));
  }
  if (['lobby', 'running', 'paused', 'between_rounds'].includes(g.status) && (g.current_round > 0 || r)) {
    btns.push(h('button', { class: g.current_round >= g.total_rounds ? 'btn btn-primary btn-lg' : 'btn',
      onclick: () => confirm('¿Finalizar la partida y declarar al ganador?') && act('finish_game') }, '🏁 Finalizar partida'));
  }
  if (g.status !== 'closed') {
    btns.push(h('button', { class: 'btn btn-danger-ghost', onclick: () => {
      if (!confirm('¿Cerrar la partida? Los participantes ya no podrán ver resultados y el código se liberará.')) return;
      act('close_game', 'Partida cerrada').then(() => { savedGame(null); stopGameView(); openHistory(); });
    } }, '✖️ Cerrar partida'));
  }
  btns.push(h('button', { class: 'btn btn-ghost', onclick: toggleFullscreen }, '⛶ Pantalla completa'));
  return h('div', { class: 'controls' }, btns);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function qrBlock(code, big) {
  const img = h('img', { class: big ? 'qr qr-big' : 'qr', alt: `Código QR para unirse a la partida ${code}` });
  QRCode.toDataURL(joinUrl(code), { margin: 1, width: big ? 360 : 180, errorCorrectionLevel: 'M' })
    .then((src) => { img.src = src; }).catch(() => {});
  return h('div', { class: big ? 'join-box' : 'join-box join-box-small' },
    h('p', { class: 'join-url' }, 'Ingresa en ', h('strong', {}, joinUrl('').replace(/\?code=$/, ''))),
    h('div', { class: big ? 'code-big' : 'code-small', 'aria-label': 'Código de partida' }, code),
    img);
}

function playersPanel() {
  const players = hs.players.filter((p) => !p.kicked);
  const online = players.filter((p) => p.connected).length;
  return h('section', { class: 'card players-panel' },
    h('h3', {}, `👥 Participantes: ${players.length}`, h('span', { class: 'muted small' }, ` · ${online} conectados`)),
    h('ul', { class: 'player-chips' }, players.map((p) => h('li', { class: p.connected ? 'online' : 'offline' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }), p.alias,
      h('button', { class: 'kick', title: `Retirar a ${p.alias}`, 'aria-label': `Retirar a ${p.alias}`, onclick: async () => {
        if (!confirm(`¿Retirar a "${p.alias}" de la partida?`)) return;
        try { await rpc('kick_player', { p_game_id: gameId, p_player_id: p.id }); await poll(); } catch (e) { toast(friendlyError(e), 'error'); }
      } }, '×')))));
}

function leaderboardTable(rows, limit = 10) {
  const list = rows.slice(0, limit);
  if (!list.length) return h('p', { class: 'muted' }, 'Aún no hay puntajes.');
  return h('table', { class: 'table leaderboard-table' },
    h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Alias'), h('th', {}, 'Puntos'), h('th', {}, 'Aciertos'), h('th', {}, 'Tiempo (s)'))),
    h('tbody', {}, list.map((r) => h('tr', { class: r.pos === 1 ? 'first' : '' },
      h('td', {}, `${r.pos}°`), h('td', {}, r.alias), h('td', {}, String(r.score)),
      h('td', {}, String(r.correct)), h('td', {}, (r.correct_ms / 1000).toFixed(1))))));
}

function settingsPanel(g) {
  if (!['lobby', 'between_rounds'].includes(g.status)) return null;
  const lobby = g.status === 'lobby';
  const num = (value, min, max, step = 1, disabled = false) => h('input', { type: 'number', value, min, max, step, disabled });
  const f = {
    duration: num(g.round_duration_s, 10, 600, 5),
    items: num(g.items_per_round, 1, 30),
    rounds: num(g.total_rounds, Math.max(1, g.current_round), 20),
    base: num(g.base_points, 10, 1000, 10, !lobby),
    bonus: num(g.speed_bonus_max, 0, 50, 5, !lobby),
    feedback: h('select', {},
      h('option', { value: 'inmediata', selected: g.feedback_mode === 'inmediata' }, 'Inmediata'),
      h('option', { value: 'al_final', selected: g.feedback_mode === 'al_final' }, 'Al final de la ronda')),
  };
  return h('details', { class: 'card settings' },
    h('summary', {}, '⚙️ Configuración de la partida'),
    h('div', { class: 'form-grid' },
      h('label', {}, 'Duración (s)', f.duration), h('label', {}, 'Residuos por ronda', f.items),
      h('label', {}, 'Rondas', f.rounds), h('label', {}, 'Retroalimentación', f.feedback),
      h('label', {}, 'Puntos base', f.base), h('label', {}, 'Bono por rapidez (máx. 50)', f.bonus),
      lobby ? null : h('p', { class: 'small muted span-2' }, 'La puntuación queda fija una vez iniciada la partida.'),
      h('div', { class: 'span-2 actions' }, h('button', { class: 'btn', onclick: async () => {
        try {
          await rpc('update_game_settings', {
            p_game_id: gameId,
            p_round_duration_s: Number(f.duration.value),
            p_items_per_round: Number(f.items.value),
            p_total_rounds: Number(f.rounds.value),
            p_feedback_mode: f.feedback.value,
            p_base_points: lobby ? Number(f.base.value) : null,
            p_speed_bonus_max: lobby ? Number(f.bonus.value) : null,
          });
          toast('Configuración guardada', 'ok');
          await poll();
          signal();
        } catch (e) { toast(friendlyError(e), 'error'); }
      } }, 'Guardar'))));
}

function renderGame() {
  const g = hs.game;
  const r = hs.round;
  const inRound = (g.status === 'running' || g.status === 'paused') && r;
  const key = `${g.status}:${r?.id ?? ''}:${r?.status ?? ''}:${showLiveRanking}`;

  if (view?.key === key) { updateGame(); return; }
  view = { key };
  app.dataset.theme = hs.scope_info?.theme || 'residuos';

  const head = h('div', { class: 'game-head' },
    h('div', {},
      h('h2', {}, g.title || (hs.scope_info?.theme === 'riesgos' ? 'Partida Riesgos Críticos' : 'Partida SSOMA Eco Challenge')),
      h('div', { class: 'chips' },
        h('span', { class: 'chip' }, `📍 ${scopeLabel(g.scope)}`),
        h('span', { class: 'chip' }, `🗂️ ${g.bank_name || 'Todos los aprobados'}`),
        h('span', { class: `chip status-${g.status}` }, STATUS_LABEL[g.status]),
        h('span', { class: 'chip' }, `Ronda ${g.current_round}/${g.total_rounds}`),
        h('span', { class: 'chip' }, `Código ${g.code}`))),
    controls(g, r));

  const body = [];
  if (g.status === 'lobby') {
    body.push(h('div', { class: 'lobby-grid' }, qrBlock(g.code, true), playersPanel()));
  } else if (inRound) {
    view.timer = h('div', { class: 'host-timer' }, '');
    view.bar = h('div', { class: 'timer-bar' }, h('span'));
    view.progress = h('div', { class: 'host-progress' });
    view.itemCounts = new Map();
    const items = h('div', { class: 'host-items' }, r.items.map((it) => {
      const count = h('span', { class: 'count' }, '0');
      view.itemCounts.set(it.id, count);
      return h('figure', { class: 'host-item' }, wasteImage(it.image_url, it.name), h('figcaption', {}, it.name), count);
    }));
    view.overlay = h('div', { class: 'host-overlay', hidden: true });
    body.push(
      h('div', { class: 'round-top' }, view.timer, view.progress,
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: showLiveRanking,
          onchange: (e) => { showLiveRanking = e.target.checked; renderGame(); } }), ' Mostrar ranking en vivo'),
        h('div', { class: 'side-join' }, qrBlock(g.code, false))),
      view.bar,
      h('div', { class: showLiveRanking ? 'round-grid with-ranking' : 'round-grid' },
        h('section', { class: 'card' }, items, view.overlay),
        showLiveRanking ? h('section', { class: 'card' }, h('h3', {}, '🏆 Ranking en vivo'), view.ranking = h('div')) : null),
      h('section', { class: 'card' }, h('div', { class: 'bins-legend bins-host' }, hs.bins.map((b) => binBadge(b)))));
  } else if (g.status === 'between_rounds') {
    body.push(
      h('div', { class: 'round-grid with-ranking' },
        h('section', { class: 'card' }, h('h3', {}, `✅ Respuestas correctas · Ronda ${r?.round_no ?? ''}`), reveal(r)),
        h('section', { class: 'card' }, h('h3', {}, '🏆 Ranking'), leaderboardTable(hs.leaderboard))),
      h('div', { class: 'lobby-grid' }, playersPanel(), qrBlock(g.code, false)));
  } else {
    body.push(finalView());
  }
  const settings = settingsPanel(g);
  clear(app).append(head, ...body, settings || '');
  updateGame();
}

function reveal(r) {
  if (!r) return h('p', { class: 'muted' }, '—');
  const bins = new Map(hs.bins.map((b) => [b.code, b]));
  return h('ul', { class: 'reveal' }, r.items.map((it) => {
    const b = bins.get(it.correct_bin);
    const pct = it.answers ? Math.round((it.correct / it.answers) * 100) : 0;
    return h('li', {}, wasteImage(it.image_url, it.name, 'review-img'),
      h('div', {}, h('strong', {}, it.name), h('p', { class: 'small muted' }, it.explanation)),
      b ? binBadge(b, { cls: 'bin bin-mini' }) : null,
      h('span', { class: 'pct', title: 'Porcentaje de aciertos' }, `${pct}%`));
  }));
}

function finalView() {
  const rows = hs.leaderboard;
  const winners = rows.filter((x) => x.pos === 1 && x.score > 0);
  const podium = rows.slice(0, 3);
  const sep = h('select', { onchange: (e) => { csvSep = e.target.value; } },
    h('option', { value: ';', selected: csvSep === ';' }, 'Separador ";" (Excel en español)'),
    h('option', { value: ',', selected: csvSep === ',' }, 'Separador "," (Excel en inglés)'));
  return h('div', {},
    h('section', { class: 'card center final-host' },
      h('div', { class: 'big-emoji' }, '🏆'),
      winners.length
        ? h('h2', {}, `${winners.length > 1 ? 'Ganadores' : 'Ganador'}: ${winners.map((w) => w.alias).join(', ')}`)
        : h('h2', {}, 'Partida finalizada'),
      h('div', { class: 'podium' }, podium.map((p, i) => h('div', { class: `podium-step p${i + 1}` },
        h('span', { class: 'alias' }, p.alias), h('span', { class: 'pts' }, `${p.score} pts`), h('span', { class: 'place' }, `${p.pos}°`))))),
    h('section', { class: 'card' },
      h('h3', {}, 'Ranking final'),
      h('p', { class: 'small muted' }, 'Desempate: 1) más aciertos, 2) menor tiempo acumulado en respuestas correctas.'),
      leaderboardTable(rows, 500),
      h('div', { class: 'actions' }, sep,
        h('button', { class: 'btn btn-primary', onclick: () => exportCsv(gameId, 'ranking') }, '⬇️ Ranking (CSV)'),
        h('button', { class: 'btn', onclick: () => exportCsv(gameId, 'detalle') }, '⬇️ Detalle de respuestas (CSV)'))));
}

function updateGame() {
  if (!hs || !view) return;
  const r = hs.round;
  if (view.timer && r) {
    const t = roundTimer(r, clock.now());
    view.timer.textContent = t.phase === 'leadin' ? `Comienza en ${Math.ceil(t.leadInMs / 1000)}…`
      : t.phase === 'paused' ? `⏸️ ${formatSeconds(t.remainingMs)}` : `⏱️ ${formatSeconds(t.remainingMs)}`;
    view.timer.classList.toggle('low', t.phase === 'running' && t.remainingMs <= 10000);
    view.bar.firstChild.style.width = `${Math.round(t.fraction * 100)}%`;
    const players = hs.players.filter((p) => !p.kicked).length;
    const expected = players * r.items.length;
    view.progress.textContent = `📨 ${r.answers_total}/${expected} respuestas · ✅ ${r.players_done}/${players} completaron`;
    for (const it of r.items) view.itemCounts.get(it.id).textContent = String(it.answers);
    if (view.ranking) clear(view.ranking).append(leaderboardTable(hs.leaderboard));
    if (t.phase === 'ended' && !view.endScheduled) {
      view.endScheduled = true;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 1600);
    }
    view.overlay.hidden = t.phase !== 'paused';
    if (t.phase === 'paused') clear(view.overlay).append(h('strong', {}, '⏸️ Ronda en pausa'));
  }
  if (hs.game.status === 'lobby' || hs.game.status === 'between_rounds') {
    const panel = app.querySelector('.players-panel');
    if (panel) panel.replaceWith(playersPanel());
  }
}

// ---------------------------------------------------------------------
// Exportación CSV e historial
// ---------------------------------------------------------------------
async function exportCsv(id, kind) {
  try {
    const res = await rpc('game_results', { p_game_id: id });
    const g = res.game;
    const base = `eco-challenge_${g.code}_${new Date(g.created_at).toISOString().slice(0, 10)}`;
    if (kind === 'ranking') {
      const csv = toCsv(res.ranking, [
        { label: 'Puesto', key: 'pos' }, { label: 'Alias', key: 'alias' }, { label: 'Puntaje', key: 'score' },
        { label: 'Aciertos', key: 'correct' }, { label: 'Respuestas', key: 'answered' },
        { label: 'Tiempo acumulado aciertos (s)', value: (r) => (r.correct_ms / 1000).toFixed(1).replace('.', csvSep === ';' ? ',' : '.') },
        { label: 'Ámbito', value: () => scopeLabel(g.scope) }, { label: 'Partida', value: () => g.title || g.code },
        { label: 'Fecha', value: () => formatDate(g.created_at) },
      ], csvSep);
      downloadFile(`${base}_ranking.csv`, csv, 'text/csv;charset=utf-8');
    } else {
      const csv = toCsv(res.answers, [
        { label: 'Ronda', key: 'round_no' }, { label: 'Alias', key: 'alias' }, { label: 'Residuo', key: 'item' },
        { label: 'Contenedor elegido', key: 'chosen_bin' }, { label: 'Contenedor correcto', key: 'correct_bin' },
        { label: 'Correcto', value: (a) => (a.is_correct ? 'Sí' : 'No') }, { label: 'Puntos', key: 'points' },
        { label: 'Tiempo de respuesta (s)', value: (a) => (a.response_ms / 1000).toFixed(1).replace('.', csvSep === ';' ? ',' : '.') },
        { label: 'Fecha y hora', value: (a) => formatDate(a.answered_at) },
      ], csvSep);
      downloadFile(`${base}_detalle.csv`, csv, 'text/csv;charset=utf-8');
    }
  } catch (err) {
    toast(friendlyError(err), 'error');
  }
}

async function openHistory() {
  stopGameView();
  gameId = null;
  clear(app).append(h('p', { class: 'muted' }, 'Cargando historial…'));
  try {
    const games = await rpc('my_games', { p_limit: 100 });
    const table = games.length ? h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Fecha', 'Partida', 'Código', 'Ámbito', 'Estado', 'Rondas', 'Participantes', 'Ganador', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, games.map((g) => h('tr', {},
        h('td', {}, formatDate(g.created_at)), h('td', {}, g.title || '—'), h('td', {}, g.code),
        h('td', {}, scopeLabel(g.scope)), h('td', {}, STATUS_LABEL[g.status]),
        h('td', {}, `${g.current_round}/${g.total_rounds}`), h('td', {}, String(g.players)), h('td', {}, g.winner || '—'),
        h('td', { class: 'row-actions' },
          h('button', { class: 'btn btn-small', onclick: () => openGame(g.id) }, g.status === 'closed' ? 'Ver' : 'Abrir'),
          h('button', { class: 'btn btn-small btn-ghost', onclick: () => exportCsv(g.id, 'ranking') }, 'CSV'))))))
      : h('p', { class: 'muted' }, 'Todavía no has creado partidas.');
    clear(app).append(h('section', { class: 'card' }, h('h2', {}, 'Historial de partidas'), table));
  } catch (err) {
    clear(app).append(h('p', { class: 'form-error' }, friendlyError(err)));
  }
}

// ---------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------
async function start() {
  if (configError) { renderConfigError(app, configError); return; }
  try {
    staff = await currentStaff();
  } catch {
    staff = null;
  }
  if (!staff?.role) {
    renderLogin(app, { title: 'Panel del instructor', onLoggedIn: (s) => { staff = s; boot(); } });
    return;
  }
  boot();
}

async function boot() {
  renderNav();
  await loadScopes();
  setInterval(() => { if (view?.timer) updateGame(); }, 250);
  const saved = savedGame();
  if (saved) openGame(saved); else openNewGame();
}

start();
