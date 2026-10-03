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
    // datele. Fara garda asta, fiecare frame de pan ar rula sute de isPointInPath.
    uatCountsDirty: true,
    // UAT-ul selectat, ca orice alt filtru (audit harta, P0: click = selectare, nu fereastra
    // separata): cheia lui (cod SIRUTA sau nume) traieste in adresa (?judet=X&uat=Y), Back/
    // Forward il anuleaza/restabileste, iar panoul lateral arata stirile lui. `pendingUat`
    // tine intentia pana cand asignarea geometrica e posibila (UAT-urile judetului incarcate
    // + canvas dimensionat) -- pana atunci panoul primeste mesajul de incarcare, nu o lista
    // inselatoare.
    selectedUat: null,
    pendingUat: null,
    // Fly-to: în timpul animației de apropiere, vederea e dictată de interpolare
    // (flyView), nu de stare. flyToken anulează animația anterioară când pornește alta.
    flyView: null,
    flyToken: 0,
    // Fetchuri de siluete UAT pentru vecini, în zbor (dedup per județ).
    neighborFetches: new Set(),
  };

  const REGION_FILLS = {
    "Transilvania": "#cddccd",
    "Muntenia": "#f1e2c3",
    "Moldova": "#cddfe9",
    "Banat": "#e3d3e6",
    "Dobrogea": "#eee0a6",
    "Oltenia": "#efcabf",
    "Bucovina": "#d0d7ee",
  };

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
      // Textul PESTE suprafetele pline de accent (buline, badge-uri): alb pe auriu masura
      // 3.15:1 in tema deschisa, sub minimul WCAG de 4.5:1 -- de-aia vine din variabile
      // dedicate, nu din --text/--surface.
      onAccent: styles.getPropertyValue("--map-on-accent").trim() || "#171717",
      badgeText: styles.getPropertyValue("--map-badge-text").trim() || "#171717",
      // Treptele choropleth h0-h4 (h0 = fără știri) + haloul de silueta + bordura internă.
      // Vin din variabile, ca tema dark să fie o primă cetățeană, nu o excepție.
      h: [
        styles.getPropertyValue("--map-h0").trim() || "#f2f0e8",
        styles.getPropertyValue("--map-h1").trim() || "#f1e3b6",
        styles.getPropertyValue("--map-h2").trim() || "#e4c46a",
        styles.getPropertyValue("--map-h3").trim() || "#c2911c",
        styles.getPropertyValue("--map-h4").trim() || "#7a5a10",
      ],
      halo: styles.getPropertyValue("--map-halo").trim() || "#d9d5c7",
      inner: styles.getPropertyValue("--map-inner").trim() || "#ffffff",
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
    fetch(`./data/uat/${encodeURIComponent(county)}.json`)
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
        state.uatCountsDirty = true;
        // Vecinii, în fundal: siluetele lor UAT înlocuiesc conturul Natural Earth în
        // vederea de județ, ca granițele comune să se potrivească prin construcție.
        loadNeighborOutlines(county);
      })
      .catch(() => {
        if (state.uatCounty === county && state.uatRequestId === requestId) state.uats = [];
      })
      .finally(() => {
        if (state.uatCounty === county && state.uatRequestId === requestId) {
          state.uatLoading = false;
          // buildMap face si aplicarea selectiei de UAT (asignarea geometrica abia acum e
          // posibila), apoi renderList o prezinta in panou.
          buildMap();
          renderList();
          announceState();
        }
      });
  }

  // Asignarea articolelor la UAT-uri se face din `rawVisible`, NU din `visible`: selectia de
  // UAT restrange `visible` pe baza asignarii, deci daca asignarea s-ar calcula din el,
  // selectia s-ar auto-hrani -- la a doua trecere toate celelalte UAT-uri ar cadea pe 0.
  function countUatNews(ctx, canvas, view) {
    if (!state.zoomCounty || !state.uats.length) return;
    for (const uat of state.uats) {
      uat.count = 0;
      uat.localities = [];
      uat.items = [];
    }
    for (const item of state.rawVisible) {
      if (item.county !== state.zoomCounty) continue;
      // Asignarea DETERMINISTA bate geometria: `uat` vine din SIRUTA la build (satul ->
      // UAT-ul parinte, campul `uat` din map.json). smallestUatAt intoarce tot comuna
      // gresita cand satul sta in raza poligonului mic vecin: masurat 3 oct 2026, 106
      // puncte (Apuseni preponderent) erau asignate comunei vecine si dupa fixul
      // min-poligon. x/y nu mai e obligatoriu: localitatea e cunoscuta si cand punctul
      // ei lipseste din stratul de puncte.
      let uat = item.uat ? state.uats.find((unit) => String(unit.id) === String(item.uat)) : null;
      if (!uat && item.x != null && item.y != null) {
        const point = devicePointFromMap(canvas, view, Number(item.x), Number(item.y));
        if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
          uat = smallestUatAt(ctx, point.x, point.y);
        }
      }
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

  // In zonele de suprapunere reziduale dintre UAT-uri, poligonul cel mai MIC care acopera
  // punctul castiga -- acelasi principiu ca la enclava Bucuresti/Ilfov in countyFillAtPoint:
  // acolo e singura intentie geometrica posibila, iar asignarea stirilor trebuie sa o urmeze,
  // altfel lista si hit-testul harti ar spune lucruri diferite. Auditul geometric din 2 oct
  // a masurat 104 puncte de localitate care cadeau in suprapunerea vecinilor si luau
  // „primul poligon care acopera" -- adica comuna gresita la prima stire din ele.
  function smallestUatAt(ctx, x, y) {
    let best = null;
    let bestArea = Infinity;
    for (const unit of state.uats) {
      if (!ctx.isPointInPath(unit.path2d, x, y, "evenodd")) continue;
      const bounds = pathBounds(unit.path);
      const area = bounds ? (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY) : 0;
      if (area < bestArea) {
        bestArea = area;
        best = unit;
      }
    }
    return best;
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

  // Vecinii geografici ai județului deschis: intersectarea dreptunghiurilor împadritoare
  // cu o margine de 35% din mărimea județului. Nu e o listă de adiacență reală, e o
  // supraproximare deliberată — un vecin în plus costă un fetch mic (fișier ~50 KB,
  // cache HTTP implicit), o graniță nealiniată costă încrederea în hartă.
  function neighborCountiesFor(county) {
    const self = state.counties[county] ? pathBounds(state.counties[county]) : null;
    if (!self) return [];
    const padX = (self.maxX - self.minX) * 0.35;
    const padY = (self.maxY - self.minY) * 0.35;
    const out = [];
    for (const other of Object.keys(state.counties)) {
      if (other === county) continue;
      const b = pathBounds(state.counties[other]);
      if (!b) continue;
      if (b.minX > self.maxX + padX || b.maxX < self.minX - padX) continue;
      if (b.minY > self.maxY + padY || b.maxY < self.minY - padY) continue;
      out.push(other);
    }
    return out;
  }

  // Silueta UAT pentru un vecin, în fundal: vine din ACEEAȘI sursă oficială ca județul
  // deschis, deci granița comună se potrivește prin construcție. Eșecul e tăcut și
  // acceptabil: vecinul rămâne pe conturul Natural Earth, exact ca înainte de fix.
  // Cache-ul e cel implicit al browserului (revalidare ETag după max-age), nu force-cache:
  // după un rebuild al geometriei, copia veche din cache nu trebuie să supraviețuiască
  // mai mult de fereastra serverului.
  function loadNeighborOutline(county) {
    if (state.uatOutlineCache.has(county) || state.uatCache.has(county)) return;
    if (state.neighborFetches.has(county)) return;
    state.neighborFetches.add(county);
    fetch(`./data/uat/${encodeURIComponent(county)}.json`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        const units = Array.isArray(data?.uats) ? data.uats.map((unit) => ({
          ...unit,
          path2d: new Path2D(unit.path || ""),
          count: 0,
          localities: [],
          items: [],
        })) : [];
        state.uatCache.set(county, units);
        state.uatOutlineCache.set(county, buildCountyOutline(units, county));
        // Silueta contează doar în vederea de județ; acolo o redesenare o pune în lactă.
        if (state.zoomCounty) buildMap();
      })
      .catch(() => {})
      .finally(() => state.neighborFetches.delete(county));
  }

  function loadNeighborOutlines(county) {
    for (const neighbor of neighborCountiesFor(county)) loadNeighborOutline(neighbor);
  }

  function drawUats(ctx, palette, canvas, view) {
    if (!state.zoomCounty || !state.uats.length) return;
    // Asignarea item-UAT e INVARIANTA la zoom/pan (geometria nu se misca): se recalculeaza
    // doar cand se schimba datele (filtre, UAT-uri nou incarcate). Fara garda asta,
    // fiecare frame de pan ar rerula sute de isPointInPath si panul ar sacada.
    if (state.uatCountsDirty) {
      countUatNews(ctx, canvas, view);
      state.uatCountsDirty = false;
    }
    // Scara choropleth pentru UAT-uri: cuartele volumului județului curent, aceeași
    // formulă ca la nivel național și ca mini-harta (praguriFor/rampClassFor).
    const uatMax = Math.max(0, ...state.uats.map((unit) => unit.count));
    const uatPraguri = praguriFor(uatMax);
    updateLegend(uatPraguri, uatMax, { show: Boolean(state.uats.length) });
    for (const uat of state.uats) {
      // UAT-ul de sub cursor/deget se ingroasa si prinde contur de accent: fara asta,
      // tooltipul spune un nume dar nu se vede CARE forma de pe harta il poarta.
      const hovered = uat === state.hoverUat;
      // Selectia e persistenta, hover-ul e trecutor: UAT-ul ales prinde accentul, restul
      // se estompeaza mai puternic decat simpla lipsa de stiri, ca sa se vada CE e selectat.
      const isSelected = state.selectedUat === String(uat.id || uat.name);
      const dimmedBySelection = Boolean(state.selectedUat) && !isSelected;
      // Umplerea PLINE e decizie de contrast masurata: accentSoft la alpha mic nu separa
      // doua stari adiacente (1.08:1 pe alb, sesizat de proprietar pe live). Pe choropleth
      // umplerea duce volumul pe toata forma — de la h0 (hartie rece) la h4 (brun inchis).
      const strongFill = Boolean(uat.count);
      ctx.globalAlpha = dimmedBySelection ? 0.12 : 1;
      ctx.fillStyle = strongFill ? palette.h[rampClassFor(uat.count, uatPraguri)]
        : hovered ? palette.accentSoft : palette.h[0];
      ctx.fill(uat.path2d, "evenodd");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = hovered || isSelected ? palette.hot : palette.inner;
      ctx.lineWidth = hovered ? 2 : isSelected ? 2.4 : 0.9;
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
      // Badge INVERS față de înainte: pastilă albă cu cifră închisă, peste orice treaptă
      // a rampei — lizibil pe h1–h4 la fel ca pe h0 (auriu plin cu cifră închisă mergea,
      // dar cifrele plutite pe auriu formau mormanul vizual raportat de proprietar).
      ctx.fillStyle = palette.surface;
      ctx.fill();
      ctx.lineWidth = Math.min(1.2, Math.max(0.5, radius * 0.2));
      ctx.strokeStyle = palette.halo;
      ctx.stroke();
      ctx.fillStyle = palette.text;
      ctx.font = `800 ${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(uat.count), x, y);
      // Numele unitatii, sub badge, DOAR cand in propria forma e loc de text: clearance-ul
      // calculat pentru badge masoara spatiul liber pana la contur, deci e si masura spatiului
      // pentru eticheta. Fara garda asta, 99 de nume ar inunda vederea unui judet dens.
      const name = uat.label || uat.name;
      if (name && placement.clearance >= 7) {
        ctx.font = "700 8px sans-serif";
        ctx.textBaseline = "top";
        const ty = y + radius + 1.5;
        // Halo in culoarea fundalului, ca numele sa fie lizibil si peste granitele UAT-urilor.
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = palette.surface;
        ctx.strokeText(name, x, ty);
        ctx.fillStyle = palette.text;
        ctx.fillText(name, x, ty);
      }
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

  // --- scara choropleth --------------------------------------------------------------------
  // ACEEASI formula ca mini-harta din homepage (generator/mini_harta.py, fixul #382):
  // praguri = cuartele volumului maxim, deduplicate, fara 0; clasa = 1 + cate praguri
  // sunt STRICT sub count (c > p, nu c >= p). Doua feliuiaza aceeasi scara — homepage si
  // harta spun aceeasi poveste cu aceeasi culori.
  function praguriFor(max) {
    return [...new Set([1, 2, 3].map((q) => Math.floor(max * q / 4)))]
      .filter((p) => p > 0).sort((a, b) => a - b);
  }

  function rampClassFor(count, praguri) {
    if (!count) return 0;
    return Math.min(4, 1 + praguri.filter((p) => count > p).length);
  }

  function updateLegend(praguri, max, { show = true } = {}) {
    const legend = $("#map-legend");
    if (!legend) return;
    if (!show || !(max > 0)) {
      legend.hidden = true;
      legend.replaceChildren();
      return;
    }
    const p = praguri.length === 3 ? praguri : praguriFor(max);
    const steps = [
      { cls: "h0", label: "0" },
      { cls: "h1", label: p[0] > 1 ? `1–${p[0] - 1}` : "1" },
      { cls: "h2", label: `${p[0] + 1}–${p[1]}` },
      { cls: "h3", label: `${p[1] + 1}–${p[2]}` },
      { cls: "h4", label: `${p[2] + 1}+` },
    ];
    const title = document.createElement("span");
    title.className = "legend-title";
    title.textContent = "Volum de știri";
    legend.replaceChildren(title);
    for (const step of steps) {
      const cell = document.createElement("span");
      cell.className = "legend-step";
      const swatch = document.createElement("span");
      swatch.className = `swatch ${step.cls}`;
      swatch.setAttribute("aria-hidden", "true");
      cell.append(swatch, document.createTextNode(step.label));
      legend.appendChild(cell);
    }
    legend.hidden = false;
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

  // --- zoom si pan geometric (utilizator) -------------------------------------------------
  // Conventiile standard ale hartilor web: rotita si dublu-click zoom cu punctul de sub
  // cursor fix, tragere = pan; pe mobil o deget ramane scroll de pagina, doua degete
  // pinch/pan. Butoanele +/- sunt calea GARANTATA (tastatura/cititoare de ecran) si au
  // starea dezactivata expusa prin disabled + aria-disabled (evaluarea WCAG a hartilor
  // web semnaleaza exact aici un mod de esec frecvent).

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
    buildMap();
  }

  function panBy(dxBase, dyBase) {
    const base = state.baseView;
    if (!base || state.userZoom.k <= 1) return;
    const c = zoomCenter(base);
    const c2 = clampZoomCenter({ x: c.x - dxBase, y: c.y - dyBase }, base);
    state.userZoom = { k: state.userZoom.k, cx: c2.x, cy: c2.y };
    syncZoomControls();
    buildMap();
  }

  function syncZoomControls() {
    const z = state.userZoom || { k: 1 };
    if (state.zoomIn) {
      state.zoomIn.disabled = z.k >= ZOOM_MAX;
      state.zoomIn.setAttribute("aria-disabled", z.k >= ZOOM_MAX ? "true" : "false");
      state.zoomOut.disabled = z.k <= ZOOM_MIN;
      state.zoomOut.setAttribute("aria-disabled", z.k <= ZOOM_MIN ? "true" : "false");
      state.zoomReset.hidden = z.k <= ZOOM_MIN;
    }
    if (state.canvas) state.canvas.style.cursor = z.k > 1 ? "grab" : "pointer";
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
    // ACELASI prag desparte pan-ul de click la zoom>1: sub 10px e click, peste e pan.
    let downAt = null;
    let panFrom = null;
    let pinch = null;
    // Memoria gestului de dublu-click: primul click al unui dblclick se aplica deja ca
    // selectie (starea e imediata), deci dblclick-ul are nevoie de adresa de dinaintea
    // gestului ca sa o poata restabili si sa zoomeze curat. Se pastreaza PRIMA atingere a
    // gestului (click-2 al aceluiasi dblclick nu o suprascrie) si doar pe acelasi loc.
    let lastCanvasSelect = null;
    const touchPoints = new Map();
    const twoFingerState = () => {
      const [a, b] = [...touchPoints.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") {
        downAt = { x: e.clientX, y: e.clientY };
        if (state.userZoom.k > 1) {
          panFrom = { x: e.clientX, y: e.clientY };
          canvas.style.cursor = "grabbing";
        }
        return;
      }
      touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Pe touch nu exista hover inainte de atingere: prima atingere trebuie sa spuna ea
      // numele, altfel pe telefon tooltipul n-ar aparea niciodata la un tap simplu.
      if (touchPoints.size === 1) {
        // Garda tap-vs-drag are nevoie de punctul de plecare SI la atingere: doar mouse-ul
        // o seta, deci un click sintetizat la capatul unui gest de derulare trecea drept
        // tap si selecta un judet (masurat de garda mobila, 2 oct 2026).
        downAt = { x: e.clientX, y: e.clientY };
        onCanvasHover(e);
      }
      if (touchPoints.size === 2) {
        // Al doilea deget = gest de harta (pinch/pan): anuleaza tap-ul in asteptare.
        downAt = null;
        const s = twoFingerState();
        pinch = { d: s.d, mid: s.mid };
      }
    });
    canvas.addEventListener("pointercancel", () => {
      downAt = null;
      // Fara resetarea asta, un drag de mouse intrerupt de cancel lasa cursorul "grabbing"
      // si panFrom agatat -- gestul urmator porni de unde a ramas, nu de sub cursor.
      panFrom = null;
      touchPoints.clear();
      pinch = null;
      canvas.style.cursor = state.userZoom.k > 1 ? "grab" : "pointer";
    });
    canvas.addEventListener("click", (event) => {
      const moved = downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 10;
      downAt = null;
      if (!moved) {
        const now = performance.now();
        const sameSpot = lastCanvasSelect
          && Math.hypot(event.clientX - lastCanvasSelect.x, event.clientY - lastCanvasSelect.y) <= 10;
        if (!lastCanvasSelect || now - lastCanvasSelect.at > 600 || !sameSpot) {
          lastCanvasSelect = { at: now, prevSearch: location.search, x: event.clientX, y: event.clientY };
        }
        onCanvasClick(event);
      }
    });
    canvas.addEventListener("wheel", (event) => {
      if (!state.view || !state.baseView) return;
      // Pagina asta E o unealta de harta: rotita actioneaza pe harta, nu deruleaza pagina
      // (conventia standard pe harti dedicate, nu embedded in articole).
      event.preventDefault();
      takeUserView();
      const p = pointForEvent(canvas, state.view, event);
      zoomTo(state.userZoom.k * Math.exp(-event.deltaY * 0.0016), p);
    }, { passive: false });
    canvas.addEventListener("dblclick", (event) => {
      if (!state.view || !state.baseView) return;
      event.preventDefault();
      // Dublu-click = comanda de ZOOM (conventia hartilor web), nu selectie. Primul click
      // al gestului s-a aplicat deja ca selectie (starea e imediata), al doilea a intrat
      // pe UAT-ul de sub cursor -- ambele se anuleaza restabilind adresa de dinaintea
      // gestului, altfel zoomul ar lucra pe vederea de județ selectata de propriul sau
      // primul click (masurat: ×2 pe zona de UAT-uri fara stiri, aproape fara aur).
      if (lastCanvasSelect && performance.now() - lastCanvasSelect.at <= 600
          && Math.hypot(event.clientX - lastCanvasSelect.x, event.clientY - lastCanvasSelect.y) <= 10) {
        history.replaceState(null, "", lastCanvasSelect.prevSearch || location.pathname);
        applyState(stateFromUrl(), { push: false });
        lastCanvasSelect = null;
      }
      takeUserView();
      const p = pointForEvent(canvas, state.view, event);
      zoomTo(state.userZoom.k * 2, p);
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

    // Mouse pe desktop si deget pe Android trec amandoua prin Pointer Events. Un singur
    // dispatcher aici: mouse = hover/pan, touch = hover + pinch/pan cu doua degete (o
    // deget ramane al browserului -- scroll de pagina, touch-action: pan-y de pe canvas).
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") {
        if (panFrom && (e.buttons & 1) && downAt) {
          const dist = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
          if (dist >= 10) {
            const r = state.canvas.getBoundingClientRect();
            const dx = (e.clientX - panFrom.x) * state.view.width / r.width;
            const dy = (e.clientY - panFrom.y) * state.view.height / r.height;
            panFrom = { x: e.clientX, y: e.clientY };
            panBy(dx, dy);
            return;
          }
        }
        onCanvasHover(e);
        return;
      }
      if (!touchPoints.has(e.pointerId)) return;
      touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touchPoints.size >= 2) {
        const s = twoFingerState();
        takeUserView();
        const anchor = pointForEvent(state.canvas, state.view, { clientX: s.mid.x, clientY: s.mid.y });
        zoomTo(state.userZoom.k * s.d / pinch.d, anchor);
        pinch = { d: s.d, mid: s.mid };
        return;
      }
      if (touchPoints.size === 1) onCanvasHover(e);
    });
    canvas.addEventListener("pointerleave", clearCanvasHover);
    canvas.addEventListener("pointercancel", clearCanvasHover);
    canvas.addEventListener("pointerup", (e) => {
      if (e.pointerType !== "mouse") {
        touchPoints.delete(e.pointerId);
        if (touchPoints.size < 2) pinch = null;
      }
      panFrom = null;
      canvas.style.cursor = state.userZoom.k > 1 ? "grab" : "pointer";
    });
    state.canvas = canvas;

    // Butoanele de zoom: calea GARANTATA pentru marire/micsorare (tastatura, cititoare de
    // ecran), pe langa rotita si pinch. Tinte de 44px (WCAG 2.5.8 -- Exceptia Equivalent
    // e exact rolul lor).
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
    // Zoom si pan si din TASTATURA, pe grupul de controale: sagețile deplasează vederea
    // cand harta e mărită, +/- schimbă scara. Fara asta, un utilizator de tastatura poate
    // mări dar NU se poate misca -- exact golul pe care ghidurile de harti accesibile îl
    // semnalează (pan/zoom trebuie să răspundă pe toate input-urile). Săgeata = vederea
    // merge in direcția ei (centrul crește pe axa), ca în Leaflet.
    zoomBox.addEventListener("keydown", (event) => {
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (step && state.view && state.canvas) {
        event.preventDefault();
        const rect = state.canvas.getBoundingClientRect();
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
    host.appendChild(zoomBox);
    state.zoomIn = zin;
    state.zoomOut = zout;
    state.zoomReset = zreset;
    syncZoomControls();

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
    const base = selectedView(vx, vy, vw, vh);
    state.baseView = base;
    // În timpul fly-to-ului vederea e dictată de interpolare, nu de stare: animația
    // scrie state.flyView la fiecare cadru, iar starea reală se aplică la final —
    // ultimul cadru al animației coincide cu prima randare a stării noi.
    const view = state.flyView || zoomedView(base);
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
      // În vederea de județ TOATE județele se desenează din silueta UAT-urilor când e
      // disponibilă (cache populat de syncUats: județul deschis + vecinii lui). Silueta
      // oficială geo-spatial.org și conturul UAT provin din ACEEAȘI sursă, deci granita
      // comună se potrivește prin construcție; conturul Natural Earth e generalizat și
      // lăsa un canal vizibil între județul conturat auriu și vecini (audit 12 sep:
      // mediană 14px, max 44px). La nivel național rămân TOATE pe Natural Earth:
      // uniformitate de sursă, niciodată amestec.
      const outline = state.zoomCounty ? countyOutline(county) : null;
      let path;
      if (outline) {
        path = outline.path2d;
      } else {
        try { path = new Path2D(pathData); } catch { continue; }
      }
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
      // Estomparea pe niveluri: național/regional — județele în afara selecției. În
      // vederea de județ vecinii rămân VIZIBILI pe ton de hârtie (decizie proprietar,
      // 5 sep: „vreau să mă mut pe altul" nu trebuie să treacă prin butonul de
      // întoarcere) și se estompează doar când un UAT e selectat, ca alegerea să iasă.
      const isZoomedCounty = county === state.zoomCounty;
      const dim = isZoomedCounty ? 1
        : state.zoomCounty ? (state.selectedUat ? 0.25 : 1)
        : (outsideSelection ? 0.25 : 1);
      paths.push({ county, region, path, count, selected, dim,
        bounds: pathBounds(outline ? outline.d : pathData) });
    }
    // Choroplethul: pragurile se calculeaza din volumul VIZIBIL (filtrul curent), deci
    // scara urmareste ce priveste omul, nu corpusul intreg. Legenda spune acelasi lucru.
    const maxCount = Math.max(0, ...paths.map((e) => e.count));
    const praguri = praguriFor(maxCount);
    updateLegend(praguri, maxCount, { show: !state.zoomCounty && state.level !== "regional" });

    // Trei treceri, nu una: (1) contur lat deschis sub fiecare judet; (2) umplerea
    // choropleth; (3) bordura fina intre judete. Umplerea din trecerea 2 acopera haloul
    // din interior — haloul ramane vizibil DOAR pe marginea exterioara, unde nu are
    // vecin care sa-l acopere: silueta tarii iese dintr-un data, fara nicio geometrie noua.
    ctx.lineJoin = "round";
    // Haloul de silueta există doar la vederea largă: în vederea de județ conturul auriu
    // al județului deschis e singurul accent necesar, iar halourile cu opacitate plină
    // sângerau prin zonele estompute ale vecinilor și dublau bandă la granița externă
    // (raportat de proprietar pe live, 2 oct). Haloul respectă și el estomparea.
    if (!state.zoomCounty) {
      ctx.strokeStyle = palette.halo;
      ctx.lineWidth = 3;
      for (const entry of paths) {
        ctx.globalAlpha = entry.dim;
        ctx.stroke(entry.path);
      }
      ctx.globalAlpha = 1;
    }
    for (const entry of paths) {
      // Județele fără știri nu mai sunt „stinse" (alpha 0.32 inainte): primesc h0, hartia
      // rece a scalei — absența de știri e informație, nu defect de randare.
      ctx.globalAlpha = entry.dim;
      // În modul regional, culorile distincte și etichetele fac vizibilă delimitarea
      // regiunilor editoriale; în celelalte moduri umplerea duce volumul de știri.
      ctx.fillStyle = entry.selected ? palette.accentSoft
        : state.level === "regional" ? regionFill(entry.region, palette.fill)
        : palette.h[rampClassFor(entry.count, praguri)];
      // Silueta e o reuniune de subcai (cate una per UAT), deci cere "evenodd" ca sa nu se
      // umple gaurile dintre ele; conturul simplu de judet se umple la fel de bine asa.
      ctx.fill(entry.path, "evenodd");
      ctx.globalAlpha = 1;
    }
    for (const entry of paths) {
      // Județul de sub cursor se ingroasa si prinde contur de accent, la fel ca UAT-ul
      // de sub cursor: tooltipul spune numele, conturul arata CARE forma il poartă.
      const hovered = !state.zoomCounty && state.hoverCounty === entry.county;
      ctx.globalAlpha = entry.dim;
      ctx.strokeStyle = hovered || entry.selected ? palette.hot : palette.inner;
      ctx.lineWidth = hovered ? 2.2 : entry.selected ? 2 : 1.2;
      ctx.stroke(entry.path);
      ctx.globalAlpha = 1;
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

    // Selectia de UAT devine continut abia cand asignarea geometrica e posibila (UAT-urile
    // incarcate + canvas dimensionat). Pana atunci `pendingUat` tine intentia, iar panoul
    // arata lista judetului -- nu o lista inselatoare. Cheia dintr-un link vechi, care nu
    // mai exista in date, se renunta in loc sa blocheze filtrarea.
    if (state.pendingUat && state.uats.length && !state.uatLoading) {
      const wanted = state.uats.find((unit) => String(unit.id || unit.name) === state.pendingUat);
      state.pendingUat = null;
      if (wanted) {
        state.visible = state.selectedUat ? itemsForView(wanted.items) : state.visible;
      } else {
        state.selectedUat = null;
      }
    }

    // Bulinele cu cifre de la nivel național au fost STERSE, nu restilizate: pe choropleth,
    // intensitatea umplerii duce volumul, tooltipul dă cifra + primele titluri, iar cifra
    // desenată peste umplere crea exact zgomotul raportat de proprietar (buline aurii
    // uniforme, suprapuse la București, pe un fond gri fără semnificație). Hit-testul de
    // click nu le simte lipsa: cascada rămâne pe interiorul poligonului, apoi margine.

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
        // Același badge invers ca la UAT-uri: pastilă albă, cifră închisă, lizibilă pe
        // orice treaptă a rampei (auriu plin cu cifră închisă masura 5.70:1, dar nu se mai
        // potrivește cu limbajul choropleth).
        ctx.fillStyle = palette.surface;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = palette.halo;
        ctx.stroke();
        ctx.fillStyle = palette.text;
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
      const hasSelection = Boolean(state.selectedRegion || state.selectedCounty || state.selectedLocality || state.selectedUat);
      state.backButton.hidden = !hasSelection;
      // Text UNIC, nu trei variante dupa adancimea selectiei (audit harta, P2): cat de adanc
      // esti il spune acum firul de deasupra hartii; butonul are o singura promisiune.
      state.backButton.textContent = "← Înapoi la România";
    }
    syncZoomControls();
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
    if (state.selectedCounty) {
      trail.push({
        label: state.selectedCounty,
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
  // ORDINEA (audit harta, P0): interiorul clar de poligon castiga inaintea bulinelor. O bulina
  // are raza de desen + 10px de toleranta si sta langa granita județului ei; fara regula asta,
  // un click clar primit in județul A, langa granita cu B, putea fi furat de bulina lui B.
  // Pentru clickul tintit pe bulina nimic nu se schimba: bulina sta in poligonul propriului
  // judet, iar acolo interiorul intoarce exact acelasi judet.

  function countyFillAtPoint(ctx, point, { includeEmpty = false } = {}) {
    let best = null;
    for (const e of state.paths) {
      if (!includeEmpty && !(e.count > 0)) continue;
      if (!ctx.isPointInPath(e.path, point.x, point.y)) continue;
      // Enclavele: Bucurestiul e desenat in inelul Ilfovului, iar datele nu modeleaza mereu
      // enclavele ca gauri, deci un punct din Bucuresti poate fi "inside" si pentru Ilfov.
      // Poligonul cel mai mic castiga -- acolo e singura intentie geometrica posibila.
      const area = e.bounds
        ? (e.bounds.maxX - e.bounds.minX) * (e.bounds.maxY - e.bounds.minY)
        : Infinity;
      if (!best || area < best.area) best = { ...e, area };
    }
    return best || null;
  }

  function countyEdgeAtPoint(ctx, point) {
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
      // Fara filtrul de stiri: un județ gol e o zona legitima de selectat (raspunsul e
      // mesajul explicit de gol), nu o zona moarta.
      return state.paths.find((e) => ctx.isPointInStroke(e.path, point.x, point.y)) || null;
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
      uat: params.get("uat") || null,
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
    buildMap();
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
    buildMap();
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
      buildMap();
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
      picker.setAttribute("aria-label", `Localități în ${state.zoomCounty}`);
      const loading = document.createElement("p");
      loading.className = "picker-empty";
      loading.textContent = `Se încarcă localitățile din ${state.zoomCounty}…`;
      picker.appendChild(loading);
      return;
    }

    // După alegerea unui județ, selectorul devine lista UAT-urilor acelui județ care au
    // știri în filtrul curent. Fiecare buton deschide aceeași listă de știri ca badge-ul de hartă.
    if (state.zoomCounty && state.uats.length) {
      const uats = state.uats.filter((uat) => uat.count > 0)
        .sort((a, b) => String(a.label).localeCompare(String(b.label), "ro"));
      picker.setAttribute("aria-label", `Orașe și comune cu știri în ${state.zoomCounty}`);
      if (!uats.length) {
        const empty = document.createElement("p");
        empty.className = "picker-empty";
        empty.textContent = `Nu există știri localizate pe orașe și comune în ${state.zoomCounty} pentru filtrul curent.`;
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
          buildMap();
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
    return smallestUatAt(ctx, dp.x, dp.y) || null;
  }

  // Numele UAT-ului sub cursor sau sub deget. Pana acum harta nu spunea nicaieri peste ce
  // esti: aflai abia dupa ce dadeai click si se deschidea dialogul.
  function onCanvasHover(event) {
    if (state.zoomCounty) {
      const uat = uatAtPoint(event);
      if (uat !== state.hoverUat) {
        state.hoverUat = uat;
        syncUatHighlight();
        buildMap();
      }
      showMapTip(uat, event);
      return;
    }
    // Nivel național: același contract „hover = previzualizare". Doar interiorul poligonului
    // aprinde -- fără toleranță aici, ca un deget pe margine să nu aprindă vecinul doar
    // pentru că e aproape; toleranțele rămân treaba clickului.
    const canvas = state.canvas;
    const view = state.view;
    if (!canvas || !view) { showMapTip(null, null); return; }
    const ctx = canvas.getContext("2d");
    const dp = devicePointForEvent(canvas, event);
    if (!ctx || !dp) { showMapTip(null, null); return; }
    applyViewTransform(ctx, canvas, view);
    const entry = countyFillAtPoint(ctx, dp, { includeEmpty: true });
    const county = entry ? entry.county : null;
    if (county !== state.hoverCounty) {
      state.hoverCounty = county;
      buildMap();
    }
    showMapTip(entry, event);
  }

  function clearCanvasHover() {
    if (state.hoverUat) {
      state.hoverUat = null;
      syncUatHighlight();
      buildMap();
    }
    if (state.hoverCounty) {
      state.hoverCounty = null;
      buildMap();
    }
    showMapTip(null, null);
  }

  function showMapTip(target, event) {
    const tip = state.tip;
    const canvas = state.canvas;
    if (!tip) return;
    if (!target || !event || !canvas) {
      tip.hidden = true;
      tip.replaceChildren();
      return;
    }
    const count = target.count || 0;
    // Eticheta depinde de forma de sub cursor: UAT-urile poarta label/name, județele
    // county, iar la nivel regional cifra apartine REGIUNII, nu județului atins.
    const label = target.label || target.name || target.county
      || (state.level === "regional" ? target.region : "") || "";
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "tip-head";
    const name = document.createElement("span");
    name.textContent = label || "—";
    head.appendChild(name);
    if (count) {
      const figure = document.createElement("span");
      figure.className = "tip-count";
      figure.textContent = `${count} ${itemLabelFor(count)}`;
      head.appendChild(figure);
    }
    tip.appendChild(head);
    // Previzualizare: primele trei titluri din zona atinsă. UAT-urile au asignarea
    // proprie (uat.items); județele le scot din lista vizibilă; regiunile, la fel.
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
      hint.textContent = "Click pentru lista completă";
      tip.appendChild(hint);
    }
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
      const uat = closestHit(p, state.uats.filter((unit) => unit.marker), (unit) => unit.marker)
        || smallestUatAt(ctx, dp.x, dp.y);
      // Selectie, nu fereastra: acelasi contract ca clickul pe judet sau pe localitate --
      // panoul filtreaza, adresa poarta starea, Back anuleaza. UAT-urile fara stiri sunt
      // si ele selectabile (panoul raspunde cu mesajul explicit de gol), pe acelasi principiu.
      if (uat) applyState({ uat: String(uat.id || uat.name) });
    } else {
      // Transformarea se reafirma explicit inainte de hit-test: buildMap() o lasa setata, dar
      // a te baza pe ordinea apelurilor face hit-testul sa cada silentios la prima schimbare.
      // Cascada: (1) interior clar de poligon, (2) margine cu toleranta. IncludeEmpty:
      // județele fara stiri se selecteaza si ele -- click mort pe o zona vizibila era exact
      // plangerea de pe live; panoul raspunde cu mesaj de gol. Bulinele au fost sterse odata
      // cu choroplethul (markerii de judet nu mai exista), deci nu mai e si un pas de bulina.
      const ctx = canvas.getContext("2d");
      applyViewTransform(ctx, canvas, view);
      const dp = devicePointForEvent(canvas, event);
      const entry = (dp && countyFillAtPoint(ctx, dp, { includeEmpty: true }))
        || (dp && countyEdgeAtPoint(ctx, dp));
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
    if (state.selectedUat) {
      const uat = state.uats.find((unit) => String(unit.id || unit.name) === state.selectedUat);
      // Asignarea poate sa nu fie inca posibila (UAT-urile se incarca): panoul spune atunci
      // județul, nu o cheie tehnica.
      return uat ? (uat.label || uat.name) : (state.selectedCounty || state.selectedUat);
    }
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