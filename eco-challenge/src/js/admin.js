// Módulo administrativo: banco de residuos, validación, bancos de preguntas,
// importación/exportación y personal autorizado.
import { supabase, configError, rpc } from './supabase.js';
import { h, $, clear, toast, renderConfigError, wasteImage, binBadge, scopeLabel, downloadFile, formatDate } from './ui.js';
import { friendlyError } from './errors.js';
import { currentStaff, renderLogin, logout } from './auth.js';
import { toCsv, parseCsv } from './csv.js';
import { validateWasteItem, SCOPES } from './validation.js';

const app = $('#app');
const nav = $('#nav');
const ITEM_COLS = 'id, name, scope, bin_code, image_url, image_source, image_credit, explanation, active, status, review_note, validated_at, created_at, updated_at';
const MAX_UPLOAD = 2 * 1024 * 1024;
const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const STATUS = { pendiente: '🕓 Pendiente', aprobado: '✅ Aprobado', rechazado: '⛔ Rechazado' };

let staff = null;
let bins = [];
let items = [];
let tab = 'items';
const filters = { scope: '', status: '', active: '', q: '' };
const selected = new Set();

const isAdmin = () => staff?.role === 'admin';
const binOf = (scope, code) => bins.find((b) => b.scope === scope && b.code === code);

async function loadBase() {
  const [b, i] = await Promise.all([
    supabase.from('bins').select('*').order('scope').order('sort_order'),
    supabase.from('waste_items').select(ITEM_COLS).order('scope').order('name'),
  ]);
  if (b.error) throw b.error;
  if (i.error) throw i.error;
  bins = b.data;
  items = i.data;
}

function renderNav() {
  const tabs = [['items', '🖼️ Residuos'], ['banks', '🗂️ Bancos'], ['io', '⇅ Importar / Exportar']];
  if (isAdmin()) tabs.push(['staff', '👤 Personal']);
  clear(nav).append(
    ...tabs.map(([id, label]) => h('button', { class: `btn btn-ghost ${tab === id ? 'active' : ''}`, onclick: () => { tab = id; route(); } }, label)),
    h('a', { class: 'btn btn-ghost', href: '/instructor.html' }, '🎮 Panel del instructor'),
    h('span', { class: 'muted small nav-user' }, `${staff.user.email} · ${staff.role}`),
    h('button', { class: 'btn btn-ghost', onclick: logout }, 'Salir'));
}

async function route() {
  renderNav();
  try {
    if (tab === 'items') { await loadBase(); renderItems(); }
    else if (tab === 'banks') { await loadBase(); await renderBanks(); }
    else if (tab === 'io') { await loadBase(); renderIO(); }
    else if (tab === 'staff') await renderStaff();
  } catch (err) {
    clear(app).append(h('p', { class: 'form-error' }, friendlyError(err)));
  }
}

// ---------------------------------------------------------------------
// Residuos
// ---------------------------------------------------------------------
function filtered() {
  const q = filters.q.trim().toLowerCase();
  return items.filter((i) => (!filters.scope || i.scope === filters.scope)
    && (!filters.status || i.status === filters.status)
    && (filters.active === '' || String(i.active) === filters.active)
    && (!q || i.name.toLowerCase().includes(q)));
}

