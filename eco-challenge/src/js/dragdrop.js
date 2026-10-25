// Clasificación por arrastre (mouse y táctil, con Pointer Events) y por toque:
// toque en un residuo para seleccionarlo y luego toque en un contenedor.

const DRAG_THRESHOLD = 8;

export function attachClassifier({ board, onClassify, isLocked = () => false }) {
  let selected = null; // tarjeta seleccionada por toque
  let drag = null;     // { card, ghost, startX, startY, pointerId, moved, overBin }

  const cardFrom = (t) => t?.closest?.('.waste-card[data-item]:not(.done):not(.sending)');
  const binFrom = (t) => t?.closest?.('[data-bin]');

  function select(card) {
    if (selected) selected.classList.remove('selected');
    selected = card && card !== selected ? card : null;
    if (selected) selected.classList.add('selected');
    board.classList.toggle('has-selection', Boolean(selected));
  }

  function classify(card, binEl) {
    if (!card || !binEl || isLocked()) return;
    const itemId = card.dataset.item;
    const bin = binEl.dataset.bin;
    select(null);
    binEl.classList.add('bump');
    setTimeout(() => binEl.classList.remove('bump'), 350);
    onClassify(itemId, bin, card);
  }

  function binAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const b = binFrom(el);
    return b && board.contains(b) ? b : null;
  }

  function setOver(bin) {
    if (drag.overBin === bin) return;
    drag.overBin?.classList.remove('drop-target');
    drag.overBin = bin;
    bin?.classList.add('drop-target');
  }

  board.addEventListener('pointerdown', (ev) => {
    const card = cardFrom(ev.target);
    if (!card || isLocked() || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    drag = { card, startX: ev.clientX, startY: ev.clientY, pointerId: ev.pointerId, moved: false, overBin: null, ghost: null };
  });

  board.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      try { drag.card.setPointerCapture(ev.pointerId); } catch { /* sin captura */ }
      const rect = drag.card.getBoundingClientRect();
      const ghost = drag.card.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      drag.offX = drag.startX - rect.left;
      drag.offY = drag.startY - rect.top;
      document.body.append(ghost);
      drag.ghost = ghost;
      drag.card.classList.add('dragging');
      select(null);
    }
    ev.preventDefault();
    drag.ghost.style.transform = `translate(${ev.clientX - drag.offX}px, ${ev.clientY - drag.offY}px) rotate(-3deg)`;
    setOver(binAt(ev.clientX, ev.clientY));
  });

  function endDrag(ev, cancelled) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    d.ghost?.remove();
    d.card.classList.remove('dragging');
    d.overBin?.classList.remove('drop-target');
    if (cancelled) return;
    if (d.moved) {
      const bin = binAt(ev.clientX, ev.clientY);
      if (bin) classify(d.card, bin);
    } else {
      select(d.card);
    }
  }
  board.addEventListener('pointerup', (ev) => endDrag(ev, false));
  board.addEventListener('pointercancel', (ev) => endDrag(ev, true));

  // Toque/clic en contenedor con un residuo seleccionado.
  board.addEventListener('click', (ev) => {
    const bin = binFrom(ev.target);
    if (bin && selected) classify(selected, bin);
  });

  // Teclado: Enter/Espacio selecciona la tarjeta; luego Enter sobre un contenedor.
  board.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const card = cardFrom(ev.target);
    if (card) { ev.preventDefault(); select(card); }
  });

  return { clearSelection: () => select(null) };
}
