/* WeatherPower Tropical Storm Center.
 * Active storms (NHC CurrentStorms.json), forecast cones, tracks, watches/warnings, past tracks and the
 * 7-day tropical weather outlook from the NHC MapServer, plus GOES imagery from NOAA STAR. */
(function () {
  "use strict";
  const X = window.WPX;
  if (!X) return;
  const { API, esc, escA, say, getJson, pick, num, timeLabel, compass, fc } = X;
  const MS = API.nhcMapServer;

  const T = {
    storms: [], stormsError: "", stormsLoaded: false,
    layers: null, layersError: "",
    geo: {}, // bin -> {cone, track, points, ww, pastTrack, pastPoints}
    outlook: { areas7: null, points7: null, areas2: null, error: "" },
    selected: "",
    tab: "storms",
    show: { cone: true, track: true, points: true, past: true, ww: true, outlook: true },
    map: null, body: null, loading: false, fetchedAt: 0, tv: false
  };
  X.prefs.tropical = Object.assign({ show: T.show }, X.prefs.tropical || {});
  T.show = Object.assign({}, T.show, X.prefs.tropical.show || {});

  const CLASS_NAMES = { TD: "Tropical Depression", TS: "Tropical Storm", HU: "Hurricane", MH: "Major Hurricane", STD: "Subtropical Depression", STS: "Subtropical Storm", PTC: "Potential Tropical Cyclone", PC: "Post-Tropical Cyclone", TY: "Typhoon", LO: "Low", DB: "Disturbance", RL: "Remnant Low", EX: "Extratropical" };
  const WW_COLORS = { HWR: "#ff1a1a", HWA: "#ff9ecf", TWR: "#1e6bff", TWA: "#ffd400", SSW: "#b537f2", SSA: "#e8a6ff" };
  const WW_NAMES = { HWR: "Hurricane Warning", HWA: "Hurricane Watch", TWR: "Tropical Storm Warning", TWA: "Tropical Storm Watch", SSW: "Storm Surge Warning", SSA: "Storm Surge Watch" };
  const RISK_COLORS = { low: "#ffd84d", medium: "#ff8f29", high: "#ff2d2d" };

  const ktToMph = kt => Math.round(kt * 1.15078);
  function category(kt) {
    if (kt === null) return "";
    if (kt >= 137) return "Category 5";
    if (kt >= 113) return "Category 4";
    if (kt >= 96) return "Category 3";
    if (kt >= 83) return "Category 2";
    if (kt >= 64) return "Category 1";
    if (kt >= 34) return "Tropical storm force";
    return "Depression strength";
  }
  function stormColor(kt) {
    if (kt === null) return "#9db4bb";
    if (kt >= 113) return "#ff2d7a";
    if (kt >= 96) return "#ff3b3b";
    if (kt >= 83) return "#ff8a3d";
    if (kt >= 64) return "#ffc53d";
    if (kt >= 34) return "#3ddc84";
    return "#52c8ff";
  }

  /* ---------- Data ---------- */
  async function loadStorms() {
    try {
      const json = await getJson(API.nhcCurrentStorms(), { label: "NHC current storms", preferNative: !!window.WeatherPowerAndroid });
      T.storms = (json.activeStorms || []).map(s => ({
        id: String(s.id || "").toUpperCase(),
        bin: String(s.binNumber || "").toUpperCase(),
        name: s.name || "Unnamed",
        cls: String(s.classification || "").toUpperCase(),
        kt: num(s.intensity),
        mb: num(s.pressure),
        lat: num(s.latitudeNumeric),
        lon: num(s.longitudeNumeric),
        latText: s.latitude || "", lonText: s.longitude || "",
        dir: num(s.movementDir), speed: num(s.movementSpeed),
        updated: s.lastUpdate || "",
        advisory: s.publicAdvisory || null,
        discussion: s.forecastDiscussion || null,
        graphics: s.forecastGraphics || null
      }));
      T.stormsError = "";
    } catch (error) {
      T.storms = [];
      T.stormsError = `NHC storm list unavailable (${error.message || error}).`;
    }
    T.stormsLoaded = true;
  }

  async function loadLayerIndex() {
    if (T.layers) return T.layers;
    const json = await getJson(`${MS}?f=json`, { label: "NHC map service" });
    const layers = json.layers || [];
    const byId = new Map(layers.map(l => [l.id, l]));
    const path = l => {
      const names = [];
      let cur = l, guard = 0;
      while (cur && guard++ < 8) { names.unshift(cur.name || ""); cur = cur.parentLayerId >= 0 ? byId.get(cur.parentLayerId) : null; }
      return names.join(" / ");
    };
    const out = { bins: {}, outlook: {} };
    layers.filter(l => !(l.subLayerIds && l.subLayerIds.length)).forEach(l => {
      const full = path(l);
      const name = String(l.name || "");
      if (/wind|prob|surge|arrival|swath|radii|inundation/i.test(full)) return;
      const bin = full.match(/\b(AT|EP|CP)\s*-?\s*([1-5])\b/i);
      if (!bin) {
        if (!/outlook/i.test(full)) return;
        const seven = /(7|seven)[\s-]*day/i.test(full);
        const two = /(2|two)[\s-]*day/i.test(full);
        const kind = /point/i.test(name) ? "points" : /line/i.test(name) ? "lines" : "areas";
        if (seven) out.outlook[`${kind}7`] = out.outlook[`${kind}7`] ?? l.id;
        else if (two) out.outlook[`${kind}2`] = out.outlook[`${kind}2`] ?? l.id;
        return;
      }
      const key = `${bin[1]}${bin[2]}`.toUpperCase();
      const b = out.bins[key] = out.bins[key] || {};
      const past = /past|observed|best track|previous/i.test(full);
      if (/cone/i.test(name)) b.cone = l.id;
      else if (/watch|warning/i.test(name)) b.ww = l.id;
      else if (past && /track|line/i.test(name)) b.pastTrack = l.id;
      else if (past && /point|position/i.test(name)) b.pastPoints = l.id;
      else if (/track|line/i.test(name)) b.track = b.track ?? l.id;
      else if (/point|position/i.test(name)) b.points = b.points ?? l.id;
    });
    T.layers = out;
    return out;
  }

  const queryUrl = id => `${MS}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`;
  async function queryLayer(id) {
    if (id === undefined || id === null) return fc([]);
    try {
      const json = await getJson(queryUrl(id), { label: "NHC layer", timeoutMs: 20000 });
      return json && json.type === "FeatureCollection" ? json : fc([]);
    } catch (error) {
      console.warn("NHC layer query failed", id, error);
      return fc([]);
    }
  }

  async function loadGeometry() {
    try {
      await loadLayerIndex();
      T.layersError = "";
    } catch (error) {
      T.layersError = `NHC map layers unavailable (${error.message || error}); showing the NHC map image instead.`;
      return;
    }
    // Storm list may be down: fall back to scanning every storm slot's forecast points.
    let bins = T.storms.map(s => s.bin).filter(Boolean);
    if (!T.storms.length) bins = Object.keys(T.layers.bins);
    await Promise.all(bins.map(async bin => {
      const ids = T.layers.bins[bin];
      if (!ids) return;
      const [cone, track, points, ww, pastTrack, pastPoints] = await Promise.all([ids.cone, ids.track, ids.points, ids.ww, ids.pastTrack, ids.pastPoints].map(queryLayer));
      T.geo[bin] = { cone, track, points, ww, pastTrack, pastPoints };
    }));
    if (!T.storms.length) {
      T.storms = Object.entries(T.geo).map(([bin, g]) => {
        const first = (g.points.features || []).map(f => f.properties || {}).sort((a, b) => num(a.TAU) - num(b.TAU))[0];
        if (!first) return null;
        const coords = (g.points.features || []).find(f => f.properties === first)?.geometry?.coordinates || [];
        return { id: `${first.BASIN || ""}${first.STORMNUM || ""}`, bin, name: first.STORMNAME || "Storm", cls: String(first.STORMTYPE || "").toUpperCase(), kt: num(first.MAXWIND), mb: num(first.MSLP), lat: num(first.LAT ?? coords[1]), lon: num(first.LON ?? coords[0]), dir: num(first.TCDIR), speed: num(first.TCSPD), speedKt: true, updated: first.ADVDATE || "", advisory: first.ADVISNUM ? { advNum: first.ADVISNUM, issuance: first.ADVDATE } : null };
      }).filter(Boolean);
    }
    const o = T.layers.outlook;
    const [areas7, points7, areas2] = await Promise.all([o.areas7, o.points7, o.areas2].map(queryLayer));
    T.outlook = { areas7, points7, areas2, error: "" };
  }

  async function refresh(force) {
    if (T.loading) return;
    if (!force && T.fetchedAt && Date.now() - T.fetchedAt < 5 * 60000) { draw(); return; }
    T.loading = true;
    draw();
    await loadStorms();
    draw();
    await loadGeometry();
    T.fetchedAt = Date.now();
    T.loading = false;
    draw();
    drawMap();
    fitStorms();
  }

  /* ---------- Map ---------- */
  function initMap(container) {
    if (!window.maplibregl) { container.innerHTML = `<p class="wpx-note">Map library unavailable offline.</p>`; return; }
    T.map = X.quietErrors(new maplibregl.Map({ container, style: X.basemapStyle(), center: [-60, 22], zoom: 2.4, attributionControl: false, pitchWithRotate: false, dragRotate: false }));
    T.map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "NOAA/NHC" }), "bottom-right");
    T.map.on("load", () => { drawMap(); fitStorms(); });
    T.map.on("click", event => {
      const layers = ["wpx-trop-pts", "wpx-trop-cone", "wpx-trop-otlk"].filter(id => T.map.getLayer(id));
      const hit = T.map.queryRenderedFeatures(event.point, { layers })[0];
      if (!hit) return;
      const p = hit.properties || {};
      if (p.__bin) { select(p.__bin); return; }
      if (hit.layer.id === "wpx-trop-otlk") {
        new maplibregl.Popup({ className: "wpx-popup" }).setLngLat(event.lngLat).setHTML(`<strong>Tropical outlook area</strong><br>2-day: ${esc(p.PROB2DAY || p.prob2day || "--")} · 7-day: ${esc(p.PROB7DAY || p.prob7day || "--")}<br><small>${esc(p.RISK7DAY || p.risk7day || "")} chance of formation</small>`).addTo(T.map);
      }
    });
  }

  function tagged(collection, bin) {
    return (collection?.features || []).map(f => Object.assign({}, f, { properties: Object.assign({ __bin: bin }, f.properties || {}) }));
  }

  function drawMap() {
    const map = T.map;
    if (!map) return;
    if (!X.mapReady(map)) { map.once("idle", drawMap); return; }
    const layerOk = !T.layersError;
    // Service-image fallback when the layer index could not be read.
    if (!layerOk) {
      X.setRaster(map, "wpx-trop-img", [`${MS}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image`], { opacity: 0.9, resampling: "linear", attribution: "NOAA/NHC" });
      return;
    }
    X.removeLayerAndSource(map, "wpx-trop-img");
    const bins = Object.keys(T.geo);
    const all = key => fc(bins.flatMap(bin => tagged(T.geo[bin][key], bin)));
    const outlook = fc([].concat(T.outlook.areas7?.features || []));
    const outlookPts = fc([].concat(T.outlook.points7?.features || []));
    const sets = [
      ["wpx-trop-otlk-src", T.show.outlook ? outlook : fc([])],
      ["wpx-trop-otlkpt-src", T.show.outlook ? outlookPts : fc([])],
      ["wpx-trop-cone-src", T.show.cone ? all("cone") : fc([])],
      ["wpx-trop-ww-src", T.show.ww ? all("ww") : fc([])],
      ["wpx-trop-past-src", T.show.past ? all("pastTrack") : fc([])],
      ["wpx-trop-track-src", T.show.track ? all("track") : fc([])],
      ["wpx-trop-pts-src", T.show.points ? all("points") : fc([])]
    ];
    sets.forEach(([id, data]) => X.setGeoJson(map, id, data));
    const riskExpr = key => ["match", ["downcase", ["to-string", ["coalesce", ["get", key], ["get", key.toLowerCase()], ""]]], "high", RISK_COLORS.high, "medium", RISK_COLORS.medium, RISK_COLORS.low];
    X.addLayerOnce(map, { id: "wpx-trop-otlk", type: "fill", source: "wpx-trop-otlk-src", paint: { "fill-color": riskExpr("RISK7DAY"), "fill-opacity": 0.28 } });
    X.addLayerOnce(map, { id: "wpx-trop-otlk-line", type: "line", source: "wpx-trop-otlk-src", paint: { "line-color": riskExpr("RISK7DAY"), "line-width": 2 } });
    X.addLayerOnce(map, { id: "wpx-trop-otlkpt", type: "symbol", source: "wpx-trop-otlkpt-src", layout: { "text-field": "×", "text-size": 26, "text-allow-overlap": true }, paint: { "text-color": riskExpr("RISK7DAY"), "text-halo-color": "#000", "text-halo-width": 1 } });
    X.addLayerOnce(map, { id: "wpx-trop-cone", type: "fill", source: "wpx-trop-cone-src", paint: { "fill-color": "#ffffff", "fill-opacity": 0.22 } });
    X.addLayerOnce(map, { id: "wpx-trop-cone-line", type: "line", source: "wpx-trop-cone-src", paint: { "line-color": "#ffffff", "line-width": 1.5, "line-opacity": 0.8 } });
    X.addLayerOnce(map, { id: "wpx-trop-ww", type: "line", source: "wpx-trop-ww-src", layout: { "line-cap": "round" }, paint: { "line-color": ["match", ["get", "TCWW"], "HWR", WW_COLORS.HWR, "HWA", WW_COLORS.HWA, "TWR", WW_COLORS.TWR, "TWA", WW_COLORS.TWA, "SSW", WW_COLORS.SSW, "SSA", WW_COLORS.SSA, "#ffffff"], "line-width": 6 } });
    X.addLayerOnce(map, { id: "wpx-trop-past", type: "line", source: "wpx-trop-past-src", paint: { "line-color": "#c0c8d0", "line-width": 2, "line-dasharray": [2, 1.5] } });
    X.addLayerOnce(map, { id: "wpx-trop-track", type: "line", source: "wpx-trop-track-src", paint: { "line-color": "#111", "line-width": 2.5 } });
    X.addLayerOnce(map, { id: "wpx-trop-pts", type: "circle", source: "wpx-trop-pts-src", paint: { "circle-radius": 7, "circle-color": ["interpolate", ["linear"], ["to-number", ["get", "MAXWIND"], 0], 0, "#52c8ff", 34, "#3ddc84", 64, "#ffc53d", 83, "#ff8a3d", 96, "#ff3b3b", 113, "#ff2d7a"], "circle-stroke-color": "#08101f", "circle-stroke-width": 1.5 } });
    X.addLayerOnce(map, { id: "wpx-trop-pts-lbl", type: "symbol", source: "wpx-trop-pts-src", layout: { "text-field": ["coalesce", ["get", "DVLBL"], ""], "text-size": 10, "text-allow-overlap": true }, paint: { "text-color": "#08101f" } });
    X.setGeoJson(map, "wpx-trop-now-src", fc(T.storms.filter(s => s.lat !== null && s.lon !== null).map(s => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { __bin: s.bin, name: s.name, color: stormColor(s.kt) } }))));
    X.addLayerOnce(map, { id: "wpx-trop-now", type: "symbol", source: "wpx-trop-now-src", layout: { "text-field": ["get", "name"], "text-size": 13, "text-offset": [0, -1.4], "text-allow-overlap": true }, paint: { "text-color": "#ffffff", "text-halo-color": "#000", "text-halo-width": 1.5 } });
  }

  function fitStorms(storm) {
    const map = T.map;
    if (!map) return;
    const list = storm ? [storm] : T.storms;
    const pts = [];
    list.forEach(s => {
      if (s.lat !== null && s.lon !== null) pts.push([s.lon, s.lat]);
      const g = T.geo[s.bin];
      (g?.cone?.features || []).forEach(f => walk(f.geometry?.coordinates, pts));
    });
    if (!pts.length) return;
    const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    try { map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 40, maxZoom: storm ? 6 : 5, duration: 700 }); } catch (_) {}
  }
  function walk(c, out) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") { out.push(c); return; }
    c.forEach(x => walk(x, out));
  }

  /* ---------- UI ---------- */
  function select(bin) {
    T.selected = bin;
    T.tab = "storms";
    const storm = T.storms.find(s => s.bin === bin);
    draw();
    if (storm) fitStorms(storm);
    const target = T.body?.querySelector(".wpx-trop-detail");
    if (target) target.scrollIntoView({ block: "nearest" });
    if (T.tv && X.tv) X.tv.focusFirst(T.body.querySelector(".wpx-trop-panel"));
  }

  function motionText(s) {
    if (s.dir === null && s.speed === null) return "--";
    if (s.speed === 0) return "Stationary";
    const speed = s.speed === null ? "" : s.speedKt ? ` at ${ktToMph(s.speed)} mph` : ` at ${Math.round(s.speed)} mph`;
    return `${compass(s.dir)}${speed}`;
  }

  function stormCard(s) {
    const color = stormColor(s.kt);
    return `<button class="wpx-trop-storm${T.selected === s.bin ? " active" : ""}" data-wpx="tropSelect" data-bin="${escA(s.bin)}" style="--storm:${color}">
      <span class="wpx-trop-dot"></span>
      <span><strong>${esc(CLASS_NAMES[s.cls] || s.cls)} ${esc(s.name)}</strong><small>${s.kt !== null ? `${ktToMph(s.kt)} mph` : "--"} · ${s.mb !== null ? `${s.mb} mb` : "--"} · ${esc(motionText(s))}</small></span></button>`;
  }

  function forecastRows(bin) {
    const pts = (T.geo[bin]?.points?.features || []).map(f => f.properties || {}).sort((a, b) => num(a.TAU) - num(b.TAU));
    if (!pts.length) return "";
    return `<table class="wpx-table"><thead><tr><th>Time</th><th>Wind</th><th>Type</th></tr></thead><tbody>${pts.map(p => {
      const kt = num(p.MAXWIND);
      const when = p.FLDATELBL || p.DATELBL || (num(p.TAU) !== null ? `+${p.TAU} h` : "");
      return `<tr><td>${esc(num(p.TAU) === 0 ? "Now" : when)}</td><td>${kt !== null ? `${ktToMph(kt)} mph` : "--"}</td><td>${esc(CLASS_NAMES[String(p.STORMTYPE || p.DVLBL || "").toUpperCase()] || p.TCDVLP || p.STORMTYPE || "")}</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function wwList(bin) {
    const kinds = [...new Set((T.geo[bin]?.ww?.features || []).map(f => f.properties?.TCWW).filter(Boolean))];
    if (!kinds.length) return `<p class="wpx-note">No coastal watches or warnings in effect for this storm.</p>`;
    return `<div class="wpx-chips">${kinds.map(k => `<span class="wpx-tag" style="--c:${WW_COLORS[k] || "#fff"}">${esc(WW_NAMES[k] || k)}</span>`).join("")}</div>`;
  }

  function stormDetail(s) {
    const kt = s.kt;
    const adv = s.advisory || {};
    return `<div class="wpx-card wpx-trop-detail" style="--storm:${stormColor(kt)}">
      <div class="wpx-trop-title"><span class="wpx-trop-dot"></span><div><h3>${esc(CLASS_NAMES[s.cls] || s.cls)} ${esc(s.name)}</h3><small>${esc(s.id)}${s.bin ? ` · ${esc(s.bin)}` : ""}</small></div></div>
      <div class="wpx-kv">
        <div><small>Max winds</small><strong>${kt !== null ? `${ktToMph(kt)} mph` : "--"}</strong><em>${kt !== null ? `${kt} kt · ${esc(category(kt))}` : ""}</em></div>
        <div><small>Pressure</small><strong>${s.mb !== null ? `${s.mb} mb` : "--"}</strong><em>${s.mb !== null ? `${(s.mb * 0.02953).toFixed(2)} inHg` : ""}</em></div>
        <div><small>Motion</small><strong>${esc(motionText(s))}</strong><em>${s.dir !== null ? `${Math.round(s.dir)}°` : ""}</em></div>
        <div><small>Position</small><strong>${esc(s.latText || (s.lat !== null ? `${Math.abs(s.lat).toFixed(1)}°${s.lat >= 0 ? "N" : "S"}` : "--"))} ${esc(s.lonText || (s.lon !== null ? `${Math.abs(s.lon).toFixed(1)}°${s.lon >= 0 ? "E" : "W"}` : ""))}</strong></div>
        <div><small>Advisory</small><strong>${adv.advNum ? `#${esc(adv.advNum)}` : "--"}</strong><em>${esc(timeLabel(adv.issuance || s.updated))}</em></div>
      </div>
      <h4>Coastal watches &amp; warnings</h4>${wwList(s.bin)}
      <h4>Forecast track</h4>${forecastRows(s.bin) || `<p class="wpx-note">Forecast points are loading or unavailable.</p>`}
      <div class="wpx-btnrow">
        ${adv.url ? `<button class="wpx-btn" data-wpx="openUrl" data-url="${escA(adv.url)}">Public advisory</button>` : ""}
        ${s.discussion?.url ? `<button class="wpx-btn" data-wpx="openUrl" data-url="${escA(s.discussion.url)}">Discussion</button>` : ""}
        <button class="wpx-btn" data-wpx="tropSat" data-id="${escA(s.id)}">Satellite</button>
      </div>
    </div>`;
  }

  function outlookHtml() {
    const areas = T.outlook.areas7?.features || [];
    if (T.loading && !areas.length) return `<p class="wpx-note">Loading the 7-day outlook…</p>`;
    if (!areas.length) return `<p class="wpx-note">No areas of possible development are highlighted by NHC in the 7-day outlook.</p>`;
    return areas.map(f => {
      const p = f.properties || {};
      const risk = String(p.RISK7DAY || p.risk7day || "").toLowerCase();
      return `<div class="wpx-card" style="border-left:5px solid ${RISK_COLORS[risk] || RISK_COLORS.low}"><strong>${esc(p.BASIN ? `${p.BASIN} ` : "")}Area of interest</strong><div class="wpx-kv"><div><small>2-day formation</small><strong>${esc(p.PROB2DAY || p.prob2day || "--")}</strong><em>${esc(p.RISK2DAY || p.risk2day || "")}</em></div><div><small>7-day formation</small><strong>${esc(p.PROB7DAY || p.prob7day || "--")}</strong><em>${esc(p.RISK7DAY || p.risk7day || "")}</em></div></div></div>`;
    }).join("") + `<p class="wpx-note">Source: NHC Graphical Tropical Weather Outlook.</p>`;
  }

  const SECTORS = [
    { id: "taw", sat: "GOES19", label: "Tropical Atlantic", sizes: ["1800x1080", "900x540"] },
    { id: "car", sat: "GOES19", label: "Caribbean", sizes: ["1000x1000", "2000x2000"] },
    { id: "gm", sat: "GOES19", label: "Gulf", sizes: ["1000x1000", "2000x2000"] },
    { id: "eep", sat: "GOES18", label: "East Pacific", sizes: ["1800x1080", "900x540"] },
    { id: "tpw", sat: "GOES18", label: "Tropical Pacific", sizes: ["1800x1080", "900x540"] }
  ];
  const BANDS = [["GEOCOLOR", "GeoColor"], ["13", "Infrared"], ["Sandwich", "Sandwich"]];

  function sectorUrls(sector, band) {
    const base = `https://cdn.star.nesdis.noaa.gov/${sector.sat}/ABI/SECTOR/${sector.id}/${band}`;
    return sector.sizes.map(size => `${base}/${size}.jpg`).concat(`${base}/latest.jpg`);
  }
  function floaterUrls(stormId, band) {
    const base = `https://cdn.star.nesdis.noaa.gov/FLOATER/data/${stormId}/${band}`;
    return [`${base}/1000x1000.jpg`, `${base}/latest.jpg`];
  }

  function satImg(urls, alt) {
    return `<img class="wpx-sat-img" alt="${escA(alt)}" src="${escA(urls[0])}" data-fallbacks="${escA(urls.slice(1).join("|"))}">`;
  }

  function satelliteHtml() {
    const sat = X.prefs.tropicalSat = Object.assign({ sector: "taw", band: "GEOCOLOR", storm: "" }, X.prefs.tropicalSat || {});
    const sector = SECTORS.find(s => s.id === sat.sector) || SECTORS[0];
    const storm = sat.storm && T.storms.find(s => s.id === sat.storm);
    return `<div class="wpx-chips">${T.storms.map(s => `<button class="wpx-chip${sat.storm === s.id ? " active" : ""}" data-wpx="tropSat" data-id="${escA(s.id)}">${esc(s.name)}</button>`).join("")}${SECTORS.map(s => `<button class="wpx-chip${!sat.storm && sat.sector === s.id ? " active" : ""}" data-wpx="tropSector" data-id="${s.id}">${esc(s.label)}</button>`).join("")}</div>
      <div class="wpx-chips">${BANDS.map(([id, label]) => `<button class="wpx-chip${sat.band === id ? " active" : ""}" data-wpx="tropBand" data-id="${id}">${esc(label)}</button>`).join("")}</div>
      <div class="wpx-card wpx-sat">${storm ? satImg(floaterUrls(storm.id, sat.band), `${storm.name} GOES floater`) : satImg(sectorUrls(sector, sat.band), `${sector.label} GOES imagery`)}</div>
      <p class="wpx-note">${storm ? `${esc(storm.name)} storm floater` : `${esc(sector.label)} · ${esc(sector.sat.replace("GOES", "GOES-"))}`} · latest image from NOAA/NESDIS STAR. Refreshes about every 10 minutes.</p>`;
  }

  function panelHtml() {
    const toggles = [["cone", "Cone"], ["track", "Track"], ["points", "Points"], ["past", "Past track"], ["ww", "Watches/Warnings"], ["outlook", "7-day outlook"]];
    const selected = T.storms.find(s => s.bin === T.selected);
    let content;
    if (T.tab === "outlook") content = outlookHtml();
    else if (T.tab === "satellite") content = satelliteHtml();
    else {
      content = `${T.stormsError ? `<p class="wpx-note">${esc(T.stormsError)}</p>` : ""}${T.layersError ? `<p class="wpx-note">${esc(T.layersError)}</p>` : ""}
        ${!T.stormsLoaded ? `<p class="wpx-note">Loading active storms…</p>` : T.storms.length ? T.storms.map(stormCard).join("") : `<div class="wpx-card"><strong>No active tropical cyclones</strong><p class="wpx-note">NHC is not issuing advisories right now. Check the 7-day outlook for areas to watch.</p></div>`}
        ${selected ? stormDetail(selected) : ""}`;
    }
    return `<div class="wpx-tabs wpx-trop-tabs">${[["storms", "Storms"], ["outlook", "7-Day Outlook"], ["satellite", "GOES Satellite"]].map(([id, label]) => `<button class="wpx-chip${T.tab === id ? " active" : ""}" data-wpx="tropTab" data-tab="${id}">${esc(label)}</button>`).join("")}<button class="wpx-chip" data-wpx="tropRefresh">${T.loading ? "Updating…" : "Refresh"}</button></div>
      <div class="wpx-chips wpx-trop-toggles">${toggles.map(([key, label]) => `<button class="wpx-chip toggle${T.show[key] ? " active" : ""}" data-wpx="tropToggle" data-key="${key}" aria-pressed="${T.show[key]}">${esc(label)}</button>`).join("")}</div>
      ${content}
      <p class="wpx-note">Official information: National Hurricane Center. ${T.fetchedAt ? `Updated ${esc(new Date(T.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}.` : ""}</p>`;
  }

  function draw() {
    const panel = T.body?.querySelector(".wpx-trop-panel");
    if (!panel) return;
    const focusKey = document.activeElement && panel.contains(document.activeElement) ? focusSignature(document.activeElement) : "";
    const scroll = panel.scrollTop;
    panel.innerHTML = panelHtml();
    panel.scrollTop = scroll;
    wireSatFallbacks(panel);
    if (focusKey) {
      const again = [...panel.querySelectorAll("[data-wpx]")].find(el => focusSignature(el) === focusKey);
      if (again) again.focus({ preventScroll: true });
      else if (T.tv && X.tv) X.tv.focusFirst(panel);
    }
  }
  const focusSignature = el => `${el.dataset.wpx || ""}|${el.dataset.bin || el.dataset.key || el.dataset.tab || el.dataset.id || ""}`;

  function wireSatFallbacks(root) {
    root.querySelectorAll("img[data-fallbacks]").forEach(img => {
      img.addEventListener("error", () => {
        const rest = (img.dataset.fallbacks || "").split("|").filter(Boolean);
        if (rest.length) { img.dataset.fallbacks = rest.slice(1).join("|"); img.src = rest[0]; }
        else img.replaceWith(Object.assign(document.createElement("p"), { className: "wpx-note", textContent: "Satellite imagery for this view is not available right now." }));
      });
    });
  }

  function open(options = {}) {
    T.tv = !!options.tv;
    const body = X.openOverlay({ id: "tropical", title: "Tropical Storm Center", className: `wpx-tropical${T.tv ? " wpx-tv-screen" : ""}`, onClose: () => { try { T.map && T.map.remove(); } catch (_) {} T.map = null; T.body = null; } });
    T.body = body;
    body.innerHTML = `<div class="wpx-trop-layout"><div class="wpx-trop-map" id="wpxTropMap"></div><div class="wpx-trop-panel"></div></div>`;
    draw();
    requestAnimationFrame(() => initMap(body.querySelector("#wpxTropMap")));
    refresh(false);
    return body;
  }

  // TV screens embed the same center inside their own content area.
  function mount(container, options = {}) {
    T.tv = !!options.tv;
    T.body = container;
    container.innerHTML = `<div class="wpx-trop-layout"><div class="wpx-trop-map" id="wpxTropMap"></div><div class="wpx-trop-panel"></div></div>`;
    draw();
    requestAnimationFrame(() => initMap(container.querySelector("#wpxTropMap")));
    refresh(false);
  }
  function unmount() { try { T.map && T.map.remove(); } catch (_) {} T.map = null; T.body = null; }

  Object.assign(X.actions, {
    openTropical: () => open(),
    tropSelect: el => select(el.dataset.bin),
    tropTab: el => { T.tab = el.dataset.tab; draw(); },
    tropRefresh: () => refresh(true),
    tropToggle: el => { const k = el.dataset.key; T.show[k] = !T.show[k]; X.prefs.tropical.show = T.show; X.savePrefs(); draw(); drawMap(); },
    tropSat: el => { X.prefs.tropicalSat = Object.assign({ sector: "taw", band: "GEOCOLOR" }, X.prefs.tropicalSat || {}, { storm: el.dataset.id }); X.savePrefs(); T.tab = "satellite"; draw(); },
    tropSector: el => { X.prefs.tropicalSat = Object.assign({ band: "GEOCOLOR" }, X.prefs.tropicalSat || {}, { sector: el.dataset.id, storm: "" }); X.savePrefs(); draw(); },
    tropBand: el => { X.prefs.tropicalSat = Object.assign({ sector: "taw", storm: "" }, X.prefs.tropicalSat || {}, { band: el.dataset.id }); X.savePrefs(); draw(); }
  });

  // Phone entry points on the More tab.
  if (typeof renderMore === "function") {
    const originalRenderMore = renderMore;
    // eslint-disable-next-line no-global-assign
    renderMore = function () {
      const out = originalRenderMore.apply(this, arguments);
      try {
        const host = document.getElementById("moreContent");
        const first = host && host.querySelector(".section");
        if (host && first && !host.querySelector(".wpx-more")) {
          const item = (action, title, detail, glyph, tab) => `<button class="tool" data-wpx="${action}"${tab ? ` data-tab="${tab}"` : ""}><span class="wpx-more-glyph" aria-hidden="true">${glyph}</span><span><strong>${esc(title)}</strong><span>${esc(detail)}</span></span>${action === "openTropical" && T.storms.length ? `<span class="badge soon-badge">${T.storms.length} active</span>` : ""}<span class="chev">›</span></button>`;
          const section = document.createElement("section");
          section.className = "section wpx-more";
          section.innerHTML = `<div class="section-head"><h2>Radar 3.1 &amp; Tropics</h2><span>New</span></div><div class="tool-list">
            ${item("openTropical", "Tropical Storm Center", "Active storms, cones, tracks, watches/warnings, 7-day outlook, GOES satellite.", "🌀")}
            ${item("r31Open", "Radar 3.1 site products", "Pick any NEXRAD site, product and tilt: velocity, CC, ZDR, KDP, echo tops, VIL.", "📡", "radar")}
            ${item("r31Open", "MRMS hail & rotation", "Hail size and rotation tracks from NOAA MRMS.", "🧊", "mrms")}
            ${item("r31Open", "Model Studio", "HRRR, NAM, GFS and ECMWF forecast fields on the radar map.", "🧭", "models")}
            ${item("r31Open", "Route weather", "NWS forecasts and alerts along your drive.", "🚗", "route")}
            ${item("r31Open", "Point soundings", "HRRR skew-T and severe parameters for any point.", "📈", "sounding")}
            ${item("r31Open", "Gas & shelters", "Gas station prices and tornado shelters on the map.", "⛽", "map")}
          </div>`;
          first.after(section);
        }
      } catch (error) { console.warn(error); }
      return out;
    };
    try { renderMore(); } catch (_) {}
  }
  loadStorms().then(() => { try { if (T.storms.length) renderMore(); } catch (_) {} });

  X.tropical = { open, mount, unmount, refresh, state: T, activeCount: () => T.storms.length, loadStorms: async () => { if (!T.stormsLoaded) await loadStorms(); return T.storms; } };
})();