function renderItems() {
  const sel = (key, options) => h('select', { onchange: (e) => { filters[key] = e.target.value; renderItems(); } },
    options.map(([v, l]) => h('option', { value: v, selected: filters[key] === v }, l)));
  const search = h('input', { type: 'search', placeholder: 'Buscar residuo…', value: filters.q,
    oninput: (e) => { filters.q = e.target.value; renderList(); } });

  const pending = items.filter((i) => i.status === 'pendiente').length;
  const list = h('div', { class: 'item-grid' });
  const bulk = h('div', { class: 'bulk' });

  function renderBulk() {
    clear(bulk);
    if (!isAdmin()) return;
    bulk.append(
      h('button', { class: 'btn btn-small', onclick: () => { filtered().forEach((i) => selected.add(i.id)); renderList(); } }, 'Seleccionar visibles'),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => { selected.clear(); renderList(); } }, 'Quitar selección'),
      h('button', { class: 'btn btn-small btn-primary', disabled: !selected.size, onclick: () => setStatus([...selected], 'aprobado') },
        `✅ Aprobar seleccionados (${selected.size})`));
  }

  function renderList() {
    clear(list);
    const rows = filtered();
    if (!rows.length) list.append(h('p', { class: 'muted' }, 'No hay residuos con esos filtros.'));
    for (const it of rows) list.append(itemCard(it, renderList));
    renderBulk();
  }

  clear(app).append(
    h('section', { class: 'card' },
      h('div', { class: 'toolbar' },
        h('h2', {}, 'Banco de residuos'),
        h('button', { class: 'btn btn-primary', onclick: () => openEditor(null) }, '➕ Nuevo residuo')),
      pending ? h('p', { class: 'notice' }, `🕓 ${pending} residuo(s) pendientes de validación${isAdmin() ? '' : ' por un administrador'}. Sólo los aprobados y activos se usan en las partidas.`) : null,
      h('div', { class: 'filters' },
        sel('scope', [['', 'Todos los ámbitos'], ['municipal', 'Municipal'], ['no_municipal', 'No municipal']]),
        sel('status', [['', 'Todos los estados'], ['pendiente', 'Pendientes'], ['aprobado', 'Aprobados'], ['rechazado', 'Rechazados']]),
        sel('active', [['', 'Activos e inactivos'], ['true', 'Sólo activos'], ['false', 'Sólo inactivos']]),
        search),
      bulk),
    list);
  renderList();
}

function itemCard(it, rerender) {
  const bin = binOf(it.scope, it.bin_code);
  const check = isAdmin() ? h('input', { type: 'checkbox', checked: selected.has(it.id), 'aria-label': `Seleccionar ${it.name}`,
    onchange: (e) => { if (e.target.checked) selected.add(it.id); else selected.delete(it.id); rerender(); } }) : null;
  return h('article', { class: `item-card ${it.active ? '' : 'inactive'}` },
    h('div', { class: 'item-top' }, check, h('span', { class: `badge badge-${it.status}` }, STATUS[it.status]),
      h('span', { class: 'chip chip-small' }, scopeLabel(it.scope))),
    wasteImage(it.image_url, it.name, 'item-img'),
    h('h3', {}, it.name),
    bin ? binBadge(bin, { cls: 'bin bin-mini' }) : null,
    h('p', { class: 'small muted' }, it.explanation),
    it.image_credit ? h('p', { class: 'tiny muted' }, `Imagen: ${it.image_credit}`) : null,
    it.review_note ? h('p', { class: 'tiny' }, `Observación: ${it.review_note}`) : null,
    h('div', { class: 'item-actions' },
      h('button', { class: 'btn btn-small', onclick: () => openEditor(it) }, 'Editar'),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => toggleActive(it) }, it.active ? 'Desactivar' : 'Activar'),
      isAdmin() && it.status !== 'aprobado' ? h('button', { class: 'btn btn-small btn-primary', onclick: () => setStatus([it.id], 'aprobado') }, 'Aprobar') : null,
      isAdmin() && it.status !== 'rechazado' ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => reject(it) }, 'Rechazar') : null,
      isAdmin() ? h('button', { class: 'btn btn-small btn-danger-ghost', onclick: () => removeItem(it) }, 'Eliminar') : null));
}

async function setStatus(ids, status, note = null) {
  if (!ids.length) return;
  const { error } = await supabase.from('waste_items').update({ status, review_note: note }).in('id', ids);
  if (error) { toast(friendlyError(error), 'error'); return; }
  ids.forEach((id) => selected.delete(id));
  toast(status === 'aprobado' ? `${ids.length} residuo(s) aprobados` : 'Estado actualizado', 'ok');
  route();
}

async function reject(it) {
  const note = prompt(`Motivo del rechazo de "${it.name}" (visible para el personal):`, it.review_note || '');
  if (note === null) return;
  setStatus([it.id], 'rechazado', note.trim() || null);
}

