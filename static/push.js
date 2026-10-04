/* IZZ.ro — alerte de ultimă oră (Web Push), cu opt-in explicit.
   FISIER EXTERN: CSP-ul (`script-src 'self'`, fara 'unsafe-inline') blocheaza orice cod din
   pagina. Blocul de mai jos NU porneste nimic de la sine: nu exista cerere de permisiune
   fara click pe „Activează alertele", iar fara acel click nu pleaca nicio cerere catre
   server — nici macar pentru cheia publica VAPID.

   CE PRIMESTE CITITORUL, scris inainte de apasare, nu dupa: o alerta pe zi, maximum; doar
   stiri de ultima ora; formulare faptica (regula e aplicata si mecanic, pe server, in
   infra/push.js::verificaAlerta). Niciun abonament nu se inregistreaza in numele cuiva care
   n-a cerut — nu exista „presupunem ca vrea".

   DATELE: pe server se pastreaza doar endpointul de push si cele doua chei ale lui. Nu se
   colecteaza nume, e-mail, IP (nu e scris in cod) si nu se face profil: alerta e aceeasi
   pentru toti, o singura data pe zi. */
(function () {
  'use strict';

  var CHEIE_ACTIV = 'izz_alerte_v1';        // 'on' | 'off'
  var CHEIE_CHEIE = 'izz_cheie_push_v1';    // cheia publica VAPID, tinuta 7 zile
  var ZILE_CHEIE = 7 * 24 * 3600 * 1000;

  var cutie = document.getElementById('izz-alerte');
  var buton = document.getElementById('izz-alerte-btn');
  var panou = document.getElementById('izz-alerte-panou');
  var porneste = document.getElementById('izz-alerte-porneste');
  var opreste = document.getElementById('izz-alerte-opreste');
  var stare = document.getElementById('izz-alerte-stare');

  function spune(mesaj) {
    if (stare) stare.textContent = mesaj || '';
  }

  function citeste(cheie) {
    try { return localStorage.getItem(cheie); } catch { return null; }
  }
  function scrie(cheie, valoare) {
    try { localStorage.setItem(cheie, valoare); } catch { /* mod privat */ }
  }

  function suportat() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  // Cheia publica VAPID se cere o singura data pe saptamana: e aceeasi pentru toti, se
  // schimba doar daca se refac cheile, si nu are rost sa cada o cerere pe fiecare vizita.
  function cheiePublica() {
    var tinuta = null;
    try { tinuta = JSON.parse(citeste(CHEIE_CHEIE) || 'null'); } catch { tinuta = null; }
    if (tinuta && tinuta.cheie && Date.now() - tinuta.la < ZILE_CHEIE) {
      return Promise.resolve(tinuta.cheie);
    }
    return fetch('/push/cheie', { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('indisponibil');
        return r.json();
      })
      .then(function (date) {
        scrie(CHEIE_CHEIE, JSON.stringify({ cheie: date.cheie, la: Date.now() }));
        return date.cheie;
      });
  }

  function abonamentCurent() {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    });
  }

  function urlUint8(b64url) {
    var brut = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(brut.length);
    for (var i = 0; i < brut.length; i++) out[i] = brut.charCodeAt(i);
    return out;
  }

  function arataPanou(deschis) {
    if (!panou) return;
    panou.hidden = !deschis;
    if (buton) buton.setAttribute('aria-expanded', deschis ? 'true' : 'false');
  }

  function arataStarea() {
    var activ = citeste(CHEIE_ACTIV) === 'on';
    if (porneste) porneste.hidden = activ;
    if (opreste) opreste.hidden = !activ;
    if (buton) buton.textContent = activ ? 'Alerte activate' : 'Alerte de ultimă oră';
  }

  function activeaza() {
    spune('Se cere permisiunea browserului…');
    Notification.requestPermission().then(function (permisiune) {
      if (permisiune !== 'granted') {
        spune(permisiune === 'denied'
          ? 'Browserul a refuzat notificările pentru acest site. Le poți permite din setările site-ului (iconița din bara de adrese).'
          : 'Permisiunea nu s-a acordat, deci nu s-a activat nimic.');
        return null;
      }
      return Promise.all([cheiePublica(), abonamentCurent()]).then(function (rezultate) {
        var cheie = rezultate[0];
        var vechi = rezultate[1];
        if (vechi) return vechi;
        return navigator.serviceWorker.ready.then(function (reg) {
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlUint8(cheie),
          });
        });
      }).then(function (sub) {
        return fetch('/push/abonare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
      }).then(function (r) {
        if (!r.ok) throw new Error('refuzat');
        scrie(CHEIE_ACTIV, 'on');
        arataStarea();
        spune('Alertele sunt active pe acest dispozitiv. Maximum una pe zi.');
      }).catch(function (e) {
        if (e && e.message === 'indisponibil') {
          spune('Alertele nu sunt pornite pe server în acest moment. Încearcă mai târziu.');
        } else {
          spune('Nu s-au putut activa alertele. Pe iPhone, adaugă întâi site-ul pe ecranul de pornire.');
        }
      });
    });
  }

  function dezactiveaza() {
    return abonamentCurent().then(function (sub) {
      var endpoint = sub ? sub.endpoint : null;
      var opresteLocal = sub ? sub.unsubscribe() : Promise.resolve(true);
      return opresteLocal.then(function () {
        if (!endpoint) return null;
        return fetch('/push/dezabonare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: endpoint }),
        });
      });
    }).then(function () {
      scrie(CHEIE_ACTIV, 'off');
      arataStarea();
      spune('Alertele sunt dezactivate. Nu am păstrat nimic.');
    }).catch(function () {
      spune('Dezactivarea nu a reușit complet; abonamentul rămâne activ până la reîncercare.');
    });
  }

  function init() {
    if (!cutie) return;
    if (!suportat()) {
      cutie.hidden = true;
      return;
    }
    cutie.hidden = false;
    arataStarea();

    if (buton) {
      buton.addEventListener('click', function () {
        arataPanou(panou && panou.hidden);
      });
    }
    if (porneste) porneste.addEventListener('click', activeaza);
    if (opreste) opreste.addEventListener('click', dezactiveaza);

    if (Notification.permission === 'denied') {
      arataPanou(true);
      spune('Notificările sunt blocate în browser. Le poți permite din setările site-ului.');
      if (porneste) porneste.disabled = true;
      return;
    }
    // Permisiunea poate fi retrasa din setarile browserului fara sa treaca prin pagina:
    // starea salvata in localStorage nu e adevarul, abonamentul real e.
    if (citeste(CHEIE_ACTIV) === 'on') {
      abonamentCurent().then(function (sub) {
        if (!sub) {
          scrie(CHEIE_ACTIV, 'off');
          arataStarea();
        }
      }).catch(function () { /* fara service worker activ, nu avem ce verifica */ });
    }
  }

  init();
})();
