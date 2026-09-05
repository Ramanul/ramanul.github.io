/* Calculator salariu net.
 *
 * De ce e fisier extern si nu <script> inline: CSP-ul sitului e `script-src 'self'` FARA
 * `'unsafe-inline'` (vezi render._write_headers). Varianta inline nu a rulat niciodata pe
 * live -- masurat 2026-08-02 pe https://izz.ro/ghiduri/salariul-minim/: `calcSalariu` era
 * `undefined`, `#calc-results` era gol, si nicio cifra introdusa nu producea nimic.
 * Din acelasi motiv nu exista `onclick=`/`oninput=` in markup: si alea sunt cod inline.
 *
 * Salariul minim vine din `data-salariu-minim` pe container, nu dintr-un literal generat
 * in JS, ca sa nu mai fie nevoie de interpolare de sursa executabila.
 */
(function () {
  "use strict";

  function lei(n) {
    // Separator de mie romanesc; Math.round inainte, ca sa nu apara zecimale de rotunjire.
    return Math.round(n).toLocaleString("ro-RO") + " lei";
  }

  function scazut(n) {
    // Minusul are sens doar cand chiar se scade ceva: cu campul golit, "-0 lei" pe cinci
    // randuri arata a defect.
    return (n > 0 ? "-" : "") + lei(n);
  }

  function rand(eticheta, valoare, clasa) {
    var d = document.createElement("div");
    d.className = "calc-item" + (clasa ? " " + clasa : "");
    var e = document.createElement("span");
    e.className = "calc-label";
    e.textContent = eticheta;
    var v = document.createElement("span");
    v.className = "calc-val";
    v.textContent = valoare;
    d.appendChild(e);
    d.appendChild(v);
    return d;
  }

  function init(box) {
    var input = box.querySelector(".calc-brut");
    var out = box.querySelector(".calc-results");
    if (!input || !out) return;

    var salariuMinim = parseFloat(box.getAttribute("data-salariu-minim")) || 0;

    function calc() {
      // `min="0"` tine doar de validarea formularului, nu de valoarea citita aici: un brut
      // negativ tastat manual dadea "- -1.250 lei" pe fiecare rand.
      var brut = Math.max(0, parseFloat(input.value) || 0);
      var cas = Math.round(brut * 0.25);
      var cass = Math.round(brut * 0.1);
      // Deducere personala de baza, fara persoane in intretinere: art. 77 Cod Fiscal
      // (Legea 227/2015, modificat OG 16/2022) NU e un procent fix -- e degresiva.
      //
      // Sursa exacta, ca sa nu se reciteasca gresit peste sase luni: forma consolidata de pe
      // legislatie.just.ro, document 257144, citita 2026-08-07; in vigoare de la 01-01-2023
      // prin pct. 40 al art. I din OG nr. 16/2022 (M. Of. 716/15.07.2022).
      // CAPCANA PORTALULUI: deasupra formei in vigoare afiseaza si forma VECHE a art. 77,
      // cea cu "venit lunar brut de pana la 1.950 lei ... 510 lei". Aia e istoric, nu drept
      // aplicabil -- cine o copiaza de acolo obtine un calculator gresit care pare documentat. La
      // salariul minim brut: 20%. Peste minim, scade cu 0,5 puncte procentuale la fiecare
      // transa de 50 lei, pana la 0% cand brutul trece de minim+2.000 lei (plafonul de
      // acordare). Un flat `salariuMinim * 0.2` supraestima deducerea (deci subestima
      // impozitul) pentru orice brut STRICT peste minim.
      //
      // `ceil`, NU `floor` (corectat 2026-08-15). Tabelul din art. 77 alin. (4) deschide
      // fiecare transa la +1 leu, nu la +0: "salariul minim" = 20,00%, "minim + 1 leu ...
      // minim + 50 lei" = 19,50%, "minim + 51 ... + 100 lei" = 19,00%. Cu `floor`, un brut
      // de minim+1 leu primea 20% in loc de 19,50% -- adica deducere prea mare, impozit prea
      // mic, net afisat prea mare. Cele doua formule coincid DOAR pe multiplii exacti de 50,
      // deci greseala lovea 49 din 50 de valori posibile. `tests/test_calc_salariu.py`
      // ruleaza fisierul asta in node si il compara rand cu rand cu tabelul din lege.
      var trepte = Math.max(0, Math.ceil((brut - salariuMinim) / 50));
      var rataDeducere = Math.max(0, 20 - trepte * 0.5);
      var deducere = brut > salariuMinim + 2000 ? 0 : Math.round(salariuMinim * rataDeducere / 100);
      // Art. 77 alin. (2): deducerea se acorda in limita venitului impozabil lunar realizat.
      // Fara plafon, la un brut sub salariul minim se afisa "Deducere personala: 865 lei"
      // peste un venit impozabil de 650 -- randul se contrazicea cu cel de deasupra lui.
      deducere = Math.min(deducere, Math.max(0, brut - cas - cass));
      var baza = Math.max(0, brut - cas - cass - deducere);
      var impozit = Math.round(baza * 0.1);
      var net = brut - cas - cass - impozit;

      out.textContent = "";
      out.appendChild(rand("CAS (25%)", scazut(cas)));
      out.appendChild(rand("CASS (10%)", scazut(cass)));
      out.appendChild(rand("Deducere personală", lei(deducere)));
      out.appendChild(rand("Bază impozabilă", lei(baza)));
      out.appendChild(rand("Impozit (10%)", scazut(impozit)));
      out.appendChild(rand("SALARIU NET", lei(net), "calc-total"));
    }

    input.addEventListener("input", calc);
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest(".btn-preset");
      if (!b || !box.contains(b)) return;
      input.value = b.getAttribute("data-brut");
      calc();
    });
    calc();
  }

  function start() {
    var boxes = document.querySelectorAll(".calculator[data-salariu-minim]");
    for (var i = 0; i < boxes.length; i++) init(boxes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
