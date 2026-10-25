// Utilidades de interfaz. Todo el texto proveniente de datos se inserta con
// textContent (nunca innerHTML) para evitar inyección de HTML.

/** Crea un elemento: h('div', {class: 'x', onclick}, 'texto', hijo) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

let toastBox;
export function toast(message, kind = 'info', ms = 3500) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Muestra un aviso fijo de configuración faltante. */
export function renderConfigError(container, message) {
  clear(container).append(
    h('div', { class: 'card config-error' },
      h('h2', {}, '⚙️ Configuración pendiente'),
      h('p', {}, message),
      h('p', { class: 'muted' }, 'Consulta el archivo README.md, sección "Variables de entorno".')),
  );
}

export function confirmDialog(message) {
  return window.confirm(message);
}

export function downloadFile(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
}

/** Imagen con texto alternativo y respaldo si no carga. */
export function wasteImage(url, name, cls = 'waste-img') {
  const img = h('img', { class: cls, src: url, alt: name, loading: 'eager', decoding: 'async', draggable: 'false' });
  img.addEventListener('error', () => { img.src = '/img/residuos/sin-imagen.svg'; }, { once: true });
  return img;
}

/** Botón/etiqueta de contenedor con color, icono y nombre. */
export function binBadge(bin, { tag = 'div', cls = 'bin', ...props } = {}) {
  const el = h(tag, { class: `${cls} bin-${bin.code}`, dataset: { bin: bin.code }, ...props },
    h('span', { class: 'bin-icon', 'aria-hidden': 'true' }, bin.icon),
    h('span', { class: 'bin-label' }, bin.label),
    h('span', { class: 'bin-color' }, bin.color_name));
  el.style.setProperty('--bin-bg', bin.color_hex);
  el.style.setProperty('--bin-fg', bin.text_hex);
  return el;
}

export function scopeLabel(scope) {
  return scope === 'no_municipal' ? 'No municipal' : 'Municipal';
}
