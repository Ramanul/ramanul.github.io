/* Service worker IZZ.ro — citire offline si alerte.
   Publicat la RADACINA (/sw.js), nu in /static/: un service worker nu poate controla decat
   propriul director si subdirectoarele lui, deci unul livrat de la /static/sw.js ar vedea
   doar /static/ si nicio pagina de articol.

   STRATEGII, si de ce una nu ajunge:
     · shellul (prima pagina, pagina de offline, CSS-urile, fonturile, iconitele) se
       PRECACHEAZA la instalare — fara asta, prima deschidere fara net arata o eroare de
       browser in loc de site;
     · articolele si restul paginilor merg pe stale-while-revalidate: se raspunde din cache
       imediat si se reimprospateaza in fundal. Un ziar se citeste si in metrou; a astepta
       reteaua inseamna a afisa „pagina nu poate fi incarcata" exact cand cititorul are
       continutul deja pe telefon.
     · /static/* e servit cu cheia FARA query: activele poarta ?v=<hash> ca sa sparga
       cache-ul de 30 de zile, iar altfel fiecare deploy ar lasa o copie noua in cache.

   CE NU INTERCEPTEAZA, deliberat:
     · orice altceva decat GET;
     · domenii straine (n-avem ce cache-ui, si am deveni o problema de confidentialitate);
     · /push/* — abonarea e o operatiune, nu un document;
     · /build.json, /feed.xml, sitemapuri: sunt date vii, citite de unelte, si un raspuns
       servit din cache ar minti despre versiunea publicata.

   LIMITA ASUMATA: cache-ul de articole e plafonat la MAX_ARTICOLE intrari, taiate de la cea
   mai veche. Nu e o arhiva: e „ce ai mai citit". Articolele expirate din fereastra TTL nu
   sunt recuperate aici — pentru ele exista fallback-ul de oglinda din infra/worker-404-mirror.js.
*/

const SHELL = 'izz-shell-v1';
const ARTICOLE = 'izz-articole-v1';
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

/* Cheia de cache: fara `?v=` pentru active, cu tot restul pentru pagini. */
function cheie(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/static/')) return url.origin + url.pathname;
  return url.href;
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

  if (url.pathname.startsWith('/static/')) {
    event.respondWith(staleWhileRevalidate(request, SHELL, event));
    return;
  }
  if (eNavigare(request)) {
    // Prima pagina sta in cache-ul de shell (e precache-uita); restul paginilor, in cel de
    // articole, care e plafonat si se taie.
    event.respondWith(staleWhileRevalidate(request, url.pathname === '/' ? SHELL : ARTICOLE, event));
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