async function toggleActive(it) {
  const { error } = await supabase.from('waste_items').update({ active: !it.active }).eq('id', it.id);
  if (error) toast(friendlyError(error), 'error'); else route();
}

async function removeItem(it) {
  if (!confirm(`¿Eliminar definitivamente "${it.name}"? Si ya se usó en partidas, desactívalo en su lugar.`)) return;
  const { error } = await supabase.from('waste_items').delete().eq('id', it.id);
  if (error) {
    toast(/foreign key/i.test(error.message) ? 'Este residuo ya se usó en partidas: desactívalo en lugar de eliminarlo.' : friendlyError(error), 'error');
    return;
  }
  toast('Residuo eliminado', 'ok');
  route();
}

// Editor con vista previa (tal como lo verá el participante).
function openEditor(it) {
  const isNew = !it;
  const data = it ? { ...it } : { name: '', scope: '', bin_code: '', image_url: '', image_source: 'propia', image_credit: '', explanation: '', active: true };
  let file = null;
  let fileUrl = null;

  const name = h('input', { value: data.name, maxlength: 80, required: true });
  const scope = h('select', { required: true },
    h('option', { value: '' }, 'Seleccione…'),
    Object.entries(SCOPES).map(([v, l]) => h('option', { value: v, selected: data.scope === v }, l)));
  const bin = h('select', { required: true });
  const source = h('select', {},
    h('option', { value: 'propia', selected: data.image_source === 'propia' }, 'Imagen propia del sitio (ruta /img/...)'),
    h('option', { value: 'storage', selected: data.image_source === 'storage' }, 'Subir archivo (PNG, JPG o WEBP, máx. 2 MB)'),
    h('option', { value: 'externa_autorizada', selected: data.image_source === 'externa_autorizada' }, 'URL externa con licencia autorizada'));
  const url = h('input', { value: data.image_url, placeholder: '/img/residuos/papel.svg o https://…' });
  const upload = h('input', { type: 'file', accept: Object.keys(UPLOAD_TYPES).join(',') });
  const credit = h('input', { value: data.image_credit || '', maxlength: 200, placeholder: 'Autor, licencia y fuente (p. ej. "Foto propia – Área SSOMA")' });
  const explanation = h('textarea', { rows: 3, maxlength: 600, required: true }, data.explanation);
  const active = h('input', { type: 'checkbox', checked: data.active });
  const hazard = h('p', { class: 'notice notice-danger', hidden: true },
    '⚠️ Residuo peligroso: se muestra sólo con fines educativos. La explicación debe indicar que no se manipule sin EPP ni procedimiento, y que se entregue al responsable.');
  const msg = h('p', { class: 'form-error', role: 'alert' });
  const preview = h('div', { class: 'preview' });

  function fillBins() {
    const current = bin.value || data.bin_code;
    clear(bin).append(h('option', { value: '' }, scope.value ? 'Seleccione…' : 'Primero elija el ámbito'));
    for (const b of bins.filter((x) => x.scope === scope.value)) {
      bin.append(h('option', { value: b.code, selected: current === b.code }, `${b.icon} ${b.color_name} – ${b.label}`));
    }
  }
  function syncSource() {
    url.closest('label').hidden = source.value === 'storage';
    upload.closest('label').hidden = source.value !== 'storage';
    credit.required = source.value === 'externa_autorizada';
  }
  function renderPreview() {
    hazard.hidden = bin.value !== 'rojo';
    const src = source.value === 'storage' ? (fileUrl || (data.image_source === 'storage' ? data.image_url : '')) : url.value.trim();
    const b = binOf(scope.value, bin.value);
    clear(preview).append(
      h('p', { class: 'small muted' }, 'Vista previa en el celular del participante:'),
      h('div', { class: 'waste-card preview-card' },
        src ? wasteImage(src, name.value || 'Residuo') : h('div', { class: 'waste-img placeholder' }, 'Sin imagen'),
        h('span', { class: 'waste-name' }, name.value || 'Nombre del residuo')),
      b ? h('div', {}, h('p', { class: 'small muted' }, 'Contenedor correcto (no se muestra al jugador):'), binBadge(b, { cls: 'bin bin-mini' })) : null,
      explanation.value ? h('p', { class: 'small' }, `💡 ${explanation.value}`) : null);
  }

  upload.addEventListener('change', () => {
    msg.textContent = '';
    const f = upload.files[0];
    if (!f) return;
    if (!UPLOAD_TYPES[f.type]) { msg.textContent = 'Formato no permitido. Use PNG, JPG o WEBP.'; upload.value = ''; return; }
    if (f.size > MAX_UPLOAD) { msg.textContent = 'La imagen supera 2 MB.'; upload.value = ''; return; }
    file = f;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(f);
    renderPreview();
  });

  async function save(approve) {
    msg.textContent = '';
    try {
      let imageUrl = url.value.trim();
      if (source.value === 'storage') {
        if (file) {
          const path = `items/${crypto.randomUUID()}.${UPLOAD_TYPES[file.type]}`;
          const up = await supabase.storage.from('residuos').upload(path, file, { contentType: file.type, upsert: false });
          if (up.error) throw up.error;
          imageUrl = supabase.storage.from('residuos').getPublicUrl(path).data.publicUrl;
        } else if (data.image_source === 'storage') {
          imageUrl = data.image_url;
        } else {
          throw new Error('Seleccione el archivo de imagen.');
        }
      }
      const { item, errors } = validateWasteItem({
        name: name.value, scope: scope.value, bin_code: bin.value, image_url: imageUrl,
        image_source: source.value, image_credit: credit.value, explanation: explanation.value, active: active.checked,
      });
      if (errors.length) { msg.textContent = errors.join(' '); return; }
      if (isAdmin()) item.status = approve ? 'aprobado' : 'pendiente';
      const q = isNew ? supabase.from('waste_items').insert(item) : supabase.from('waste_items').update(item).eq('id', it.id);
      const { error } = await q;
      if (error) throw error;
      toast(isNew ? 'Residuo registrado' : 'Cambios guardados', 'ok');
      dialog.close();
      route();
    } catch (err) {
      msg.textContent = friendlyError(err);
    }
  }

  const form = h('form', { class: 'editor', method: 'dialog', onsubmit: (e) => { e.preventDefault(); save(false); } },
    h('h2', {}, isNew ? 'Nuevo residuo' : `Editar: ${it.name}`),
    h('div', { class: 'editor-grid' },
      h('div', { class: 'form-col' },
        h('label', {}, 'Nombre del residuo', name),
        h('label', {}, 'Ámbito de gestión', scope),
        h('label', {}, 'Contenedor correcto', bin),
        hazard,
        h('label', {}, 'Origen de la imagen', source),
        h('label', {}, 'Ruta o URL de la imagen', url),
        h('label', {}, 'Archivo de imagen', upload),
        h('label', {}, 'Autor / licencia de la imagen', credit),
        h('label', {}, 'Explicación educativa', explanation),
        h('label', { class: 'inline' }, active, ' Activo'),
        isAdmin() ? null : h('p', { class: 'small muted' }, 'Los cambios de clasificación quedan pendientes hasta que un administrador los valide.')),
      preview),
    msg,
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Cancelar'),
      h('button', { class: 'btn', type: 'submit' }, isAdmin() ? 'Guardar (pendiente)' : 'Guardar y enviar a validación'),
      isAdmin() ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => save(true) }, 'Guardar y aprobar') : null));

  const dialog = h('dialog', { class: 'dialog' }, form);
  dialog.addEventListener('close', () => { if (fileUrl) URL.revokeObjectURL(fileUrl); dialog.remove(); });
  for (const el of [name, url, credit, explanation]) el.addEventListener('input', renderPreview);
  scope.addEventListener('change', () => { fillBins(); renderPreview(); });
  bin.addEventListener('change', renderPreview);
  source.addEventListener('change', () => { syncSource(); renderPreview(); });
  document.body.append(dialog);
  fillBins();
  syncSource();
  renderPreview();
  dialog.showModal();
}

