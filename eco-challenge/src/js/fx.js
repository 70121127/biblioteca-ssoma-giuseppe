// Efectos de sonido y animación: música de espera, tic-tac final y piñata
// que revienta al terminar el tiempo. Todo el audio se sintetiza con la
// Web Audio API (sin archivos ni música con derechos de autor).

const MUTE_KEY = 'eco.sonido.silenciado';
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Melodías (semitonos respecto a La 440 Hz; null = silencio).
const SONGS = {
  // Espera: tranquila y alegre.
  espera: {
    bpm: 104,
    lead: [0, 4, 7, 12, 7, 4, 0, null, 2, 5, 9, 14, 9, 5, 2, null, -1, 2, 7, 11, 7, 2, -1, null, 0, 4, 7, 4, 0, null, null, null],
    bass: [-24, null, -17, null, -22, null, -15, null, -25, null, -18, null, -24, null, -17, null],
    wave: 'triangle',
    gain: 0.12,
  },
  // Ronda: más rápida, tipo concurso.
  ronda: {
    bpm: 138,
    lead: [12, null, 12, 14, 15, null, 14, 12, 10, null, 10, 12, 14, null, 12, 10, 8, null, 8, 10, 12, null, 10, 8, 7, null, 10, null, 7, null, null, null],
    bass: [-12, -12, -5, -5, -10, -10, -3, -3, -14, -14, -7, -7, -12, -12, -5, -5],
    wave: 'square',
    gain: 0.06,
  },
};

const hz = (semi) => 440 * 2 ** (semi / 12);

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.timer = null;
    this.song = null;
    this.step = 0;
    this.nextTime = 0;
    try { this.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { this.muted = false; }
  }

  /** Debe llamarse dentro de un gesto del usuario (clic/toque): política de autoplay. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      // Limitador: permite subir el volumen sin que el parlante del celular distorsione.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      this.master.connect(limiter).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  get ready() {
    return Boolean(this.ctx) && this.ctx.state === 'running';
  }

  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* opcional */ }
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  toggleMute() {
    this.unlock();
    this.setMuted(!this.muted);
    return this.muted;
  }

  // ---------- Música en bucle ----------
  music(name) {
    if (this.song === name) return;
    this.stopMusic();
    if (!name || !SONGS[name]) return;
    this.song = name;
    this.step = 0;
    this.nextTime = 0;
    this.timer = setInterval(() => this._schedule(), 30);
  }

  stopMusic() {
    clearInterval(this.timer);
    this.timer = null;
    this.song = null;
  }

  _schedule() {
    if (!this.ready || !this.song) return;
    const s = SONGS[this.song];
    const stepDur = 60 / s.bpm / 2; // corcheas
    const now = this.ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now + 0.05;
    while (this.nextTime < now + 0.15) {
      const lead = s.lead[this.step % s.lead.length];
      if (lead !== null) this._note(hz(lead), this.nextTime, stepDur * 0.9, s.wave, s.gain);
      if (this.step % 2 === 0) {
        const bass = s.bass[(this.step / 2) % s.bass.length];
        if (bass !== null) this._note(hz(bass), this.nextTime, stepDur * 1.8, 'triangle', s.gain * 1.4);
      }
      this.step++;
      this.nextTime += stepDur;
    }
  }

  _note(freq, t, dur, wave = 'square', gain = 0.05) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = wave;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  _noise(t, dur, { gain = 0.5, freq = 1200, q = 0.8, type = 'bandpass' } = {}) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  // ---------- Efectos ----------
  /** Tic-tac de los últimos segundos; más agudo cuanto menos tiempo queda. */
  tick(secondsLeft) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const urgency = Math.max(0, Math.min(1, (10 - secondsLeft) / 10));
    this._note(880 + urgency * 660, t, 0.06, 'square', 0.08 + urgency * 0.05);
    this._noise(t, 0.03, { gain: 0.2, freq: 4000, q: 2 });
  }

  /** ¡La piñata revienta!: golpe grave, crujido de cartón y lluvia de campanitas. */
  burst(loud = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    // Golpe grave (bombo)
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.35);
    g.gain.setValueAtTime(0.9 * loud, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.5);
    // Crujido / papel rasgado
    this._noise(t, 0.5, { gain: 0.8 * loud, freq: 900, q: 0.6 });
    this._noise(t + 0.02, 0.25, { gain: 0.5 * loud, freq: 3000, q: 1.2, type: 'highpass' });
    // Lluvia de dulces (campanitas)
    const notes = [24, 28, 31, 36, 31, 33, 36, 40];
    notes.forEach((n, i) => this._note(hz(n), t + 0.12 + i * 0.06 + Math.random() * 0.02, 0.25, 'triangle', 0.07 * loud));
    // Fanfarria corta
    [12, 16, 19, 24].forEach((n, i) => this._note(hz(n), t + 0.65 + i * 0.11, i === 3 ? 0.5 : 0.12, 'square', 0.05 * loud));
  }

  correct() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._note(hz(19), t, 0.1, 'triangle', 0.09);
    this._note(hz(24), t + 0.09, 0.18, 'triangle', 0.09);
  }

  wrong() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._note(hz(-5), t, 0.16, 'sawtooth', 0.05);
    this._note(hz(-9), t + 0.14, 0.24, 'sawtooth', 0.05);
  }

  start() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    [0, 4, 7, 12].forEach((n, i) => this._note(hz(n + 12), t + i * 0.08, 0.15, 'square', 0.05));
  }
}

