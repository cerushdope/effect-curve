// boot.js — pre-app bootstrap.
//
// Lives in a file rather than an inline <script> because Manifest V3's default
// extension CSP (`script-src 'self'`) blocks inline script outright, and the
// same index.html is loaded as the extension's side panel.

(function () {
  try {
    var p = new URLSearchParams(location.search);
    if (p.get("mock") === "1") window.EFFECT_CURVE_MOCK = true;
  } catch (e) {}
})();
