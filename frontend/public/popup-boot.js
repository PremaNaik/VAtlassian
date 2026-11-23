// Loaded by webauthn.html as an external classic script, before the module
// bundle. It must stay external: Forge serves Custom UI with `script-src 'self'`
// and no 'unsafe-inline', so an inline <script> in the HTML never runs.
//
// The device-check popup is a top-level window, not a Forge iframe, so there
// is no Custom UI bridge. @forge/bridge throws while the vendor chunk is being
// evaluated unless window.__bridge exists. That stops React from mounting and
// leaves "Loading device check…" on screen. This shim prevents that.
(function () {
  if (!window.__bridge) {
    window.__bridge = {
      callBridge: function () {
        return Promise.resolve({});
      }
    };
  }

  function showStartupError(text) {
    var root = document.getElementById('root');
    // Only replace the static placeholder; never overwrite a mounted React tree.
    if (!root || !root.querySelector('[data-popup-placeholder]')) return;
    root.textContent = '';
    var container = document.createElement('div');
    container.style.cssText = 'padding:24px;font-family:Arial,sans-serif;color:#AE2E24;';
    var heading = document.createElement('h3');
    heading.textContent = 'Device check could not start';
    var message = document.createElement('p');
    message.textContent = text || 'An unexpected error occurred.';
    var hint = document.createElement('p');
    hint.style.color = '#44546F';
    hint.textContent = 'Nothing has been recorded. Close this window and retry.';
    container.appendChild(heading);
    container.appendChild(message);
    container.appendChild(hint);
    root.appendChild(container);
  }

  window.addEventListener('error', function (event) {
    console.error('WebAuthn popup error:', event.error || event.message);
    showStartupError(event.message);
  });

  window.addEventListener('unhandledrejection', function (event) {
    console.error('WebAuthn popup rejected promise:', event.reason);
  });
})();
