/* Căutare client-side pe /cauta/: index JSON mic, generat la render.
   Fără dependențe, fără server, fără trackere. Diacritice-insensibilă. */
(function () {
  "use strict";
  var q = document.getElementById("q");
  var category = document.getElementById("search-category");
  var out = document.getElementById("search-results");
  var status = document.getElementById("search-status");
  var quickButtons = document.querySelectorAll("[data-quick-filter]");
  var resultLimit = Number(status && status.getAttribute("data-result-limit")) || 50;
  var quickFilter = "";
  var quickLabels = {
    concursuri: "concursuri",
    hotarari: "hotărâri",
    achizitii: "achiziții",
    oficiale: "anunțuri oficiale"
  };
  if (!q || !out || !status) return;

  var form = document.getElementById("search-form");
  if (form) form.addEventListener("submit", function (e) { e.preventDefault(); });

  var index = null, loading = false;
  var MAP = { "ă": "a", "â": "a", "î": "i", "ș": "s", "ş": "s", "ț": "t", "ţ": "t" };
  function norm(s) {
    return s.toLowerCase().replace(/[ăâîșşțţ]/g, function (c) { return MAP[c] || c; });
  }

  function setQuickFilter(value) {
    quickFilter = value;
    for (var i = 0; i < quickButtons.length; i++) {
      var active = quickButtons[i].getAttribute("data-quick-filter") === value;
      quickButtons[i].setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function load(cb) {
    if (index) return cb();
    if (loading) return;
    loading = true;
    status.textContent = "Se încarcă indexul…";
    fetch("/search-index.json")
      .then(function (r) {
        if (!r.ok) throw new Error("index indisponibil");
        return r.json();
      })
      .then(function (d) {
        index = d.map(function (a) { return { n: norm(a.t || ""), a: a }; });
        loading = false;
        status.textContent = "";
        cb();
      })
      .catch(function () {
        loading = false;
        status.textContent = "Indexul nu a putut fi încărcat.";
      });
  }

  function matchesQuickFilter(article) {
    if (!quickFilter) return true;
    if (quickFilter === "oficiale") return Boolean(article.f);
    return article.f === quickFilter;
  }

  function filterSuffix(selectedCategory) {
    var labels = [];
    if (quickFilter) labels.push(quickLabels[quickFilter]);
    if (selectedCategory) labels.push("categoria „" + selectedCategory + "”");
    return labels.length ? " pentru " + labels.join(" · ") : "";
  }

  function run() {
    var words = norm(q.value.trim()).split(/\s+/).filter(function (w) { return w.length > 1; });
    var selectedCategory = category ? category.value : "";
    var suffix = filterSuffix(selectedCategory);
    out.textContent = "";

    if (!words.length && !quickFilter) {
      status.textContent = selectedCategory ? "Introdu un termen pentru categoria selectată." : "";
      return;
    }

    var hits = [];
    for (var i = 0; i < index.length && hits.length < resultLimit; i++) {
      var article = index[i].a;
      var ok = (!selectedCategory || article.c === selectedCategory) && matchesQuickFilter(article);
      for (var j = 0; ok && j < words.length; j++) {
        if (index[i].n.indexOf(words[j]) === -1) ok = false;
      }
      if (ok) hits.push(article);
    }
    if (hits.length) {
      status.textContent = (hits.length === resultLimit ? "Primele " + resultLimit + " rezultate" : hits.length + " rezultate") + suffix + ".";
    } else {
      status.textContent = "Niciun rezultat" + suffix + ". Încearcă un termen mai general sau o altă categorie.";
    }
    hits.forEach(function (article) {
      var li = document.createElement("li");
      var link = document.createElement("a");
      link.href = article.u;
      link.textContent = article.t;
      var meta = document.createElement("span");
      meta.className = "search-meta";
      meta.textContent = " — " + article.c + ", " + article.d;
      li.appendChild(link);
      li.appendChild(meta);
      out.appendChild(li);
    });
  }

  q.addEventListener("input", function () { load(run); });
  if (category) category.addEventListener("change", function () { load(run); });
  for (var i = 0; i < quickButtons.length; i++) {
    quickButtons[i].addEventListener("click", function () {
      setQuickFilter(this.getAttribute("data-quick-filter") || "");
      load(run);
    });
  }
})();
