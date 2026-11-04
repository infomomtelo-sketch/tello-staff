/*!
 * Tello Staff time clock — widget for any website.
 *
 * Add one line to a page (the admin copies it from Time > Time clock app):
 *   <script src="https://staff.tello.live/embed.js" data-key="YOUR_CLOCK_KEY" async></script>
 *
 * It adds a "Clock In / Out" button to the page. Tapping it opens the Tello Staff
 * clock in a panel on top of the page. Staff sign in there with their employee
 * number + PIN; the clock lives on staff.tello.live, so nothing from the host
 * site (cookies, page content) is ever readable by it, and vice versa.
 *
 * The host site must be listed under "Allowed websites" in the admin's Time tab,
 * otherwise the browser refuses to show the panel.
 *
 * Optional attributes: data-label="Time clock"  data-position="left"
 */
(function () {
  var script = document.currentScript || document.querySelector('script[data-key][src*="embed.js"]');
  if (!script) return;
  var key = (script.getAttribute('data-key') || '').trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) { console.warn('Tello Staff clock: missing or invalid data-key'); return; }
  if (document.getElementById('tello-clock-btn')) return;

  var origin = new URL(script.src, location.href).origin;
  var label = script.getAttribute('data-label') || 'Clock In / Out';
  var side = script.getAttribute('data-position') === 'left' ? 'left' : 'right';

  var btn = document.createElement('button');
  btn.id = 'tello-clock-btn';
  btn.type = 'button';
  btn.textContent = '🕒 ' + label;
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.style.cssText = 'position:fixed;bottom:20px;' + side + ':20px;z-index:2147482000;padding:14px 20px;border:0;border-radius:999px;' +
    'background:#1a3a2e;color:#e8c15c;font:700 16px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.3)';

  var overlay = null;
  function build() {
    overlay = document.createElement('div');
    overlay.id = 'tello-clock-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Tello Staff time clock');
    overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);align-items:center;justify-content:center;padding:12px';
    var panel = document.createElement('div');
    panel.style.cssText = 'position:relative;width:100%;max-width:440px;height:min(760px,94vh);background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)';
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.style.cssText = 'position:absolute;top:8px;right:8px;z-index:2;width:36px;height:36px;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:16px;cursor:pointer';
    var frame = document.createElement('iframe');
    frame.title = 'Tello Staff time clock';
    // The clock needs the camera (selfie) and location (at the moment of a punch).
    frame.setAttribute('allow', 'camera; geolocation');
    frame.src = origin + '/clock/?embed=1&k=' + encodeURIComponent(key);
    frame.style.cssText = 'width:100%;height:100%;border:0;background:#1a3a2e';
    panel.appendChild(close);
    panel.appendChild(frame);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    close.addEventListener('click', hide);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });
  }
  function show() {
    if (!overlay) build();
    overlay.style.display = 'flex';
    document.addEventListener('keydown', onKey);
  }
  function hide() {
    if (overlay) overlay.style.display = 'none';
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') hide(); }

  btn.addEventListener('click', show);
  function mount() { document.body.appendChild(btn); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
