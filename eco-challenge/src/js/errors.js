// Traducción de los códigos de error que devuelven las funciones del servidor.
const MESSAGES = {
  NO_AUTORIZADO: 'Tu cuenta no tiene permisos para esta acción.',
  PARTIDA_NO_ENCONTRADA: 'La partida no existe o no te pertenece.',
  AMBITO_REQUERIDO: 'Selecciona el ámbito: municipal o no municipal.',
  AMBITO_DISTINTO: 'El banco seleccionado pertenece a otro ámbito.',
  AMBITO_EN_USO: 'Quita el residuo de sus bancos antes de cambiar su ámbito.',
  BANCO_NO_ENCONTRADO: 'El banco seleccionado no existe.',
  BANCO_VACIO: 'No hay residuos aprobados y activos para ese ámbito o banco. Valídalos en el módulo administrativo.',
  ESTADO_INVALIDO: 'Esa acción no está disponible en el estado actual de la partida.',
  SIN_RONDAS: 'Ya se jugaron todas las rondas configuradas. Finaliza la partida.',
  PUNTUACION_BLOQUEADA: 'La puntuación sólo puede cambiarse antes de iniciar la partida.',
  RONDAS_INVALIDAS: 'El número de rondas no puede ser menor que las ya jugadas.',
  ALIAS_INVALIDO: 'Alias no válido: usa de 2 a 20 letras, números, espacio, punto o guion.',
  ALIAS_EN_USO: 'Ese alias ya está en uso en esta partida. Elige otro.',
  CODIGO_INVALIDO: 'Código de partida no válido.',
  PARTIDA_FINALIZADA: 'Esta partida ya terminó.',
  SALA_LLENA: 'La sala está llena.',
  SESION_INVALIDA: 'Tu sesión de juego ya no es válida. Vuelve a ingresar.',
  EXPULSADO: 'El instructor te retiró de la partida.',
  RONDA_INVALIDA: 'Esa ronda ya no está activa.',
  RONDA_PAUSADA: 'La ronda está en pausa.',
  TIEMPO_AGOTADO: '¡Tiempo agotado! Las respuestas están bloqueadas.',
  AUN_NO_INICIA: 'La ronda aún no empieza.',
  ELEMENTO_INVALIDO: 'Ese residuo no pertenece a esta ronda.',
  CONTENEDOR_INVALIDO: 'Contenedor no válido para este ámbito.',
  USUARIO_NO_ENCONTRADO: 'No existe un usuario con ese correo. Créalo primero en Supabase Auth.',
  NO_PUEDE_QUITARSE_ADMIN: 'No puedes quitarte el rol de administrador a ti mismo.',
  ROL_INVALIDO: 'Rol no válido.',
};

/** Extrae el código (p. ej. "ALIAS_EN_USO") del mensaje de error de Postgres. */
export function errorCode(err) {
  const msg = String(err?.message ?? err ?? '');
  const m = msg.match(/^([A-Z_]{4,})(?::|$)/);
  return m ? m[1] : null;
}

export function friendlyError(err) {
  const code = errorCode(err);
  if (code && MESSAGES[code]) return MESSAGES[code];
  const msg = String(err?.message ?? err ?? 'Error desconocido');
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Sin conexión. Reintentando…';
  if (/Invalid login credentials/i.test(msg)) return 'Correo o contraseña incorrectos.';
  if (/row-level security|permission denied/i.test(msg)) return MESSAGES.NO_AUTORIZADO;
  return msg;
}

export function isNetworkError(err) {
  return /Failed to fetch|NetworkError|network|Load failed|fetch failed/i.test(String(err?.message ?? err ?? ''));
}
