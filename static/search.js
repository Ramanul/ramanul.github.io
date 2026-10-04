/* Căutare instantanee pe /cauta/ — index Pagefind construit la fiecare build.
   Fără dependențe externe, fără server, fără trackere.

   CUM FUNCȚIONEAZĂ. `generator/pagefind_index.py` rulează Pagefind peste output/ și lasă în
   `/_pagefind/` un index BM25 cu stemmer de română și pliere de diacritice. La prima tastă
   apăsată încărcăm două lucruri, în paralel: modulul Pagefind și `search-index.json` (mapa
   de rezultate). Pagefind găsește și ierarhizează paginile, dar `search()` întoarce doar
   id-ul intern al paginii; titlul, categoria și data vin din mapă, fiindcă fragmentele din
   care le-am fi cerut sunt șterse la build — unul per pagină ar duce output-ul peste plafonul
   de 20.000 de fișiere al Workers Free. Vezi specs/cautare-pagefind.md.

   ZERO ZGOMOT. Afișăm exact ce a potrivit indexul: fără rezultate aproximative, fără
   „poate te interesează”, fără umplutură când căutarea nu dă nimic. Când indexul lipsește
   (build fără Pagefind) cădem pe o căutare simplificată, doar în titluri, și SPUNEM asta în
   pagină — un mod degradat care nu se anunță e mai rău decât o eroare.

   Diacriticele nu contează în niciun sens: plierea de mai jos e folosită doar pentru marcare
   și pentru modul simplificat; Pagefind își pliază singur termenii. */
