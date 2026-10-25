// Simulador de participantes contra un proyecto Supabase REAL.
// 1) El instructor crea una partida en /instructor.html y anota el código.
// 2) Ejecute:  SUPABASE_URL=... SUPABASE_ANON_KEY=... node tests/load/simulate-supabase.mjs 123456 100 [--realtime]
// 3) Inicie las rondas desde el panel: los bots responden (≈70 % correcto al azar
//    entre contenedores) y al final se imprime un resumen de latencias y errores.
// Use un proyecto de PRUEBAS: crea participantes "Bot NNN" en la partida.
import { createClient } from '@supabase/supabase-js';

const [code, nArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const N = Number(nArg || 50);
const REALTIME = process.argv.includes('--realtime');
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key || !/^\d{6}$/.test(code || '')) {
  console.error('Uso: SUPABASE_URL=... SUPABASE_ANON_KEY=... node tests/load/simulate-supabase.mjs <codigo> <participantes> [--realtime]');
  process.exit(1);
}

const lat = {};
const errs = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(sb, fn, args) {
  const t = performance.now();
  const { data, error } = await sb.rpc(fn, args);
  (lat[fn] ||= []).push(performance.now() - t);
  if (error) { const k = `${fn}: ${error.message.split(':')[0]}`; errs[k] = (errs[k] || 0) + 1; throw error; }
  return data;
}

async function bot(i) {
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const alias = `Bot ${String(i).padStart(3, '0')}`;
  await sleep(Math.random() * 3000);
  const me = await call(sb, 'join_game', { p_code: code, p_alias: alias });
  let wake = () => {};
  if (REALTIME) {
    sb.channel(`eco-${code}`).on('broadcast', { event: 'signal' }, () => wake()).subscribe();
  }
  const done = new Set();
  for (;;) {
    let st;
    try { st = await call(sb, 'player_state', { p_token: me.token }); } catch { await sleep(3000); continue; }
    const g = st.game;
    if (g.status === 'finished' || g.status === 'closed' || st.player.kicked) return st.me;
    const r = st.round;
    if (g.status === 'running' && r && r.status === 'running') {
      const wait = Date.parse(r.started_at) - Date.parse(st.server_now);
      if (wait > 0) await sleep(wait + 100);
      const bins = st.bins.map((b) => b.code);
      for (const it of r.items) {
        if (done.has(`${r.id}:${it.id}`)) continue;
        await sleep(500 + Math.random() * 3000);
        try {
          await call(sb, 'submit_answer', { p_token: me.token, p_round_id: r.id, p_item_id: it.id,
            p_bin: bins[Math.floor(Math.random() * bins.length)] });
          done.add(`${r.id}:${it.id}`);
        } catch { /* ronda cerrada o pausa: se reintenta en el próximo sondeo */ }
      }
    }
    await Promise.race([sleep(REALTIME ? 8000 : 3000), new Promise((r) => { wake = r; })]);
  }
}

console.log(`Lanzando ${N} participantes simulados en la partida ${code} (${REALTIME ? 'con' : 'sin'} Realtime)…`);
const t0 = Date.now();
const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => bot(i + 1)));
const ok = results.filter((r) => r.status === 'fulfilled').length;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
console.log(`\nTerminado en ${((Date.now() - t0) / 1000).toFixed(0)} s · ${ok}/${N} participantes completaron`);
console.table(Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { llamadas: v.length, 'p50 ms': pct(v, 50).toFixed(0), 'p95 ms': pct(v, 95).toFixed(0), 'máx ms': Math.max(...v).toFixed(0) }])));
if (Object.keys(errs).length) { console.log('Errores devueltos por el servidor:'); console.table(errs); }
process.exit(ok === N ? 0 : 1);
