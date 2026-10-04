/* IZZ.ro — inregistrarea service workerului, butonul de instalare si precache-ul articolelor.
   FISIER EXTERN, DELIBERAT: CSP-ul emis de generator/render.py::_write_headers are
   `script-src 'self'` fara 'unsafe-inline', deci orice cod din pagina e refuzat tacut.

   BUTONUL DE INSTALARE STA IN AFARA FLUXULUI (position: fixed, jos-stanga), NU IN HEADER.
   Masurat pe 2026-08-02, emulare mobil 412 px: varianta din header era `hidden` in markup si
   aparea la `beforeinstallprompt`, impingand <main> in jos cu 49 px — Lighthouse atribuia
   100% din CLS (0.272) exact acestui element. Un element fix nu poate muta nimic, deci nu
   poate produce CLS. Detaliul masuratorii: specs/masuratori-frontend.md. */
(function () {
  'use strict';

  var RESPINS = 'izz_install_respins';   // '1' = „nu-mi mai arata"
  var CALE_ARTICOL = /^\/[a-z0-9-]+\/[a-z0-9-]+\/$/;

  function refuzat() {
    try { return localStorage.getItem(RESPINS) === '1'; } catch { return false; }
  }
  function refuza() {
    try { localStorage.setItem(RESPINS, '1'); } catch { /* mod privat */ }
  }
  function dejaInstalata() {
    try { return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true; } catch { return false; }
  }

  /* ---- inregistrare ---- */
  function inregistreaza() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {
        /* Fara service worker site-ul merge la fel; doar citirea offline lipseste. */
      });
    });
  }

  /* ---- buton de instalare ---- */
  function initInstalare() {
    var cutie = document.getElementById('izz-install');
    var buton = document.getElementById('izz-install-btn');
    var inchide = document.getElementById('izz-install-inchide');
    if (!cutie || !buton) return;
    if (refuzat() || dejaInstalata()) return;

    var amanat = null;
    function arata() { cutie.hidden = false; }
    function ascunde() { cutie.hidden = true; }

    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      amanat = ev;
      arata();
    });

    // Doua motive sa dispara definitiv, nu doar sa se ascunda: instalarea s-a facut (nu mai
    // are ce oferi) sau omul a refuzat (a-l intreba a doua oara e insistenta, nu discretie).
    window.addEventListener('appinstalled', function () { refuza(); ascunde(); });

    buton.addEventListener('click', function () {
      if (!amanat) return;
      amanat.prompt();
      amanat.userChoice.then(function (alegere) {
        if (alegere && alegere.outcome === 'dismissed') refuza();
        amanat = null;
        ascunde();
      }).catch(function () { ascunde(); });
    });

    if (inchide) {
      inchide.addEventListener('click', function () { refuza(); ascunde(); });
    }
  }

  /* ---- precache: articolele vizibile in prima pagina, doar cand e ieftin ---- */
  function initPrecache() {
    if (!('serviceWorker' in navigator)) return;
    var legatura = navigator.connection;
    // Doar cand suntem pe prima pagina, online, si nu pe o conexiune economisita de om
    // (`saveData` exista tocmai ca sa nu descarce lucruri in plus).
    if (location.pathname !== '/' || !navigator.onLine) return;
    if (legatura && (legatura.saveData || /2g/.test(legatura.effectiveType || ''))) return;

    var alege = function () {
      var urluri = [];
      var vazute = {};
      var legaturi = document.querySelectorAll('main a[href]');
      for (var i = 0; i < legaturi.length && urluri.length < 8; i++) {
        var cale = legaturi[i].getAttribute('href') || '';
        if (!CALE_ARTICOL.test(cale) || vazute[cale]) continue;
        vazute[cale] = 1;
        urluri.push(cale);
      }
      if (!urluri.length) return;
      // `ready`, nu `controller`: la PRIMA vizita controllerul e null pana cand noul
      // service worker se activeaza, deci `controller` ar amana precache-ul cu o vizita
      // intreaga — exact vizita in care omul il instaleaza pe telefon.
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg.active) reg.active.postMessage({ tip: 'precache', urluri: urluri });
      }).catch(function () { /* nimic de raportat: e o optimizare, nu o functie */ });
    };

    if (window.requestIdleCallback) window.requestIdleCallback(alege, { timeout: 4000 });
    else window.setTimeout(alege, 2000);
  }

  inregistreaza();
  initInstalare();
  initPrecache();
})();