(function () {
  "use strict";

  var app = document.getElementById("search-app");
  var q = document.getElementById("q");
  var category = document.getElementById("search-category");
  var out = document.getElementById("search-results");
  var status = document.getElementById("search-status");
  var quickButtons = document.querySelectorAll("[data-quick-filter]");
  var sortButtons = document.querySelectorAll("[data-sort]");
  var form = document.getElementById("search-form");
  if (!app || !q || !out || !status) return;

  var resultLimit = Number(status.getAttribute("data-result-limit")) || 50;
  var RADACINA = app.getAttribute("data-pagefind") || "/_pagefind/";
  var MAPA_URL = app.getAttribute("data-index") || "/search-index.json";
  var DEBOUNCE_MS = 200;

  var quickLabels = {
    concursuri: "concursuri",
    hotarari: "hotărâri",
    achizitii: "achiziții",
    oficiale: "anunțuri oficiale"
  };

  // Stare. `pagefind` ramane null cand indexul nu a putut fi incarcat — atunci cautarea
  // cade pe `cautaInTitluri`, nu pe o eroare.
  var pagefind = null;
  var intrari = null;      // [[u, t, c, d, f, id], ...] in ordinea publicarii (cele mai noi primele)
  var dupaId = null;       // id Pagefind -> intrare
  var etichete = {};       // slug categorie -> eticheta romana (din <select>, ca sa nu le duplicam)
  var incarcat = false;
  var seIncarca = null;
  var quickFilter = "";
  var sortare = "";
  var timer = null;
  var cerere = 0;

  if (form) form.addEventListener("submit", function (e) { e.preventDefault(); ruleaza(0); });

  /* ---- diacritice ------------------------------------------------------------- */
  // Pliere caracter cu caracter, ca indicii din sirul pliat sa ramana valabili si pe sirul
  // original: marcarea taie din titlul NEPLIAT la pozitiile gasite in cel pliat. Un caracter
  // a carui forma mica are alta lungime (rar, dar exista in Unicode) devine un marcaj care nu
  // se potriveste cu nimic, in loc sa decaleze tot sirul.
  var PLIERE = { "ă": "a", "â": "a", "î": "i", "ș": "s", "ş": "s", "ț": "t", "ţ": "t" };
  function pliaza(s) {
    var rez = "";
    for (var i = 0; i < s.length; i++) {
      var mic = s.charAt(i).toLowerCase();
      rez += (mic.length === 1 ? (PLIERE[mic] || mic) : "\u0000");
    }
    return rez;
  }

  function etichetaCategorie(slug) {
    return etichete[slug] || slug;
  }
  if (category) {
    for (var i = 0; i < category.options.length; i++) {
      if (category.options[i].value) {
        etichete[category.options[i].value] = category.options[i].textContent;
      }
    }
  }

  function descrieFiltre(cat) {
    var parti = [];
    if (quickFilter) parti.push(quickLabels[quickFilter] || quickFilter);
    if (cat) parti.push("categoria „" + etichetaCategorie(cat) + "”");
    return parti.length ? " pentru " + parti.join(" · ") : "";
  }

  /* ---- incarcare -------------------------------------------------------------- */
  function incarcaMapa() {
    return fetch(MAPA_URL).then(function (r) {
      if (!r.ok) throw new Error("mapa de rezultate indisponibila (HTTP " + r.status + ")");
      return r.json();
    }).then(function (d) {
      intrari = (d && d.a) || [];
      dupaId = {};
      for (var k = 0; k < intrari.length; k++) {
        if (intrari[k][5]) dupaId[intrari[k][5]] = intrari[k];
      }
    });
  }

  function incarcaPagefind() {
    // import() dinamic: modulul Pagefind e ESM, iar noi ramanem un script clasic. Un import
    // static ar cere type="module" pe pagina si ar taia tot scriptul pe browsere fara module.
    var mod;
    try {
      mod = import(RADACINA + "pagefind.js");
    } catch (e) {
      return Promise.resolve(null);
    }
    return mod.then(function (m) {
      // Forma modulului e verificata, nu presupusa. Un fisier servit gresit (un 404 care
      // intoarce pagina de eroare, un proxy care rescrie raspunsul, o versiune de Pagefind
      // cu alt API) ar lasa pagina blocata pe „Se caută…” fara nicio cale de iesire; asa
      // cade pe cautarea simplificata, care se anunta singura.
      return (m && typeof m.search === "function") ? m : null;
    }).catch(function () { return null; });
  }

  function pregateste(cb) {
    if (incarcat) { cb(); return; }
    if (seIncarca) { seIncarca.then(cb); return; }
    status.textContent = "Se încarcă indexul…";
    seIncarca = Promise.all([incarcaMapa(), incarcaPagefind()]).then(function (rez) {
      pagefind = rez[1];
      incarcat = true;
      status.textContent = "";
    }).catch(function () {
      // Fara mapa nu putem afisa nici macar titluri: asta e singura eroare fata-in-fata.
      intrari = null;
      incarcat = true;
      status.textContent = "Datele pentru căutare nu au putut fi încărcate. Reîncarcă pagina.";
    });
    seIncarca.then(cb);
  }

  /* ---- marcare ---------------------------------------------------------------- */
  // Marcheaza termenii cautati in titlu. Cautam in sirul pliat (fara diacritice), dar taiem
  // din cel original, ca <mark> sa contina textul exact asa cum e scris.
  function marcheaza(tinta, text, termeni) {
    var intervale = [];
    var pliat = pliaza(text);
    for (var i = 0; i < termeni.length; i++) {
      var deLa = 0;
      var gasit;
      while ((gasit = pliat.indexOf(termeni[i], deLa)) !== -1) {
        intervale.push([gasit, gasit + termeni[i].length]);
        deLa = gasit + termeni[i].length;
      }
    }
    if (!intervale.length) { tinta.textContent = text; return; }
    intervale.sort(function (a, b) { return a[0] - b[0]; });
    var cursor = 0;
    for (var j = 0; j < intervale.length; j++) {
      if (intervale[j][0] < cursor) continue;   // suprapunere cu o potrivire deja marcata
      if (intervale[j][0] > cursor) {
        tinta.appendChild(document.createTextNode(text.slice(cursor, intervale[j][0])));
      }
      var mark = document.createElement("mark");
      mark.textContent = text.slice(intervale[j][0], intervale[j][1]);
      tinta.appendChild(mark);
      cursor = intervale[j][1];
    }
    if (cursor < text.length) {
      tinta.appendChild(document.createTextNode(text.slice(cursor)));
    }
  }

  /* ---- rezultate -------------------------------------------------------------- */
  function deseneaza(hits, total, termeni, cat) {
    out.textContent = "";
    var sufix = descrieFiltre(cat);
    var mod = pagefind ? "" :
      " Căutare simplificată: indexul complet nu e disponibil, am căutat doar în titluri.";
    if (!total) {
      status.textContent = "Niciun rezultat" +
        (termeni.length ? " pentru „" + q.value.trim() + "”" : "") + sufix +
        ". Încearcă un termen mai general sau o altă categorie." + mod;
      return;
    }
    if (hits.length < total) {
      status.textContent = "Primele " + hits.length + " din " + total + " rezultate" + sufix + "." + mod;
    } else if (termeni.length) {
      status.textContent = total + (total === 1 ? " rezultat" : " rezultate") +
        " pentru „" + q.value.trim() + "”" + sufix + "." + mod;
    } else {
      status.textContent = total + (total === 1 ? " știre" : " știri") + sufix + " — cele mai noi." + mod;
    }
    for (var i = 0; i < hits.length; i++) {
      var e = hits[i];
      var li = document.createElement("li");
      var link = document.createElement("a");
      link.href = e[0];
      marcheaza(link, e[1], termeni);
      var meta = document.createElement("span");
      meta.className = "search-meta";
      meta.textContent = " — " + etichetaCategorie(e[2]) + ", " + e[3] + (e[4] ? " · anunț oficial" : "");
      li.appendChild(link);
      li.appendChild(meta);
      out.appendChild(li);
    }
  }

  /* ---- modul simplificat (index Pagefind indisponibil) ------------------------- */
  // Mapa e scrisa in ordinea publicarii (cele mai noi primele), deci rezultatul e deja
  // sortat cronologic — singura ordonare onesta fara un index de relevanta.
  function cautaInTitluri(termeni) {
    var toate = [];
    for (var i = 0; i < intrari.length; i++) {
      var e = intrari[i];
      if (!treceFiltre(e)) continue;
      var pliat = pliaza(e[1]);
      var ok = true;
      for (var j = 0; j < termeni.length; j++) {
        if (pliat.indexOf(termeni[j]) === -1) { ok = false; break; }
      }
      if (ok) toate.push(e);
    }
    return { hits: toate.slice(0, resultLimit), total: toate.length };
  }

  /* ---- filtre ----------------------------------------------------------------- */
  function filtrePagefind(cat) {
    var f = {};
    if (cat) f.categorie = cat;
    if (quickFilter === "oficiale") f.oficial = "da";
    else if (quickFilter) f.tip = quickFilter;
    return f;
  }

  function treceFiltre(e) {
    var cat = category ? category.value : "";
    if (cat && e[2] !== cat) return false;
    if (quickFilter === "oficiale") return Boolean(e[4]);
    if (quickFilter) return e[4] === quickFilter;
    return true;
  }

  /* ---- cautare ---------------------------------------------------------------- */
  function ruleaza(intarziere) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (intarziere > 0) {
      timer = setTimeout(function () { timer = null; ruleaza(0); }, intarziere);
      return;
    }
    pregateste(function () {
      var termen = q.value.trim();
      // Cuvintele sub doua litere nu au ce sa potriveasca: indexul e pe cuvinte intregi
      // (cu potrivire pe prefix), nu pe litere izolate.
      var termeni = pliaza(termen).split(/\s+/).filter(function (w) { return w.length > 1; });
      var cat = category ? category.value : "";
      var areFiltre = Boolean(cat || quickFilter);
      out.textContent = "";

      if (!termeni.length && !areFiltre) {
        // Campul si filtrele au fost golite: nu mai e nimic de cautat. Dar o cerere poate fi
        // INCA IN DRUM (debounce + indexul care raspunde dupa ~10 ms). Fara invalidarea ei
        // aici, raspunsul acela si-ar gasi contorul neschimbat si ar redesena lista pe care
        // tocmai am golit-o — rezultate care reapar dupa ce ai sters textul, adica zgomot.
        cerere++;
        // Si `aria-busy`, din acelasi motiv: raspunsul invalidat de mai sus iese prin
        // `idCerere !== cerere` FARA sa curete atributul (il curata abia dupa garda), deci
        // fara linia asta lista ramane anuntata ca „in lucru" pana la urmatoarea cautare.
        out.setAttribute("aria-busy", "false");
        status.textContent = "";
        return;
      }
      if (!intrari) {
        status.textContent = "Datele pentru căutare nu au putut fi încărcate. Reîncarcă pagina.";
        return;
      }
      if (!pagefind) {
        var doarTitluri = cautaInTitluri(termeni);
        deseneaza(doarTitluri.hits, doarTitluri.total, termeni, cat);
        return;
      }

      var idCerere = ++cerere;
      status.textContent = "Se caută…";
      out.setAttribute("aria-busy", "true");
      var optiuni = { filters: filtrePagefind(cat) };
      if (termeni.length && sortare) {
        optiuni.sort = {};
        optiuni.sort[sortare] = "desc";
      } else {
        // Fara termen (numai filtre) relevanta nu inseamna nimic, deci ordonam cronologic.
        optiuni.sort = { data: "desc" };
      }

      var cautare;
      try {
        cautare = pagefind.search(termeni.length ? termen : null, optiuni);
      } catch (e) {
        // Un apel care ARUNCA sincron (in loc sa intoarca o promisiune respinsa) nu e prins
        // de .catch-ul de mai jos; fara try/catch aici pagina ramane blocata pe „Se caută…”.
        cautare = Promise.reject(e);
      }
      cautare.then(function (rez) {
        if (idCerere !== cerere) return;   // a mai intrat o tasta intre timp: rezultatul e vechi
        var hits = [];
        for (var i = 0; i < rez.results.length; i++) {
          var e = dupaId[rez.results[i].id];
          // Un id pe care nu-l avem in mapa nu devine rezultat: mai bine un rezultat mai
          // putin decat o intrare fara titlu si fara link.
          if (e) hits.push(e);
          if (hits.length >= resultLimit) break;
        }
        out.setAttribute("aria-busy", "false");
        if (rez.results.length && !hits.length) {
          // Indexul si mapa s-au despartit (build partial, cache vechi): am gasit pagini,
          // dar nu le putem numi. Nu afisam „Primele 0 din N" — cadem pe titluri si spunem.
          var rezerva = cautaInTitluri(termeni);
          deseneaza(rezerva.hits, rezerva.total, termeni, cat);
          return;
        }
        deseneaza(hits, rez.results.length, termeni, cat);
      }).catch(function () {
        if (idCerere !== cerere) return;
        out.setAttribute("aria-busy", "false");
        var rezultat = cautaInTitluri(termeni);
        deseneaza(rezultat.hits, rezultat.total, termeni, cat);
      });
    });
  }

  /* ---- legatura partajabila --------------------------------------------------- */
  function scrieInAdresa() {
    if (!window.history || !history.replaceState) return;
    var termen = q.value.trim();
    history.replaceState(null, "", location.pathname + (termen ? "?q=" + encodeURIComponent(termen) : ""));
  }

  function marcheazaApasat(butoane, atribut, valoare) {
    for (var i = 0; i < butoane.length; i++) {
      butoane[i].setAttribute("aria-pressed",
        butoane[i].getAttribute(atribut) === valoare ? "true" : "false");
    }
  }

  q.addEventListener("input", function () { scrieInAdresa(); ruleaza(DEBOUNCE_MS); });
  q.addEventListener("search", function () { ruleaza(0); });
  if (category) category.addEventListener("change", function () { ruleaza(0); });
  for (var b = 0; b < quickButtons.length; b++) {
    quickButtons[b].addEventListener("click", function () {
      quickFilter = this.getAttribute("data-quick-filter") || "";
      marcheazaApasat(quickButtons, "data-quick-filter", quickFilter);
      ruleaza(0);
    });
  }
  for (var s = 0; s < sortButtons.length; s++) {
    sortButtons[s].addEventListener("click", function () {
      sortare = this.getAttribute("data-sort") || "";
      marcheazaApasat(sortButtons, "data-sort", sortare);
      ruleaza(0);
    });
  }

  // ?q= — un rezultat de cautare se poate trimite mai departe ca legatura.
  var dinAdresa = new URLSearchParams(location.search).get("q");
  if (dinAdresa) {
    q.value = dinAdresa;
    ruleaza(0);
  }
})();
