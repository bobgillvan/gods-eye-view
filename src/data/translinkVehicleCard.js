/**
 * Click card for a live TransLink vehicle.
 *
 * A small DOM panel, deliberately NOT part of the world-overlay canvas: that
 * canvas is `pointer-events: none` so its cards cannot own a copy button or
 * text selection, and the whole point of this card is that its contents can be
 * selected and shared.
 *
 * The card owns no data. It is handed rows by the layer and renders them, so
 * what counts as shareable detail stays one function
 * (`vehicleDetailRows`) rather than being spread across the DOM code.
 */

const CARD_ID = 'gev-translink-vehicle-card';

let _card = null;
let _onClose = null;

/** Inline styles: this file ships no stylesheet, and the app's CSS is global. */
const CARD_STYLE = [
  'position:absolute',
  'z-index:60',
  'min-width:240px',
  'max-width:320px',
  'padding:12px 14px',
  'background:rgba(6,14,22,0.92)',
  'border:1px solid rgba(0,224,255,0.45)',
  'border-radius:6px',
  'box-shadow:0 6px 28px rgba(0,0,0,0.55)',
  'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
  'color:#dff3ff',
  'pointer-events:auto',
  'backdrop-filter:blur(6px)',
].join(';');

/**
 * Escape text for interpolation into innerHTML.
 *
 * Stop names and route names come from an upstream feed, so they are untrusted
 * input even though they look like plain labels.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

/**
 * Create the card element once and attach it to the document.
 *
 * @returns {HTMLElement|null} Null when there is no DOM (unit tests).
 */
function ensureCard() {
  if (_card) return _card;
  if (typeof document === 'undefined') return null;
  _card = document.createElement('div');
  _card.id = CARD_ID;
  _card.setAttribute('style', CARD_STYLE);
  _card.style.display = 'none';
  document.body.appendChild(_card);
  _card.addEventListener('click', (event) => {
    const action = event.target?.dataset?.gevAction;
    if (action === 'close') {
      hideVehicleCard();
      _onClose?.();
    }
    if (action === 'copy') {
      const text = _card.dataset.shareText || '';
      // Clipboard access can be denied (insecure origin, permissions). Say so
      // on the button rather than failing silently.
      navigator.clipboard
        ?.writeText(text)
        .then(() => {
          event.target.textContent = 'copied';
          setTimeout(() => {
            if (event.target.isConnected) event.target.textContent = 'copy';
          }, 1200);
        })
        .catch(() => {
          event.target.textContent = 'copy failed';
        });
    }
  });
  return _card;
}

/**
 * Show the card for one vehicle.
 *
 * @param {object} options
 * @param {Array<[string,string]>} options.rows Label/value pairs to render.
 * @param {string} options.shareText One-line plain text for the copy button.
 * @param {string} [options.accent] CSS colour for the title rule.
 * @param {{x:number,y:number}} options.at Screen position of the click.
 * @param {Function} [options.onClose] Called when the card is dismissed.
 * @returns {HTMLElement|null}
 */
export function showVehicleCard({ rows, shareText, accent = '#00e0ff', at, onClose }) {
  const card = ensureCard();
  if (!card) return null;
  _onClose = onClose || null;
  card.dataset.shareText = shareText || '';

  const [titleRow, ...rest] = rows.length ? rows : [['Vehicle', 'no detail']];
  card.innerHTML = [
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">`,
    `<span style="width:8px;height:8px;border-radius:50%;background:${escapeHtml(accent)};flex:none"></span>`,
    `<strong style="font-size:13px;letter-spacing:0.02em">${escapeHtml(titleRow[1])}</strong>`,
    `<button data-gev-action="close" style="margin-left:auto;background:none;border:none;color:#7fa6bb;cursor:pointer;font:inherit;padding:0 2px" aria-label="Close">x</button>`,
    `</div>`,
    `<dl style="margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px">`,
    ...rest.map(
      ([label, value]) =>
        `<dt style="color:#7fa6bb">${escapeHtml(label)}</dt><dd style="margin:0">${escapeHtml(value)}</dd>`,
    ),
    `</dl>`,
    `<button data-gev-action="copy" style="margin-top:10px;background:rgba(0,224,255,0.12);border:1px solid rgba(0,224,255,0.4);color:#dff3ff;cursor:pointer;font:inherit;padding:3px 10px;border-radius:3px">copy</button>`,
  ].join('');

  card.style.display = 'block';
  // Keep the card on screen when the click lands near an edge.
  const pad = 12;
  const rect = card.getBoundingClientRect();
  const maxX = (window.innerWidth || rect.width) - rect.width - pad;
  const maxY = (window.innerHeight || rect.height) - rect.height - pad;
  card.style.left = `${Math.max(pad, Math.min(at?.x ?? pad, Math.max(pad, maxX)))}px`;
  card.style.top = `${Math.max(pad, Math.min((at?.y ?? pad) + 14, Math.max(pad, maxY)))}px`;
  return card;
}

/** Hide the card without destroying it. */
export function hideVehicleCard() {
  if (_card) _card.style.display = 'none';
}

/** Remove the card entirely (layer teardown). */
export function destroyVehicleCard() {
  if (_card?.isConnected) _card.remove();
  _card = null;
  _onClose = null;
}

/** Test seam: the live card element, or null. */
export function _vehicleCardElementForTest() {
  return _card;
}
