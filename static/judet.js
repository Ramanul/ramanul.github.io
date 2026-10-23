/* IZZ.ro — alegerea județului, făcută de cititor și numai de el.
 *
 * Singura variație a fluxului de la un cititor la altul. Site-ul nu deduce ce te interesează
 * din ce citești: nu numără clicuri, nu măsoară timpul de lectură, nu reordonează rubricile.
 * Până la 2026-10-23 făcea toate trei (profil local cu decădere, o secțiune de recomandări,
 * meniul reordonat, plus statistici de audiență și înregistrarea navigării la terți), după un
 * singur buton de consimțământ. Au ieșit împreună cu bara care le cerea; motivul și ce s-a
 * cântărit stau în specs/plan-paradigma-izz.md §5 (decizia D6).
 *
 * Ce stochează: cheia `izz_judet`, scrisă DOAR la `change` pe select, adică la cererea
 * explicită a cititorului (Legea 506/2004 art. 4 alin. 5: stocare strict necesară unui
 * serviciu cerut expres). „Toată țara" o șterge. La încărcare nu se scrie nimic.
 */
(function () {
  'use strict';

  var KEYJ = 'izz_judet';

  /* ---- curățenie, o singură dată per browser, fără marcaj propriu ----
   * Cine a apăsat „Activează" înainte de 2026-10-23 are în browser ce i-a lăsat versiunea
   * veche: profilul de lectură și alegerea de consimțământ (localStorage), plus cookie-urile
   * first-party ale statisticilor externe (`_ga*`, `_gid`, `_gat*`, `_clck`, `_clsk`), care
   * altfel ar rămâne până la doi ani și ar pleca la fiecare cerere. Ștergem doar ce a pus
   * codul nostru. Idempotent: pe un browser curat nu găsește nimic și nu scrie nimic.
   * DE SCOS după 2027-01-31 — după trei luni, cine revine a trecut deja pe aici. */
  function curataUrmeleVechi() {
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && /^izz_(profile|consent)/.test(k)) localStorage.removeItem(k);
      }
    } catch (e) { /* private mode / stocare blocată */ }
    var nume = document.cookie.split(';').map(function (c) {
      return c.split('=')[0].trim();
    }).filter(function (n) { return /^(_ga|_gid|_gat|_clck|_clsk)/.test(n); });
    if (!nume.length) return;
    // Google și Clarity își pun cookie-urile pe domeniul cel mai larg („.izz.ro"); fără
    // atributul `domain` identic, browserul ignoră ștergerea. Le încercăm pe toate.
    var gazda = location.hostname;
    var parti = gazda.split('.');
    var domenii = ['', gazda, '.' + gazda];
    if (parti.length > 2) domenii.push('.' + parti.slice(-2).join('.'));
    nume.forEach(function (n) {
      domenii.forEach(function (d) {
        document.cookie = n + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  function pinJudet() {
    var sel = document.getElementById('judet-meu');
    var cutie = document.getElementById('din-judet');
    if (!sel || !cutie) return;
    try {
      var salvat = localStorage.getItem(KEYJ) || '';
      if (salvat && /^[A-Z0-9]+$/.test(salvat)) sel.value = salvat;
    } catch (e) { /* private mode */ }
    sel.addEventListener('change', function () {
      try {
        if (sel.value) localStorage.setItem(KEYJ, sel.value);
        else localStorage.removeItem(KEYJ);
      } catch (e) { /* private mode */ }
      deseneazaJudet();
    });
    deseneazaJudet();

    function deseneazaJudet() {
      var code = sel.value;
      cutie.replaceChildren();
      if (!code || !/^[A-Z0-9]+$/.test(code)) {
        cutie.hidden = true;
        Array.prototype.forEach.call(document.querySelectorAll('.card-al-meu'), function (c) {
          c.classList.remove('card-al-meu');
        });
        return;
      }
      var opt = sel.options[sel.selectedIndex];
      var slug = opt.getAttribute('data-slug') || '';
      var label = opt.textContent || code;
      var titlu = document.createElement('h2');
      titlu.className = 'section-title';
      titlu.id = 'din-judet-title';
      titlu.textContent = 'Din județul tău';
      cutie.appendChild(titlu);
      var cards = Array.prototype.filter.call(
        document.querySelectorAll('.card[data-judet]'),
        function (card) {
          var alMeu = card.getAttribute('data-judet') === code && !cutie.contains(card);
          card.classList.toggle('card-al-meu', alMeu);
          return alMeu;
        }
      );
      if (!cards.length) {
        var p = document.createElement('p');
        p.className = 'empty';
        p.appendChild(document.createTextNode('Pe prima pagină nu e încă o știre din ' + label + '. '));
        if (slug) {
          var a = document.createElement('a');
          a.href = '/harta/' + slug + '/';
          a.textContent = 'Vezi județul pe hartă';
          p.appendChild(a);
        }
        cutie.appendChild(p);
      } else {
        var grid = document.createElement('section');
        grid.className = 'grid';
        cards.slice(0, 6).forEach(function (card) { grid.appendChild(card.cloneNode(true)); });
        cutie.appendChild(grid);
      }
      cutie.hidden = false;
    }
  }

  function boot() {
    curataUrmeleVechi();
    pinJudet();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