// ---------------------------------------------------------------------
// Bancos de preguntas
// ---------------------------------------------------------------------
async function renderBanks(openId = null) {
  const [banksRes, linksRes] = await Promise.all([
    supabase.from('question_banks').select('id, name, scope, description, owner_id, created_at').order('name'),
    supabase.from('bank_items').select('bank_id, item_id'),
  ]);
  if (banksRes.error) throw banksRes.error;
  if (linksRes.error) throw linksRes.error;
  const links = linksRes.data;
  const canEdit = (b) => isAdmin() || b.owner_id === staff.user.id;

  const name = h('input', { required: true, maxlength: 80, placeholder: 'Ej.: Obra civil – Campamento' });
  const scope = h('select', { required: true }, h('option', { value: '' }, 'Ámbito…'),
    Object.entries(SCOPES).map(([v, l]) => h('option', { value: v }, l)));
  const desc = h('input', { maxlength: 200, placeholder: 'Descripción (opcional)' });
  const createForm = h('form', { class: 'inline-form', onsubmit: async (e) => {
    e.preventDefault();
    const { data, error } = await supabase.from('question_banks')
      .insert({ name: name.value.trim(), scope: scope.value, description: desc.value.trim() || null, owner_id: staff.user.id })
      .select('id').single();
    if (error) { toast(friendlyError(error), 'error'); return; }
    toast('Banco creado', 'ok');
    renderBanks(data.id);
  } }, name, scope, desc, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Crear banco'));

  const detail = h('div');
  function openBank(b) {
    const inBank = new Set(links.filter((l) => l.bank_id === b.id).map((l) => l.item_id));
    const editable = canEdit(b);
    const candidates = items.filter((i) => i.scope === b.scope);
    clear(detail).append(h('section', { class: 'card' },
      h('div', { class: 'toolbar' },
        h('h3', {}, `${b.name} · ${scopeLabel(b.scope)}`),
        editable ? h('button', { class: 'btn btn-small btn-danger-ghost', onclick: async () => {
          if (!confirm(`¿Eliminar el banco "${b.name}"? Los residuos no se eliminan.`)) return;
          const { error } = await supabase.from('question_banks').delete().eq('id', b.id);
          if (error) toast(friendlyError(error), 'error'); else renderBanks();
        } }, 'Eliminar banco') : null),
      b.description ? h('p', { class: 'muted' }, b.description) : null,
      editable ? null : h('p', { class: 'small muted' }, 'Sólo el creador del banco o un administrador puede modificarlo.'),
      h('p', { class: 'small muted' }, 'Sólo se listan residuos del mismo ámbito del banco. Los no aprobados o inactivos no aparecerán en las partidas.'),
      h('ul', { class: 'check-list' }, candidates.map((it) => h('li', {},
        h('label', { class: 'inline' },
          h('input', { type: 'checkbox', checked: inBank.has(it.id), disabled: !editable, onchange: async (e) => {
            const res = e.target.checked
              ? await supabase.from('bank_items').insert({ bank_id: b.id, item_id: it.id })
              : await supabase.from('bank_items').delete().eq('bank_id', b.id).eq('item_id', it.id);
            if (res.error) { toast(friendlyError(res.error), 'error'); e.target.checked = !e.target.checked; return; }
            if (e.target.checked) links.push({ bank_id: b.id, item_id: it.id });
            else links.splice(links.findIndex((l) => l.bank_id === b.id && l.item_id === it.id), 1);
          } }),
          wasteImage(it.image_url, it.name, 'thumb'),
          ` ${it.name} `,
          h('span', { class: `badge badge-${it.status}` }, STATUS[it.status]),
          it.active ? null : h('span', { class: 'badge' }, 'inactivo')))))));
  }

  clear(app).append(
    h('section', { class: 'card' }, h('h2', {}, 'Bancos de preguntas'),
      h('p', { class: 'muted' }, 'Cada banco pertenece a un único ámbito: no se mezclan clasificaciones municipales y no municipales.'),
      createForm,
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Banco', 'Ámbito', 'Residuos', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, banksRes.data.map((b) => h('tr', {},
          h('td', {}, b.name), h('td', {}, scopeLabel(b.scope)),
          h('td', {}, String(links.filter((l) => l.bank_id === b.id).length)),
          h('td', {}, h('button', { class: 'btn btn-small', onclick: () => openBank(b) }, 'Gestionar'))))))),
    detail);
  const toOpen = banksRes.data.find((b) => b.id === openId);
  if (toOpen) openBank(toOpen);
}

