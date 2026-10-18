/* Service worker IZZ.ro — citire offline si alerte.
   Publicat la RADACINA (/sw.js), nu in /static/: un service worker nu poate controla decat
   propriul director si subdirectoarele lui, deci unul livrat de la /static/sw.js ar vedea
   doar /static/ si nicio pagina de articol.

   STRATEGII, si de ce una nu ajunge:
     · shellul (prima pagina, pagina de offline, CSS-urile, fonturile, iconitele) se
       PRECACHEAZA la instalare — fara asta, prima deschidere fara net arata o eroare de
       browser in loc de site;
     · paginile (prima pagina, articolele, categoriile) merg pe RETEA INTAI, cu termen:
       daca reteaua raspunde in TERMEN_RETEA ms, cititorul vede site-ul de acum; daca nu
       (metrou, semnal slab) sau pica, primeste copia salvata. Pana pe 2026-10-16 era
       stale-while-revalidate: fiecare intoarcere pe site arata INTAI prima pagina de la
       vizita trecuta — la un agregator de stiri, stirile de ieri, prezentate ca azi.
     · /static/*?v=<hash> e cheiat pe URL-ul EXACT si servit din cache doar daca e
       EXACT versiunea ceruta; altfel din retea, iar copiile cu alt hash ale aceluiasi
       fisier se sterg (un singur exemplar per fisier, ca inainte). Doar FARA retea se
       accepta alta versiune decat cea ceruta — mai bine o pagina cu stilul de ieri decat
       niciuna.
       De ce nu mai e cheia fara query (cum a fost pana pe 2026-10-16): asa, `?v=` — singurul
       mecanism care sparge cache-ul de 30 de zile — nu mai sparge nimic pentru cine are
       service workerul. HTML-ul nou venea cu `styles.css` VECHI: reprodus in Chromium
       headless pe /extern/ (coperta cu portret randata cu CSS-ul de dinainte de 3 oct.:
       poza pe tot cardul, taiata la frunte, cu sigiliul datei peste ea) si masurat: dupa
       orice schimbare de CSS, prima vizita a fiecarui cititor iesea rupta.

   CE NU INTERCEPTEAZA, deliberat:
     · orice altceva decat GET;
     · domenii straine (n-avem ce cache-ui, si am deveni o problema de confidentialitate);
     · /push/* — abonarea e o operatiune, nu un document;
     · /build.json, /feed.xml, sitemapuri: sunt date vii, citite de unelte, si un raspuns
       servit din cache ar minti despre versiunea publicata;
     · /static/harta-stiri/data/*: datele hartii (map.json, UAT-uri) sunt date vii ale
       ultimei rulari, nevesionate — prin stale-while-revalidate, harta arata la prima
       deschidere stirile de la vizita trecuta (citit 2026-10-16).

   LIMITA ASUMATA: cache-ul de articole e plafonat la MAX_ARTICOLE intrari, taiate de la cea
   mai veche. Nu e o arhiva: e „ce ai mai citit". Articolele expirate din fereastra TTL nu
   sunt recuperate aici — pentru ele exista fallback-ul de oglinda din infra/worker-404-mirror.js.
*/

const SHELL = 'izz-shell-v3';   // v3: invalidate pages cached before correction propagation
const ARTICOLE = 'izz-articole-v3';
const TERMEN_RETEA = 2500;   // ms pana cand o pagina cade pe copia salvata
const MAX_ARTICOLE = 60;
const OFFLINE = '/offline/';

const PRECACHE = [
  '/',
  OFFLINE,
  '/static/styles.css',
  '/static/site.css',
  '/static/faza2.css',
  '/static/fonts.css',
  '/static/theme.js',
  '/static/pwa.js',
  '/static/push.js',
  '/static/logo.svg',
  '/static/favicon.svg',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/fonts/Inter-400.ro.woff2',
  '/static/fonts/Inter-700.ro.woff2',
  '/static/fonts/PlayfairDisplay-800.ro.woff2',
];

/* Cheia de cache: URL-ul intreg. Un activ versionat (`?v=`) e alt fisier la alt hash. */
function cheie(request) {
  return new URL(request.url).href;
}

