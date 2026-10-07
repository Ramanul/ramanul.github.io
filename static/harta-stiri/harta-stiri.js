(() => {
  "use strict";

  const DATA_URL = "/static/harta-stiri/data/map.json";
  const PROJECTION_URL = "/static/harta-stiri/data/projection.json";
  const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
  const state = {
    map: null,
    data: null,
    projection: null,
    basemap: null,
    basemapContainer: null,
    basemapMath: null,
    basemapProjection: null,
    basemapReady: false,
    basemapStarted: false,
    basemapLoadTimer: null,
    basemapSize: null,
    basemapCamera: null,
    basemapStatus: "idle",
    counties: {},
    etichete: {},
    articles: [],
    rawVisible: [],
    visible: [],
    viewMode: "events",
    listLimit: 120,
    selectedRegion: null,
    selectedCounty: null,
    selectedLocality: null,
    zoomCounty: null,
    level: "all",
    search: "",
    stage: null,
    svg: null,
    view: null,
    layers: null,
    clipPath: null,
    anchors: new Map(),
    // F3: modul de scara. `populatii` se incarca LENEȘTE, doar daca cititorul cere ratele
    // (zero cereri in plus pentru vizualizarea implicita).
    scaleMode: "volum",
    populatii: null,
    populatiiPromise: null,
    localityMarkers: new Map(),
    countyTargets: new Map(),
    uatNodes: new Map(),
    labelPool: new Map(),
    counts: new Map(),
    pointerDown: null,
    panFrom: null,
    uatCounty: null,
    uats: [],
    uatLoading: false,
    uatRequestId: 0,
    uatCache: new Map(),
    // Silueta judetului derivata din UAT-urile lui. Vezi buildCountyOutline().
    hoverUat: null,
    // Județul de sub cursor la nivel național: același contract „hover = previzualizare"
    // ca la UAT-uri (audit harta, P1) -- până acum doar UAT-urile spuneau numele înainte
    // de click, deși suprafața de județ e ținta cea mai des atinsă.
    hoverCounty: null,
    // Zoom-ul GEOMETRIC (utilizator): k=1 = vederea de bază, k>1 mărește în interiorul ei.
    // Nu e stare de adresă -- e fereastră de citire, nu filtru -- și se resetează când se
    // schimbă contextul geografic (vezi applyState).
    userZoom: { k: 1, cx: null, cy: null },
    baseView: null,
    // Asignarea item-UAT e invariantă la zoom/pan: se recalculează doar când se schimbă
    // datele. Fara garda asta, fiecare frame de pan ar renumara sute de poligoane.
    uatCountsDirty: true,
    // UAT-ul selectat, ca orice alt filtru (audit harta, P0: click = selectare, nu fereastra
    // separata): cheia lui (cod SIRUTA sau nume) traieste in adresa (?judet=X&uat=Y), Back/
    // Forward il anuleaza/restabileste, iar panoul lateral arata stirile lui. `pendingUat`
    // tine intentia pana cand asignarea geometrica e posibila (UAT-urile judetului incarcate
    // + UAT-urile incarcate) -- pana atunci panoul primeste mesajul de incarcare, nu o lista
    // inselatoare.
    selectedUat: null,
    pendingUat: null,
    // Fly-to: în timpul animației de apropiere, vederea e dictată de interpolare
    // (flyView), nu de stare. flyToken anulează animația anterioară când pornește alta.
    flyView: null,
    flyToken: 0,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const norm = (value) => (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

  // Numele de judet PENTRU AFISARE. Cheile din date si din adresa sunt coduri (TIMIS,
  // BISTRITA-NASAUD), dar omul citeste „Timiș", „Bistrița-Năsăud" — pana acum selectorul,
  // firul de navigare si tooltipul tipareau codul brut. Tabelul sta in index.html
  // (`generator.geo.eticheta_judet` e sursa lui, iar tests/test_harta_etichete.py apara
  // egalitatea), deci URL-urile si datele raman pe coduri, iar interfata vorbeste romana.
  function judetLabel(code) {
    return (code && state.etichete && state.etichete[code]) || code || "";
  }

  function slugSegment(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function countyRoute(county) {
    const slug = slugSegment(judetLabel(county));
    return slug ? `/harta/${slug}/` : "/harta/";
  }

  function openCountyRoute(county) {
    if (!county) return;
    window.location.assign(countyRoute(county));
  }

  function articleUrl(article) {
    return `../../${encodeURIComponent(article.category)}/${encodeURIComponent(article.slug)}/`;
  }

  function dateLabel(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ro-RO", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    }).format(date);
  }

  function matchesPlace(item, query) {
    return norm(`${item.county} ${item.locality}`).includes(query);
  }

  function matchesText(item, query) {
    return norm(`${item.title} ${item.source}`).includes(query);
  }

  // Al treilea predicat, separat: potrivirea pe numele SURSEI. Meta randului afisat arata
  // sursa, deci o potrivire pe sursa e "vizibila in rand" la fel ca locul -- sortarea o
  // trateaza ca pe locul, nu ca pe o potrivire doar de titlu (vezi filtered).
  function matchesSource(item, query) {
    return norm(item.source_name || item.source || "").includes(query);
  }

  // Nivelurile sunt CUMULATIVE, nu trei cutii separate: "Regional" arata tot ce se afla in
  // regiune, nu doar stirile care pomenesc exclusiv regiunea. Egalitatea stricta de dinainte
  // filtra de fapt RUBRICA editoriala a articolului (/local/, /judetean/, /regional/), care
  // poarta acelasi nume ca nivelul geografic dar nu promite acelasi lucru. Consecinta se vedea
  // pe harta, masurat pe map.json v4 (488 de articole): doar 4 aveau geo_level "regional", deci
  // 5 din 7 regiuni apareau goale -- Muntenia arata 0 cu 78 de stiri in ea, Oltenia arata 2 din
  // 25. Un selector care se numeste "nivel geografic" promite continere, nu rubrici.
  const LEVEL_RANK = { regional: 1, judetean: 2, local: 3 };

  function matchesLevel(item, level) {
    if (level === "all") return true;
    const wanted = LEVEL_RANK[level];
    if (!wanted) return true;
    const own = LEVEL_RANK[item.geo_level || item.category];
    // Rubricile fara nivel geografic (extern, politic, sport) n-au rank: raman in afara
    // oricarui nivel, exact ca inainte. Se vad doar in "Toate".
    if (!own) return false;
    return own >= wanted;
  }

  // `ignorePlace` sare peste filtrele de judet/localitate, pastrand nivelul si cautarea. E
  // folosit de selectorul de judete: construit din `state.visible`, dupa o selectie ar ramane
  // cu un singur buton -- cel al judetului curent -- si cine navigheaza din tastatura n-ar mai
  // avea cum sa treaca la alt judet. Acelasi mod de esec ca harta "blocata" pe judet raportata
  // pe 12 aug, pe alta cale (masurat: 38 de butoane -> 1).
  function filtered(options = {}) {
    const query = norm(state.search);
    const base = state.articles.filter((item) => {
      if (!matchesLevel(item, state.level)) return false;
      if (!options.ignorePlace && state.selectedRegion && item.region !== state.selectedRegion) return false;
      if (!options.ignorePlace && state.selectedCounty && item.county !== state.selectedCounty) return false;
      if (!options.ignorePlace && state.selectedLocality) {
        const localities = Array.isArray(state.selectedLocality) ? state.selectedLocality : [state.selectedLocality];
        const itemNorm = norm(item.locality);
        if (!localities.some((loc) => norm(loc) === itemNorm)) return false;
      }
      if (!query) return true;
      return matchesPlace(item, query) || matchesText(item, query);
    });
    if (!query) return base;
    // Sortare stabila: potrivirile care se VAD in rand (loc sau sursa -- meta randului
    // afiseaza amandoua) urca primele, apoi cele care intra doar prin titlu; ordinea
    // originala se pastreaza in fiecare grup. Un articol de la "Gazeta de Cluj" e citit
    // de utilizator ca potrivire de Cluj chiar daca county/locality spun altceva, deci
    // nu are ce cauta printre potrivirile de titlu. Nimeni nu pierde rezultate.
    const visibleMatch = (item) => matchesPlace(item, query) || matchesSource(item, query);
    return [...base].sort((a, b) => Number(visibleMatch(b)) - Number(visibleMatch(a)));
  }

  function itemsForView(items) {
    if (state.viewMode === "articles") return items;
    const events = new Map();
    for (const item of items) {
      const key = item.event_id || `${item.slug || item.title}|${item.county}|${item.published}`;
      const group = events.get(key) || [];
      group.push(item);
      events.set(key, group);
    }
    return Array.from(events.values()).map((members) => {
      const primary = members[0];
      // Contorul de surse uneste sursa fiecarui articol CU lista `sources` pastrata de
      // dedup-ul editorial (relatarile identice se unesc inainte de publicare — fara
      // lista, un eveniment acoperit de 3 surse reale ar afisa „1 sursă").
      const sources = new Set();
      for (const member of members) {
        const own = member.source_name || member.source;
        if (own) sources.add(own);
        for (const s of member.sources || []) if (s && s.name) sources.add(s.name);
      }
      return {
        ...primary,
        eventArticleCount: members.length,
        eventSourceCount: sources.size,
      };
    });
  }


  // --- substratul de desenare: SVG/DOM, fara canvas ----------------------------------------
  // De ce s-a schimbat (masurat pe starea dinainte, cifre in notes/harta-revolutie-proposal):
  //   * hit-testul era scris de mana (isPointInPath/isPointInStroke pe Path2D, doua spatii de
  //     coordonate, tolerante CSS->viewBox) si a costat doua runde de defecte (IZZ-0193/0194).
  //     In DOM hit-testul E al browserului: cine a fost atins o spune `event.target`.
  //   * asezarea pastilelor rula ~80.000 de interogari point-in-polygon per redraw (masurat
  //     pe TIMIS: 11 UAT-uri cu stiri x 122 candidati x 16 raze, nimic cache-uit); acum ancora
  //     vine din date (`center`, calculat la build) si se valideaza O SINGURA DATA per UAT.
  //   * textul era desenat in unitati viewBox, deci pe telefon ajungea la 2,9-4 px; acum
  //     fiecare eticheta sta intr-un grup contrascarat, deci are marime de ecran la orice zoom
  //     (si e text adevarat: selectabil, cautabil cu Ctrl+F, citit de cititoarele de ecran).
  //   * liniile folosesc `vector-effect: non-scaling-stroke` -> 1 px pe ecran la orice zoom.
  //   * fiecare județ are cale focusabilă (`tabindex`, `role="link"`) și țintă tactilă
  //     de minimum 24px, deci angajarea nu depinde de precizia pe poligon.
  // Ce s-a STERS odata cu canvasul: ensureCanvas, applyViewTransform, devicePointFromMap,
  // devicePointForEvent, pointForEvent, countyFillAtPoint, countyEdgeAtPoint, smallestUatAt,
  // uatContainsMapPoint, uatBadgePlacement, closestHit, hitDistance, path2d-ul re-parsat la
  // fiecare cadru si toata prefetch-ul de siluete ale vecinilor (inlocuit de clip-path).

  const SVG_NS = "http://www.w3.org/2000/svg";
  // Contractul de realitate (§5.1): niciun text nu coboara sub 11 px pe ecran.
  const LABEL_PX = { judet: 13, regiune: 14, uat: 11, cifra: 12 };

  function svgNode(name, attrs = {}) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function stageRect() {
    const rect = state.stage ? state.stage.getBoundingClientRect() : null;
    // jsdom nu calculeaza layout: fara latime reala se presupune latimea de referinta a
    // hartii pe desktop, ca testele de structura sa poata rula fara browser.
    const width = rect && rect.width > 0 ? rect.width : 820;
    const height = rect && rect.height > 0 ? rect.height : width * 0.7;
    return { width, height };
  }

  // Pixeli de ecran per unitate de viewBox, pentru vederea curenta (xMidYMid meet).
  function screenScale(view) {
    const rect = stageRect();
    return Math.min(rect.width / view.width, rect.height / view.height);
  }

  function screenPoint(view, x, y) {
    const rect = stageRect();
    const s = screenScale(view);
    return {
      x: rect.width / 2 + (x - (view.x + view.width / 2)) * s,
      y: rect.height / 2 + (y - (view.y + view.height / 2)) * s,
      s,
    };
  }

  function mapPointFromEvent(event) {
    const view = state.view;
    const top = worldBox();
    if (!view || !top) return null;
    const s = Math.min(top.width / view.width, top.height / view.height);
    if (!s) return null;
    return {
      x: view.x + (event.clientX - top.left - top.width / 2) / s + view.width / 2,
      y: view.y + (event.clientY - top.top - top.height / 2) / s + view.height / 2,
    };
  }

  function worldBox() {
    const stage = state.stage;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return rect;
  }

  function setBasemapStatus(status) {
    state.basemapStatus = status;
    const host = $("#map");
    if (host) host.dataset.basemapStatus = status;
    if (state.stage) state.stage.classList.toggle("has-basemap", status === "ready");
    const message = $("#map-basemap-status");
    if (message) {
      message.hidden = status !== "unavailable";
      if (status === "unavailable") {
        message.textContent = "Basemapul OpenFreeMap nu este disponibil acum; harta tematică și filtrele rămân active.";
      }
    }
  }

  function projectionForView() {
    if (!state.basemapMath) return null;
    return state.basemapMath.projectionForMap(state.projection, state.map?.viewbox);
  }

  function basemapViewportBox(view) {
    const stage = state.stage;
    if (!stage || !view || !view.width || !view.height) return null;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scale = Math.min(rect.width / view.width, rect.height / view.height);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const width = view.width * scale;
    const height = view.height * scale;
    return {
      left: (rect.width - width) / 2,
      top: (rect.height - height) / 2,
      width,
      height,
    };
  }

  function positionBasemapViewport(box) {
    const viewport = state.basemapContainer?.parentElement;
    if (!viewport || !box) return false;
    viewport.style.left = `${box.left}px`;
    viewport.style.top = `${box.top}px`;
    viewport.style.right = "auto";
    viewport.style.bottom = "auto";
    viewport.style.width = `${box.width}px`;
    viewport.style.height = `${box.height}px`;
    return true;
  }

  function syncBasemapToView(view) {
    const container = state.basemapContainer;
    const stage = state.stage;
    const map = state.basemap;
    if (!container || !stage || !view || !state.basemapMath) return;
    const box = basemapViewportBox(view);
    if (!box || !positionBasemapViewport(box)) return;

    const projection = state.basemapProjection || projectionForView();
    const camera = state.basemapMath.cameraForView(view, projection, box.width);
    if (!camera) {
      if (state.basemapReady) failBasemap(new Error("Vederea SVG nu poate fi sincronizată cu proiecția geografică."));
      return;
    }
    container.style.transform = `scaleY(${camera.scaleY})`;
    container.style.visibility = state.basemapReady ? "visible" : "hidden";
    if (!map || !state.basemapReady) return;

    const sizeKey = `${Math.round(box.width)}x${Math.round(box.height)}`;
    try {
      if (state.basemapSize !== sizeKey) {
        state.basemapSize = sizeKey;
        map.resize();
        state.basemapCamera = null;
      }
      const [lon, lat] = camera.center;
      const previous = state.basemapCamera;
      if (!previous || Math.abs(previous.lon - lon) > 0.00001
          || Math.abs(previous.lat - lat) > 0.00001
          || Math.abs(previous.zoom - camera.zoom) > 0.0001) {
        map.jumpTo({ center: camera.center, zoom: camera.zoom, bearing: 0, pitch: 0 });
        state.basemapCamera = { lon, lat, zoom: camera.zoom };
      }
    } catch (error) {
      failBasemap(error);
    }
  }

  function failBasemap(error) {
    if (state.basemapStatus === "unavailable") return;
    if (state.basemapLoadTimer) window.clearTimeout(state.basemapLoadTimer);
    state.basemapLoadTimer = null;
    state.basemapReady = false;
    if (state.basemapContainer) state.basemapContainer.style.visibility = "hidden";
    const map = state.basemap;
    state.basemap = null;
    state.basemapCamera = null;
    if (map) {
      try { map.remove(); } catch { /* SVG-ul rămâne fallback-ul funcțional */ }
    }
    console.warn("Basemap OpenFreeMap indisponibil; folosesc harta SVG fără fundal.", error || "");
    setBasemapStatus("unavailable");
  }

  function startBasemap() {
    if (state.basemapStarted) return;
    state.basemapStarted = true;
    const container = state.basemapContainer;
    setBasemapStatus("loading");
    if (!container || !container.isConnected) {
      failBasemap(new Error("Containerul basemapului nu este în pagină."));
      return;
    }
    if (!state.projection) {
      failBasemap(new Error("Metadatele proiecției lipsesc."));
      return;
    }
    if (typeof window.WebGLRenderingContext === "undefined"
        && typeof window.WebGL2RenderingContext === "undefined") {
      failBasemap(new Error("WebGL nu este disponibil în acest browser."));
      return;
    }

    state.basemapLoadTimer = window.setTimeout(() => {
      if (!state.basemapReady) failBasemap(new Error("OpenFreeMap nu a încărcat stilul și dalele la timp."));
    }, 15000);

    Promise.all([
      import("./basemap-camera.mjs"),
      import("./vendor/maplibre/maplibre-gl.mjs"),
    ]).then(([math, { Map: MapLibreMap }]) => {
      if (!container.isConnected || state.basemapStatus === "unavailable") return;
      state.basemapMath = math;
      const projection = projectionForView();
      if (!projection) {
        failBasemap(new Error("Proiecția geografică nu corespunde viewBox-ului SVG."));
        return;
      }
      state.basemapProjection = projection;
      const initialBox = basemapViewportBox(state.view);
      if (!initialBox || !positionBasemapViewport(initialBox)) {
        failBasemap(new Error("Viewportul SVG nu are dimensiuni utilizabile pentru basemap."));
        return;
      }
      const initialCamera = math.cameraForView(state.view, projection, initialBox.width);
      if (!initialCamera) {
        failBasemap(new Error("Nu se poate calcula camera basemapului din vederea SVG."));
        return;
      }
      const dark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
      const style = dark ? "https://tiles.openfreemap.org/styles/dark" : BASEMAP_STYLE;
      try {
        const map = new MapLibreMap({
          container,
          style,
          center: initialCamera.center,
          zoom: initialCamera.zoom,
          interactive: false,
          attributionControl: false,
          trackResize: false,
          renderWorldCopies: false,
          maxPitch: 0,
          pitch: 0,
          bearing: 0,
          fadeDuration: 0,
        });
        state.basemap = map;
        const mapCanvas = map.getCanvas();
        mapCanvas.setAttribute("aria-hidden", "true");
        mapCanvas.tabIndex = -1;
        mapCanvas.addEventListener("webglcontextlost", (event) => {
          event.preventDefault();
          failBasemap(new Error("Contextul WebGL a fost pierdut."));
        }, { once: true });
        map.once("load", () => {
          if (state.basemap !== map) return;
          if (state.basemapLoadTimer) window.clearTimeout(state.basemapLoadTimer);
          state.basemapLoadTimer = null;
          state.basemapReady = true;
          state.basemapCamera = null;
          setBasemapStatus("ready");
          syncBasemapToView(state.view);
        });
        map.on("error", (event) => {
          if (state.basemap !== map) return;
          const error = event?.error || new Error("MapLibre a raportat o eroare.");
          const message = String(error.message || error);
          const status = Number(error.status || error.statusCode || 0);
          if (!state.basemapReady || status >= 400
              || /webgl|context lost|worker|failed to initialize|failed to load|failed to fetch|network|timeout/i.test(message)) {
            failBasemap(error);
          }
        });
      } catch (error) {
        failBasemap(error);
      }
    }).catch(failBasemap);
  }

  function ensureStage() {
    const host = $("#map");
    if (!host) return null;
    if (state.stage && host.contains(state.stage)) return state.stage;
    host.replaceChildren();

    const stage = document.createElement("div");
    stage.className = "map-stage";
    const basemapViewport = document.createElement("div");
    basemapViewport.className = "map-basemap-viewport";
    basemapViewport.setAttribute("aria-hidden", "true");
    const basemapContainer = document.createElement("div");
    basemapContainer.className = "map-basemap";
    basemapContainer.style.visibility = "hidden";
    basemapViewport.appendChild(basemapContainer);
    stage.appendChild(basemapViewport);
    const svg = svgNode("svg", {
      class: "map-svg",
      role: "group",
      "aria-label": "Harta României cu știri pe județe și localități",
      preserveAspectRatio: "xMidYMid meet",
    });
    const defs = svgNode("defs");
    const clip = svgNode("clipPath", { id: "clip-judet" });
    // Silueta județului deschis: un singur <path> in <defs>, folosit de doua ori -- ca
    // zona de taiere a UAT-urilor si ca linie de contur desenata deasupra lor. Inainte
    // conturul venea din siluetele vecinilor aduse separat (si nu se potrivea niciodata).
    const clipPath = svgNode("path", { id: "clip-judet-silueta", d: "" });
    clip.appendChild(svgNode("use", { href: "#clip-judet-silueta" }));
    // Silueta sta in <defs> (nu e desenata de doua ori), dar TREBUIE adaugata in arbore:
    // o referinta catre un id inexistent nu clipeste nimic, adica taie toate UAT-urile din
    // vedere (prins de verificarea de DOM, nu de ochi -- jsdom, 2026-10-04).
    defs.appendChild(clipPath);
    defs.appendChild(clip);
    svg.appendChild(defs);

    const layers = {};
    // Ordinea conteaza: conturul județului deschis sta INTRE UAT-uri si puncte, ca sa nu fie
    // nici tăiat de clip (jumatate din grosime s-ar pierde), nici sters cand stratul de UAT-uri
    // e golit la revenirea la nivel national (prins de verificarea de DOM, 2026-10-04).
    for (const name of ["counties", "targets", "uats", "outline", "points", "labels"]) {
      layers[name] = svgNode("g", { class: `layer layer-${name}` });
      svg.appendChild(layers[name]);
    }
    // UAT-urile se deseneaza TAiate pe silueta județului deschis: asa nu mai apare canalul
    // dintre conturul oficial (geo-spatial.org) si cel generalizat (Natural Earth), iar
    // siluetele vecinilor nu mai trebuie aduse deloc (inainte: pana la 16 fisiere per click).
    layers.uats.setAttribute("clip-path", "url(#clip-judet)");
    // Conturul siluetei: strat propriu, desenat peste UAT-uri, cu pointer-events:none
    // (nu fura click-urile de pe UAT-uri) si vizibil doar cat timp un județ e deschis.
    layers.outline.appendChild(svgNode("use", { class: "map-outline", href: "#clip-judet-silueta" }));
    stage.appendChild(svg);
    state.basemapContainer = basemapContainer;

    const tip = document.createElement("div");
    tip.className = "map-tip";
    tip.hidden = true;
    tip.setAttribute("role", "status");
    tip.setAttribute("aria-live", "polite");
    stage.appendChild(tip);

    const zoomBox = document.createElement("div");
    zoomBox.className = "map-zoom";
    zoomBox.setAttribute("role", "group");
    zoomBox.setAttribute("aria-label", "Controale de zoom și deplasare ale hărții");
    const zin = document.createElement("button");
    zin.type = "button";
    zin.textContent = "+";
    zin.setAttribute("aria-label", "Apropie harta");
    zin.addEventListener("click", () => { zoomTo(state.userZoom.k * ZOOM_STEP, null); announceZoom(); });
    const zout = document.createElement("button");
    zout.type = "button";
    zout.textContent = "−";
    zout.setAttribute("aria-label", "Îndepărtează harta");
    zout.addEventListener("click", () => { zoomTo(state.userZoom.k / ZOOM_STEP, null); announceZoom(); });
    const zreset = document.createElement("button");
    zreset.type = "button";
    zreset.textContent = "×";
    zreset.setAttribute("aria-label", "Resetează zoom-ul hărții");
    zreset.hidden = true;
    zreset.addEventListener("click", () => { zoomTo(ZOOM_MIN, null); announceZoom(); });
    // Zoom si pan si din TASTATURA: sagețile deplaseaza vederea cand harta e marita, +/-
    // schimba scara. Fara asta, un utilizator de tastatura poate mari dar nu se poate misca.
    zoomBox.addEventListener("keydown", (event) => {
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (step && state.view) {
        event.preventDefault();
        const rect = worldBox() || { width: 820, height: 574 };
        const css = 80; // pas de deplasare, in pixeli CSS
        panBy(-step[0] * css * state.view.width / rect.width,
              -step[1] * css * state.view.height / rect.height);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomTo(state.userZoom.k * ZOOM_STEP, null);
        announceZoom();
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomTo(state.userZoom.k / ZOOM_STEP, null);
        announceZoom();
      }
    });
    zoomBox.append(zin, zout, zreset);
    stage.appendChild(zoomBox);

    const back = document.createElement("button");
    back.type = "button";
    back.className = "map-back";
    back.textContent = "← Toate județele";
    back.hidden = true;
    back.addEventListener("click", resetSelection);
    stage.appendChild(back);

    host.appendChild(stage);
    state.stage = stage;
    state.svg = svg;
    state.layers = layers;
    state.clipPath = clipPath;
    state.tip = tip;
    state.zoomIn = zin;
    state.zoomOut = zout;
    state.zoomReset = zreset;
    state.backButton = back;
    state.labelPool = new Map();
    wireStage();
    syncZoomControls();
    return stage;
  }

  // --- interactiunea pe forme (hit-test nativ) ---------------------------------------------
  // Un singur set de ascultatori pe <svg>, delegat: formele se recreeaza la fiecare redesenare,
  // iar ascultatorii per forma ar fi exact tiparul care putrezeste (IZZ-0177).
  function wireStage() {
    const svg = state.svg;
    svg.addEventListener("pointerdown", onStagePointerDown);
    svg.addEventListener("pointermove", onStagePointerMove);
    svg.addEventListener("pointerup", onStagePointerUp);
    svg.addEventListener("pointercancel", onStagePointerCancel);
    svg.addEventListener("pointerleave", clearShapeHover);
    svg.addEventListener("click", onStageClick);
    svg.addEventListener("dblclick", onStageDblClick);
    svg.addEventListener("keydown", onStageKeyDown);
    // Pagina asta E o unealta de harta: rotita actioneaza pe harta, nu deruleaza pagina.
    svg.addEventListener("wheel", (event) => {
      if (!state.view || !state.baseView) return;
      event.preventDefault();
      takeUserView();
      const p = mapPointFromEvent(event);
      zoomTo(state.userZoom.k * Math.exp(-event.deltaY * 0.0016), p);
    }, { passive: false });
    // Escape inchide tooltipul, nimic altceva: hover-ul nu are focus (vine din
    // pointermove), deci prindem la nivel de document. Selectia si URL-ul raman neatinse.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const tip = state.tip;
      if (!tip || tip.hidden) return;
      clearShapeHover();
    });
  }

  function shapeFromEvent(event) {
    const target = event.target;
    const top = target && target.closest ? target.closest("[data-harta]") : null;
    if (!top || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)
      || typeof DOMPoint !== "function") return top;
    const layer = top.parentElement;
    if (!layer) return top;

    const hits = [];
    for (const candidate of layer.children) {
      if (!candidate.hasAttribute("data-harta") || typeof candidate.isPointInFill !== "function") continue;
      try {
        // Cutia de ecran elimina majoritatea formelor inaintea testului geometric exact.
        const rect = candidate.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom) continue;
        const ctm = candidate.getScreenCTM();
        if (!ctm) continue;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
        if (!candidate.isPointInFill(point)) continue;
        const anchorKey = candidate.dataset.judet
          ? `judet:${candidate.dataset.judet}`
          : candidate.dataset.uat ? `uat:${candidate.dataset.uat}` : null;
        const anchor = anchorKey ? anchorFor(candidate, anchorKey, null) : null;
        const bounds = candidate.getBBox();
        const x = anchor ? anchor[0] : bounds.x + bounds.width / 2;
        const y = anchor ? anchor[1] : bounds.y + bounds.height / 2;
        hits.push({
          node: candidate,
          distance: (point.x - x) ** 2 + (point.y - y) ** 2,
          area: bounds.width * bounds.height,
        });
      } catch (err) {
        // O forma fara geometrie utilizabila nu invalideaza hit-testul pentru celelalte.
      }
    }
    if (!hits.length) return top;
    hits.sort((a, b) => {
      const delta = a.distance - b.distance;
      if (Math.abs(delta) > 1e-9) return delta;
      if (a.node === top) return -1;
      if (b.node === top) return 1;
      return a.area - b.area;
    });
    return hits[0].node;
  }

  function shapeKey(node) {
    return node && (node.dataset.uat || node.dataset.localitate || node.dataset.judet || node.dataset.regiune) || null;
  }

  function uatByKey(key) {
    return state.uats.find((unit) => String(unit.id || unit.name) === String(key)) || null;
  }

  function countyCount(county) {
    return state.counts ? (state.counts.get(county) || 0) : 0;
  }

  function regionForCounty(county) {
    const regions = state.map?.regiuni || {};
    return Object.entries(regions).find(([, list]) => list.includes(county))?.[0] || "";
  }

  function hoverTargetFor(node) {
    if (!node) return null;
    if (node.dataset.localitate) {
      const group = state.localityMarkers.get(node.dataset.localitate);
      if (!group) return null;
      return { kind: "locality", label: group.locality, count: group.count, items: group.items };
    }
    if (node.dataset.uat) {
      const uat = uatByKey(node.dataset.uat);
      if (!uat) return null;
      return { kind: "uat", label: uat.label || uat.name, count: uat.count, items: uat.items };
    }
    if (node.dataset.judet) {
      if (state.level === "regional") {
        const region = regionForCounty(node.dataset.judet);
        if (!region) return null;
        return { kind: "region", label: region, region, count: countyCount(node.dataset.judet) };
      }
      return {
        kind: "county",
        county: node.dataset.judet,
        label: judetLabel(node.dataset.judet),
        count: countyCount(node.dataset.judet),
      };
    }
    return null;
  }

  // Hover-ul NU mai redeseneaza harta: comuta clase pe formele atinse. Inainte, fiecare
  // miscare de mouse peste alt județ declansa un buildMap() complet (42 de Path2D re-parsate).
  function markHoverShapes() {
    const layers = state.layers;
    if (!layers) return;
    for (const node of layers.counties.children) {
      node.classList.toggle("is-hover", !state.zoomCounty && node.dataset.judet === state.hoverCounty);
    }
    for (const node of layers.uats.children) {
      node.classList.toggle("is-hover", Boolean(state.hoverUat) && node.dataset.uat === String(state.hoverUat.id || state.hoverUat.name));
    }
  }

  function clearShapeHover() {
    if (state.hoverUat) {
      state.hoverUat = null;
      syncUatHighlight();
    }
    state.hoverCounty = null;
    markHoverShapes();
    showMapTip(null, null);
  }

  function onStagePointerDown(event) {
    state.pointerDown = { x: event.clientX, y: event.clientY, moved: false, pointerId: event.pointerId };
    if (event.pointerType === "mouse" && state.userZoom.k > 1) {
      state.panFrom = { x: event.clientX, y: event.clientY };
      state.stage.classList.add("is-panning");
    }
  }

  function onStagePointerMove(event) {
    // Tap-vs-drag: orice pointer care s-a miscat peste prag nu mai activeaza zona la click.
    // Vechea garda marca `moved` doar pe pan cu mouse-ul; pe telefon o derulare putea ajunge
    // la click-ul sintetic de la final si deschidea județul atins accidental.
    if (state.pointerDown
        && Math.hypot(event.clientX - state.pointerDown.x, event.clientY - state.pointerDown.y) >= 10) {
      state.pointerDown.moved = true;
    }
    // Pan: doar cand harta e marita si un buton e apasat; sub 10 px e in continuare click
    // (acelasi prag ca garda tap-vs-drag de pe telefon).
    if (state.panFrom && (event.buttons & 1)) {
      const top = worldBox();
      if (top) {
        const dx = (event.clientX - state.panFrom.x) * state.view.width / top.width;
        const dy = (event.clientY - state.panFrom.y) * state.view.height / top.height;
        if (Math.hypot(event.clientX - state.pointerDown.x, event.clientY - state.pointerDown.y) >= 10) {
          state.pointerDown.moved = true;
          state.panFrom = { x: event.clientX, y: event.clientY };
          panBy(dx, dy);
          return;
        }
      }
    }
    if (event.pointerType !== "mouse") {
      // Pe touch nu exista hover inainte de atingere: prima atingere spune ea numele.
      if (!state.pointerDown) return;
      if (state.pointerDown.moved) return;
    }
    const node = shapeFromEvent(event);
    const target = hoverTargetFor(node);
    if (state.zoomCounty) {
      const uat = target && target.kind === "uat" ? uatByKey(node.dataset.uat) : null;
      if (uat !== state.hoverUat) {
        state.hoverUat = uat;
        syncUatHighlight();
        markHoverShapes();
      }
    } else {
      const county = node && node.dataset.judet ? node.dataset.judet : null;
      if (county !== state.hoverCounty) {
        state.hoverCounty = county;
        markHoverShapes();
      }
    }
    showMapTip(target, event);
  }

  function onStagePointerUp() {
    state.panFrom = null;
    if (state.stage) state.stage.classList.remove("is-panning");
    // `click` se emite dupa pointerup; pastram pointerDown pana acolo ca pragul moved sa
    // poata anula navigarea dupa un swipe. Urmatorul pointerdown il inlocuieste oricum.
  }

  function onStagePointerCancel() {
    state.panFrom = null;
    state.pointerDown = null;
    if (state.stage) state.stage.classList.remove("is-panning");
  }

  function activateShape(node) {
    if (!node) return;
    if (node.dataset.localitate) {
      const group = state.localityMarkers.get(node.dataset.localitate);
      if (group) applyState({ locality: group.localities || [group.locality] });
      return;
    }
    if (node.dataset.uat) {
      const key = String(node.dataset.uat);
      applyState({ uat: state.selectedUat === key ? null : key });
      return;
    }
    if (node.dataset.judet) {
      openCountyRoute(node.dataset.judet);
      return;
    }
    if (node.dataset.regiune) selectRegion(node.dataset.regiune);
  }

  function onStageClick(event) {
    if (state.pointerDown && state.pointerDown.moved) {
      state.pointerDown = null;
      return; // a fost pan, nu click
    }
    const node = shapeFromEvent(event);
    state.pointerDown = null;
    activateShape(node);
  }

  function onStageDblClick(event) {
    if (!state.view || !state.baseView) return;
    event.preventDefault();
    takeUserView();
    const p = mapPointFromEvent(event);
    zoomTo(state.userZoom.k * 2, p);
  }

  function onStageKeyDown(event) {
    const node = event.target && event.target.closest ? event.target.closest("[data-harta]") : null;
    if (!node) return;
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      activateShape(node);
    }
  }

  // --- randarea propriu-zisa ----------------------------------------------------------------
  function fmt(value) {
    return Math.round(value * 100) / 100;
  }

  // Enclavele (Bucuresti in inelul Ilfovului) se picteaza DUPA judetul parinte: SVG
  // picteaza in ordinea DOM, iar Ilfov — venit dupa in date — acoperea complet
  // enclavea, care nu mai era nici vizibila, nici accesibila click-ului (hit-testul
  // livreaza mereu parintele). Vezi garda "centrul Bucurestiului" din
  // tools/harta_dom_check.py si planul de remediere D1 (Arena, 6 oct).
  const COUNTIES_DRAW_LAST = ["BUCURESTI"];

  function ensureCountyPaths() {
    const layer = state.layers.counties;
    if (layer.childElementCount === Object.keys(state.counties).length) return;
    layer.replaceChildren();
    const chei = Object.keys(state.counties);
    const ordonate = [
      ...chei.filter((county) => !COUNTIES_DRAW_LAST.includes(county)),
      ...chei.filter((county) => COUNTIES_DRAW_LAST.includes(county)),
    ];
    for (const county of ordonate) {
      const pathData = state.counties[county];
      const node = svgNode("path", {
        class: "map-county h0",
        d: pathData,
        "data-harta": "judet",
        "data-judet": county,
        "data-regiune": regionForCounty(county),
        "data-href": countyRoute(county),
        tabindex: "0",
        role: "link",
      });
      layer.appendChild(node);
    }
  }

  // Ancora unei forme: `center` din date cand e valid, altfel o cautare pe grila mica,
  // calculata O SINGURA DATA per forma si tinuta minte in state.anchors.
  function anchorFor(node, key, fallback) {
    if (state.anchors.has(key)) return state.anchors.get(key);
    let point = fallback;
    const inside = (x, y) => {
      if (typeof node.isPointInFill !== "function") return true;
      try { return node.isPointInFill(new DOMPoint(x, y)); } catch (err) { return true; }
    };
    if (point && !inside(point[0], point[1])) {
      const bounds = pathBounds(node.getAttribute("d") || "");
      if (bounds) {
        const order = [];
        for (let row = 1; row <= 9; row += 1) {
          for (let column = 1; column <= 9; column += 1) {
            order.push({
              x: bounds.minX + (bounds.maxX - bounds.minX) * column / 10,
              y: bounds.minY + (bounds.maxY - bounds.minY) * row / 10,
            });
          }
        }
        const middle = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
        order.sort((a, b) => Math.hypot(a.x - middle.x, a.y - middle.y) - Math.hypot(b.x - middle.x, b.y - middle.y));
        const found = order.find((candidate) => inside(candidate.x, candidate.y));
        if (found) point = [found.x, found.y];
      }
    }
    if (!point) {
      const bounds = pathBounds(node.getAttribute("d") || "");
      point = bounds ? [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2] : [0, 0];
    }
    state.anchors.set(key, point);
    return point;
  }

  // Etichetele: candidati in ordinea prioritatii, apoi respingere la coliziune (dreptunghiuri
  // in spatiul ECRANULUI, nu in unitati de harta: acolo se vede daca se calca).
  function placeLabels(candidates, view) {
    const rect = stageRect();
    const s = screenScale(view);
    const placed = [];
    const out = [];
    for (const candidate of candidates) {
      const point = screenPoint(view, candidate.x, candidate.y);
      // width/height sunt in pixeli de ecran (asa se estimeaza textul), deci nu se scaleaza.
      const offsetY = candidate.offsetY || 0;
      const box = {
        left: point.x - candidate.width / 2, right: point.x + candidate.width / 2,
        top: point.y + offsetY - candidate.height / 2,
        bottom: point.y + offsetY + candidate.height / 2,
      };
      if (box.right < 0 || box.left > rect.width || box.bottom < 0 || box.top > rect.height) continue;
      const collides = placed.some((other) => !(box.right < other.left || box.left > other.right
        || box.bottom < other.top || box.top > other.bottom));
      if (collides) continue;
      placed.push(box);
      out.push(candidate);
    }
    return out;
  }

  function estimateWidth(text, fontSize) {
    return Math.max(14, String(text).length * fontSize * 0.56) + 6;
  }

  function poolLabel(kind, key) {
    const pool = state.labelPool;
    const id = `${kind}:${key}`;
    let entry = pool.get(id);
    if (entry) return entry;
    const group = svgNode("g", { class: `map-label label-${kind}` });
    const fit = svgNode("g", { class: "label-fit" });
    group.appendChild(fit);
    state.layers.labels.appendChild(group);
    entry = { id, kind, key, group, fit, parts: {} };
    pool.set(id, entry);
    return entry;
  }

  function labelText(entry, name, cls, attrs = {}) {
    let node = entry.parts[name];
    if (!node) {
      node = svgNode("text", { class: cls });
      entry.fit.appendChild(node);
      entry.parts[name] = node;
    }
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function labelDisc(entry) {
    let node = entry.parts.disc;
    if (!node) {
      node = svgNode("circle", { class: "label-disc", "aria-hidden": "true" });
      entry.fit.appendChild(node);
      entry.parts.disc = node;
    }
    return node;
  }

  function pruneLabels(used) {
    for (const [id, entry] of state.labelPool) {
      if (used.has(id)) continue;
      entry.group.remove();
      state.labelPool.delete(id);
    }
  }


  // Cardul de previzualizare de sub cursor sau deget: numele zonei + cifra + primele titluri.
  // Traieste in scena (nu in <svg>), deci nu se scaleaza cu harta si poate folosi CSS-ul paginii.
  function showMapTip(target, event) {
    const tip = state.tip;
    const stage = state.stage;
    if (!tip) return;
    if (!target || !event || !stage) {
      tip.hidden = true;
      tip.replaceChildren();
      return;
    }
    const count = target.count || 0;
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "tip-head";
    const name = document.createElement("span");
    name.textContent = target.label || "—";
    head.appendChild(name);
    // Județul e singurul nivel cu populație cunoscuta, deci singurul care isi schimba cifra
    // in modul „pe locuitor"; UAT-urile si localitatile rămân pe numaratoare, iar unitatea
    // din text spune care e care.
    const esteJudet = Boolean(target.county) && !target.kind?.startsWith("uat");
    if (count || (esteJudet && valoareJudet(target.county) != null)) {
      const figure = document.createElement("span");
      figure.className = "tip-count";
      figure.textContent = esteJudet
        ? cifraJudet(target.county).bucata
        : `${count} ${itemLabelFor(count)}`;
      head.appendChild(figure);
    }
    tip.appendChild(head);
    // Previzualizare: primele trei titluri din zona atinsa.
    let titles = [];
    if (Array.isArray(target.items)) titles = target.items.slice(0, 3);
    else if (target.county) titles = state.visible.filter((it) => it.county === target.county).slice(0, 3);
    else if (target.region) titles = state.visible.filter((it) => it.region === target.region).slice(0, 3);
    if (titles.length) {
      const list = document.createElement("ul");
      list.className = "tip-list";
      for (const item of titles) {
        const li = document.createElement("li");
        li.textContent = item.title || "…";
        list.appendChild(li);
      }
      tip.appendChild(list);
      const hint = document.createElement("div");
      hint.className = "tip-hint";
      hint.textContent = target.kind === "county" ? "Click pentru pagina județului" : "Click pentru lista completă";
      tip.appendChild(hint);
    }
    tip.hidden = false;
    const hostRect = stage.getBoundingClientRect();
    const x = event.clientX - hostRect.left;
    const y = event.clientY - hostRect.top;
    const w = tip.offsetWidth || 0;
    const h = tip.offsetHeight || 0;
    const left = Math.max(4, Math.min(hostRect.width - w - 4, x - w / 2));
    // Deasupra punctului atins, ca degetul sa nu acopere exact ce trebuie citit.
    const top = Math.max(4, y - h - 14);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function renderCountyTargets(view) {
    const layer = state.layers.targets;
    if (!layer || !view) return;
    const scale = screenScale(view);
    if (!scale) return;
    const radius = 12 / scale; // 24px diametru în ecran, minimul WCAG 2.5.8.
    const byKey = state.countyTargets || new Map();
    const seen = new Set();
    // În detaliul de județ, UAT-urile sunt țintele active; cercurile naționale ar fura
    // tap-uri de pe orașe/comune. Poligonul rămâne sub ele pentru click pe zonele libere.
    layer.hidden = Boolean(state.zoomCounty && state.uats.length);
    for (const node of state.layers.counties.children) {
      const county = node.dataset.judet;
      seen.add(county);
      const anchor = anchorFor(node, `judet:${county}`, null);
      let hit = byKey.get(county);
      if (!hit) {
        hit = svgNode("circle", {
          class: "map-county-hit",
          "data-harta": "judet",
          "data-judet": county,
          "data-regiune": regionForCounty(county),
          "data-href": countyRoute(county),
          "aria-hidden": "true",
        });
        byKey.set(county, hit);
        layer.appendChild(hit);
      }
      hit.setAttribute("cx", String(fmt(anchor[0])));
      hit.setAttribute("cy", String(fmt(anchor[1])));
      hit.setAttribute("r", String(fmt(radius)));
    }
    for (const [county, node] of byKey) {
      if (seen.has(county)) continue;
      node.remove();
      byKey.delete(county);
    }
    state.countyTargets = byKey;
  }

  function renderLabels(view) {
    const used = new Set();
    const candidates = [];
    const regional = state.level === "regional";

    if (regional) {
      // O eticheta per REGIUNE, la media ancorarilor judetelor ei: numele regiunii nu se
      // repeta de 14 ori, iar prioritatea e volumul regiunii.
      const regions = new Map();
      for (const node of state.layers.counties.children) {
        const region = node.dataset.regiune;
        const count = state.counts.get(region) || 0;
        if (!count) continue;
        const anchor = anchorFor(node, `judet:${node.dataset.judet}`, null);
        const acc = regions.get(region) || { x: 0, y: 0, n: 0, count: 0 };
        acc.x += anchor[0];
        acc.y += anchor[1];
        acc.n += 1;
        acc.count += count;
        regions.set(region, acc);
      }
      for (const [region, acc] of regions) {
        candidates.push({
          kind: "regiune", key: region,
          x: acc.x / acc.n, y: acc.y / acc.n,
          text: region, count: acc.count,
          width: estimateWidth(`${region} ${acc.count}`, LABEL_PX.regiune), height: 20,
          priority: acc.count,
        });
      }
    } else if (!state.zoomCounty || !state.uats.length) {
      for (const node of state.layers.counties.children) {
        const county = node.dataset.judet;
        const count = countyCount(county);
        // Toate judetele primesc eticheta, inclusiv cele cu 0 stiri (cerinta editorului):
        // suprapunerile le rezolva placeLabels pe prioritatea count-ului, nu un prag hard.
        const anchor = anchorFor(node, `judet:${county}`, null);
        const label = judetLabel(county);
        // In modul „pe locuitor" eticheta arata RATA, adica exact numarul care da culoarea.
        const valoare = valoareJudet(county);
        const afisat = valoare == null ? String(count) : fmtValoare(valoare);
        candidates.push({
          kind: "judet", key: county,
          x: anchor[0], y: anchor[1],
          text: label, count: valoare == null ? count : valoare, afisat,
          width: estimateWidth(`${label} ${afisat}`, LABEL_PX.judet), height: 18,
          priority: count,
        });
      }
    }

    if (state.zoomCounty && state.uats.length) {
      for (const uat of state.uats) {
        const key = String(uat.id || uat.name);
        const node = state.uatNodes && state.uatNodes.get(key);
        const anchor = node ? anchorFor(node, `uat:${key}`, uat.center) : uat.center;
        if (!anchor) continue;
        const radius = Math.max(9, Math.min(15, 8 + Math.sqrt(uat.count) * 1.4));
        const name = uat.label || uat.name;
        const nameWidth = estimateWidth(name, LABEL_PX.uat) + 8;
        candidates.push({
          kind: "uat", key,
          x: anchor[0], y: anchor[1],
          text: name, count: uat.count, radius,
          width: Math.max(radius * 2, nameWidth),
          height: radius * 2 + 14,
          offsetY: 7,
          priority: uat.count,
        });
      }
    }

    candidates.sort((a, b) => b.priority - a.priority);
    for (const candidate of placeLabels(candidates, view)) {
      const entry = poolLabel(candidate.kind, candidate.key);
      used.add(entry.id);
      entry.group.setAttribute("transform", `translate(${fmt(candidate.x)} ${fmt(candidate.y)})`);
      entry.fit.setAttribute("transform", `scale(${fmt(1 / screenScale(view))})`);
      if (candidate.kind === "uat") {
        // Pastila inversa (disc alb, cifra inchisa) pentru TOATE UAT-urile: si cele fara stiri
        // arata „0" (cerinta editorului, 7 oct); aglomerarea o taie placeLabels pe prioritate,
        // etichetele de prioritate 0 fiind primele sacrificate la coliziune.
        labelDisc(entry).setAttribute("r", String(fmt(candidate.radius)));
        labelText(entry, "num", "label-count", {
          y: "0", "text-anchor": "middle", "dominant-baseline": "central",
        }).textContent = String(candidate.count);
        labelText(entry, "name", "label-name", {
          y: String(fmt(candidate.radius + 11)),
          "text-anchor": "middle",
        }).textContent = candidate.text;
      } else {
        if (entry.parts.disc) { entry.parts.disc.remove(); delete entry.parts.disc; }
        const text = labelText(entry, "num", candidate.kind === "regiune" ? "label-region" : "label-county", {
          y: "0", "text-anchor": "middle", "dominant-baseline": "central",
        });
        text.textContent = "";
        text.appendChild(document.createTextNode(candidate.text + " "));
        const figure = svgNode("tspan", { class: "label-value" });
        // `afisat` = exact numarul care da si culoarea (rotunjit la ce se scrie); pentru
        // regiuni si pentru UAT-uri rămâne numaratoarea, fiindca acolo nu exista numitor.
        figure.textContent = String(candidate.afisat ?? candidate.count);
        text.appendChild(figure);
      }
    }
    pruneLabels(used);
  }

  function renderLocalityMarkers(view) {
    const layer = state.layers.points;
    layer.replaceChildren();
    const markers = new Map();
    const groups = new Map();
    if (state.zoomCounty && !state.uats.length) {
      for (const item of state.visible) {
        if (item.county !== state.zoomCounty || item.x == null || item.y == null) continue;
        const x = Number(item.x);
        const y = Number(item.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        // Doua inregistrari SIRUTA diferite pot cadea pe acelasi punct: un singur marker
        // vizual, dar TOATE identitatile pastrate, ca un click sa nu aleaga alta localitate.
        const key = `${x.toFixed(4)}|${y.toFixed(4)}`;
        const group = groups.get(key) || {
          x, y, locality: item.locality || item.county, localities: [], items: [], count: 0,
        };
        group.count += 1;
        group.items.push(item);
        const locality = item.locality || item.county;
        if (!group.localities.includes(locality)) group.localities.push(locality);
        groups.set(key, group);
      }
    }
    const scale = 1 / screenScale(view);
    for (const group of groups.values()) {
      const key = group.localities[0];
      const radius = Math.max(6, Math.min(14, 5 + Math.sqrt(group.count) * 1.6));
      const node = svgNode("g", { class: "map-locality", "data-harta": "localitate", "data-localitate": key });
      const fit = svgNode("g", { class: "label-fit", transform: `scale(${fmt(scale)})` });
      fit.appendChild(svgNode("circle", { class: "locality-disc", r: String(fmt(radius)) }));
      const label = svgNode("text", {
        class: "label-count", y: "0", "text-anchor": "middle", "dominant-baseline": "central",
      });
      label.textContent = String(group.count);
      fit.appendChild(label);
      node.appendChild(fit);
      node.setAttribute("transform", `translate(${fmt(group.x)} ${fmt(group.y)})`);
      node.setAttribute("aria-hidden", "true");
      layer.appendChild(node);
      markers.set(key, group);
    }
    state.localityMarkers = markers;
  }

  function renderUats() {
    const layer = state.layers.uats;
    const byKey = state.uatNodes || new Map();
    const seen = new Set();
    for (const uat of state.uats) {
      const key = String(uat.id || uat.name);
      seen.add(key);
      let node = byKey.get(key);
      if (!node) {
        node = svgNode("path", {
          class: "map-uat h0",
          d: uat.path || "",
          "data-harta": "uat",
          "data-uat": key,
          tabindex: "0",
          role: "button",
        });
        byKey.set(key, node);
        layer.appendChild(node);
      }
      const selected = state.selectedUat === key;
      node.classList.toggle("is-selected", selected);
      node.classList.toggle("is-dim", Boolean(state.selectedUat) && !selected);
      node.classList.toggle("is-empty", !uat.count);
      // Scara UAT-urilor e VOLUMUL, indiferent de modul hartii: nu avem populație pe unitati
      // administrativ-teritoriale, iar a aplica pragurile de rate pe numaratoare ar colora
      // 7 știri ca „4+ la 100.000" — o scara care minte (vezi nota din legenda).
      const klassUat = rampClassFor(uat.count, PRAGURI);
      for (let i = 0; i < 5; i += 1) node.classList.toggle(`h${i}`, klassUat === i);
      node.setAttribute("aria-label", `${uat.label || uat.name}: ${uat.count} ${itemLabelFor(uat.count)}`);
      node.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    for (const [key, node] of byKey) {
      if (seen.has(key)) continue;
      node.remove();
      byKey.delete(key);
    }
    state.uatNodes = byKey;
  }

  function renderMap() {
    const host = $("#map");
    if (!host || !state.map) return;
    const stage = ensureStage();
    if (!stage) return;

    const [vx, vy, vw, vh] = baseViewBox();
    const base = selectedView(vx, vy, vw, vh);
    state.baseView = base;
    // În timpul fly-to-ului vederea e dictata de interpolare, nu de stare.
    const view = state.flyView || zoomedView(base);
    state.view = view;
    state.svg.setAttribute("viewBox", `${fmt(view.x)} ${fmt(view.y)} ${fmt(view.width)} ${fmt(view.height)}`);
    // Scena ia raportul de aspect al vederii CURENTE (ca inainte, cand inaltimea canvasului
    // deriva din view): altfel vederea de județ, care are alt raport, ar fi incadrata cu
    // benzi goale in sus si in jos.
    stage.style.setProperty("--map-aspect", `${fmt(view.width)} / ${fmt(view.height)}`);
    if (!state.basemapStarted && state.projection) startBasemap();
    syncBasemapToView(view);
    stage.classList.toggle("is-zoomed", state.userZoom.k > 1);
    stage.classList.toggle("is-regional", state.level === "regional");

    const counts = new Map();
    for (const item of state.visible) {
      const key = state.level === "regional" ? item.region : item.county;
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    state.counts = counts;

    ensureCountyPaths();
    const keepNationalCountyContext = state.level === "judetean" && Boolean(state.selectedCounty);
    for (const node of state.layers.counties.children) {
      const county = node.dataset.judet;
      const region = node.dataset.regiune || regionForCounty(county);
      const count = counts.get(state.level === "regional" ? region : county) || 0;
      const selected = state.selectedCounty === county
        || (state.selectedRegion && state.selectedRegion === region);
      const outside = (state.selectedCounty && county !== state.selectedCounty)
        || (state.selectedRegion && region !== state.selectedRegion);
      const isZoomedCounty = county === state.zoomCounty;
      // La nivel județean cadrul rămâne național: selectarea unui județ nu estompează
      // vecinii. La zoom local, doar UAT-ul activ poate estompa restul formelor.
      const dim = isZoomedCounty ? false
        : state.zoomCounty ? Boolean(state.selectedUat)
        : Boolean(outside && !keepNationalCountyContext);
      node.classList.toggle("is-selected", Boolean(selected));
      node.classList.toggle("is-dim", dim);
      node.classList.toggle("is-empty", count === 0);
      node.classList.toggle("is-hover", !state.zoomCounty && county === state.hoverCounty);
      const cifra = cifraJudet(county);
      const klass = state.level === "regional" || cifra.valoare == null
        ? 0 : rampClassFor(cifra.valoare);
      for (let i = 0; i < 5; i += 1) node.classList.toggle(`h${i}`, state.level === "regional" ? i === 0 : klass === i);
      node.setAttribute("aria-label", `${judetLabel(county)}: ${cifra.bucata}. Deschide pagina județului.`);
      if (selected) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
    }
    renderCountyTargets(view);

    // UAT-urile județului deschis, taiate pe silueta lui (clip-path), fara siluetele vecinilor.
    const showUats = Boolean(state.zoomCounty && state.uats.length);
    state.layers.uats.hidden = !showUats;
    state.layers.outline.hidden = !showUats;
    if (showUats) {
      state.clipPath.setAttribute("d", state.counties[state.zoomCounty] || "");
      renderUats();
      // Numaratoarea are nevoie de noduri (hit-test nativ) si de datele curente; se face o
      // singura data per schimbare de date (uatCountsDirty), nu la fiecare cadru de pan.
      if (state.uatCountsDirty) {
        countUatNews();
        state.uatCountsDirty = false;
      }
      renderUats();
    } else if (state.layers.uats.childElementCount) {
      state.layers.uats.replaceChildren();
      state.uatNodes = new Map();
    }

    // Selectia de UAT devine continut abia cand asignarea geometrica e posibila.
    if (state.pendingUat && state.uats.length && !state.uatLoading) {
      const wanted = state.uats.find((unit) => String(unit.id || unit.name) === state.pendingUat);
      state.pendingUat = null;
      if (wanted) {
        state.visible = state.selectedUat ? itemsForView(wanted.items) : state.visible;
      } else {
        state.selectedUat = null;
      }
    }

    // Legenda: la nivel national/judetean urmeaza modul de scara; cand stratul de UAT-uri e
    // deschis, scara de acolo e VOLUMUL (nu avem populație pe orase si comune in datele
    // publicate), iar titlul o spune.
    const varianta = state.zoomCounty && state.uats.length
      ? "uat"
      : (esteModRata() ? "locuitori" : "volum");
    // Legenda se ascunde doar cand umplerea NU e o scara (nivel regional: culorile spun
    // regiunea editoriala). In interiorul unui județ rămâne vizibila, fiindca acolo se
    // schimba exact ce explica ea: treptele UAT-urilor. (Inainte era ascunsa la zoom, deci
    // cititorul cu un județ deschis nu avea nicio scara pe ecran.)
    updateLegend({ show: state.level !== "regional", variant: varianta });
    updateWindow();
    renderLabels(view);
    renderLocalityMarkers(view);

    if (state.backButton) {
      const hasSelection = Boolean(state.selectedRegion || state.selectedCounty || state.selectedLocality || state.selectedUat);
      state.backButton.hidden = !hasSelection;
      state.backButton.textContent = "← Înapoi la România";
    }
    syncZoomControls();
  }

  function syncUats() {
    const county = state.zoomCounty;
    if (!county) {
      state.uatRequestId += 1;
      state.uatCounty = null;
      state.uats = [];
      state.uatLoading = false;
      return;
    }
    if (state.uatCounty === county && (state.uatLoading || state.uats.length)) return;
    state.uatCounty = county;
    state.uats = [];
    const requestId = state.uatRequestId + 1;
    state.uatRequestId = requestId;
    // Fara asta, un UAT ramas evidentiat din județul anterior ar tine aprins un rand din
    // lista noua care nu are nicio legatura cu el.
    state.hoverUat = null;
    const cached = state.uatCache.get(county);
    if (cached) {
      state.uatLoading = false;
      state.uats = cached;
      return;
    }
    state.uatLoading = true;
    fetch(`/static/harta-stiri/data/uat/${encodeURIComponent(county)}.json`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (state.uatCounty !== county || state.uatRequestId !== requestId) return;
        const uats = Array.isArray(data?.uats) ? data.uats.map((unit) => ({
          ...unit,
          count: 0,
          localities: [],
          items: [],
        })) : [];
        state.uatCache.set(county, uats);
        state.uats = uats;
        state.uatCountsDirty = true;
        // O singura cerere per județ: siluetele vecinilor nu mai sunt necesare, pentru ca
        // stratul de UAT-uri e taiat pe conturul județului cu clip-path (vezi ensureStage).
      })
      .catch(() => {
        if (state.uatCounty === county && state.uatRequestId === requestId) state.uats = [];
      })
      .finally(() => {
        if (state.uatCounty === county && state.uatRequestId === requestId) {
          state.uatLoading = false;
          // renderMap face si aplicarea selectiei de UAT (asignarea geometrica abia acum e
          // posibila), apoi renderList o prezinta in panou.
          renderMap();
          renderList();
          announceState();
        }
      });
  }

  // Asignarea articolelor la UAT-uri se face din `rawVisible`, NU din `visible`: selectia de
  // UAT restrange `visible` pe baza asignarii, deci daca asignarea s-ar calcula din el,
  // selectia s-ar auto-hrani -- la a doua trecere toate celelalte UAT-uri ar cadea pe 0.
  function countUatNews() {
    if (!state.zoomCounty || !state.uats.length) return;
    for (const uat of state.uats) {
      uat.count = 0;
      uat.localities = [];
      uat.items = [];
    }
    const nodes = state.uatNodes || new Map();
    for (const item of state.rawVisible) {
      if (item.county !== state.zoomCounty) continue;
      // Asignarea DETERMINISTA bate geometria: `uat` vine din SIRUTA la build (satul -> UAT-ul
      // parinte, campul `uat` din map.json), iar geometria decide doar cand campul lipseste.
      let uat = item.uat ? state.uats.find((unit) => String(unit.id) === String(item.uat)) : null;
      if (!uat && item.x != null && item.y != null) {
        uat = uatAtMapPoint(nodes, Number(item.x), Number(item.y));
      }
      if (!uat) continue;
      uat.count += 1;
      uat.items.push(item);
      if (item.locality && !uat.localities.includes(item.locality)) uat.localities.push(item.locality);
    }
  }

  // In zonele de suprapunere reziduale dintre UAT-uri, poligonul cel mai MIC care acopera
  // punctul castiga -- acelasi principiu ca inainte, dar hit-testul il face browserul
  // (`SVGGeometryElement.isPointInFill`), nu o re-parsare de Path2D facuta de noi.
  function uatAtMapPoint(nodes, x, y) {
    if (typeof DOMPoint !== "function") return null;
    let best = null;
    let bestArea = Infinity;
    for (const uat of state.uats) {
      const node = nodes.get(String(uat.id || uat.name));
      if (!node || typeof node.isPointInFill !== "function") continue;
      let inside = false;
      try { inside = node.isPointInFill(new DOMPoint(x, y)); } catch (err) { inside = false; }
      if (!inside) continue;
      const bounds = pathBounds(uat.path);
      const area = bounds ? (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY) : 0;
      if (area < bestArea) { bestArea = area; best = uat; }
    }
    return best;
  }

  function pathBounds(pathData) {
    const numbers = String(pathData).match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (numbers.length < 4) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      const x = numbers[i];
      const y = numbers[i + 1];
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    return { minX, minY, maxX, maxY };
  }


  // --- scara choropleth --------------------------------------------------------------------
  // PRAGURI ABSOLUTE, nu cuartile recalculate per filtru. Motivul e un defect vazut pe LIVE
  // (`?q=Giroc`, 4 oct 2026): cuartilele unui maxim de 2 ieseau [1,1], legenda se construia
  // din ele si afisa „012–undefinedNaN–undefinedNaN+" — o scara care minte. Acum:
  //   1. pragurile sunt fixe si strict crescatoare, deci clasa nu poate fi nedeterminata;
  //   2. etichetele BENZILOR sunt scrise static in index.html (nu construite aici), deci
  //      „NaN"/„undefined" nu pot ajunge pe ecran prin constructie;
  //   3. aceeasi culoare = acelasi numar in orice stare (filtru, judet, UAT) — o harta pe
  //      care nu poti compara doua ecrane nu e o scara, e o decoratiune.
  // Sursa de adevar a pragurilor e atributul `data-praguri` al legendei din index.html, iar
  // tests/test_harta_scara.py citeste de acolo SI etichetele benzilor si le verifica una
  // impotriva alteia (acoperire de la 0 in sus, fara goluri, fara suprapuneri).
  function praguriDinPagina(atribut, fallback) {
    const raw = ($("#map-legend") || {}).dataset?.[atribut] || "";
    const list = raw.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    return list.length === 4 ? list : fallback;
  }

  const PRAGURI = praguriDinPagina("praguri", [1, 6, 15, 30]);
  // Ratele sunt la 100.000 de locuitori, pe fereastra hartii (circa 12 zile), deci valorile
  // sunt de ordinul unitatilor: praguri absolute [0,1 / 1 / 2 / 4]. Zero e singura valoare
  // sub 0,1, iar prima banda (0,1-0,9) nu poate inghiti o știre existenta -- verificat de
  // tests/test_harta_scara.py pe grila de afisare (o zecimala).
  const PRAGURI_LOCUITOR = praguriDinPagina("praguriLocuitor", [0.1, 1, 2, 4]);

  function praguriActive() {
    return state.scaleMode === "locuitori" ? PRAGURI_LOCUITOR : PRAGURI;
  }

  // Fiecare prag e PRIMUL numar al benzii lui: [1, 6, 15, 30] -> 1–5 / 6–14 / 15–29 / 30+.
  // Clasa = cate praguri sunt acoperite de count, deci benzile sunt contigue prin
  // constructie — vechea formula (cuartile + strict `>`) lasa si goluri intre benzi
  // („1–12 / 14–27 / 28–41 / 42+": 13 nu apare nicaieri), iar aceea e harta care minte.
  function rampClassFor(valoare, praguri = praguriActive()) {
    if (!valoare) return 0;
    return Math.min(4, praguri.filter((p) => valoare >= p).length);
  }

  // --- numitorul (F3) ----------------------------------------------------------------------
  // Populația pe județe: 42 de valori, ~1 KB, cerute O SINGURA DATA si doar cand cititorul
  // comuta pe „pe locuitor". Daca cererea eșuează, modul nu se activeaza si se spune de ce —
  // o harta care afiseaza rate fara numitor ar fi mai rea decat una care afiseaza volum.
  function incarcaPopulatii() {
    if (state.populatii) return Promise.resolve(state.populatii);
    if (state.populatiiPromise) return state.populatiiPromise;
    state.populatiiPromise = fetch("/static/harta-stiri/data/populatie.json")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((date) => {
        // ATENTIE la ce se pastreaza: harta indexeaza pe COD de județ, deci in stare intra
        // dictionarul `judete`, nu fisierul intreg. Prima versiune a tinut minte fisierul,
        // iar `state.populatii["TIMIS"]` era undefined, deci modul „pe locuitor" afisa
        // tacut numaratoarea — prins de verificarea de DOM, nu de ochi (2026-10-04).
        state.populatii = (date && date.judete) || null;
        if (!state.populatii) throw new Error("fara judete");
        return state.populatii;
      })
      .catch((err) => {
        state.populatiiPromise = null;
        throw err;
      });
    return state.populatiiPromise;
  }

  function populatieJudet(county) {
    if (!state.populatii) return null;
    const pop = state.populatii[county];
    return typeof pop === "number" && pop > 0 ? pop : null;
  }

  // Valoarea afisata a unui județ, in modul curent, ROTUNJITA la ce se scrie pe ecran.
  // Rotunjirea nu e cosmetică: clasa de culoare se calculeaza din chiar valoarea afisata,
  // deci „aceeasi culoare = acelasi numar" e adevarat pentru ce vede cititorul (o zecimala),
  // nu doar pentru numarul din memorie.
  function valoareJudet(county) {
    const count = countyCount(county);
    if (state.scaleMode !== "locuitori") return count;
    const pop = populatieJudet(county);
    if (!pop) return null;
    return Math.round((count / pop) * 100000 * 10) / 10;
  }

  function esteModRata() {
    return state.scaleMode === "locuitori";
  }

  function fmtValoare(valoare) {
    if (valoare == null) return "—";
    return esteModRata() ? valoare.toFixed(1).replace(".", ",") : String(valoare);
  }

  function unitateValoare() {
    return esteModRata() ? "la 100.000 de locuitori" : "";
  }

  // Textul unei cifre de județ, cu acord si unitate — folosit de etichete, panou, tooltip,
  // butoane si aria-label, ca TOATE sa spuna acelasi lucru.
  function cifraJudet(county) {
    const valoare = valoareJudet(county);
    const bucata = esteModRata() && valoare != null
      ? `${fmtValoare(valoare)} ${itemLabel()} la 100.000 de locuitori`
      : `${countyCount(county)} ${itemLabelFor(countyCount(county))}`;
    return { valoare, bucata };
  }

  // Legenda e continut static in pagina; JS-ul o arata/ascunde dupa modul de afisare
  // (in modul regional umplerea spune regiunea editoriala, nu volumul, deci scara nu se
  // aplica). Zero text construit aici, deci zero ocazii de a tipari o banda goala.
  function updateLegend({ show = true, variant = "volum" } = {}) {
    const legend = $("#map-legend");
    if (!legend) return;
    legend.hidden = !show;
    // Titlul si benzile sunt continut static; aici doar se alege care se vede. In modul
    // regional legenda nu se aplica deloc (umplerea spune regiunea, nu volumul) si e ascunsa.
    for (const titlu of legend.querySelectorAll("[data-title]")) {
      titlu.hidden = titlu.dataset.title !== variant;
    }
    for (const benzi of legend.querySelectorAll("[data-bands]")) {
      benzi.hidden = benzi.dataset.bands !== (variant === "locuitori" ? "locuitori" : "volum");
    }
  }

  function selectedView(vx, vy, vw, vh) {
    if (!state.zoomCounty || !state.counties[state.zoomCounty]) {
      return { x: vx, y: vy, width: vw, height: vh };
    }
    const bounds = pathBounds(state.counties[state.zoomCounty]);
    if (!bounds) return { x: vx, y: vy, width: vw, height: vh };
    // Margine de 26% (era 12%): cand ești intrat pe un județ, vecinii trebuie să fie
    // vizibili -- „vreau să mă mut pe altul" nu trebuie să treacă obligatoriu prin butonul
    // de întoarcere (sesizare proprietar, 5 sep 2026).
    const padX = Math.max(12, (bounds.maxX - bounds.minX) * 0.26);
    const padY = Math.max(12, (bounds.maxY - bounds.minY) * 0.26);
    const x = Math.max(vx, bounds.minX - padX);
    const y = Math.max(vy, bounds.minY - padY);
    const right = Math.min(vx + vw, bounds.maxX + padX);
    const bottom = Math.min(vy + vh, bounds.maxY + padY);
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  }

  const ZOOM_MIN = 1;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 1.6;

  function clampZoomCenter(c, base) {
    return {
      x: Math.min(base.x + base.width, Math.max(base.x, c.x)),
      y: Math.min(base.y + base.height, Math.max(base.y, c.y)),
    };
  }

  function zoomCenter(base) {
    const z = state.userZoom;
    return {
      x: z.cx == null ? base.x + base.width / 2 : z.cx,
      y: z.cy == null ? base.y + base.height / 2 : z.cy,
    };
  }

  function zoomedView(base) {
    const z = state.userZoom;
    if (!z || z.k <= 1) return base;
    const c = clampZoomCenter(zoomCenter(base), base);
    state.userZoom = { k: z.k, cx: c.x, cy: c.y };
    return {
      x: c.x - base.width / (2 * z.k),
      y: c.y - base.height / (2 * z.k),
      width: base.width / z.k,
      height: base.height / z.k,
    };
  }

  function zoomTo(k2, anchor) {
    const base = state.baseView;
    if (!base) return;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(k2)));
    if (!Number.isFinite(next) || next === state.userZoom.k) {
      syncZoomControls();
      return;
    }
    // Zoomul preia controlul vederii: fly-to-ul in zbor s-ar lupta cu el (flyView
    // suprascrie vederea la fiecare cadru pana la finalul animatiei).
    cancelFly();
    const c1 = zoomCenter(base);
    // Punctul de sub cursor/deget ramane fix: (p - c2) * k2 = (p - c1) * k1.
    // clampZoomCenter intoarce {x, y} -- se mapeaza EXPLICIT pe cx/cy, nu prin spread:
    // spread-ul producea userZoom fara cx/cy, iar centrul "reinvia" mereu la centrul de
    // baza -- zoomul nu era ancorat la cursor si panul era mort (prins cu instrumentare).
    const c2 = anchor
      ? { x: anchor.x - (anchor.x - c1.x) * (state.userZoom.k / next),
          y: anchor.y - (anchor.y - c1.y) * (state.userZoom.k / next) }
      : c1;
    const cc = clampZoomCenter(c2, base);
    state.userZoom = { k: next, cx: cc.x, cy: cc.y };
    syncZoomControls();
    renderMap();
  }

  function panBy(dxBase, dyBase) {
    const base = state.baseView;
    if (!base || state.userZoom.k <= 1) return;
    const c = zoomCenter(base);
    const c2 = clampZoomCenter({ x: c.x - dxBase, y: c.y - dyBase }, base);
    state.userZoom = { k: state.userZoom.k, cx: c2.x, cy: c2.y };
    syncZoomControls();
    renderMap();
  }

  function syncZoomControls() {
    // Cursorul si starea de zoom se exprima prin clase pe scena (vezi harta-stiri.css).
    const z = state.userZoom || { k: 1 };
    if (state.zoomIn) {
      state.zoomIn.disabled = z.k >= ZOOM_MAX;
      state.zoomIn.setAttribute("aria-disabled", z.k >= ZOOM_MAX ? "true" : "false");
      state.zoomOut.disabled = z.k <= ZOOM_MIN;
      state.zoomOut.setAttribute("aria-disabled", z.k <= ZOOM_MIN ? "true" : "false");
      state.zoomReset.hidden = z.k <= ZOOM_MIN;
    }
    
  }

  // Schimbările de scară se anunta in regiunea live (#map-status), dar DOAR la acțiuni
  // discrete (butoane, taste) -- rotița și pinch-ul produc zeci de evenimente pe gest și
  // ar scălda cititoarea de ecran în anunțuri.
  function announceZoom() {
    const status = $("#map-status");
    const z = state.userZoom;
    if (!status || !z) return;
    status.textContent = z.k <= 1
      ? "Harta la scara normală."
      : `Harta mărită de ${z.k.toFixed(1).replace(".", ",")}x.`;
  }


  // --- fly-to: apropierea animată la selecție ----------------------------------------------
  // Convenția hărților de produs: selectarea unei zone ZOOMEAZĂ lin spre ea (380 ms,
  // easeInOutCubic), nu sari brutal la alt cadru. Restaurările din URL/Back rămân instant:
  // cine ajunge printr-un link vrea starea, nu spectacolul. reduce-motion sare animația.

  function baseViewBox() {
    const vb = String(state.map?.viewbox || "").trim().split(/\s+/).map(Number);
    return vb.length === 4 ? vb : [0, 0, 1000, 700];
  }

  // Vederea țintă pentru un județ, calculată fără a schimba starea: selectedView depinde
  // de state.zoomCounty, deci îl împrumutăm pe durata calculului și-l întoarcem.
  function peekViewFor(county) {
    const saved = state.zoomCounty;
    state.zoomCounty = county;
    const [vx, vy, vw, vh] = baseViewBox();
    const view = selectedView(vx, vy, vw, vh);
    state.zoomCounty = saved;
    return view;
  }

  // Orice schimbare de vedere dictata de utilizator sau de stare omoara animatia in zbor.
  // Token-ul face ca pasul programat al animatiei vechi sa se opreasca la primul cadru;
  // flyView=null redeseneaza vederea reala (starea), nu una interpolata de zgomot.
  function cancelFly() {
    state.flyToken += 1;
    state.flyView = null;
  }

  // Intrarea de zoom a utilizatorului (rotita, dublu-click, pinch) preia controlul vederii:
  // omoara orice fly-to in zbor si redeseneaza vederea reala INAINTE ca apelantul sa
  // calculeze punctul de ancorare. Altfel ancora e calculata in spatiul vederii interpolate
  // (in plin zbor) dar zoomTo o interpreteaza in spatiul bazei -- cursorul "ajunge" in alta
  // parte si zoomul priveste o zona goala (masurat: dublu-click 16619 -> 1543 pixeli aurii).
  function takeUserView() {
    if (!state.flyView) return;
    cancelFly();
    renderMap();
  }

  function animateViewTo(target, fromView) {
    // `fromView` e plecarea EXPLICITA: cu starea aplicata imediat, state.view e deja
    // vederea finala in momentul apelului -- animatia pleaca de unde era vederea
    // inainte de aplicare, nu de unde e acum.
    const from = fromView || state.view;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (!from || reduce) return;
    state.flyToken += 1;
    const token = state.flyToken;
    const t0 = performance.now();
    const DURATION = 380;
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    // Primul cadru, la plecare, randat SINCRON: aplicarea starii a desenat deja vederea
    // finala; fara asta, finalul aparea o clipa, apoi vederea sarea inapoi la plecare
    // (palpaire la fiecare selectie). Acelasi task JS, deci nicio afisare intre ele.
    state.flyView = { ...from };
    renderMap();
    const step = (now) => {
      // O animație mai nouă a luat locul: nu mai scriem vederea peste ea.
      if (token !== state.flyToken) return;
      const t = Math.min(1, (now - t0) / DURATION);
      const e = ease(t);
      state.flyView = {
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        width: from.width + (target.width - from.width) * e,
        height: from.height + (target.height - from.height) * e,
      };
      renderMap();
      if (t < 1) {
        requestAnimationFrame(step);
        return;
      }
      state.flyView = null;
    };
    requestAnimationFrame(step);
  }

  function selectCounty(county) {
    // Starea se aplica IMMEDIAT; fly-to-ul ramane doar decorul vederii. Aplicarea amanata
    // pana la finalul animatiei (380 ms) facea ca orice citire din timpul zborului sa
    // vada starea veche (adresa, panou, aria-pressed), iar un reset din acel interval era
    // suprascris la final de animatie, care isi re-aplica singura judetul abandonat --
    // selectie fantoma, cauza comuna a FAIL-urilor gardii DOM.
    const from = state.view;
    const willFly = county && !state.zoomCounty && county !== state.selectedCounty && !state.flyView;
    const target = willFly ? peekViewFor(county) : null;
    applyState({ region: null, county, locality: null });
    if (target) animateViewTo(target, from);
  }

  function selectRegion(region) {
    applyState({ region, county: null, locality: null });
  }

  // Comuta doar clasa pe butoanele deja existente. Reconstruirea intregii liste la fiecare
  // miscare de mouse ar reface zeci de noduri DOM de ~60 de ori pe secunda si ar fura si
  // focusul de sub tastatura.
  function syncUatHighlight() {
    const picker = $("#county-picker");
    if (!picker) return;
    const hovered = state.hoverUat;
    const key = hovered ? String(hovered.id || hovered.name) : null;
    for (const button of picker.querySelectorAll("button[data-uat]")) {
      const on = key !== null && button.dataset.uat === key;
      button.classList.toggle("is-hovered", on);
      button.setAttribute("aria-current", on ? "true" : "false");
      // `nearest` nu face nimic daca randul e deja vizibil, deci lista nu sare degeaba.
      if (on) button.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function updateCountyPicker() {
    const picker = $("#county-picker");
    if (!picker) return;
    const active = document.activeElement;
    const focusedKey = active && active.closest && active.closest("#county-picker")
      ? (active.dataset.uat || active.dataset.region || active.dataset.county) : null;
    picker.replaceChildren();

    // Incarcarea UAT-urilor unui judet e async si se vede: fara mesajul asta, pickerul ar
    // sari inapoi pe butoanele de judet timp de cateva sute de ms si ar parea ca selectia
    // "nu a prins" (audit harta, P1 -- starea intermediara trebuie comunicata).
    if (state.zoomCounty && state.uatLoading) {
      picker.setAttribute("aria-label", `Localități în ${judetLabel(state.zoomCounty)}`);
      const loading = document.createElement("p");
      loading.className = "picker-empty";
      loading.textContent = `Se încarcă localitățile din ${judetLabel(state.zoomCounty)}…`;
      picker.appendChild(loading);
      return;
    }

    // Lista păstrează toate UAT-urile județului, inclusiv când filtrul curent nu găsește
    // articole în ele; astfel, schimbarea filtrului nu face numele sau zonele inaccesibile.
    if (state.zoomCounty && state.uats.length) {
      const uats = [...state.uats]
        .sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name), "ro"));
      picker.setAttribute("aria-label", `Orașe și comune din ${judetLabel(state.zoomCounty)}`);
      if (!uats.length) {
        const empty = document.createElement("p");
        empty.className = "picker-empty";
        empty.textContent = `Nu există știri localizate pe orașe și comune în ${judetLabel(state.zoomCounty)} pentru filtrul curent.`;
        picker.appendChild(empty);
        return;
      }
      for (const uat of uats) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.uat = uat.id || uat.name;
        button.textContent = `${uat.label || uat.name || "zonă"} · ${uat.count}`;
        // Selectie, nu fereastra: acelasi contract ca butoanele de judet (audit harta:
        // click = selectare, panoul arata stirile). Click repetat deselecteaza.
        const uatKey = String(uat.id || uat.name);
        button.setAttribute("aria-pressed", state.selectedUat === uatKey ? "true" : "false");
        button.addEventListener("click", () => applyState({ uat: state.selectedUat === uatKey ? null : uatKey }));
        // Legatura merge in ambele sensuri: peste forma de pe harta se aprinde randul din
        // lista, iar peste randul din lista se aprinde forma. Altfel lista si harta ar fi
        // doua liste de nume care nu se stiu una pe alta.
        const setHover = (value) => {
          if (state.hoverUat === value) return;
          state.hoverUat = value;
          syncUatHighlight();
          markHoverShapes();
        };
        button.addEventListener("pointerenter", () => setHover(uat));
        button.addEventListener("pointerleave", () => setHover(null));
        button.addEventListener("focus", () => setHover(uat));
        button.addEventListener("blur", () => setHover(null));
        picker.appendChild(button);
        if (button.dataset.uat === focusedKey) button.focus();
      }
      // Tastatura nu trebuie sa-si piarda locul cand pickerul se schimba din judete in UAT-uri:
      // niciun buton UAT nu poarta cheia judetului (dataset.uat e cod SIRUTA), deci
      // refocalizarea de mai sus nu gaseste nimic si focusul cade pe body -- acelasi mod de
      // esec reparat in IZZ-0194, reaparut insa pe tranzitia judet -> lista UAT. Primul UAT
      // e o tinta sigura; pentru utilizatorul de mouse focusedKey e null si nu i se fura focusul.
      if (focusedKey && !picker.contains(document.activeElement)) {
        const first = picker.querySelector("button[data-uat]");
        if (first) first.focus();
      }
      syncUatHighlight();
      return;
    }

    // În România/regional rămâne alternativa echivalentă pentru alegerea unei zone fără tap precis.
    const isRegional = state.level === "regional";
    const pool = itemsForView(filtered({ ignorePlace: true }));
    const counts = new Map();
    for (const item of pool) {
      const key = isRegional ? item.region : item.county;
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    // Județele fără nicio știre rămâneau în afara listei, dar pe hartă acum sunt clickabile
    // -- cine navighează din tastatură trebuie să aibă aceeași cale (echivalența WCAG:
    // controlul HTML acoperă funcția hărții). Intră cu 0, stilizate la fel.
    if (!isRegional) {
      for (const key of Object.keys(state.counties)) {
        if (!counts.has(key)) counts.set(key, 0);
      }
    }
    picker.setAttribute("aria-label", isRegional ? "Alege regiunea" : "Alege județul");
    for (const key of Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, "ro"))) {
      const button = document.createElement("button");
      button.type = "button";
      if (isRegional) button.dataset.region = key;
      else button.dataset.county = key;
      button.textContent = isRegional
        ? `${key} · ${counts.get(key)}`
        : `${judetLabel(key)} · ${fmtValoare(valoareJudet(key) ?? counts.get(key))}`;
      const selected = isRegional ? key === state.selectedRegion : key === state.selectedCounty;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.addEventListener("click", () => (isRegional ? selectRegion(key) : selectCounty(key)));
      picker.appendChild(button);
      if (key === focusedKey) button.focus();
    }
  }

  // Acelasi hit-test pe care il foloseste si clickul, scos separat ca hover-ul sa nu-l
  // duplice: doua copii ale regulii ar putea ajunge sa arate un nume si sa deschida altul.
  // --- starea in adresa paginii ----------------------------------------------------------
  // Toate schimbarile de stare trec prin `applyState`. Fara asta ar exista cai care muta harta
  // fara sa mute adresa: un link partajat ar duce pe alta stare decat cea vazuta de cel care
  // l-a trimis, iar Back ar sari de pe pagina in loc sa anuleze ultima selectie.

  function urlForState() {
    const params = new URLSearchParams();
    if (state.level && state.level !== "all") params.set("nivel", state.level);
    if (state.viewMode !== "events") params.set("mod", state.viewMode);
    if (state.selectedRegion) params.set("regiune", state.selectedRegion);
    if (state.selectedCounty) params.set("judet", state.selectedCounty);
    // Selectia de UAT, ca orice filtru: instant in adresa (nu asteapta asignarea geometrica,
    // care doar determina CONTINUTUL panoului, nu starea).
    if (state.selectedUat) params.set("uat", state.selectedUat);
    const loc = Array.isArray(state.selectedLocality)
      ? state.selectedLocality
      : (state.selectedLocality ? [state.selectedLocality] : []);
    // Mai multe localitati pot cadea pe acelasi marker; toate intra in link, altfel cel care
    // deschide adresa vede mai putine stiri decat cel care a trimis-o.
    if (loc.length) params.set("loc", loc.join("|"));
    if (state.search) params.set("q", state.search);
    if (state.scaleMode === "locuitori") params.set("scara", "locuitori");
    const query = params.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }

  // Cheia judetului din URL se normalizeaza la forma canonica din date (majuscule,
  // fara spatii) si se accepta doar daca judetul exista: un link partajat cu
  // judet=alba (minuscule) sau judet=nu-exista deschide harta nefiltrata, nu tace
  // selectand nimic. Plan de remediere D5 (Arena, 6 oct).
  function judetDinUrl(valoare) {
    const cheie = (valoare || "").trim().toUpperCase();
    if (!cheie) return null;
    return state.counties && cheie in state.counties ? cheie : null;
  }

  function stateFromUrl() {
    const params = new URLSearchParams(location.search);
    const loc = params.get("loc");
    const countyFromPage = document.querySelector('meta[name="harta-county"]')?.content || null;
    return {
      level: params.get("nivel") || "all",
      viewMode: params.get("mod") === "articles" ? "articles" : "events",
      region: params.get("regiune") || null,
      county: judetDinUrl(params.get("judet") || countyFromPage),
      locality: loc ? loc.split("|").filter(Boolean) : null,
      uat: params.get("uat") || null,
      query: params.get("q") || "",
      scale: params.get("scara") === "locuitori" ? "locuitori" : "volum",
    };
  }

  function applyState(patch, { push = true, replace = false } = {}) {
    if ("level" in patch) state.level = patch.level || "all";
    if ("viewMode" in patch) state.viewMode = patch.viewMode === "articles" ? "articles" : "events";
    if ("region" in patch) state.selectedRegion = patch.region || null;
    if ("county" in patch) state.selectedCounty = patch.county || null;
    if ("locality" in patch) state.selectedLocality = patch.locality || null;
    if ("query" in patch) state.search = patch.query || "";
    if ("uat" in patch) {
      state.selectedUat = patch.uat ? String(patch.uat) : null;
      state.pendingUat = state.selectedUat;
    }
    // UAT-ul selectat e sub-judet: orice schimbare de context geografic superior il anuleaza,
    // altfel un filtru de UAT ar supravietui județului lui. Doar un patch care vine cu `uat`
    // explicit (popstate, link direct) il pastreaza peste schimbarea de județ.
    if (["level", "region", "county"].some((key) => key in patch) && !("uat" in patch)) {
      state.selectedUat = null;
      state.pendingUat = null;
    }
    // `zoomCounty` nu e stare independenta, e derivata: la nivel Judetean click-ul filtreaza
    // fara sa mareasca (decizie proprietar, 13 aug). Tinuta separat, se desincroniza.
    state.zoomCounty = state.selectedCounty && !["judetean", "regional"].includes(state.level)
      ? state.selectedCounty : null;
    // Evidentierea de hover e a VECHII vederi: dupa zoom sau schimbare de filtru, un contur
    // ramas aprins ar arata o selectie care nu exista; urmatoarea miscare de mouse o repune.
    state.hoverCounty = null;
    // Zoom-ul geometric e legat de contextul geografic: o selectie noua = o scena noua.
    // Pastrat, ar arata un cadru care nu mai are legatura cu ce a ales omul. Cautarea si
    // schimbarea modului pastreaza zoom-ul (filtreaza aceeasi scena).
    if (["level", "region", "county", "uat"].some((key) => key in patch)) {
      state.userZoom = { k: 1, cx: null, cy: null };
      // Schimbarea de context anuleaza si orice fly-to in zbor: fara garda asta, animatia
      // veche isi aplica la final patch-ul propriu peste starea noua -- exact modul in
      // care un reset din timpul zborului era anulat de selectia fantoma.
      cancelFly();
    }
    // Plafonul listei se reseteaza doar cand se schimba CE e filtrat: selectia de UAT filtreaza
    // continutul, deci si ea reseteaza; dezactivarea unui UAT la fel.
    if (["level", "viewMode", "region", "county", "locality", "query", "uat"].some((key) => key in patch)) {
      state.listLimit = 120;
    }
    state.rawVisible = filtered();
    state.visible = itemsForView(state.rawVisible);
    state.uatCountsDirty = true;
    syncUats();

    const search = $("#map-search");
    if (search && search.value !== state.search) search.value = state.search;
    syncLevelButtons();
    syncViewButtons();
    renderMap();
    renderList();
    updateStats();
    announceState();

    if (!push && !replace) return;
    const url = urlForState();
    if (url === `${location.pathname}${location.search}`) return;
    // `replaceState` la tastare: altfel fiecare litera ar lasa o intrare in istoric si Back ar
    // trebui apasat de zece ori ca sa iasa dintr-o cautare de zece caractere.
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }

  // Firul ierarhic de deasupra hartii (NN/g "Breadcrumbs": pozitia in IERARHIE, nu istoricul
  // sesiunii; nivelul curent e text simplu, nu link; toti stramosii clickabili). Cu el,
  // adancimea selectiei e vizibila inainte de orice click -- inclusiv cand ajungi direct
  // printr-un link partajat, unde istoricul nu exista.
  function updateBreadcrumb() {
    const crumb = $("#map-breadcrumb");
    if (!crumb) return;
    crumb.replaceChildren();
    // Fara nicio selectie, România e POZITIA curenta (text, nu link -- NN/g: nivelul curent
    // nu e clickabil, e locul in care esti deja).
    const hasGeo = Boolean(state.selectedRegion || state.selectedCounty || state.selectedLocality || state.selectedUat);
    const trail = [{ label: "România", action: resetSelection, current: !hasGeo }];
    if (state.selectedRegion) {
      trail.push({
        label: state.selectedRegion,
        action: () => applyState({ region: state.selectedRegion, county: null, locality: null, uat: null }),
        current: !state.selectedCounty && !state.selectedUat,
      });
    }
    if (state.selectedCounty && !state.selectedRegion) {
      // Intrare directa pe județ (link cu judet=, fara regiune in adresa): firul arata
      // ierarhia completa România › Regiune › Județ, cu regiunea inferata din date si
      // clickabila. Plan de remediere D5 (Arena, 6 oct).
      const regiune = regionForCounty(state.selectedCounty);
      if (regiune) {
        trail.push({
          label: regiune,
          action: () => applyState({ region: regiune, county: null, locality: null, uat: null }),
          current: false,
        });
      }
    }
    if (state.selectedCounty) {
      trail.push({
        label: judetLabel(state.selectedCounty),
        action: () => applyState({ county: state.selectedCounty, locality: null, uat: null }),
        current: !state.selectedLocality && !state.selectedUat,
      });
    }
    if (state.selectedLocality && !state.selectedUat) {
      const locality = Array.isArray(state.selectedLocality)
        ? state.selectedLocality.join(", ") : state.selectedLocality;
      trail.push({ label: locality, current: true });
    }
    if (state.selectedUat) {
      const uat = state.uats.find((unit) => String(unit.id || unit.name) === state.selectedUat);
      trail.push({ label: uat ? (uat.label || uat.name) : (state.selectedCounty || state.selectedUat), current: true });
    }
    trail.forEach((step, index) => {
      if (index) {
        const sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "›";
        crumb.appendChild(sep);
      }
      if (step.current || !step.action) {
        const current = document.createElement("span");
        current.className = "crumb-current";
        current.setAttribute("aria-current", "location");
        current.textContent = step.label;
        crumb.appendChild(current);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = step.label;
        button.addEventListener("click", step.action);
        crumb.appendChild(button);
      }
    });
  }

  function contextName() {
    if (state.selectedUat) {
      const uat = state.uats.find((unit) => String(unit.id || unit.name) === state.selectedUat);
      // Asignarea poate sa nu fie inca posibila (UAT-urile se incarca): panoul spune atunci
      // județul, nu o cheie tehnica.
      return uat ? (uat.label || uat.name) : (state.selectedCounty || state.selectedUat);
    }
    if (state.selectedLocality) return Array.isArray(state.selectedLocality)
      ? state.selectedLocality.join(", ") : state.selectedLocality;
    if (state.selectedCounty) return judetLabel(state.selectedCounty);
    if (state.selectedRegion) return state.selectedRegion;
    return "România";
  }

  function itemLabel() {
    return state.viewMode === "events" ? "evenimente" : "relatări";
  }

  // `itemLabel()` da intotdeauna pluralul, iar apelantii lui de pana acum isi rezolvau
  // acordul separat (".. localizat" + "e"). Tooltipul pune cifra lipita de cuvant, unde
  // asta ar da "1 evenimente", deci are nevoie de forma acordata.
  function itemLabelFor(count) {
    if (count === 1) return state.viewMode === "events" ? "eveniment" : "relatare";
    return itemLabel();
  }

  // Fereastra reala a datelor, din datele încărcate (nu o constanta care poate minti):
  // „22 sept. – 3 oct. (12 zile)". Daca datele nu permit calculul, textul static din pagina
  // rămâne neatins — nicio ocazie de a tipari „undefined".
  function updateWindow() {
    const el = $("#map-window");
    if (!el || !state.data) return;
    const timp = (state.data.articles || [])
      .map((item) => Date.parse(item.published || ""))
      .filter((t) => Number.isFinite(t));
    if (!timp.length) return;
    const min = Math.min(...timp);
    const max = Math.max(...timp);
    const zile = Math.round((max - min) / 86400000) + 1;
    const fmtData = new Intl.DateTimeFormat("ro-RO", { day: "numeric", month: "short" });
    el.textContent = `${fmtData.format(min)} – ${fmtData.format(max)} (${zile} zile)`;
  }

  function renderList() {
    const list = $("#news-list");
    if (!list) return;
    const all = state.visible;
    const items = all.slice(0, state.listLimit);
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      const hasSelection = Boolean(state.selectedRegion || state.selectedCounty
        || state.selectedLocality || state.selectedUat);
      empty.textContent = state.search
        ? `Nu am găsit rezultate pentru „${state.search}” în contextul ales. Elimină un filtru sau resetează harta.`
        : hasSelection
          ? `Nu există știri localizate în ${contextName()} pentru filtrele actuale. Alege altă zonă de pe hartă sau resetează filtrele.`
          : "Nu există rezultate pentru filtrele selectate. Elimină un filtru sau resetează harta.";
      list.appendChild(empty);
    }
    for (const item of items) {
      const li = document.createElement("li");
      // Fara slug nu exista pagina de articol: un link construit oricum ateriza pe
      // `/local//` — adica pe pagina de categorie Local, nu pe articol (20 de inregistrari
      // event fara URL in map.json, masurat 2026-10-03). Randam titlul ca text simplu.
      const titlu = document.createElement(item.slug ? "a" : "span");
      if (item.slug) titlu.href = articleUrl(item);
      titlu.textContent = item.title || "Fără titlu";
      const meta = document.createElement("span");
      const source = item.source_name || item.source;
      meta.textContent = [item.locality, item.county, item.region, source, dateLabel(item.published)]
        .filter(Boolean).join(" · ");
      li.append(titlu, meta);
      if (state.viewMode === "events" && (item.eventArticleCount > 1 || item.eventSourceCount > 1)) {
        const context = document.createElement("span");
        context.className = "event-context";
        context.textContent = item.eventArticleCount > 1
          ? `${item.eventArticleCount} relatări · ${item.eventSourceCount} surse despre același eveniment`
          : `${item.eventSourceCount} surse despre același eveniment`;
        li.appendChild(context);
      }
      list.appendChild(li);
    }
    const context = contextName();
    const title = $("#panel-title");
    const panelContext = $("#panel-context");
    if (title) title.textContent = `${state.viewMode === "events" ? "Evenimente" : "Relatări"} în ${context}`;
    if (panelContext) panelContext.textContent = state.level === "all" ? "Toate nivelurile" : `Nivel ${state.level}`;
    const count = $("#panel-count");
    if (count) {
      const query = norm(state.search);
      const shown = all.length > items.length
        ? `${items.length} din ${all.length} ${itemLabel()}`
        : `${items.length} ${itemLabel()}`;
      const places = query ? state.rawVisible.filter((item) => matchesPlace(item, query)).length : 0;
      const matchNote = places ? `${places} potriviri de loc` : "potriviri în titlu sau sursă";
      count.textContent = query ? `${shown} · ${matchNote}` : shown;
    }
    const showMore = $("#show-more");
    if (showMore) {
      showMore.hidden = items.length >= all.length;
      showMore.textContent = `Arată încă ${Math.min(120, Math.max(0, all.length - items.length))} rezultate`;
    }
    updateCountyPicker();
    updateBreadcrumb();
  }

  function updateStats() {
    const stats = $("#map-stats");
    if (!stats) return;
    const counties = new Set(state.rawVisible.map((item) => item.county).filter(Boolean)).size;
    const regions = new Set(state.rawVisible.map((item) => item.region).filter(Boolean)).size;
    const localities = new Set(state.rawVisible
      .filter((item) => item.locality)
      .map((item) => item.siruta || `${norm(item.locality)}|${norm(item.county)}`)).size;
    const latest = state.data?.latest_article_at ? dateLabel(state.data.latest_article_at) : "dată indisponibilă";
    stats.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = state.viewMode === "events"
      ? `${itemsForView(state.rawVisible).length} evenimente`
      : `${state.rawVisible.length} relatări`;
    const span = document.createElement("span");
    span.textContent = `${state.rawVisible.length} relatări · ${regions} regiuni · ${counties} județe · ${localities} localități confirmate · actualizat ${latest}`;
    stats.append(strong, span);
  }

  function syncLevelButtons() {
    $$(".segmented [data-level]").forEach((button) => {
      const active = button.dataset.level === state.level;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function syncViewButtons() {
    // Cand fiecare eveniment din dataset are o singura relatare si o singura sursa,
    // cele doua moduri redau exact aceeasi lista. Butonul se dezactiveaza CU motivul,
    // ca sa nu arate ca un comutator stricat (masurat pe live 2026-10-03: 438 evenimente
    // = 438 relatari, comutatorul era no-op fara nicio explicatie).
    const anyMulti = state.articles.some((item) =>
      (item.event_article_count || 0) > 1 || (item.event_source_count || 0) > 1);
    $$(".segmented [data-view]").forEach((button) => {
      const active = button.dataset.view === state.viewMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
      button.disabled = !anyMulti;
      button.title = anyMulti
        ? ""
        : "În fereastra curentă, fiecare eveniment are o singură relatăre dintr-o singură sursă.";
    });
  }

  function announceState() {
    const place = contextName();
    const levelLabel = { all: "toate nivelurile", regional: "nivel regional", judetean: "nivel județean", local: "nivel local" }[state.level] || "nivelul ales";
    const message = `${state.visible.length} ${itemLabel()} afișate pentru ${place}, la ${levelLabel}.`;
    const status = $("#map-status");
    if (status) status.textContent = message;
    const context = $("#active-context");
    if (context) context.textContent = `Afișezi ${itemLabel()} pentru ${place}, la ${levelLabel}.`;
    const clear = $("#clear-selection");
    if (clear) {
      const hasSelection = Boolean(state.selectedRegion || state.selectedCounty || state.selectedLocality);
      clear.disabled = !hasSelection;
      clear.textContent = hasSelection ? "Înapoi la România" : "Ești în România";
    }
  }

  function resetSelection() {
    // Aceeasi regula ca la selectCounty: intoarcerea se aplica imediat, zoom-out-ul e decor.
    const from = state.view;
    const willFly = Boolean(state.zoomCounty) && Boolean(from) && !state.flyView;
    applyState({ region: null, county: null, locality: null });
    if (willFly) {
      const [vx, vy, vw, vh] = baseViewBox();
      animateViewTo({ x: vx, y: vy, width: vw, height: vh }, from);
    }
  }

  function resetAll() {
    // „Resetează filtrele" revine la starea canonică completă, inclusiv scara:
    // culoarea hărții e parte din filtre (scara=locuitori schimbă semnificația
    // culorilor), deci un reset care o lasă pe „locuitori" lasă harta altfel decât
    // la o intrare proaspătă. O singură intrare de istoric: applyState fără push,
    // scara fără push, apoi un singur push cu starea finală.
    // Plan de remediere D4 (Arena, 6 oct).
    const eraPeLocuitori = state.scaleMode === "locuitori";
    applyState({ level: "all", viewMode: "events", region: null, county: null,
                 locality: null, query: "" }, { push: false });
    if (eraPeLocuitori) setScaleMode("volum", { push: false });
    history.pushState({}, "", urlForState());
  }

  // Comutarea pe „pe locuitor" are nevoie de numitor: se incarca o singura data, iar daca
  // cererea eșuează, modul NU se activeaza si se spune de ce (un eșec tacut ar lasa butonul
  // apasat cu harta pe volum, adica exact genul de interfata care minte).
  function setScaleMode(mode, { push = true } = {}) {
    const dorit = mode === "locuitori" ? "locuitori" : "volum";
    if (dorit === state.scaleMode) {
      syncScaleButtons();
      return Promise.resolve();
    }
    if (dorit === "volum") {
      state.scaleMode = "volum";
      syncScaleButtons();
      afterScaleChange(push);
      return Promise.resolve();
    }
    return incarcaPopulatii().then(() => {
      state.scaleMode = "locuitori";
      syncScaleButtons();
      afterScaleChange(push);
    }).catch(() => {
      state.scaleMode = "volum";
      syncScaleButtons();
      afterScaleChange(push);
      const status = $("#map-status");
      if (status) {
        status.textContent = "Populația pe județe nu a putut fi încărcată, deci scara a rămas pe volum.";
      }
      const buton = $('.segmented [data-scale="locuitori"]');
      if (buton) buton.setAttribute("aria-disabled", "true");
    });
  }

  function afterScaleChange(push) {
    state.uatCountsDirty = true;
    renderMap();
    renderList();
    updateStats();
    updateCountyPicker();
    announceState();
    if (push) {
      const url = urlForState();
      history.pushState({}, "", url);
    }
  }

  function syncScaleButtons() {
    for (const button of $$(".segmented [data-scale]")) {
      const activ = (button.dataset.scale === "locuitori") === esteModRata();
      button.classList.toggle("active", activ);
      button.setAttribute("aria-checked", activ ? "true" : "false");
    }
  }

  function bindControls() {
    const search = $("#map-search");
    const clear = $("#clear-selection");
    const reset = $("#reset-all");
    if (search) search.addEventListener("input", () => {
      applyState({ query: search.value }, { replace: true });
    });
    const bindRadioGroup = (selector, apply) => {
      const buttons = $$(selector);
      buttons.forEach((button, index) => {
        button.addEventListener("click", () => apply(button));
        button.addEventListener("keydown", (event) => {
          if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
          const next = buttons[(index + direction + buttons.length) % buttons.length];
          next.focus();
          next.click();
        });
      });
    };
    bindRadioGroup(".segmented [data-level]", (button) => {
      // Schimbarea nivelului păstrează intenția de căutare, dar eliberează selecția incompatibilă.
      applyState({ level: button.dataset.level || "all", region: null, county: null, locality: null });
    });
    bindRadioGroup(".segmented [data-view]", (button) => {
      applyState({ viewMode: button.dataset.view || "events" });
    });
    bindRadioGroup(".segmented [data-scale]", (button) => {
      setScaleMode(button.dataset.scale);
    });
    const showMore = $("#show-more");
    if (showMore) showMore.addEventListener("click", () => {
      state.listLimit += 120;
      renderList();
      announceState();
    });
    if (clear) clear.addEventListener("click", resetSelection);
    if (reset) reset.addEventListener("click", resetAll);
    window.addEventListener("popstate", () => {
      // Modul de scara e parte din stare, deci butonul din spate trebuie sa-l intoarca si pe
      // el: altfel adresa ar spune „pe locuitor" iar harta ar rămâne pe volum.
      const patch = stateFromUrl();
      applyState(patch, { push: false });
      if (patch.scale !== state.scaleMode) setScaleMode(patch.scale, { push: false });
    });
  }

  function bindResize() {
    const host = $("#map");
    if (!host || typeof ResizeObserver === "undefined") return;
    let scheduled = false;
    let lastWidth = Math.round(host.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect?.width ?? host.getBoundingClientRect().width);
      // Doar latimea afecteaza layout-ul hartii (inaltimea e derivata din ea). Pe mobil,
      // aparitia/disparitia barei de adrese la scroll schimba inaltimea ferestrei, nu
      // latimea -- fara garda asta, fiecare eveniment de scroll redeschide o scena noua
      // in mijlocul gestului, ceea ce a fost cauza dedublarii vizuale pe mobil (2026-08-12).
      if (width === lastWidth) return;
      lastWidth = width;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        renderMap();
      });
    });
    observer.observe(host);
  }

  function showLoadError(error) {
    console.error(error);
    const host = $("#map");
    if (host) {
      host.replaceChildren();
      const message = document.createElement("p");
      message.className = "map-load-error";
      message.textContent = "Harta nu a putut fi încărcată.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary";
      retry.textContent = "Încearcă din nou";
      retry.addEventListener("click", () => window.location.reload());
      host.append(message, retry);
    }
    const list = $("#news-list");
    if (list) list.innerHTML = "<li class=\"loading\">Datele hărții nu sunt disponibile momentan. Încearcă din nou.</li>";
    const stats = $("#map-stats");
    if (stats) stats.textContent = "Datele hărții nu sunt disponibile momentan.";
  }

  async function init() {
    bindControls();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const projectionController = new AbortController();
    const projectionTimeout = window.setTimeout(() => projectionController.abort(), 5000);
    ensureStage();
    const projectionPromise = fetch(PROJECTION_URL, { signal: projectionController.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`projection.json HTTP ${response.status}`);
        return await response.json();
      })
      .catch((error) => {
        console.warn("Metadatele proiecției lipsesc; folosesc harta SVG fără basemap.", error);
        return null;
      })
      .finally(() => window.clearTimeout(projectionTimeout));
    let response;
    try {
      // Proiecția e opțională: harta SVG se randează imediat după map.json, fără să aștepte
      // o resursă auxiliară ori încărcarea MapLibre/OpenFreeMap.
      response = await fetch(DATA_URL, { signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`map.json HTTP ${response.status}`);
    const data = await response.json();
    state.data = data;
    state.etichete = (() => {
      const node = $("#judete-etichete");
      try {
        return JSON.parse(node?.dataset?.etichete || "{}");
      } catch (err) {
        console.warn("[harta] tabelul de etichete nu s-a putut citi:", err);
        return {};
      }
    })();
    state.map = data.map || {};
    state.counties = state.map.judete || {};
    state.articles = Array.isArray(data.articles) ? data.articles : [];
    // Starea din adresa se aplica INAINTE de prima desenare, altfel harta apare o clipa
    // nefiltrata si abia apoi sare pe judetul din link.
    const initial = stateFromUrl();
    if (initial.scale === "locuitori") {
      // Linkul „?scara=locuitori" trebuie sa deschida EXACT ce a trimis expeditorul, deci
      // numitorul se incarca inainte de prima desenare (un singur KB, doar pe acest drum).
      try {
        await incarcaPopulatii();
        state.scaleMode = "locuitori";
      } catch (err) {
        state.scaleMode = "volum";
        initial.scale = "volum";
      }
    }
    syncScaleButtons();
    applyState(initial, { push: false });
    bindResize();
    renderMap();
    state.projection = await projectionPromise;
    startBasemap();
  }

  init().catch(showLoadError);
})();