// ---------------------------------------------------------------------
// Piñata
// ---------------------------------------------------------------------
const PINATA_SVG = `<svg viewBox="0 0 120 150" aria-hidden="true">
  <line x1="60" y1="0" x2="60" y2="22" stroke="#6b4e1e" stroke-width="3"/>
  <g class="pinata-body">
    <polygon points="60,20 72,48 102,50 78,70 87,100 60,83 33,100 42,70 18,50 48,48" fill="#e83e8c" stroke="#8e1c52" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="60,34 67,52 86,53 71,65 76,84 60,74 44,84 49,65 34,53 53,52" fill="#ffc107"/>
    <circle cx="60" cy="60" r="7" fill="#20c997"/>
    <path d="M33 100 l-6 30 M42 96 l-2 34 M60 86 l0 40 M78 96 l2 34 M87 100 l6 30" stroke="#20c997" stroke-width="5" stroke-linecap="round"/>
    <path d="M37 98 l-4 28 M51 92 l-1 34 M69 92 l1 34 M83 98 l4 28" stroke="#fd7e14" stroke-width="4" stroke-linecap="round"/>
  </g>
</svg>`;

const PIECES = ['🍬', '🍭', '⭐', '🎉', '🍫', '🎊', '✨', '🍬', '🍭', '🎈'];
const CONFETTI = ['#e83e8c', '#ffc107', '#20c997', '#0d6efd', '#fd7e14', '#6f42c1'];

export class Pinata {
  constructor(container, { size = 120 } = {}) {
    this.el = document.createElement('div');
    this.el.className = 'pinata';
    this.el.style.setProperty('--pinata-size', `${size}px`);
    this.el.innerHTML = PINATA_SVG; // SVG estático propio, sin datos de usuario
    this.el.hidden = true;
    container.append(this.el);
    this.burstDone = false;
  }

  /** Muestra la piñata y ajusta el temblor (0 = calma, 1 = a punto de reventar). */
  shake(level) {
    if (this.burstDone) return;
    this.el.hidden = false;
    this.el.classList.remove('pinata-gone');
    const lvl = Math.max(0, Math.min(1, level));
    this.el.style.setProperty('--shake', reduceMotion() ? 0 : lvl.toFixed(2));
    this.el.style.setProperty('--shake-speed', `${(0.6 - lvl * 0.45).toFixed(2)}s`);
    this.el.classList.toggle('pinata-critical', lvl > 0.7);
  }

  hide() {
    this.el.hidden = true;
  }

  reset() {
    this.burstDone = false;
    this.el.classList.remove('pinata-gone');
    this.hide();
  }

  /** ¡Revienta! Lanza dulces y confeti desde la posición de la piñata. */
  burst() {
    if (this.burstDone) return;
    this.burstDone = true;
    this.el.hidden = false;
    const rect = this.el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    this.el.classList.add('pinata-gone');
    if (reduceMotion()) return;
    const layer = document.createElement('div');
    layer.className = 'burst-layer';
    document.body.append(layer);
    const boom = document.createElement('span');
    boom.className = 'burst-boom';
    boom.textContent = '💥';
    boom.style.left = `${cx}px`;
    boom.style.top = `${cy}px`;
    layer.append(boom);
    const n = window.innerWidth < 600 ? 34 : 60;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('span');
      const isCandy = i % 3 === 0;
      p.className = isCandy ? 'burst-piece' : 'burst-confetti';
      if (isCandy) p.textContent = PIECES[i % PIECES.length];
      else p.style.background = CONFETTI[i % CONFETTI.length];
      const angle = Math.random() * Math.PI * 2;
      const dist = 120 + Math.random() * Math.min(window.innerWidth, 900) * 0.45;
      p.style.left = `${cx}px`;
      p.style.top = `${cy}px`;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist * 0.7 - 80}px`);
      p.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
      p.style.animationDelay = `${Math.random() * 0.08}s`;
      layer.append(p);
    }
    setTimeout(() => layer.remove(), 2200);
  }
}

/** Botón 🔊/🔇 que controla un Sound. */
export function soundToggle(sound, cls = 'btn btn-ghost sound-toggle') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  const paint = () => {
    b.textContent = sound.muted ? '🔇' : '🔊';
    b.title = sound.muted ? 'Activar sonido' : 'Silenciar';
    b.setAttribute('aria-label', b.title);
  };
  b.addEventListener('click', () => { sound.toggleMute(); paint(); });
  paint();
  return b;
}