function eNavigare(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

async function puneIn(cacheNume, url, raspuns) {
  if (!raspuns || !raspuns.ok) return false;
  try {
    const cache = await caches.open(cacheNume);
    await cache.put(url, raspuns.clone());
    return true;
  } catch {
    return false;   // cota depasita sau mod privat: citirea offline nu e un drept, e un plus
  }
}

/* Taierea celui mai vechi articol. Cheile vin in ordinea insertiei, asa ca primele sunt
   cele mai vechi — nu exista `lastUsed` in Cache API. */
async function taieArticole() {
  const cache = await caches.open(ARTICOLE);
  const chei = await cache.keys();
  for (let i = 0; i < chei.length - MAX_ARTICOLE; i++) {
    await cache.delete(chei[i]);
  }
}

async function reimprospateaza(request, cacheNume) {
  try {
    const raspuns = await fetch(request);
    if (raspuns && raspuns.ok) {
      await puneIn(cacheNume, cheie(request), raspuns);
      if (cacheNume === ARTICOLE) await taieArticole();
    }
    return raspuns;
  } catch {
    return null;   // offline: cel care asteapta raspunsul cade pe ce e in cache
  }
}

async function staleWhileRevalidate(request, cacheNume, event) {
  const cache = await caches.open(cacheNume);
  const gasit = await cache.match(cheie(request));
  const promisiune = reimprospateaza(request, cacheNume);
  // Reimprospatarea trebuie LEGATA de eveniment, nu lasata in aer: fara `waitUntil`,
  // browserul poate opri service workerul imediat dupa ce a primit raspunsul din cache,
  // iar „stale-while-revalidate" devine doar „stale" — cache-ul nu se mai actualizeaza
  // niciodata si cititorul vede mereu varianta veche.
  if (event && event.waitUntil) event.waitUntil(promisiune);
  if (gasit) return gasit;
  const viu = await promisiune;
  if (viu) return viu;
  const ofl = await caches.match(OFFLINE);
  return ofl || new Response('Fără conexiune și fără copie salvată.', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/* Activ versionat: continutul de la un `?v=` dat nu se schimba niciodata (hash de continut,
   `render._asset_ver`), deci copia EXACTA din cache e mereu corecta, iar lipsa ei inseamna
   un deploy nou — care se ia din retea, nu se ghiceste din cache. */
async function activVersionat(request) {
  const cache = await caches.open(SHELL);
  const exact = await cache.match(request.url);
  if (exact) return exact;
  try {
    const raspuns = await fetch(request);
    if (raspuns && raspuns.ok) {
      const url = new URL(request.url);
      await puneIn(SHELL, url.href, raspuns);
      // Cel mult DOUA copii per fisier (cea noua + cea dinainte), altfel fiecare deploy ar
      // lasa inca un styles.css in telefon. A doua ramane pentru o pagina salvata offline
      // care inca cere hash-ul vechi. Cheile vin in ordinea insertiei: primele sunt vechi.
      const aceleasi = (await cache.keys()).filter((k) => new URL(k.url).pathname === url.pathname);
      for (const k of aceleasi.slice(0, Math.max(0, aceleasi.length - 2))) await cache.delete(k);
      return raspuns;
    }
    if (raspuns) return raspuns;
  } catch { /* offline: cadem pe orice versiune a fisierului */ }
  // `match` ar da PRIMA copie (cea mai veche); vrem ultima pusa.
  const toate = await cache.matchAll(request, { ignoreSearch: true });
  return toate[toate.length - 1] || new Response('', { status: 504 });
}

/* Pagini: reteaua castiga daca raspunde in TERMEN_RETEA; altfel copia salvata, iar
   raspunsul care vine mai tarziu tot ajunge in cache (`waitUntil`). */
async function copieCuAvertisment(raspuns) {
  if (!(raspuns.headers.get('content-type') || '').includes('text/html')) return raspuns;
  const text = await raspuns.text();
  const avertisment = '<aside role="status" class="trust-label">Copie salvată: actualitatea și eventualele corecții nu pot fi verificate. Reconectează-te pentru versiunea curentă.</aside>';
  const headers = new Headers(raspuns.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('X-IZZ-Cached-Copy', 'unverified');
  return new Response(text.replace(/(<body\b[^>]*>)/i, '$1' + avertisment),
    { status: raspuns.status, statusText: raspuns.statusText, headers });
}

async function reteaIntai(request, cacheNume, event) {
  const promisiune = reimprospateaza(request, cacheNume);
  if (event && event.waitUntil) event.waitUntil(promisiune);
  const termen = new Promise((rezolva) => setTimeout(() => rezolva(undefined), TERMEN_RETEA));
  const primul = await Promise.race([promisiune, termen]);
  if (primul) return primul;
  const cache = await caches.open(cacheNume);
  const gasit = await cache.match(cheie(request));
  if (gasit) return copieCuAvertisment(gasit);
  const viu = await promisiune;   // nici copie, nici retea in termen: asteptam reteaua
  if (viu) return viu;
  const ofl = await caches.match(OFFLINE);
  return ofl || new Response('Fără conexiune și fără copie salvată.', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Cate una, nu `addAll`: un singur fisier lipsa (ex. un font redenumit) ar face sa pice
    // TOATA instalarea, deci vizitatorul n-ar avea deloc service worker.
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const raspuns = await fetch(new Request(url, { cache: 'reload' }));
        if (raspuns && raspuns.ok) await cache.put(cheie(new Request(url)), raspuns);
      } catch { /* offline la prima vizita: shellul se umple la urmatoarea */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const pastrate = new Set([SHELL, ARTICOLE]);
    const nume = await caches.keys();
    await Promise.all(nume.filter((n) => !pastrate.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/push/')) return;
  if (url.pathname.startsWith('/editorial-') && url.pathname.endsWith('.json')) return;
  if (url.pathname.startsWith('/static/harta-stiri/data/')) return;

  if (url.pathname.startsWith('/static/')) {
    // Versionat -> URL exact; nevesionat (fonturi, iconite: nume stabile) -> din cache,
    // reimprospatat in fundal.
    event.respondWith(url.searchParams.has('v')
      ? activVersionat(request)
      : staleWhileRevalidate(request, SHELL, event));
    return;
  }
  if (eNavigare(request)) {
    // Prima pagina sta in cache-ul de shell (e precache-uita); restul paginilor, in cel de
    // articole, care e plafonat si se taie.
    event.respondWith(reteaIntai(request, url.pathname === '/' ? SHELL : ARTICOLE, event));
  }
});

/* Precache la cerere: pagina trimite linkurile articolelor din prima pagina, când e online
   si pe o conexiune care nu e economisita. Fara asta, „citire offline" ar insemna doar
   articolele deja deschise — adica zero pentru cine instaleaza aplicatia si pleaca. */
self.addEventListener('message', (event) => {
  const date = event.data || {};
  if (date.tip !== 'precache' || !Array.isArray(date.urluri)) return;
  event.waitUntil((async () => {
    for (const url of date.urluri.slice(0, MAX_ARTICOLE)) {
      const absolut = new URL(url, self.location.origin);
      if (absolut.origin !== self.location.origin) continue;
      const cache = await caches.open(ARTICOLE);
      if (await cache.match(absolut.href)) continue;
      await reimprospateaza(new Request(absolut.href), ARTICOLE);
    }
  })());
});

/* --- alerte ------------------------------------------------------------------ */

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let date;
  try {
    date = event.data.json();
  } catch {
    date = { titlu: 'IZZ.ro', text: event.data.text(), url: '/' };
  }
  // Nicio alerta fara titlu si fara destinatie: un push gol e zgomot pur, iar zgomotul e
  // exact ce promite site-ul ca nu face.
  if (!date || !date.titlu || !date.url) return;
  event.waitUntil(self.registration.showNotification(date.titlu, {
    body: date.text || '',
    tag: date.tag || 'ultima-ora',
    lang: 'ro',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    data: { url: date.url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const tinta = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const ferestre = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const f of ferestre) {
      if (f.url === new URL(tinta, self.location.origin).href && 'focus' in f) return f.focus();
    }
    // O alerta deschide ARTICOLUL, nu prima pagina: cine a dat click vrea stirea, nu
    // navigarea pana la ea.
    if (self.clients.openWindow) await self.clients.openWindow(tinta);
  })());
});
