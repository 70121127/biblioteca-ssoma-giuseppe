import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, parseCsv, csvCell } from '../../src/js/csv.js';
import { ServerClock, roundTimer, formatSeconds } from '../../src/js/clock.js';
import { checkSupabaseConfig } from '../../src/js/keys.js';
import { errorCode, friendlyError } from '../../src/js/errors.js';
import { isValidAlias, normalizeAlias, isValidCode, validateWasteItem, shuffle } from '../../src/js/validation.js';

const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

test('CSV: BOM, separador, comillas y protección contra fórmulas', () => {
  const csv = toCsv([{ a: 'Ana; "la jefa"', b: '=1+1' }, { a: 'Ñandú', b: 3 }], [{ label: 'Alias', key: 'a' }, { label: 'Puntos', key: 'b' }], ';');
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv, '﻿Alias;Puntos\r\n"Ana; ""la jefa""";\'=1+1\r\nÑandú;3\r\n');
  assert.equal(csvCell(null), '');
});

test('CSV: ida y vuelta con parseCsv', () => {
  const rows = [{ nombre: 'Lata, aluminio', ambito: 'municipal', explicacion: 'Línea 1\nLínea 2' }];
  const cols = Object.keys(rows[0]).map((k) => ({ label: k, key: k }));
  for (const sep of [';', ',']) assert.deepEqual(parseCsv(toCsv(rows, cols, sep)), rows);
});

test('Reloj del servidor y cronómetro', () => {
  let local = 1_000_000;
  const c = new ServerClock(() => local);
  c.sample(new Date(1_005_000).toISOString(), 999_900, 1_000_100); // RTT 200 ms
  assert.equal(c.now(), 1_005_000);
  const round = { status: 'running', duration_s: 60, started_at: new Date(10_000).toISOString(), ends_at: new Date(70_000).toISOString() };
  assert.equal(roundTimer(round, 8_000).phase, 'leadin');
  const t = roundTimer(round, 40_000);
  assert.equal(t.phase, 'running');
  assert.equal(t.remainingMs, 30_000);
  assert.equal(roundTimer(round, 71_000).phase, 'ended');
  const paused = { ...round, status: 'paused', paused_at: new Date(50_000).toISOString() };
  assert.equal(roundTimer(paused, 99_000).remainingMs, 20_000);
  assert.equal(formatSeconds(59_001), '1:00');
  assert.equal(formatSeconds(9_200), '10');
});

test('Configuración: se rechazan claves secretas', () => {
  assert.match(checkSupabaseConfig('', ''), /no está configurado/);
  assert.equal(checkSupabaseConfig('https://x.supabase.co', jwt({ role: 'anon' })), null);
  assert.match(checkSupabaseConfig('https://x.supabase.co', jwt({ role: 'service_role' })), /service_role/);
  assert.match(checkSupabaseConfig('https://x.supabase.co', 'sb_secret_abc'), /SECRETA/);
  assert.equal(checkSupabaseConfig('https://x.supabase.co', 'sb_publishable_abc'), null);
});

test('Errores del servidor traducidos', () => {
  assert.equal(errorCode({ message: 'ALIAS_EN_USO' }), 'ALIAS_EN_USO');
  assert.equal(errorCode({ message: 'BANCO_VACIO: no hay residuos' }), 'BANCO_VACIO');
  assert.match(friendlyError({ message: 'TIEMPO_AGOTADO' }), /Tiempo agotado/);
  assert.match(friendlyError(new TypeError('Failed to fetch')), /Sin conexión/);
});

test('Alias, código y mezcla', () => {
  assert.equal(normalizeAlias('  Ana   María '), 'Ana María');
  assert.ok(isValidAlias('José_01'));
  assert.ok(!isValidAlias('x'));
  assert.ok(!isValidAlias('<b>hola</b>'));
  assert.ok(isValidCode('012345'));
  assert.ok(!isValidCode('12345'));
  const s = shuffle([1, 2, 3, 4, 5]);
  assert.deepEqual([...s].sort(), [1, 2, 3, 4, 5]);
});

test('Validación de registros del banco (importación)', () => {
  const ok = validateWasteItem({ nombre: 'Lata', ambito: 'No municipal', contenedor: 'Amarillo', imagen: '/img/residuos/lata.svg',
    explicacion: 'Metales al amarillo', activo: 'si' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.item.scope, 'no_municipal');
  assert.equal(ok.item.bin_code, 'amarillo');
  const marron = validateWasteItem({ name: 'Cáscara', scope: 'municipal', bin_code: 'Marrón', image_url: '/x.svg', explanation: 'Orgánico' });
  assert.equal(marron.item.bin_code, 'marron');
  const mix = validateWasteItem({ name: 'Papel', scope: 'municipal', bin_code: 'azul', image_url: '/x.svg', explanation: 'Papel limpio' });
  assert.match(mix.errors.join(), /no válido para el ámbito Municipal/);
  const ext = validateWasteItem({ name: 'Foto', scope: 'municipal', bin_code: 'verde', image_url: 'https://e.com/a.png', image_source: 'externa_autorizada', explanation: 'Texto ok' });
  assert.match(ext.errors.join(), /autor y licencia/);
  const js = validateWasteItem({ name: 'X1', scope: 'municipal', bin_code: 'verde', image_url: 'javascript:alert(1)', explanation: 'Texto ok' });
  assert.match(js.errors.join(), /Imagen/);
});