// ---------------------------------------------------------------------
// Importar / exportar
// ---------------------------------------------------------------------
const CSV_COLUMNS = [
  { label: 'id', key: 'id' }, { label: 'nombre', key: 'name' }, { label: 'ambito', key: 'scope' },
  { label: 'contenedor', key: 'bin_code' }, { label: 'imagen', key: 'image_url' },
  { label: 'origen_imagen', key: 'image_source' }, { label: 'credito_imagen', key: 'image_credit' },
  { label: 'explicacion', key: 'explanation' }, { label: 'activo', value: (r) => (r.active ? 'si' : 'no') },
  { label: 'estado', key: 'status' },
];

function renderIO() {
  const stamp = new Date().toISOString().slice(0, 10);
  const file = h('input', { type: 'file', accept: '.json,.csv,application/json,text/csv' });
  const out = h('div');

  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    clear(out);
    try {
      const text = await f.text();
      let rows;
      if (/\.json$/i.test(f.name) || text.trim().startsWith('{') || text.trim().startsWith('[')) {
        const json = JSON.parse(text);
        rows = Array.isArray(json) ? json : json.waste_items;
        if (!Array.isArray(rows)) throw new Error('El JSON debe contener una lista "waste_items".');
      } else {
        rows = parseCsv(text);
      }
      const parsed = rows.map((r, i) => ({ line: i + 1, ...validateWasteItem(r) }));
      const ok = parsed.filter((p) => !p.errors.length);
      const bad = parsed.filter((p) => p.errors.length);
      out.append(
        h('p', {}, `${ok.length} registro(s) válidos, ${bad.length} con errores.`),
        bad.length ? h('ul', { class: 'errors' }, bad.map((b) => h('li', {}, `Fila ${b.line}: ${b.errors.join(' ')}`))) : null,
        ok.length ? h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ['Vista', 'Nombre', 'Ámbito', 'Contenedor'].map((t) => h('th', {}, t)))),
          h('tbody', {}, ok.slice(0, 200).map(({ item }) => h('tr', {},
            h('td', {}, wasteImage(item.image_url, item.name, 'thumb')), h('td', {}, item.name),
            h('td', {}, scopeLabel(item.scope)), h('td', {}, binOf(item.scope, item.bin_code)?.color_name ?? item.bin_code))))) : null,
        ok.length ? h('button', { class: 'btn btn-primary', onclick: async (e) => {
          e.target.disabled = true;
          try {
            // Todo registro importado queda pendiente de validación.
            const withId = ok.filter((p) => p.item.id).map((p) => ({ ...p.item, status: 'pendiente' }));
            const without = ok.filter((p) => !p.item.id).map((p) => ({ ...p.item, status: 'pendiente' }));
            if (withId.length) {
              const { error } = await supabase.from('waste_items').upsert(withId, { onConflict: 'id' });
              if (error) throw error;
            }
            if (without.length) {
              const { error } = await supabase.from('waste_items').insert(without);
              if (error) throw error;
            }
            toast(`${ok.length} registro(s) importados como pendientes de validación`, 'ok', 5000);
            tab = 'items';
            filters.status = 'pendiente';
            route();
          } catch (err) {
            toast(friendlyError(err), 'error', 6000);
            e.target.disabled = false;
          }
        } }, `Importar ${ok.length} registro(s)`) : null);
    } catch (err) {
      out.append(h('p', { class: 'form-error' }, `No se pudo leer el archivo: ${friendlyError(err)}`));
    }
  });

  clear(app).append(
    h('section', { class: 'card' },
      h('h2', {}, 'Exportar'),
      h('p', { class: 'muted' }, `${items.length} residuo(s) en el banco.`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => {
          const [qb, bi] = await Promise.all([
            supabase.from('question_banks').select('id, name, scope, description'),
            supabase.from('bank_items').select('bank_id, item_id'),
          ]);
          const payload = { format: 'ssoma-eco-challenge', version: 1, exported_at: new Date().toISOString(),
            bins, waste_items: items, question_banks: qb.data ?? [], bank_items: bi.data ?? [] };
          downloadFile(`banco-residuos_${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
        } }, '⬇️ Exportar JSON (completo)'),
        h('button', { class: 'btn', onclick: () => downloadFile(`banco-residuos_${stamp}.csv`, toCsv(items, CSV_COLUMNS, ';'), 'text/csv;charset=utf-8') },
          '⬇️ Exportar CSV (Excel)'),
        h('button', { class: 'btn btn-ghost', onclick: () => downloadFile('plantilla-residuos.csv', toCsv([{
          name: 'Botella de plástico PET', scope: 'municipal', bin_code: 'verde', image_url: '/img/residuos/botella-pet.svg',
          image_source: 'propia', image_credit: 'Ilustración propia', explanation: 'Las botellas PET son aprovechables.', active: true, status: '',
        }], CSV_COLUMNS, ';'), 'text/csv;charset=utf-8') }, '⬇️ Plantilla CSV'))),
    h('section', { class: 'card' },
      h('h2', {}, 'Importar'),
      h('p', { class: 'muted' }, 'Archivo JSON exportado por esta aplicación o CSV con las columnas de la plantilla. ',
        'Los ámbitos válidos son "municipal" y "no_municipal"; los contenedores: verde, marron, negro, rojo (municipal) o azul, blanco, amarillo, plomo, marron, rojo, negro (no municipal). ',
        'Si la fila trae un "id" existente se actualiza; si no, se crea. Todo lo importado queda pendiente de validación.'),
      file, out));
}

// ---------------------------------------------------------------------
// Personal
// ---------------------------------------------------------------------
async function renderStaff() {
  const list = await rpc('admin_list_staff');
  const email = h('input', { type: 'email', required: true, placeholder: 'correo@empresa.com' });
  const role = h('select', {}, h('option', { value: 'instructor' }, 'Instructor'), h('option', { value: 'admin' }, 'Administrador'));
  const draw = (rows) => h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, ['Correo', 'Rol', 'Desde', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((s) => h('tr', {}, h('td', {}, s.email), h('td', {}, s.role), h('td', {}, formatDate(s.created_at)),
      h('td', {}, s.user_id === staff.user.id ? h('span', { class: 'muted small' }, '(tú)') : h('button', { class: 'btn btn-small btn-danger-ghost', onclick: async () => {
        if (!confirm(`¿Quitar el acceso de ${s.email}?`)) return;
        try { await rpc('admin_set_role', { p_email: s.email, p_role: null }); renderStaff(); } catch (e) { toast(friendlyError(e), 'error'); }
      } }, 'Quitar acceso'))))));
  clear(app).append(h('section', { class: 'card' },
    h('h2', {}, 'Personal autorizado'),
    h('p', { class: 'muted' }, '1) Crea el usuario en Supabase → Authentication → Users (o invítalo por correo). 2) Asígnale aquí un rol.'),
    h('form', { class: 'inline-form', onsubmit: async (e) => {
      e.preventDefault();
      try { await rpc('admin_set_role', { p_email: email.value, p_role: role.value }); toast('Rol asignado', 'ok'); renderStaff(); }
      catch (err) { toast(friendlyError(err), 'error'); }
    } }, email, role, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Asignar rol')),
    draw(list)));
}

// ---------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------
async function start() {
  if (configError) { renderConfigError(app, configError); return; }
  try { staff = await currentStaff(); } catch { staff = null; }
  if (!staff?.role) {
    renderLogin(app, { title: 'Módulo administrativo', onLoggedIn: (s) => { staff = s; route(); } });
    return;
  }
  route();
}

start();
