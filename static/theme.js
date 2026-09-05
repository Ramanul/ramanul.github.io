/* Tema light/dark + butonul "inapoi sus".
   FISIER EXTERN, DELIBERAT: CSP-ul emis de generator/render.py::_write_headers are
   `script-src 'self'` fara 'unsafe-inline', deci orice <script> inline sau atribut
   onclick= din HTML e refuzat de browser pe productie (Cloudflare Pages aplica
   _headers; un `python -m http.server` local NU-l aplica -- de aceea comutatorul
   parea sa mearga local si era mort pe live). Scriptul se incarca sincron in <head>
   ca tema sa fie aplicata inainte de prima pictare (fara flash alb). */
(function () {
  "use strict";

  var root = document.documentElement;
  var KEY = "izz_theme";

  function read() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ }
  }

  function prefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function isDark() {
    return root.getAttribute("data-theme") === "dark";
  }

  function apply(dark) {
    if (dark) root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");
  }

  /* Alegerea explicita a utilizatorului bate preferinta sistemului; fara alegere
     salvata, urmam prefers-color-scheme. ("" = valoare veche pentru "light".) */
  var saved = read();
  if (saved === "dark") apply(true);
  else if (saved === "light" || saved === "") apply(false);
  else apply(prefersDark());

  /* Glifa (☾/☀) vine din CSS, ca sa fie corecta inca de la prima pictare. Aici raman doar
     atributele pe care CSS-ul nu le poate scrie. `title` anunta ACTIUNEA, ca si glifa. */
  function syncToggle() {
    var btn = document.querySelector(".theme-toggle");
    if (!btn) return;
    var dark = isDark();
    btn.setAttribute("aria-pressed", dark ? "true" : "false");
    btn.setAttribute("title", dark ? "Mod luminos" : "Mod întunecat");
  }

  /* Delegare pe document: scriptul ruleaza in <head>, butoanele inca nu exista. */
  document.addEventListener("click", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest(".theme-toggle, .back-to-top") : null;
    if (!el) return;
    if (el.classList.contains("theme-toggle")) {
      var dark = !isDark();
      apply(dark);
      write(dark ? "dark" : "light");
      syncToggle();
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  var backBtn = null;
  window.addEventListener("scroll", function () {
    if (!backBtn) backBtn = document.querySelector(".back-to-top");
    if (backBtn) backBtn.classList.toggle("visible", window.scrollY > 300);
  }, { passive: true });

  document.addEventListener("DOMContentLoaded", syncToggle);
})();
