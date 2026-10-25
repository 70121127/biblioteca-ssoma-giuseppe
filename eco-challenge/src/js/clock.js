// Sincronización con el reloj del servidor: el cronómetro que ve cada
// dispositivo se calcula con la hora del servidor, no con la del celular.
export class ServerClock {
  constructor(now = () => Date.now()) {
    this._now = now;
    this.offset = 0;
    this.bestRtt = Infinity;
  }

  /** Registra una muestra: hora del servidor y tiempos local de envío/recepción. */
  sample(serverIso, sentAt, receivedAt) {
    const server = Date.parse(serverIso);
    if (Number.isNaN(server)) return;
    const rtt = Math.max(0, receivedAt - sentAt);
    // Se conserva la muestra con menor latencia (más precisa), con caducidad suave.
    if (rtt <= this.bestRtt * 1.5 || !Number.isFinite(this.bestRtt)) {
      this.offset = server - (sentAt + rtt / 2);
      this.bestRtt = Math.min(rtt, this.bestRtt);
    }
  }

  now() {
    return this._now() + this.offset;
  }
}

/**
 * Estado del cronómetro de una ronda.
 * @returns {{phase:'leadin'|'running'|'paused'|'ended', remainingMs:number, leadInMs:number, fraction:number}}
 */
export function roundTimer(round, nowMs) {
  if (!round) return { phase: 'ended', remainingMs: 0, leadInMs: 0, fraction: 0 };
  const start = Date.parse(round.started_at);
  const end = Date.parse(round.ends_at);
  const total = Math.max(1, round.duration_s * 1000);
  if (round.status === 'ended') return { phase: 'ended', remainingMs: 0, leadInMs: 0, fraction: 0 };
  if (round.status === 'paused') {
    const pausedAt = Date.parse(round.paused_at);
    const ref = Math.max(pausedAt, start);
    const remaining = Math.max(0, end - ref);
    return { phase: 'paused', remainingMs: remaining, leadInMs: Math.max(0, start - pausedAt), fraction: remaining / total };
  }
  if (nowMs < start) {
    return { phase: 'leadin', remainingMs: total, leadInMs: start - nowMs, fraction: 1 };
  }
  const remaining = Math.max(0, end - nowMs);
  return { phase: remaining > 0 ? 'running' : 'ended', remainingMs: remaining, leadInMs: 0, fraction: remaining / total };
}

export function formatSeconds(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : String(s);
}
