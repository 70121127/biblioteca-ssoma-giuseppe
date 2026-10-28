// Validaciones compartidas (reflejan las restricciones de la base de datos,
// que es la que tiene la última palabra).

export const SCOPES = {
  municipal: 'Municipal',
  no_municipal: 'No municipal',
};

export const BIN_CODES = {
  municipal: ['verde', 'marron', 'negro', 'rojo'],
  no_municipal: ['azul', 'blanco', 'amarillo', 'plomo', 'marron', 'rojo', 'negro'],
};

export function normalizeAlias(alias) {
  return String(alias ?? '').trim().replace(/\s+/g, ' ');
}

export function isValidAlias(alias) {
  const a = normalizeAlias(alias);
  return a.length >= 2 && a.length <= 20 && /^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ _.-]+$/.test(a);
}

export function isValidCode(code) {
  return /^\d{6}$/.test(String(code ?? '').trim());
}

const IMAGE_URL = /^(https:\/\/|\/)[^\s"'<>]+$/;

/**
 * Valida y normaliza un registro del banco (formulario o importación).
 * @returns {{item?: object, errors: string[]}}
 */
export function validateWasteItem(raw, { scopes = SCOPES, binCodes = BIN_CODES } = {}) {
  const errors = [];
  const scopeRaw = String(raw.scope ?? raw.ambito ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const scope = scopeRaw === 'nomunicipal' ? 'no_municipal' : (scopes[scopeRaw] ? scopeRaw : null);
  const bin = String(raw.bin_code ?? raw.contenedor ?? '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const name = String(raw.name ?? raw.nombre ?? '').trim();
  const explanation = String(raw.explanation ?? raw.explicacion ?? '').trim();
  const image_url = String(raw.image_url ?? raw.imagen ?? '').trim();
  const sourceRaw = String(raw.image_source ?? raw.origen_imagen ?? 'propia').trim();
  const image_source = ['propia', 'storage', 'externa_autorizada'].includes(sourceRaw) ? sourceRaw : null;
  const image_credit = String(raw.image_credit ?? raw.credito_imagen ?? '').trim() || null;
  const activeRaw = raw.active ?? raw.activo ?? true;
  const active = !['false', '0', 'no', 'n'].includes(String(activeRaw).trim().toLowerCase());

  if (name.length < 2 || name.length > 160) errors.push('Nombre: entre 2 y 160 caracteres.');
  if (!scope) errors.push(`Ámbito no válido. Use uno de: ${Object.keys(scopes).join(', ')}.`);
  else if (!(binCodes[scope] || []).includes(bin)) errors.push(`Contenedor "${bin}" no válido para el ámbito ${scopes[scope]}.`);
  if (!IMAGE_URL.test(image_url)) errors.push('Imagen: ruta propia (/img/...) o URL https://.');
  if (!image_source) errors.push('Origen de imagen: propia, storage o externa_autorizada.');
  if (image_source === 'externa_autorizada' && !image_credit) errors.push('Imagen externa: indique autor y licencia.');
  if (explanation.length < 5 || explanation.length > 600) errors.push('Explicación: entre 5 y 600 caracteres.');

  const id = String(raw.id ?? '').trim();
  const item = { name, scope, bin_code: bin, image_url, image_source, image_credit, explanation, active };
  if (/^[0-9a-f-]{36}$/i.test(id)) item.id = id;
  return errors.length ? { errors } : { item, errors };
}

export function shuffle(list, rnd = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
