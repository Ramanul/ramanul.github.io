/* IZZ.ro Personalization Engine — client-side only, localStorage, zero PII */
(function () {
  'use strict';

  const KEY = 'izz_profile_v1';
  const HALF_LIFE_MS = 7 * 24 * 3600 * 1000;
  const MIN_INTERACTIONS = 5;
  const STOP_WORDS = new Set(['si','sau','in','la','de','cu','pe','un','o','nu','se','ca','din','ale','ale','cel','cea','cei','cele','este','sunt','fost','care','prin','dupa','este','mai','dar','daca','tot','astfel','insa','chiar','doar','iar','despre','acest','acestei','aceasta','acesta','sa','au','al','ai','am','ar','fi','vor','va','poate','orice']);

  /* ---- storage ---- */
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || empty(); }
    catch { return empty(); }
  }
  function save(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {}
  }
  function empty() {
    return { cats: {}, sources: {}, keywords: {}, reads: 0, totalTime: 0, interactions: 0 };
  }

  /* ---- decay: score × 0.5^(age/half_life) ---- */
  function decayed(signals, now) {
    const out = {};
    for (const [k, v] of Object.entries(signals || {})) {
      const score = (v.score || 0) * Math.pow(0.5, (now - (v.ts || now)) / HALF_LIFE_MS);
      if (score > 0.01) out[k] = { score, ts: v.ts || now };
    }
    return out;
  }

  function bump(map, key, delta, now) {
    const cur = map[key] || { score: 0, ts: now };
    map[key] = { score: (cur.score || 0) + delta, ts: now };
  }

  /* ---- keywords from title ---- */
  function keywords(title) {
    return (title || '').toLowerCase()
      .replace(/[^a-zăâîșțáéíóú\s-]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));
  }

  /* ---- track a card click ---- */
  function trackClick(category, source, title) {
    const p = load();
    const now = Date.now();
    p.cats    = decayed(p.cats,    now);
    p.sources = decayed(p.sources, now);
    p.keywords= decayed(p.keywords,now);
    bump(p.cats,    category, 3, now);
    bump(p.sources, source,   2, now);
    keywords(title).forEach(w => bump(p.keywords, w, 1, now));
    p.interactions = (p.interactions || 0) + 1;
    save(p);
  }

  /* ---- track read time (called from article page) ---- */
  function trackTime(seconds) {
    const p = load();
    p.reads    = (p.reads    || 0) + 1;
    p.totalTime= (p.totalTime|| 0) + seconds;
    if (seconds > 30) {
      const now = Date.now();
      const cat = document.body.dataset.category;
      const src = document.body.dataset.source;
      const ttl = document.body.dataset.title;
      if (cat) bump(p.cats    = decayed(p.cats,    now), cat, 2, now);
      if (src) bump(p.sources = decayed(p.sources, now), src, 1, now);
      if (ttl) keywords(ttl).forEach(w => bump(p.keywords = decayed(p.keywords, now), w, 0.5, now));
    }
    save(p);
  }

  /* ---- score an article element ---- */
  function scoreArticle(el, p, now) {
    const cat  = el.dataset.cat   || '';
    const src  = el.dataset.source || '';
    const kws  = keywords(el.dataset.title || '');
    const dCats = decayed(p.cats,     now);
    const dSrcs = decayed(p.sources,  now);
    const dKws  = decayed(p.keywords, now);
    const catS  = (dCats[cat]?.score || 0);
    const srcS  = (dSrcs[src]?.score || 0);
    const kwS   = kws.reduce((s, w) => s + (dKws[w]?.score || 0), 0) / Math.max(kws.length, 1);
    return 0.4 * catS + 0.3 * srcS + 0.3 * kwS;
  }

  /* ---- render "Pentru tine" section ---- */
  function renderForYou() {
    const p = load();
    if ((p.interactions || 0) < MIN_INTERACTIONS) return;
    const now = Date.now();

    const cards = Array.from(document.querySelectorAll('.grid .card[data-cat]'));
    if (cards.length < 3) return;

    const scored = cards
      .map(el => ({ el, score: scoreArticle(el, p, now) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    if (scored.length < 2) return;

    const section = document.createElement('section');
    section.id = 'pentru-tine';
    section.innerHTML = '<h2 class="section-title pt-title">Pentru tine <span class="pt-badge">personalizat</span></h2>';
    const grid = document.createElement('div');
    grid.className = 'grid';
    scored.forEach(({ el }) => grid.appendChild(el.cloneNode(true)));
    section.appendChild(grid);

    const main = document.querySelector('main');
    const firstGrid = main && main.querySelector('.grid');
    if (!firstGrid) return;
    main.insertBefore(section, firstGrid);
    rewireClicks(section);
  }

  /* ---- reorder nav by preference ---- */
  function reorderNav() {
    const p = load();
    if ((p.interactions || 0) < MIN_INTERACTIONS) return;
    const now = Date.now();
    const nav = document.querySelector('.subnav');   // categoriile stau in randul secundar
    if (!nav) return;
    const links = Array.from(nav.querySelectorAll('a[href]'));
    links.sort((a, b) => {
      // cheia = slug-ul (data-cat), nu textul afisat (care e acum eticheta localizata)
      const catA = (a.dataset.cat || a.textContent.trim()).toLowerCase();
      const catB = (b.dataset.cat || b.textContent.trim()).toLowerCase();
      const sA = (decayed(p.cats, now)[catA]?.score || 0);
      const sB = (decayed(p.cats, now)[catB]?.score || 0);
      return sB - sA;
    });
    links.forEach(l => nav.appendChild(l));
  }

  /* ---- wire click tracking on cards ---- */
  function rewireClicks(root) {
    (root || document).querySelectorAll('.card[data-cat] .read-more, .card[data-cat] .card-title a').forEach(a => {
      a.addEventListener('click', () => {
        const card = a.closest('[data-cat]');
        if (card) trackClick(card.dataset.cat, card.dataset.source, card.dataset.title || '');
      });
    });
  }

  /* ---- stats panel ---- */
  function buildStatsPanel() {
    const p = load();
    const now = Date.now();
    const cats = decayed(p.cats, now);
    const sources = decayed(p.sources, now);
    const keywords = decayed(p.keywords, now);

    const topCats = Object.entries(cats).sort((a,b) => b[1].score - a[1].score).slice(0, 5);
    const topSrc  = Object.entries(sources).sort((a,b) => b[1].score - a[1].score).slice(0, 5);
    const topKws  = Object.entries(keywords).sort((a,b) => b[1].score - a[1].score).slice(0, 10);
    const avgTime = p.reads ? Math.round(p.totalTime / p.reads) : 0;
    const catTotal = topCats.reduce((s, [,v]) => s + v.score, 0) || 1;

    const panel = document.createElement('div');
    panel.id = 'izz-stats';
    panel.innerHTML = `
      <div class="stats-backdrop"></div>
      <div class="stats-box" role="dialog" aria-label="Profilul tău de cititor">
        <div class="stats-header">
          <span class="stats-title">Profilul tău</span>
          <button class="stats-close" aria-label="Închide">✕</button>
        </div>
        <div class="stats-body">
          <div class="stats-row">
            <span class="stats-num">${p.interactions || 0}</span><span class="stats-lbl">interacțiuni</span>
            <span class="stats-num">${p.reads || 0}</span><span class="stats-lbl">articole citite</span>
            <span class="stats-num">${avgTime}s</span><span class="stats-lbl">timp mediu</span>
          </div>
          ${topCats.length ? `
          <h3 class="stats-section">Categorii preferate</h3>
          <div class="stats-bars">
            ${topCats.map(([cat, v]) => `
              <div class="bar-row">
                <span class="bar-label">${cat}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.round(v.score/catTotal*100)}%"></div></div>
                <span class="bar-pct">${Math.round(v.score/catTotal*100)}%</span>
              </div>`).join('')}
          </div>` : ''}
          ${topSrc.length ? `
          <h3 class="stats-section">Surse favorite</h3>
          <ul class="stats-list">${topSrc.map(([src]) => `<li>${src}</li>`).join('')}</ul>` : ''}
          ${topKws.length ? `
          <h3 class="stats-section">Topicuri frecvente</h3>
          <div class="stats-tags">${topKws.map(([w]) => `<span class="tag">${w}</span>`).join('')}</div>` : ''}
          <button class="stats-reset">Resetează preferințele</button>
          ${!p.interactions || p.interactions < MIN_INTERACTIONS
            ? `<p class="stats-hint">Mai citește ${MIN_INTERACTIONS - (p.interactions||0)} articol${(MIN_INTERACTIONS - (p.interactions||0)) === 1 ? '' : 'e'} pentru a activa secțiunea „Pentru tine".</p>`
            : ''}
        </div>
      </div>`;

    panel.querySelector('.stats-close').onclick = () => panel.remove();
    panel.querySelector('.stats-backdrop').onclick = () => panel.remove();
    panel.querySelector('.stats-reset').onclick = () => {
      localStorage.removeItem(KEY);
      panel.remove();
      document.getElementById('pentru-tine')?.remove();
    };
    document.body.appendChild(panel);
  }

  /* ---- stats trigger button ---- */
  function addStatsButton() {
    const btn = document.createElement('button');
    btn.className = 'izz-profile-btn';
    btn.title = 'Profilul tău de cititor';
    btn.textContent = '◎';
    btn.onclick = buildStatsPanel;
    document.body.appendChild(btn);
  }

  /* ---- article page: track time ---- */
  function initArticlePage() {
    if (!document.querySelector('.article')) return;
    const start = Date.now();
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        trackTime(Math.round((Date.now() - start) / 1000));
      }
    });
    window.addEventListener('pagehide', () => {
      trackTime(Math.round((Date.now() - start) / 1000));
    });
  }

  /* ---- buton instalare PWA: independent de consimtamant, nu stocheaza nimic ---- */
  function initInstallButton() {
    const btn = document.getElementById('izz-install-btn');
    if (!btn) return;
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      btn.hidden = false;
    });
    btn.addEventListener('click', () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(() => { deferredPrompt = null; btn.hidden = true; });
    });
    window.addEventListener('appinstalled', () => { btn.hidden = true; deferredPrompt = null; });
  }

  /* ---- init ---- */
  function init() {
    rewireClicks();
    renderForYou();
    reorderNav();
    addStatsButton();
    initArticlePage();
  }

  /* ---- consimtamant (Legea 506/2004 art. 4 / ePrivacy + GDPR): profilul si
     statisticile se activeaza DOAR dupa opt-in explicit. Stocarea alegerii in
     sine e strict necesara pentru a o respecta, deci exceptata. Refuz = zero
     stocare, zero cereri externe, zero UI. v2: textul acopera si statisticile
     de trafic (GA4), deci utilizatorii v1 sunt intrebati din nou. v3: intra si
     inregistrarea navigarii (Clarity) -- domeniu nou de prelucrare, nu doar un
     furnizor nou, deci consimtamantul dat pe v2 NU-l acopera; se cere din nou.
     Acelasi motiv ca la v1->v2. ---- */
  const CONSENT = 'izz_consent_v3';   // 'yes' | 'no'

  /* ---- statistici de trafic (GA4), incarcate DOAR dupa opt-in: Consent Mode
     v2 cu totul refuzat implicit; acordam exclusiv analytics_storage. Fara
     opt-in nu se descarca niciun script si nu pleaca nicio cerere. ---- */
  const GA_ID = 'G-6HZ8BYSFEL';

  /* ---- Nici GA4 nici Clarity nu fac diferenta intre situl public si o copie
     locala sau un preview: tagul e acelasi, deci un `http.server` pe output/
     trimite sesiuni REALE in conturile de productie. Masurat 2026-08-13:
     testele de pe localhost:8766 au ajuns in panoul Clarity cu URL localhost,
     si tot asa in GA4. Allowlist, nu blocklist -- un host nou nu incepe sa
     raporteze din greseala; daca muti situl pe alt domeniu, adauga-l aici. ---- */
  const HOSTURI_PRODUCTIE = ['izz.ro', 'www.izz.ro'];

  function eProductie() {
    return HOSTURI_PRODUCTIE.indexOf(location.hostname) !== -1;
  }

  function loadAnalytics() {
    if (!eProductie()) return;                          // local/preview: nu poluam
    if (window.dataLayer) return;                       // deja incarcat
    window.dataLayer = [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', {
      ad_storage: 'denied', ad_user_data: 'denied',
      ad_personalization: 'denied', analytics_storage: 'denied'
    });
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  /* ---- harti de click si inregistrari de navigare (Microsoft Clarity),
     pe aceeasi poarta ca GA4: fara opt-in nu se descarca nimic si nu pleaca
     nicio cerere. Tag-ul contacteaza scripts.clarity.ms (biblioteca) si un host
     de colectare care NU e fix: configul tagului declara k.clarity.ms, dar
     rularea reala din 2026-08-13 a urcat pe n.clarity.ms. De-aia CSP-ul are
     wildcard `*.clarity.ms`, nu hosturi exacte -- nu-l stramta.
     MASURAT 2026-08-13 in tagul real: muidsync() -- pixelul c.clarity.ms/c.gif
     care sincronizeaza MUID, identificatorul de publicitate Microsoft --
     porneste DOAR pe ad_Storage:'granted'. Il refuzam explicit, ca la GA4,
     deci c.clarity.ms NU e in CSP: daca flagul asta regreseaza vreodata,
     browserul blocheaza pixelul oricum. ---- */
  const CLARITY_ID = 'y4z4iwgx2n';

  function loadClarity() {
    if (!eProductie()) return;                          // local/preview: nu poluam
    if (window.clarity) return;                         // deja incarcat
    window.clarity = function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.clarity.ms/tag/' + CLARITY_ID;
    document.head.appendChild(s);
  }

  function consentBar() {
    const bar = document.createElement('div');
    bar.id = 'izz-consent';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Personalizare');
    bar.innerHTML = `
      <p>Vrei recomandări personalizate și ne ajuți cu statistici anonime?
      Profilul tău de lectură rămâne <b>doar în browserul tău</b>. Google
      Analytics și Microsoft Clarity înregistrează anonim cum navighezi
      (click-uri, derulare), <b>fără urmărire publicitară</b>.
      <a href="/legal/privacy/">Detalii</a></p>
      <div class="consent-actions">
        <button type="button" class="consent-yes">Activează</button>
        <button type="button" class="consent-no">Nu, mulțumesc</button>
      </div>`;
    bar.querySelector('.consent-yes').onclick = () => {
      try { localStorage.setItem(CONSENT, 'yes'); } catch {}
      bar.remove();
      init();
      loadAnalytics();
      loadClarity();
    };
    bar.querySelector('.consent-no').onclick = () => {
      try { localStorage.setItem(CONSENT, 'no'); localStorage.removeItem(KEY); } catch {}
      bar.remove();
    };
    document.body.appendChild(bar);
  }

  function boot() {
    initInstallButton();
    let c = null;
    try { c = localStorage.getItem(CONSENT); } catch {}
    if (c === 'yes') { init(); loadAnalytics(); loadClarity(); return; }
    if (c === 'no') { return; }
    consentBar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
