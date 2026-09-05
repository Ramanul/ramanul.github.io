(() => {
  "use strict";

  const DATA_URL = "./data/map.json";
  const state = {
    map: null,
    data: null,
    counties: {},
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
    canvas: null,
    view: null,
    paths: [],
    localityMarkers: [],
    uatCounty: null,
    uats: [],
    uatLoading: false,
    uatRequestId: 0,
    uatCache: new Map(),
    // Silueta judetului derivata din UAT-urile lui. Vezi buildCountyOutline().
    uatOutlineCache: new Map(),
    hoverUat: null,
  };

  const REGION_FILLS = {
    "Transilvania": "#bdd7ee",
    "Muntenia": "#f6d6ad",
    "Moldova": "#c9e6cf",
    "Banat": "#e4c6e8",
    "Dobrogea": "#f6df91",
    "Oltenia": "#f3c1bd",
    "Bucovina": "#cbd6f3",
  };

  let dialogOpener = null;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const norm = (value) => (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

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

  function colors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      fill: styles.getPropertyValue("--map-fill").trim() || "#dfe6ee",
      stroke: styles.getPropertyValue("--map-stroke").trim() || "#9aa8b8",
      accentSoft: styles.getPropertyValue("--accent-soft").trim() || "#cfe4ff",
      hot: styles.getPropertyValue("--map-hot").trim() || "#d94b4b",
      surface: styles.getPropertyValue("--surface").trim() || "#fff",
      text: styles.getPropertyValue("--text").trim() || "#fff",
      locality: styles.getPropertyValue("--accent").trim() || "#1769aa",
    };
  }

  // Cele doua predicate sunt separate deliberat. LISTA arata ambele feluri de potrivire --
  // NN/g ("Scoped Search") arata ca restrangerea tacita a domeniului de cautare e modul de
  // esec principal: cine scrie "accident" ar primi zero rezultate fara explicatie. HARTA, in
  // schimb, aprinde doar potrivirile de LOC -- o harta care aprinde Maramuresul fiindca un
  // titlu pomeneste Clujul minte prin constructie.
  function matchesPlace(item, query) {
    return norm(`${item.county} ${item.locality}`).includes(query);
  }

  function matchesText(item, query) {
    return norm(`${item.title} ${item.source}`).includes(query);
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
    // Sortare stabila: potrivirile de loc urca primele, ordinea originala se pastreaza in
    // fiecare grup. Nimeni nu pierde rezultate; ordinea le explica.
    return [...base].sort((a, b) => Number(matchesPlace(b, query)) - Number(matchesPlace(a, query)));
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
      const sources = new Set(members.map((member) => member.source_name || member.source).filter(Boolean));
      return {
        ...primary,
        eventArticleCount: members.length,
        eventSourceCount: sources.size,
      };
    });
  }

  function regionFill(region, fallback) {
    return REGION_FILLS[region] || fallback;
  }

  function devicePointFromMap(canvas, view, x, y) {
    return {
      x: (x - view.x) * canvas.width / view.width,
      y: (y - view.y) * canvas.height / view.height,
    };
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
    // Fara asta, un UAT ramas evidentiat din judetul anterior ar tine aprins un rand din
    // lista noua care nu are nicio legatura cu el.
    state.hoverUat = null;
    const cached = state.uatCache.get(county);
    if (cached) {
      state.uatLoading = false;
      state.uats = cached;
      return;
    }
    state.uatLoading = true;
    fetch(`./data/uat/${encodeURIComponent(county)}.json`, { cache: "force-cache" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (state.uatCounty !== county || state.uatRequestId !== requestId) return;
        const uats = Array.isArray(data?.uats) ? data.uats.map((unit) => ({
          ...unit,
          path2d: new Path2D(unit.path || ""),
          count: 0,
          localities: [],
        items: [],
        })) : [];
        state.uatCache.set(county, uats);
        state.uatOutlineCache.set(county, buildCountyOutline(uats, county));
        state.uats = uats;
      })
      .catch(() => {
        if (state.uatCounty === county && state.uatRequestId === requestId) state.uats = [];
      })
      .finally(() => {
        if (state.uatCounty === county && state.uatRequestId === requestId) {
          state.uatLoading = false;
          buildMap();
          renderList();
          announceState();
        }
      });
  }

  function countUatNews(ctx, canvas, view) {
    if (!state.zoomCounty || !state.uats.length) return;
    for (const uat of state.uats) {
      uat.count = 0;
      uat.localities = [];
      uat.items = [];
    }
    for (const item of state.visible) {
      if (item.county !== state.zoomCounty || item.x == null || item.y == null) continue;
      const point = devicePointFromMap(canvas, view, Number(item.x), Number(item.y));
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const uat = state.uats.find((unit) => ctx.isPointInPath(unit.path2d, point.x, point.y, "evenodd"));
      if (!uat) continue;
      uat.count += 1;
      uat.items.push(item);
      if (item.locality && !uat.localities.includes(item.locality)) uat.localities.push(item.locality);
    }
  }

  function uatContainsMapPoint(ctx, canvas, view, uat, x, y) {
    const point = devicePointFromMap(canvas, view, x, y);
    return ctx.isPointInPath(uat.path2d, point.x, point.y, "evenodd");
  }

  function uatBadgePlacement(ctx, canvas, view, uat) {
    const bounds = pathBounds(uat.path);
    if (!bounds) return { x: uat.center?.[0] || 0, y: uat.center?.[1] || 0, clearance: 3 };
    const candidates = [];
    if (Array.isArray(uat.center)) candidates.push({ x: uat.center[0], y: uat.center[1] });
    // Centroidul unui poligon concav poate ieși în exterior. Căutarea pe grilă oferă un
    // punct interior verificat, preferându-l pe cel cu cea mai mare distanță până la contur.
    for (let row = 1; row < 12; row += 1) {
      for (let column = 1; column < 12; column += 1) {
        candidates.push({
          x: bounds.minX + (bounds.maxX - bounds.minX) * column / 12,
          y: bounds.minY + (bounds.maxY - bounds.minY) * row / 12,
        });
      }
    }
    const limit = Math.max(3, Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.45);
    let best = null;
    for (const candidate of candidates) {
      if (!uatContainsMapPoint(ctx, canvas, view, uat, candidate.x, candidate.y)) continue;
      let clearance = limit;
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
        let distance = 0.8;
        while (distance <= limit) {
          const x = candidate.x + Math.cos(angle) * distance;
          const y = candidate.y + Math.sin(angle) * distance;
          if (!uatContainsMapPoint(ctx, canvas, view, uat, x, y)) {
            clearance = Math.min(clearance, Math.max(0, distance - 0.8));
            break;
          }
          distance += 0.8;
        }
      }
      if (!best || clearance > best.clearance) best = { ...candidate, clearance };
    }
    return best || { x: uat.center?.[0] || bounds.minX, y: uat.center?.[1] || bounds.minY, clearance: 2.4 };
  }

  function closeUatDialog({ restoreFocus = true } = {}) {
    const dialog = $("#uat-dialog");
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    document.body.classList.remove("uat-dialog-open");
    if (restoreFocus && dialogOpener && typeof dialogOpener.focus === "function") dialogOpener.focus();
    dialogOpener = null;
  }

  function openUatDialog(uat, opener) {
    const dialog = $("#uat-dialog");
    const title = $("#uat-dialog-title");
    const context = $("#uat-dialog-context");
    const summary = $("#uat-dialog-summary");
    const list = $("#uat-dialog-list");
    const close = $("#uat-dialog-close");
    if (!dialog || !title || !context || !summary || !list || !close || !uat?.items?.length) return;
    dialogOpener = opener || null;
    const label = uat.label || "UAT selectat";
    const count = uat.items.length;
    title.textContent = `Știri în ${label}`;
    context.textContent = `${state.zoomCounty || "România"} · ${uat.kind || "UAT"}`;
    summary.textContent = `${count} ${itemLabel()} localizat${count === 1 ? "" : "e"} în această unitate administrativ-teritorială.`;
    list.replaceChildren();
    for (const item of uat.items) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = articleUrl(item);
      link.textContent = item.title || "Fără titlu";
      const meta = document.createElement("span");
      meta.textContent = [item.locality, item.source_name || item.source, dateLabel(item.published)]
        .filter(Boolean).join(" · ");
      li.append(link, meta);
      list.appendChild(li);
    }
    dialog.hidden = false;
    document.body.classList.add("uat-dialog-open");
    close.focus();
  }

  // Conturul de judet vine din Natural Earth (`tools/build_harta.py`), UAT-urile din exportul
  // oficial geo-spatial.org (`tools/build_harta_uat.py`). Proiectia e IDENTICA -- masurat pe
  // datele comise, bbox-ul total al celor doua straturi coincide (raport latime 0.99950,
  // inaltime 1.00028, offset 0.00px), deci NU e o problema de scara sau de viewBox.
  // Ce difera sunt GRANITELE INTERNE: Natural Earth la 1:10m generalizeaza limitele
  // administrative dintre judete, iar abaterea masurata e 3-10px (mediana 6.15px pe 42 de
  // judete). Dovada ca sursa e generalizarea, nu proiectia: la TIMIS latura de vest --
  // care e granita TARII, unde ambele surse sunt precise -- coincide la 0.00px exact, in
  // timp ce laturile interne sar cu pana la 9.7px.
  // De aceea, cand un judet e deschis si UAT-urile lui sunt vizibile, conturul se ia din
  // silueta UAT-urilor: atunci cele doua straturi se potrivesc PRIN CONSTRUCTIE, nu prin
  // ajustare, si conturul devine in plus mai precis (sursa oficiala in loc de generalizare).
  // Un `union` geometric adevarat nu e posibil aici fara o dependinta noua: UAT-urile sunt
  // simplificate fiecare separat (toleranta 0.28), deci muchiile vecinilor nu mai coincid --
  // masurat pe SIBIU, doar 45.9% din segmente sunt partajate, restul ar da un contur zdrentuit.
  // Nici nu e nevoie: subcaile concatenate desenate cu "evenodd" dau exact aria judetului, iar
  // liniile interne pe care le-ar adauga `stroke` sunt exact granitele UAT desenate oricum
  // deasupra, deci nu apare nimic in plus pe ecran.
  function buildCountyOutline(uats, county) {
    const d = uats.map((unit) => unit.path || "").filter(Boolean).join(" ");
    if (!d) return null;
    try {
      return { d, path2d: new Path2D(d) };
    } catch (err) {
      // Cadem inapoi pe conturul Natural Earth, ceea ce e corect ca imagine, dar atunci
      // nealinierea reapare. Fara linia asta esecul ar fi vizibil si cauza invizibila.
      console.warn(`[harta] silueta UAT nereconstruita pentru ${county}:`, err);
      return null;
    }
  }

  function countyOutline(county) {
    return county ? state.uatOutlineCache.get(county) || null : null;
  }

  function drawUats(ctx, palette, canvas, view) {
    if (!state.zoomCounty || !state.uats.length) return;
    countUatNews(ctx, canvas, view);
    for (const uat of state.uats) {
      // UAT-ul de sub cursor/deget se ingroasa si se umple mai tare: fara asta, tooltipul
      // spune un nume dar nu se vede CARE forma de pe harta il poarta.
      const hovered = uat === state.hoverUat;
      ctx.globalAlpha = hovered ? 0.42 : uat.count ? 0.24 : 0.08;
      ctx.fillStyle = uat.count || hovered ? palette.accentSoft : palette.fill;
      ctx.fill(uat.path2d, "evenodd");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = hovered ? palette.hot : uat.count ? palette.locality : palette.stroke;
      ctx.lineWidth = hovered ? 2 : uat.count ? 1.25 : 0.65;
      ctx.stroke(uat.path2d);
    }
    for (const uat of state.uats) {
      if (!uat.count || !Array.isArray(uat.center)) continue;
      const placement = uatBadgePlacement(ctx, canvas, view, uat);
      const { x, y } = placement;
      // 72% din distanța liberă până la contur lasă o gardă vizibilă și ține badge-ul
      // în interior inclusiv pentru UAT-uri mici sau concave.
      const radius = Math.max(2.2, Math.min(14, placement.clearance * 0.72, 7 + Math.sqrt(uat.count) * 2));
      const fontSize = Math.max(4.5, Math.min(11, radius * 0.82));
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = palette.hot;
      ctx.fill();
      ctx.lineWidth = Math.min(1.4, Math.max(0.55, radius * 0.22));
      ctx.strokeStyle = palette.surface;
      ctx.stroke();
      ctx.fillStyle = palette.text;
      ctx.font = `800 ${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(uat.count), x, y);
      uat.marker = { x, y, radius };
    }
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

  function selectedView(vx, vy, vw, vh) {
    if (!state.zoomCounty || !state.counties[state.zoomCounty]) {
      return { x: vx, y: vy, width: vw, height: vh };
    }
    const bounds = pathBounds(state.counties[state.zoomCounty]);
    if (!bounds) return { x: vx, y: vy, width: vw, height: vh };
    const padX = Math.max(12, (bounds.maxX - bounds.minX) * 0.12);
    const padY = Math.max(12, (bounds.maxY - bounds.minY) * 0.12);
    const x = Math.max(vx, bounds.minX - padX);
    const y = Math.max(vy, bounds.minY - padY);
    const right = Math.min(vx + vw, bounds.maxX + padX);
    const bottom = Math.min(vy + vh, bounds.maxY + padY);
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  }

  function hitDistance(point, marker, extra = 10) {
    // `extra` e in pixeli CSS. Se converteste in unitati viewBox ca sa insemne aceeasi distanta
    // reala pe orice rezolutie de ecran.
    if (!state.view || !state.canvas) return Math.hypot(point.x - marker.x, point.y - marker.y) <= marker.radius + extra;
    const rect = state.canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? state.view.width / rect.width : 1;
    const toleranceInViewBox = extra * scale;
    return Math.hypot(point.x - marker.x, point.y - marker.y) <= marker.radius + toleranceInViewBox;
  }

  function ensureCanvas() {
    const host = $("#map");
    if (!host) return null;
    if (state.canvas && host.contains(state.canvas)) return state.canvas;
    // Un singur element canvas traieste pe toata durata paginii. Recrearea lui la
    // fiecare redesenare (host.replaceChildren() + createElement) lasa o fereastra in
    // care browserul poate compune vizual elementul vechi si cel nou suprapuse, in
    // timp ce pagina e in mijlocul unui scroll tactil real -- asta produce dedublarea
    // verticala observata pe dispozitiv (confirmata pe video 2026-08-12).
    host.replaceChildren();
    const canvas = document.createElement("canvas");
    canvas.className = "map-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Harta României cu știri pe județe și localități");
    canvas.style.touchAction = "pan-y";
    canvas.style.cursor = "pointer";
    host.appendChild(canvas);
    // Garda tap-vs-drag. Cu hit-test pe tot poligonul judetului, o atingere din timpul unei
    // derulari tactile ajunge la `click` si ar selecta un judet la intamplare -- adica am
    // repara desktopul stricand telefonul. Pragul de 10px e ordinea de marime a `touch slop`-ului.
    let downAt = null;
    canvas.addEventListener("pointerdown", (e) => {
      downAt = { x: e.clientX, y: e.clientY };
      // Pe touch nu exista hover inainte de atingere: prima atingere trebuie sa spuna ea
      // numele, altfel pe telefon tooltipul n-ar aparea niciodata la un tap simplu.
      if (e.pointerType !== "mouse") onCanvasHover(e);
    });
    canvas.addEventListener("pointercancel", () => { downAt = null; });
    canvas.addEventListener("click", (event) => {
      const moved = downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 10;
      downAt = null;
      if (!moved) onCanvasClick(event);
    });
    // Tooltipul cu numele UAT-ului. `role=status` + `aria-live` il face sa fie citit si de
    // cititoarele de ecran, care altfel n-ar avea de unde sti peste ce unitate esti.
    const tip = document.createElement("div");
    tip.className = "map-tip";
    tip.hidden = true;
    tip.setAttribute("role", "status");
    tip.setAttribute("aria-live", "polite");
    host.appendChild(tip);
    state.tip = tip;

    // Mouse pe desktop si deget pe Android trec amandoua prin Pointer Events, deci un singur
    // set de handlere acopera ambele cazuri. Pe touch, `pointerdown` da raspunsul la prima
    // atingere, iar `pointermove` il tine actualizat cat timp degetul aluneca pe harta.
    canvas.addEventListener("pointermove", onCanvasHover);
    canvas.addEventListener("pointerleave", clearCanvasHover);
    canvas.addEventListener("pointercancel", clearCanvasHover);
    state.canvas = canvas;

    // Butonul "Arata toate judetele" din bara de deasupra hartii iese din ecran pe mobil
    // dupa ce utilizatorul deruleaza ca sa vada harta marita -- fara alta cale de intoarcere
    // vizibila, harta pare "blocata" pe judetul selectat (raportat 2026-08-12). Ancora asta
    // traieste LANGA harta, deci ramane la indemana indiferent cat s-a derulat.
    const back = document.createElement("button");
    back.type = "button";
    back.className = "map-back";
    back.textContent = "← Toate județele";
    back.hidden = true;
    back.addEventListener("click", resetSelection);
    host.appendChild(back);
    state.backButton = back;

    return canvas;
  }

  // isPointInPath/isPointInStroke citesc transformarea CURENTA a contextului, nu una salvata.
  // buildMap() o lasa setata la final, dar asta e o coincidenta de ordine, nu o garantie: orice
  // desen intercalat ar rupe hit-testul silentios -- nu crapa, doar nu mai nimereste. De-aia
  // desenul si hit-testul trec amandoua prin functia asta.
  function applyViewTransform(ctx, canvas, view) {
    ctx.setTransform(
      canvas.width / view.width, 0, 0, canvas.height / view.height,
      -view.x * canvas.width / view.width, -view.y * canvas.height / view.height,
    );
  }

  function buildMap() {
    const host = $("#map");
    if (!host || !state.map) return;
    const canvas = ensureCanvas();
    if (!canvas) return;

    const rect = host.getBoundingClientRect();
    const viewBox = String(state.map.viewbox).trim().split(/\s+/).map(Number);
    const [vx, vy, vw, vh] = viewBox.length === 4 ? viewBox : [0, 0, 1000, 700];
    const view = selectedView(vx, vy, vw, vh);
    const cssWidth = Math.max(1, rect.width - 8);
    const cssHeight = Math.max(1, Math.min(720, cssWidth * view.height / view.width));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D nu este disponibil.");
    const palette = colors();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    applyViewTransform(ctx, canvas, view);
    ctx.fillStyle = palette.surface;
    ctx.fillRect(view.x, view.y, view.width, view.height);

    const counts = new Map();
    for (const item of state.visible) {
      const key = state.level === "regional" ? item.region : item.county;
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const regions = state.map?.regiuni || {};
    const regionForCounty = (county) => Object.entries(regions)
      .find(([, counties]) => counties.includes(county))?.[0] || "";

    const paths = [];
    for (const [county, pathData] of Object.entries(state.counties)) {
      const region = regionForCounty(county);
      const count = counts.get(state.level === "regional" ? region : county) || 0;
      // Judetul deschis se deseneaza din silueta UAT-urilor lui, ca sa se potriveasca exact
      // cu ele (vezi buildCountyOutline). Restul judetelor raman pe conturul Natural Earth:
      // acolo nu se vede niciun UAT, deci nu exista cu ce sa nu se potriveasca.
      const outline = county === state.zoomCounty ? countyOutline(county) : null;
      let path;
      if (outline) {
        path = outline.path2d;
      } else {
        try { path = new Path2D(pathData); } catch { continue; }
      }
      const hasNews = count > 0;
      // `matchesSearch` a fost STERS, nu reparat. Era o constanta recalculata de 42 de ori
      // (nu continea `county`), deci o cautare potrivita doar pe titlu stingea toata harta.
      // Dar nici versiunea per-judet nu era corecta: la o cautare care nu e un loc ("accident")
      // ar fi stins tot, desi lista arata 15 rezultate -- harta si lista ar fi spus lucruri
      // diferite. Regula corecta e mai simpla: harta arata geografia listei vizibile, atat.
      // De ce e un articol in lista se explica in ORDINE (potrivirile de loc primele) si in
      // eticheta din antet ("N potriviri de loc"), nu stingand harta.
      const selected = state.selectedCounty === county
        || (state.selectedRegion && state.selectedRegion === region);
      const outsideSelection = (state.selectedCounty && county !== state.selectedCounty)
        || (state.selectedRegion && region !== state.selectedRegion);
      const dimmed = Boolean(outsideSelection || !hasNews);

      ctx.globalAlpha = dimmed ? 0.32 : 1;
      // În modul regional, culorile distincte și etichetele fac vizibilă delimitarea
      // regiunilor editoriale; în celelalte moduri se păstrează harta neutră actuală.
      ctx.fillStyle = selected ? palette.accentSoft
        : state.level === "regional" ? regionFill(region, palette.fill) : palette.fill;
      // Silueta e o reuniune de subcai (cate una per UAT), deci cere "evenodd" ca sa nu se
      // umple gaurile dintre ele; conturul simplu de judet se umple la fel de bine asa.
      ctx.fill(path, "evenodd");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = palette.stroke;
      ctx.lineWidth = 1.2;
      ctx.stroke(path);
      paths.push({ county, region, path, count, bounds: pathBounds(outline ? outline.d : pathData) });
    }

    if (state.level === "regional") {
      const labels = new Map();
      for (const entry of paths) {
        if (!entry.bounds || !entry.region) continue;
        const current = labels.get(entry.region) || { x: 0, y: 0, n: 0, count: entry.count };
        current.x += (entry.bounds.minX + entry.bounds.maxX) / 2;
        current.y += (entry.bounds.minY + entry.bounds.maxY) / 2;
        current.n += 1;
        current.count = entry.count;
        labels.set(entry.region, current);
      }
      for (const [region, label] of labels) {
        if (!label.n) continue;
        const x = label.x / label.n;
        const y = label.y / label.n;
        ctx.fillStyle = palette.text;
        ctx.font = "800 13px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(region, x, y - 10);
        if (label.count) {
          ctx.font = "800 11px sans-serif";
          ctx.fillText(String(label.count), x, y + 8);
        }
      }
    }

    drawUats(ctx, palette, canvas, view);

    if (!state.zoomCounty && state.level !== "regional") {
      for (const entry of paths) {
        if (!entry.count || !entry.bounds) continue;
        const p = {
          x: (entry.bounds.minX + entry.bounds.maxX) / 2,
          y: (entry.bounds.minY + entry.bounds.maxY) / 2,
        };
        const radius = Math.max(7, Math.min(18, 6 + Math.sqrt(entry.count) * 1.8));
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = palette.hot;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = palette.surface;
        ctx.stroke();
        ctx.fillStyle = palette.text;
        ctx.font = "800 11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(entry.count), p.x, p.y);
        entry.marker = { x: p.x, y: p.y, radius };
      }
    }

    const localityMarkers = [];
    // UAT-urile au prioritate vizuală: când geometria lor este disponibilă, cifra de pe
    // poligon este informația relevantă; markerii de localitate ar dubla aceeași valoare.
    if (state.zoomCounty && !state.uats.length) {
      const groups = new Map();
      for (const item of state.visible) {
        if (item.county !== state.zoomCounty || item.x == null || item.y == null) continue;
        const x = Number(item.x);
        const y = Number(item.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const coordinateKey = `${x.toFixed(4)}|${y.toFixed(4)}`;
        const siruta = item.siruta ? String(item.siruta) : "";
        const locality = item.locality || item.county;
        const key = siruta || `${norm(locality)}|${norm(item.county)}`;
        const group = groups.get(key) || {
          x, y, locality, county: item.county, siruta, count: 0, coordinateKey,
        };
        group.count += 1;
        groups.set(key, group);
      }

      // Different SIRUTA records can legitimately share a point. Keep one visual
      // marker, but preserve every locality identity so a click cannot select the wrong one.
      const byCoordinate = new Map();
      for (const group of groups.values()) {
        const existing = byCoordinate.get(group.coordinateKey);
        if (existing) {
          existing.count += group.count;
          existing.localities.push(group.locality);
          existing.sirutas.push(group.siruta);
        } else {
          byCoordinate.set(group.coordinateKey, {
            ...group,
            localities: [group.locality],
            sirutas: [group.siruta],
          });
        }
      }

      for (const group of byCoordinate.values()) {
        const radius = Math.max(5, Math.min(14, 4 + Math.sqrt(group.count) * 1.7));
        ctx.beginPath();
        ctx.arc(group.x, group.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = palette.locality;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = palette.surface;
        ctx.stroke();
        ctx.fillStyle = palette.surface;
        ctx.font = "800 9px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(group.count), group.x, group.y);
        localityMarkers.push({ ...group, radius });
      }
    }

    // Salvate pe state, nu pe closure: handler-ul de click e legat o singura data pe
    // canvas (in ensureCanvas), asa ca citeste mereu ultimul rezultat aici.
    state.view = view;
    state.paths = paths;
    state.localityMarkers = localityMarkers;
    if (state.backButton) {
      const hasSelection = Boolean(state.selectedRegion || state.selectedCounty || state.selectedLocality);
      state.backButton.hidden = !hasSelection;
      state.backButton.textContent = state.selectedLocality ? "← Județul selectat"
        : state.selectedCounty ? "← Toate județele" : "← Toate regiunile";
    }
  }

  function pointForEvent(canvas, view, event) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: view.x + ((event.clientX - r.left) / r.width) * view.width,
      y: view.y + ((event.clientY - r.top) / r.height) * view.height,
    };
  }

  // isPointInPath/isPointInStroke aplica transformarea CAII, nu PUNCTULUI: x,y se citesc in
  // pixeli de canvas (verificat 2026-08-14 pe Chromium -- vezi IZZ-0193). Bulinele se compara in
  // spatiul viewBox (`pointForEvent`), poligoanele in pixeli de canvas -- doua spatii, doua
  // functii, ca sa nu se mai amestece. Greseala trecea neobservata pe desktop, unde canvasul are
  // ~820px iar viewBox-ul ~1000 de unitati: punctul cadea alaturi, dar tot pe uscat. Pe telefon
  // canvasul are 364px, deci un punct de 900 cadea in afara panzei si nu nimerea niciodata.
  function devicePointForEvent(canvas, event) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: ((event.clientX - r.left) / r.width) * canvas.width,
      y: ((event.clientY - r.top) / r.height) * canvas.height,
    };
  }

  function closestHit(point, candidates, markerOf) {
    // Bulinele apropiate se pot suprapune (ex. judete mici, grupate). Alegerea primei
    // care intra in raza de atingere, indiferent de distanta reala, face ca un tap langa
    // o grupare sa "sara" mereu pe ACEEASI buline -- de-aia harta parea blocata pe un
    // singur judet, oricat de aproape ai fi apasat de altul. Se alege cea mai apropiata.
    let best = null;
    let bestDist = Infinity;
    for (const candidate of candidates) {
      const marker = markerOf(candidate);
      if (!marker || !hitDistance(point, marker)) continue;
      const dist = Math.hypot(point.x - marker.x, point.y - marker.y);
      if (dist < bestDist) { bestDist = dist; best = candidate; }
    }
    return best;
  }

  // Cascada de hit-test, de la intentia cea mai precisa la cea mai iertatoare. WCAG 2.2 SC 2.5.8
  // excepteaza explicit hartile digitale de la minimul de 24x24px ("Essential"): raza bulinei
  // CODEAZA volumul de stiri, deci marirea ei uniforma ar sterge informatia. Calea corecta e
  // zona de atins mai mare decat desenul -- exact ce recomanda si Apple HIG (44pt) si Material
  // (48dp): pictograma ramane mica, zona din jurul ei creste.

  function countyAtPoint(ctx, point) {
    const inside = state.paths.find((e) => e.count > 0 && ctx.isPointInPath(e.path, point.x, point.y));
    if (inside) return inside;
    // Toleranta pe contur pentru judetele mici (Ilfov, Bucuresti): 10px CSS, transformata in
    // unitati viewBox ca sa insemne aceeasi distanta reala pe orice ecran. `lineWidth` se umfla
    // DOAR pentru interogare si se reseteaza imediat, deci desenul nu se schimba deloc.
    const edgeToleranceCss = 10; // pixeli CSS
    const scale = state.canvas && state.canvas.getBoundingClientRect().width > 0
      ? state.view.width / state.canvas.getBoundingClientRect().width
      : 1;
    const edgeToleranceViewBox = edgeToleranceCss * scale;
    const previous = ctx.lineWidth;
    ctx.lineWidth = edgeToleranceViewBox;
    try {
      return state.paths.find((e) => e.count > 0 && ctx.isPointInStroke(e.path, point.x, point.y)) || null;
    } finally {
      ctx.lineWidth = previous;
    }
  }

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
    const loc = Array.isArray(state.selectedLocality)
      ? state.selectedLocality
      : (state.selectedLocality ? [state.selectedLocality] : []);
    // Mai multe localitati pot cadea pe acelasi marker; toate intra in link, altfel cel care
    // deschide adresa vede mai putine stiri decat cel care a trimis-o.
    if (loc.length) params.set("loc", loc.join("|"));
    if (state.search) params.set("q", state.search);
    const query = params.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }

  function stateFromUrl() {
    const params = new URLSearchParams(location.search);
    const loc = params.get("loc");
    return {
      level: params.get("nivel") || "all",
      viewMode: params.get("mod") === "articles" ? "articles" : "events",
      region: params.get("regiune") || null,
      county: params.get("judet") || null,
      locality: loc ? loc.split("|").filter(Boolean) : null,
      query: params.get("q") || "",
    };
  }

  function applyState(patch, { push = true, replace = false } = {}) {
    if ("level" in patch) state.level = patch.level || "all";
    if ("viewMode" in patch) state.viewMode = patch.viewMode === "articles" ? "articles" : "events";
    if ("region" in patch) state.selectedRegion = patch.region || null;
    if ("county" in patch) state.selectedCounty = patch.county || null;
    if ("locality" in patch) state.selectedLocality = patch.locality || null;
    if ("query" in patch) state.search = patch.query || "";
    // `zoomCounty` nu e stare independenta, e derivata: la nivel Judetean click-ul filtreaza
    // fara sa mareasca (decizie proprietar, 13 aug). Tinuta separat, se desincroniza.
    state.zoomCounty = state.selectedCounty && !["judetean", "regional"].includes(state.level)
      ? state.selectedCounty : null;
    state.listLimit = 120;
    state.rawVisible = filtered();
    state.visible = itemsForView(state.rawVisible);
    syncUats();

    const search = $("#map-search");
    if (search && search.value !== state.search) search.value = state.search;
    syncLevelButtons();
    syncViewButtons();
    buildMap();
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

  function selectCounty(county) {
    applyState({ region: null, county, locality: null });
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

    // După alegerea unui județ, selectorul devine lista UAT-urilor acelui județ care au
    // știri în filtrul curent. Fiecare buton deschide aceeași listă de știri ca badge-ul de hartă.
    if (state.zoomCounty && state.uats.length) {
      const uats = state.uats.filter((uat) => uat.count > 0)
        .sort((a, b) => String(a.label).localeCompare(String(b.label), "ro"));
      picker.setAttribute("aria-label", `UAT-uri cu știri în ${state.zoomCounty}`);
      if (!uats.length) {
        const empty = document.createElement("p");
        empty.className = "picker-empty";
        empty.textContent = `Nu există știri localizate pe UAT-uri în ${state.zoomCounty} pentru filtrul curent.`;
        picker.appendChild(empty);
        return;
      }
      for (const uat of uats) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.uat = uat.id || uat.name;
        button.setAttribute("aria-haspopup", "dialog");
        button.textContent = `${uat.label || "UAT"} · ${uat.count}`;
        button.addEventListener("click", () => openUatDialog(uat, button));
        // Legatura merge in ambele sensuri: peste forma de pe harta se aprinde randul din
        // lista, iar peste randul din lista se aprinde forma. Altfel lista si harta ar fi
        // doua liste de nume care nu se stiu una pe alta.
        const setHover = (value) => {
          if (state.hoverUat === value) return;
          state.hoverUat = value;
          syncUatHighlight();
          buildMap();
        };
        button.addEventListener("pointerenter", () => setHover(uat));
        button.addEventListener("pointerleave", () => setHover(null));
        button.addEventListener("focus", () => setHover(uat));
        button.addEventListener("blur", () => setHover(null));
        picker.appendChild(button);
        if (button.dataset.uat === focusedKey) button.focus();
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
    picker.setAttribute("aria-label", isRegional ? "Alege regiunea" : "Alege județul");
    for (const key of Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, "ro"))) {
      const button = document.createElement("button");
      button.type = "button";
      if (isRegional) button.dataset.region = key;
      else button.dataset.county = key;
      button.textContent = `${key} · ${counts.get(key)}`;
      const selected = isRegional ? key === state.selectedRegion : key === state.selectedCounty;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.addEventListener("click", () => (isRegional ? selectRegion(key) : selectCounty(key)));
      picker.appendChild(button);
      if (key === focusedKey) button.focus();
    }
  }

  // Acelasi hit-test pe care il foloseste si clickul, scos separat ca hover-ul sa nu-l
  // duplice: doua copii ale regulii ar putea ajunge sa arate un nume si sa deschida altul.
  function uatAtPoint(event) {
    const canvas = state.canvas;
    const view = state.view;
    if (!canvas || !view || !state.zoomCounty || !state.uats.length) return null;
    const ctx = canvas.getContext("2d");
    const dp = devicePointForEvent(canvas, event);
    if (!ctx || !dp) return null;
    applyViewTransform(ctx, canvas, view);
    return state.uats.find((unit) => ctx.isPointInPath(unit.path2d, dp.x, dp.y, "evenodd")) || null;
  }

  // Numele UAT-ului sub cursor sau sub deget. Pana acum harta nu spunea nicaieri peste ce
  // esti: aflai abia dupa ce dadeai click si se deschidea dialogul.
  function onCanvasHover(event) {
    const uat = uatAtPoint(event);
    if (uat !== state.hoverUat) {
      state.hoverUat = uat;
      syncUatHighlight();
      buildMap();
    }
    showMapTip(uat, event);
  }

  function clearCanvasHover() {
    if (state.hoverUat) {
      state.hoverUat = null;
      syncUatHighlight();
      buildMap();
    }
    showMapTip(null, null);
  }

  function showMapTip(uat, event) {
    const tip = state.tip;
    const canvas = state.canvas;
    if (!tip) return;
    if (!uat || !event || !canvas) {
      tip.hidden = true;
      tip.textContent = "";
      return;
    }
    const count = uat.count || 0;
    tip.textContent = count
      ? `${uat.label || uat.name} · ${count} ${itemLabelFor(count)}`
      : `${uat.label || uat.name}`;
    tip.hidden = false;
    // Pozitionare relativa la gazda hartii, tinuta in interiorul ei: langa marginea din
    // dreapta un tooltip ancorat la cursor ar iesi din ecran, iar pe telefon exact acolo
    // ajunge degetul cel mai des.
    const host = canvas.parentElement;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
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

  function onCanvasClick(event) {
    const canvas = state.canvas;
    const view = state.view;
    if (!canvas || !view) return;
    const p = pointForEvent(canvas, view, event);
    if (!p) return;
    if (state.zoomCounty) {
      const marker = closestHit(p, state.localityMarkers, (m) => m);
      if (marker) {
        // Filtrarea pe localitate are camp propriu de stare. Inainte se facea scriind
        // localitatea in `#map-search`, ceea ce stergea ce tastase utilizatorul SI aducea,
        // prin cautarea in titluri, articole din alte judete care doar o pomeneau.
        // Daca mai multe localitati cad exact pe acelasi punct (deduplicare vizuala), se
        // filtreaza pe TOATE, nu doar pe prima.
        applyState({ locality: marker.localities || [marker.locality] });
        return;
      }
      // Un click pe poligonul UAT selectează localitățile care au generat cifra din acel UAT.
      // Astfel cifra nu este doar decorativă: păstrează aceeași interacțiune ca markerii locali.
      const ctx = canvas.getContext("2d");
      const dp = devicePointForEvent(canvas, event);
      if (!ctx || !dp) return;
      applyViewTransform(ctx, canvas, view);
      const uat = closestHit(p, state.uats.filter((unit) => unit.count > 0), (unit) => unit.marker)
        || state.uats.find((unit) => unit.count > 0
          && ctx.isPointInPath(unit.path2d, dp.x, dp.y, "evenodd"));
      if (uat?.items?.length) openUatDialog(uat, canvas);
    } else {
      // Transformarea se reafirma explicit inainte de hit-test: buildMap() o lasa setata, dar
      // a te baza pe ordinea apelurilor face hit-testul sa cada silentios la prima schimbare.
      const ctx = canvas.getContext("2d");
      applyViewTransform(ctx, canvas, view);
      const dp = devicePointForEvent(canvas, event);
      const entry = closestHit(p, state.paths, (e) => e.marker)
        || (dp && countyAtPoint(ctx, dp));
      if (entry) {
        if (state.level === "regional") {
          const regions = state.map?.regiuni || {};
          const region = Object.entries(regions).find(([, counties]) => counties.includes(entry.county))?.[0];
          if (region) selectRegion(region);
        } else {
          selectCounty(entry.county);
        }
      }
    }
  }

  function contextName() {
    if (state.selectedLocality) return Array.isArray(state.selectedLocality)
      ? state.selectedLocality.join(", ") : state.selectedLocality;
    if (state.selectedCounty) return state.selectedCounty;
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

  function renderList() {
    const list = $("#news-list");
    if (!list) return;
    const all = state.visible;
    const items = all.slice(0, state.listLimit);
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = state.search
        ? `Nu am găsit rezultate pentru „${state.search}” în contextul ales. Elimină un filtru sau resetează harta.`
        : "Nu există rezultate pentru filtrele selectate. Elimină un filtru sau resetează harta.";
      list.appendChild(empty);
    }
    for (const item of items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = articleUrl(item);
      a.textContent = item.title || "Fără titlu";
      const meta = document.createElement("span");
      const source = item.source_name || item.source;
      meta.textContent = [item.locality, item.county, item.region, source, dateLabel(item.published)]
        .filter(Boolean).join(" · ");
      li.append(a, meta);
      if (state.viewMode === "events" && item.eventArticleCount > 1) {
        const context = document.createElement("span");
        context.className = "event-context";
        context.textContent = `${item.eventArticleCount} relatări · ${item.eventSourceCount} surse despre același eveniment`;
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
    $$(".segmented [data-view]").forEach((button) => {
      const active = button.dataset.view === state.viewMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
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
    applyState({ region: null, county: null, locality: null });
  }

  function resetAll() {
    applyState({ level: "all", viewMode: "events", region: null, county: null, locality: null, query: "" });
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
    const showMore = $("#show-more");
    if (showMore) showMore.addEventListener("click", () => {
      state.listLimit += 120;
      renderList();
      announceState();
    });
    if (clear) clear.addEventListener("click", resetSelection);
    if (reset) reset.addEventListener("click", resetAll);
    const dialog = $("#uat-dialog");
    const closeDialog = $("#uat-dialog-close");
    if (closeDialog) closeDialog.addEventListener("click", () => closeUatDialog());
    if (dialog) dialog.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-uat-close]")) closeUatDialog();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeUatDialog();
    });
    window.addEventListener("popstate", () => applyState(stateFromUrl(), { push: false }));
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
      // latimea -- fara garda asta, fiecare din acele evenimente redeschide un canvas
      // nou in mijlocul unui scroll, ceea ce e cauza dedublarii vizuale (vezi ensureCanvas).
      if (width === lastWidth) return;
      lastWidth = width;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        buildMap();
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
    let response;
    try {
      response = await fetch(DATA_URL, { cache: "no-store", signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`map.json HTTP ${response.status}`);
    const data = await response.json();
    state.data = data;
    state.map = data.map || {};
    state.counties = state.map.judete || {};
    state.articles = Array.isArray(data.articles) ? data.articles : [];
    // Starea din adresa se aplica INAINTE de prima desenare, altfel harta apare o clipa
    // nefiltrata si abia apoi sare pe judetul din link.
    applyState(stateFromUrl(), { push: false });
    bindResize();
  }

  init().catch(showLoadError);
})();