// Canal Realtime (Broadcast) de una partida.
// Los mensajes sólo son "avisos" para refrescar: el estado real SIEMPRE se
// obtiene del servidor mediante RPC, por lo que un mensaje falso no puede
// alterar puntajes ni revelar respuestas. Si Realtime no está disponible
// (o se supera el límite de conexiones del plan) se usa sondeo periódico.
import { supabase } from './supabase.js';

export function joinGameChannel(code, { onSignal, onStatus } = {}) {
  if (!supabase) return { send() {}, close() {}, get connected() { return false; } };
  let connected = false;
  const channel = supabase.channel(`eco-${code}`, { config: { broadcast: { self: false, ack: false } } });
  channel.on('broadcast', { event: 'signal' }, ({ payload }) => onSignal?.(payload ?? {}));
  channel.subscribe((status) => {
    connected = status === 'SUBSCRIBED';
    onStatus?.(status, connected);
  });
  return {
    get connected() { return connected; },
    send(payload) {
      if (!connected) return;
      channel.send({ type: 'broadcast', event: 'signal', payload }).catch(() => {});
    },
    close() { supabase.removeChannel(channel); },
  };
}
