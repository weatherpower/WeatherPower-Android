/* WeatherPower Tropical Storm Center.
 * Cones, forecast tracks and points, past tracks, coastal watches/warnings and the 7-day tropical weather
 * outlook from the official NHC GIS service (NOAA/NWS NHC_tropical_weather MapServer), the same layers the
 * Radar 3.1 website uses; advisory links from NHC CurrentStorms.json; GOES imagery from NOAA/NESDIS STAR. */
(function () {
  "use strict";
  const X = window.WPX;
  if (!X) return;
  const { API, esc, escA, getJson, num, compass, fc } = X;
  const MS = API.nhcMapServer;

  // Forecast Points layer id per storm slot; the slot's other layers are fixed offsets from it.
  const BINS = { AT1: 6, AT2: 32, AT3: 58, AT4: 84, AT5: 110, EP1: 136, EP2: 162, EP3: 188, EP4: 214, EP5: 240, CP1: 266, CP2: 292, CP3: 318, CP4: 344, CP5: 370 };
  const OFFSET = { track: 1, cone: 2, ww: 3, pastPts: 5, pastTrack: 6 };
  const OUTLOOK = { areas: 3, points: 2 };
  const REFRESH = 10 * 60e3;
  const WW = { HWR: ["Hurricane Warning", "#ff2a2a", 6], HWA: ["Hurricane Watch", "#ff8fd8", 5], TWR: ["Tropical Storm Warning", "#2f7bff", 5], TWA: ["Tropical Storm Watch", "#ffd21f", 4] };
  const RISK = { Low: "#ffd21f", Medium: "#ff9a1f", High: "#ff3b3b" };
  const TYPE_NAMES = { TD: "Tropical Depression", TS: "Tropical Storm", HU: "Hurricane", MH: "Major Hurricane", SD: "Subtropical Depression", SS: "Subtropical Storm", STD: "Subtropical Depression", STS: "Subtropical Storm", PTC: "Potential Tropical Cyclone", PT: "Post-Tropical Cyclone", PC: "Post-Tropical Cyclone", EX: "Extratropical", LO: "Low", DB: "Disturbance", WV: "Tropical Wave", RL: "Remnant Low" };

  const T = {
    storms: [], bins: {}, outlook: { areas: fc([]), points: fc([]) }, cs: {},
    error: "", loaded: false, loading: false, fetchedAt: 0, timer: 0,
    selected: "", tab: "storms", map: null, body: null, tv: false,
    show: { cone: true, track: true, points: true, past: true, ww: true, outlook: true }
  };
  X.prefs.tropical = Object.assign({ show: T.show }, X.prefs.tropical || {});
  T.show = Object.assign({}, T.show, X.prefs.tropical.show || {});

  function colorFor(kt, type) {
    type = String(type || "").toUpperCase();
    if (/^(EX|PT|LO|DB|WV|PTC)/.test(type) && !(kt >= 34)) return "#b9c1cf";
    if (!(kt >= 34)) return "#5ebaff";   // depression
    if (kt < 64) return "#00e6d8";       // tropical storm
    if (kt < 83) return "#ffffa8";       // cat 1
    if (kt < 96) return "#ffe066";       // cat 2
    if (kt < 113) return "#ffb340";      // cat 3
    if (kt < 137) return "#ff7a1f";      // cat 4
    return "#ff4d6d";                    // cat 5
  }
  function letterFor(p) {
    const kt = Number(p.maxwind), t = String(p.stormtype || "").toUpperCase();
    if (/^(HU|MH)/.test(t) || kt >= 64) return String(p.ssnum > 0 ? Math.round(p.ssnum) : kt >= 137 ? 5 : kt >= 113 ? 4 : kt >= 96 ? 3 : kt >= 83 ? 2 : 1);
    if (/^(EX|PT|LO|PTC)/.test(t)) return "L";
    if (/^(TS|SS)/.test(t) || kt >= 34) return "S";
    return "D";
  }
  const mph = kt => (Number.isFinite(Number(kt)) && Number(kt) < 999 ? `${Math.round(Number(kt) * 1.15078)} mph` : "—");
  function category(kt) {
    if (!(kt >= 34)) return "Depression strength";
    if (kt < 64) return "Tropical storm force";
    return `Category ${kt >= 137 ? 5 : kt >= 113 ? 4 : kt >= 96 ? 3 : kt >= 83 ? 2 : 1}`;
  }
  const titleCase = s => (/^[A-Z\s-]+$/.test(s) ? s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()) : s);

  /* ---------- Data ---------- */
  // NHC layers return lowercase field names; normalize so the rest of the code never guesses case.
  function lower(collection) {
    const features = (collection && collection.features) || [];
    return fc(features.map(f => {
      const props = {};
      Object.keys(f.properties || {}).forEach(k => { props[k.toLowerCase()] = f.properties[k]; });
      return { type: "Feature", geometry: f.geometry, properties: props };
    }));
  }
  const q = id => getJson(`${MS}/${id}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`, { label: "NHC layer", timeoutMs: 20000 }).then(lower);

  async function loadCurrentStorms() {
    try {
      const json = await getJson(API.nhcCurrentStorms(), { label: "NHC current storms", preferNative: !!window.WeatherPowerAndroid });
      const out = {};
      (json.activeStorms || []).forEach(s => { if (s.binNumber) out[String(s.binNumber).toUpperCase()] = s; });
      T.cs = out;
    } catch (_) { /* advisory links are optional; the map layers carry the storm data */ }
  }

  async function load() {
    const outlook = Promise.all([q(OUTLOOK.areas), q(OUTLOOK.points)]).catch(() => [fc([]), fc([])]);
    const cs = loadCurrentStorms();
    let failures = 0;
    const bins = await Promise.all(Object.keys(BINS).map(bin => q(BINS[bin]).then(pts => {
      if (!pts.features.length) return null;
      const id = BINS[bin];
      const parts = Object.keys(OFFSET);
      return Promise.all(parts.map(k => q(id + OFFSET[k]).catch(() => fc([])))).then(res => {
        const d = { bin, pts };
        parts.forEach((k, i) => { d[k] = res[i]; });
        return d;
      });
    }).catch(() => { failures++; return null; })));
    const [ol] = await Promise.all([outlook, cs]);
    T.outlook = { areas: ol[0], points: ol[1] };
    T.bins = {};
    bins.filter(Boolean).forEach(d => { T.bins[d.bin] = d; });
    T.storms = Object.values(T.bins).map(stormFromBin).filter(Boolean);
    T.error = failures === Object.keys(BINS).length ? "The NHC map service could not be reached. Check your connection and refresh." : "";
    T.loaded = true;
  }

  function stormFromBin(d) {
    const pts = d.pts.features.slice().sort((a, b) => Number(a.properties.tau) - Number(b.properties.tau));
    if (!pts.length) return null;
    const p0 = pts[0].properties, c = pts[0].geometry && pts[0].geometry.coordinates;
    const cs = T.cs[d.bin] || null;
    const type = String(p0.stormtype || "").toUpperCase();
    return {
      bin: d.bin,
      id: cs && cs.id ? String(cs.id).toUpperCase() : `${p0.basin || ""}${p0.stormnum || ""}${p0.year || ""}`.toUpperCase(),
      name: titleCase(String((cs && cs.name) || p0.stormname || d.bin)),
      kind: p0.tcdvlp || TYPE_NAMES[type] || type,
      type, p0,
      kt: num(p0.maxwind), gust: num(p0.gust),
      mb: num(p0.mslp) !== null && num(p0.mslp) < 9999 ? num(p0.mslp) : null,
      dir: num(p0.tcdir), spdKt: num(p0.tcspd) !== null && num(p0.tcspd) < 9999 ? num(p0.tcspd) : null,
      lat: c ? c[1] : null, lon: c ? c[0] : null,
      advNum: p0.advisnum || (cs && cs.publicAdvisory && cs.publicAdvisory.advNum) || "",
      advDate: p0.advdate || (cs && cs.publicAdvisory && cs.publicAdvisory.issuance) || "",
      advUrl: cs && cs.publicAdvisory ? cs.publicAdvisory.url : "",
      discUrl: cs && cs.forecastDiscussion ? cs.forecastDiscussion.url : "",
      forecast: pts.map(f => f.properties)
    };
  }

  async function refresh(force) {
    if (T.loading) return;
    clearTimeout(T.timer);
    T.timer = setTimeout(() => { if (T.body) refresh(true); }, REFRESH);
    if (!force && T.fetchedAt && Date.now() - T.fetchedAt < 5 * 60000) { draw(); drawMap(); return; }
    T.loading = true;
    draw();
    try { await load(); } catch (error) { T.error = `NHC data unavailable: ${error.message || error}`; }
    T.fetchedAt = Date.now();
    T.loading = false;
    draw();
    drawMap();
    fitStorms();
    try { if (typeof renderMore === "function") renderMore(); } catch (_) {}
  }

  /* ---------- Map ---------- */
  function initMap(container) {
    if (!window.maplibregl) { container.innerHTML = `<p class="wpx-note">Map library unavailable offline.</p>`; return; }
    T.map = X.quietErrors(new maplibregl.Map({ container, style: X.basemapStyle(), center: [-60, 22], zoom: 2.4, attributionControl: false, pitchWithRotate: false, dragRotate: false }));
    T.map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "NOAA/NHC" }), "bottom-right");
    T.map.on("load", () => { drawMap(); fitStorms(); });
    T.map.on("click", event => {
      const map = T.map;
      const layers = ["wpx-trop-pts", "wpx-trop-ww", "wpx-trop-otlk", "wpx-trop-otlkpt"].filter(id => map.getLayer(id));
      const hit = map.queryRenderedFeatures([[event.point.x - 6, event.point.y - 6], [event.point.x + 6, event.point.y + 6]], { layers })[0];
      if (!hit) return;
      const p = hit.properties || {};
      let html = "";
      if (hit.layer.id === "wpx-trop-pts") {
        const s = T.storms.find(x => x.bin === p.__bin);
        const now = Number(p.tau) === 0;
        html = `<strong>${esc(s ? s.name : p.stormname || "")}</strong><br><small>${esc(p.tcdvlp || p.stormtype || "")} · ${now ? "Current position" : `Forecast +${esc(p.tau)}h`} · ${esc(p.datelbl || "")}</small>
          <div class="wpx-gas-grid"><div><small>Max wind</small><b>${esc(mph(p.maxwind))}</b></div><div><small>Gusts</small><b>${esc(mph(p.gust))}</b></div>${p.mslp && Number(p.mslp) < 9999 ? `<div><small>Pressure</small><b>${esc(p.mslp)} mb</b></div>` : ""}${p.tcspd && Number(p.tcspd) < 9999 ? `<div><small>Moving</small><b>${Math.round(Number(p.tcspd) * 1.15078)} mph · ${esc(p.tcdir)}°</b></div>` : ""}</div>
          <small>NHC advisory ${esc(p.advisnum || "")} · ${esc(p.advdate || "")}</small>`;
        if (s) setTimeout(() => select(s.bin, true), 0);
      } else if (hit.layer.id === "wpx-trop-ww") {
        const w = WW[p.tcww];
        html = `<strong>${esc(w ? w[0] : p.tcww || "Watch/Warning")}</strong>${p.__bin ? `<br><small>${esc((T.storms.find(x => x.bin === p.__bin) || {}).name || "")}</small>` : ""}`;
      } else {
        html = `<strong>NHC 7-day outlook</strong>${p.basin ? ` · ${esc(p.basin)}` : ""}<br>2-day: ${esc(p.prob2day || "--")} (${esc(p.risk2day || "")}) · 7-day: ${esc(p.prob7day || "--")} (${esc(p.risk7day || "")})`;
      }
      try { new maplibregl.Popup({ className: "wpx-popup", maxWidth: "290px" }).setLngLat(event.lngLat).setHTML(html).addTo(map); } catch (_) {}
    });
  }

  function tagged(collection, bin) {
    return ((collection && collection.features) || []).map(f => ({ type: "Feature", geometry: f.geometry, properties: Object.assign({ __bin: bin }, f.properties) }));
  }

  function drawMap() {
    const map = T.map;
    if (!map) return;
    if (!X.mapReady(map)) { map.once("idle", drawMap); return; }
    const bins = Object.keys(T.bins);
    const all = key => fc(bins.flatMap(bin => tagged(T.bins[bin][key], bin)));
    const pts = fc(bins.flatMap(bin => tagged(T.bins[bin].pts, bin).map(f => Object.assign(f, { properties: Object.assign(f.properties, { __color: colorFor(Number(f.properties.maxwind), f.properties.stormtype), __letter: letterFor(f.properties), __now: Number(f.properties.tau) === 0 }) }))));
    const pastPts = fc(bins.flatMap(bin => tagged(T.bins[bin].pastPts, bin).map(f => Object.assign(f, { properties: Object.assign(f.properties, { __color: colorFor(Number(f.properties.intensity), f.properties.stormtype) }) }))));
    const set = (id, data, on) => X.setGeoJson(map, id, on ? data : fc([]));
    set("wpx-trop-otlk-src", T.outlook.areas, T.show.outlook);
    set("wpx-trop-otlkpt-src", T.outlook.points, T.show.outlook);
    set("wpx-trop-cone-src", all("cone"), T.show.cone);
    set("wpx-trop-ww-src", all("ww"), T.show.ww);
    set("wpx-trop-past-src", all("pastTrack"), T.show.past);
    set("wpx-trop-pastpt-src", pastPts, T.show.past);
    set("wpx-trop-track-src", all("track"), T.show.track);
    set("wpx-trop-pts-src", pts, T.show.points);
    const risk = key => ["match", ["get", key], "High", RISK.High, "Medium", RISK.Medium, RISK.Low];
    X.addLayerOnce(map, { id: "wpx-trop-otlk", type: "fill", source: "wpx-trop-otlk-src", paint: { "fill-color": risk("risk7day"), "fill-opacity": 0.14 } });
    X.addLayerOnce(map, { id: "wpx-trop-otlk-line", type: "line", source: "wpx-trop-otlk-src", paint: { "line-color": risk("risk7day"), "line-width": 2, "line-dasharray": [2.5, 2.5] } });
    X.addLayerOnce(map, { id: "wpx-trop-otlkpt", type: "symbol", source: "wpx-trop-otlkpt-src", layout: { "text-field": "×", "text-size": 28, "text-allow-overlap": true }, paint: { "text-color": risk("risk2day"), "text-halo-color": "#000", "text-halo-width": 1 } });
    X.addLayerOnce(map, { id: "wpx-trop-cone", type: "fill", source: "wpx-trop-cone-src", paint: { "fill-color": "#ffffff", "fill-opacity": 0.2 } });
    X.addLayerOnce(map, { id: "wpx-trop-cone-line", type: "line", source: "wpx-trop-cone-src", paint: { "line-color": "#ffffff", "line-width": 1.6, "line-opacity": 0.95 } });
    X.addLayerOnce(map, { id: "wpx-trop-ww", type: "line", source: "wpx-trop-ww-src", layout: { "line-cap": "round" }, paint: {
      "line-color": ["match", ["get", "tcww"], "HWR", WW.HWR[1], "HWA", WW.HWA[1], "TWR", WW.TWR[1], "TWA", WW.TWA[1], "#ffffff"],
      "line-width": ["match", ["get", "tcww"], "HWR", 6, "HWA", 5, "TWR", 5, "TWA", 4, 4] } });
    X.addLayerOnce(map, { id: "wpx-trop-past-casing", type: "line", source: "wpx-trop-past-src", paint: { "line-color": "#0a0d14", "line-width": 4, "line-opacity": 0.7 } });
    X.addLayerOnce(map, { id: "wpx-trop-past", type: "line", source: "wpx-trop-past-src", paint: { "line-color": "#e8edf7", "line-width": 1.6, "line-opacity": 0.9 } });
    X.addLayerOnce(map, { id: "wpx-trop-pastpt", type: "circle", source: "wpx-trop-pastpt-src", paint: { "circle-radius": 3.5, "circle-color": ["get", "__color"], "circle-stroke-color": "#0a0d14", "circle-stroke-width": 1 } });
    X.addLayerOnce(map, { id: "wpx-trop-track", type: "line", source: "wpx-trop-track-src", paint: { "line-color": "#ffffff", "line-width": 2, "line-opacity": 0.95, "line-dasharray": [3, 3] } });
    X.addLayerOnce(map, { id: "wpx-trop-pts", type: "circle", source: "wpx-trop-pts-src", paint: { "circle-radius": ["case", ["get", "__now"], 11, 8], "circle-color": ["get", "__color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": ["case", ["get", "__now"], 2.5, 1.2] } });
    X.addLayerOnce(map, { id: "wpx-trop-pts-letter", type: "symbol", source: "wpx-trop-pts-src", layout: { "text-field": ["get", "__letter"], "text-size": 11, "text-allow-overlap": true }, paint: { "text-color": "#0a0d14" } });
    X.addLayerOnce(map, { id: "wpx-trop-pts-when", type: "symbol", source: "wpx-trop-pts-src", layout: {
      "text-field": ["case", ["get", "__now"], ["concat", ["upcase", ["coalesce", ["get", "stormname"], ""]], "\n", ["coalesce", ["get", "datelbl"], ""]], ["coalesce", ["get", "datelbl"], ""]],
      "text-size": ["case", ["get", "__now"], 13, 10], "text-offset": [0, 1.4], "text-anchor": "top", "text-optional": true }, paint: { "text-color": "#ffffff", "text-halo-color": "#000", "text-halo-width": 1.4 } });
  }

  function walk(c, out) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") { out.push(c); return; }
    c.forEach(x => walk(x, out));
  }
  function fitStorms(storm) {
    const map = T.map;
    if (!map) return;
    const list = storm ? [storm] : T.storms;
    const pts = [];
    list.forEach(s => {
      if (s.lat !== null && s.lon !== null) pts.push([s.lon, s.lat]);
      (((T.bins[s.bin] || {}).cone || {}).features || []).forEach(f => walk(f.geometry && f.geometry.coordinates, pts));
    });
    if (!pts.length) return;
    const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    try { map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 40, maxZoom: storm ? 6 : 5, duration: 700 }); } catch (_) {}
  }

  /* ---------- UI ---------- */
  function select(bin, fromMap) {
    T.selected = bin;
    T.tab = "storms";
    const storm = T.storms.find(s => s.bin === bin);
    draw();
    if (storm && !fromMap) fitStorms(storm);
    const target = T.body && T.body.querySelector(".wpx-trop-detail");
    if (target) target.scrollIntoView({ block: "nearest" });
    if (T.tv && X.tv && T.body) X.tv.focusFirst(T.body.querySelector(".wpx-trop-panel"));
  }

  function motionText(s) {
    if (s.dir === null && s.spdKt === null) return "--";
    if (s.spdKt === 0) return "Stationary";
    return `${compass(s.dir)}${s.spdKt !== null ? ` at ${Math.round(s.spdKt * 1.15078)} mph` : ""}`;
  }

  function stormCard(s) {
    const color = colorFor(s.kt, s.type);
    return `<button class="wpx-trop-storm${T.selected === s.bin ? " active" : ""}" data-wpx="tropSelect" data-bin="${escA(s.bin)}" style="--storm:${color}">
      <span class="wpx-trop-dot">${esc(letterFor(s.p0))}</span>
      <span><strong>${esc(s.name)}</strong><small>${esc(s.kind)} · ${esc(mph(s.kt))}${s.advNum ? ` · Adv ${esc(s.advNum)}` : ""}</small></span></button>`;
  }

  function forecastRows(s) {
    const pts = s.forecast;
    if (!pts.length) return "";
    return `<table class="wpx-table"><thead><tr><th>Time</th><th>Wind</th><th>Type</th></tr></thead><tbody>${pts.map(p => `<tr><td>${esc(Number(p.tau) === 0 ? "Now" : p.datelbl || `+${p.tau} h`)}</td><td>${esc(mph(p.maxwind))}</td><td>${esc(p.tcdvlp || TYPE_NAMES[String(p.stormtype || "").toUpperCase()] || p.stormtype || "")}</td></tr>`).join("")}</tbody></table>`;
  }

  function wwList(s) {
    const kinds = [...new Set((((T.bins[s.bin] || {}).ww || {}).features || []).map(f => f.properties.tcww).filter(Boolean))];
    if (!kinds.length) return `<p class="wpx-note">No coastal watches or warnings in effect for this storm.</p>`;
    return `<div class="wpx-chips">${kinds.map(k => `<span class="wpx-tag" style="--c:${(WW[k] || [0, "#fff"])[1]}">${esc((WW[k] || [k])[0])}</span>`).join("")}</div>`;
  }

  function stormDetail(s) {
    const kt = s.kt;
    return `<div class="wpx-card wpx-trop-detail" style="--storm:${colorFor(kt, s.type)}">
      <div class="wpx-trop-title"><span class="wpx-trop-dot">${esc(letterFor(s.p0))}</span><div><h3>${esc(s.kind)} ${esc(s.name)}</h3><small>${esc(s.id)}${s.bin ? ` · ${esc(s.bin)}` : ""}</small></div></div>
      <div class="wpx-kv">
        <div><small>Max winds</small><strong>${esc(mph(kt))}</strong><em>${kt !== null ? `${kt} kt · ${esc(category(kt))}` : ""}</em></div>
        <div><small>Gusts</small><strong>${esc(mph(s.gust))}</strong></div>
        <div><small>Pressure</small><strong>${s.mb !== null ? `${s.mb} mb` : "—"}</strong><em>${s.mb !== null ? `${(s.mb * 0.02953).toFixed(2)} inHg` : ""}</em></div>
        <div><small>Motion</small><strong>${esc(motionText(s))}</strong><em>${s.dir !== null ? `${Math.round(s.dir)}°` : ""}</em></div>
        <div><small>Position</small><strong>${s.lat !== null ? `${Math.abs(s.lat).toFixed(1)}°${s.lat >= 0 ? "N" : "S"} ${Math.abs(s.lon).toFixed(1)}°${s.lon >= 0 ? "E" : "W"}` : "—"}</strong></div>
        <div><small>Advisory</small><strong>${s.advNum ? `#${esc(s.advNum)}` : "—"}</strong><em>${esc(s.advDate)}</em></div>
      </div>
      <h4>Coastal watches &amp; warnings</h4>${wwList(s)}
      <h4>Forecast track</h4>${forecastRows(s)}
      <div class="wpx-btnrow">
        ${s.advUrl ? `<button class="wpx-btn" data-wpx="openUrl" data-url="${escA(s.advUrl)}">Public advisory</button>` : ""}
        ${s.discUrl ? `<button class="wpx-btn" data-wpx="openUrl" data-url="${escA(s.discUrl)}">Discussion</button>` : ""}
        ${s.id ? `<button class="wpx-btn" data-wpx="tropSat" data-id="${escA(s.id)}">Satellite</button>` : ""}
      </div>
    </div>`;
  }

  function outlookHtml() {
    const areas = T.outlook.areas.features || [];
    if (T.loading && !areas.length) return `<p class="wpx-note">Loading the 7-day outlook…</p>`;
    if (!areas.length) return `<p class="wpx-note">NHC isn't highlighting any areas for possible development in the 7-day outlook.</p>`;
    return areas.map(f => {
      const p = f.properties || {};
      return `<div class="wpx-card" style="border-left:5px solid ${RISK[p.risk7day] || RISK.Low}"><strong>${esc(p.basin ? `${p.basin} · ` : "")}Area to watch</strong><div class="wpx-kv"><div><small>2-day formation</small><strong>${esc(p.prob2day || "--")}</strong><em>${esc(p.risk2day || "")}</em></div><div><small>7-day formation</small><strong>${esc(p.prob7day || "--")}</strong><em>${esc(p.risk7day || "")}</em></div></div></div>`;
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
  const sectorUrls = (sector, band) => { const base = `https://cdn.star.nesdis.noaa.gov/${sector.sat}/ABI/SECTOR/${sector.id}/${band}`; return sector.sizes.map(size => `${base}/${size}.jpg`).concat(`${base}/latest.jpg`); };
  const floaterUrls = (stormId, band) => { const base = `https://cdn.star.nesdis.noaa.gov/FLOATER/data/${stormId}/${band}`; return [`${base}/1000x1000.jpg`, `${base}/latest.jpg`]; };
  const satImg = (urls, alt) => `<img class="wpx-sat-img" alt="${escA(alt)}" src="${escA(urls[0])}" data-fallbacks="${escA(urls.slice(1).join("|"))}">`;

  function satelliteHtml() {
    const sat = X.prefs.tropicalSat = Object.assign({ sector: "taw", band: "GEOCOLOR", storm: "" }, X.prefs.tropicalSat || {});
    const sector = SECTORS.find(s => s.id === sat.sector) || SECTORS[0];
    const storm = sat.storm && T.storms.find(s => s.id === sat.storm);
    return `<div class="wpx-chips">${T.storms.filter(s => s.id).map(s => `<button class="wpx-chip${sat.storm === s.id ? " active" : ""}" data-wpx="tropSat" data-id="${escA(s.id)}">${esc(s.name)}</button>`).join("")}${SECTORS.map(s => `<button class="wpx-chip${!storm && sat.sector === s.id ? " active" : ""}" data-wpx="tropSector" data-id="${s.id}">${esc(s.label)}</button>`).join("")}</div>
      <div class="wpx-chips">${BANDS.map(([id, label]) => `<button class="wpx-chip${sat.band === id ? " active" : ""}" data-wpx="tropBand" data-id="${id}">${esc(label)}</button>`).join("")}</div>
      <div class="wpx-card wpx-sat">${storm ? satImg(floaterUrls(storm.id, sat.band), `${storm.name} GOES floater`) : satImg(sectorUrls(sector, sat.band), `${sector.label} GOES imagery`)}</div>
      <p class="wpx-note">${storm ? `${esc(storm.name)} storm floater` : `${esc(sector.label)} · ${esc(sector.sat.replace("GOES", "GOES-"))}`} · latest image from NOAA/NESDIS STAR, updated about every 10 minutes.</p>`;
  }

  function panelHtml() {
    const toggles = [["cone", "Cone"], ["track", "Track"], ["points", "Points"], ["past", "Past track"], ["ww", "Watches/Warnings"], ["outlook", "7-day outlook"]];
    const selected = T.storms.find(s => s.bin === T.selected);
    let content;
    if (T.tab === "outlook") content = outlookHtml();
    else if (T.tab === "satellite") content = satelliteHtml();
    else {
      content = `${T.error ? `<p class="wpx-note err">${esc(T.error)}</p>` : ""}
        ${!T.loaded ? `<p class="wpx-note">Loading NHC advisories…</p>` : T.storms.length ? T.storms.map(stormCard).join("") : T.error ? "" : `<div class="wpx-card"><strong>No active tropical cyclones</strong><p class="wpx-note">NHC is not issuing advisories right now. Check the 7-day outlook for areas to watch.</p></div>`}
        ${selected ? stormDetail(selected) : ""}
        <div class="wpx-classes wpx-trop-key">${Object.keys(WW).map(k => `<span><i style="background:${WW[k][1]}"></i>${esc(WW[k][0])}</span>`).join("")}<span><i style="background:${RISK.Medium}"></i>× = NHC outlook area</span></div>`;
    }
    return `<div class="wpx-tabs wpx-trop-tabs">${[["storms", "Storms"], ["outlook", "7-Day Outlook"], ["satellite", "GOES Satellite"]].map(([id, label]) => `<button class="wpx-chip${T.tab === id ? " active" : ""}" data-wpx="tropTab" data-tab="${id}">${esc(label)}</button>`).join("")}<button class="wpx-chip" data-wpx="tropRefresh">${T.loading ? "Updating…" : "Refresh"}</button></div>
      <div class="wpx-chips wpx-trop-toggles">${toggles.map(([key, label]) => `<button class="wpx-chip toggle${T.show[key] ? " active" : ""}" data-wpx="tropToggle" data-key="${key}" aria-pressed="${T.show[key]}">${esc(label)}</button>`).join("")}</div>
      ${content}
      <p class="wpx-note">Official information: National Hurricane Center.${T.fetchedAt ? ` Updated ${esc(new Date(T.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}.` : ""}</p>`;
  }

  const focusSignature = el => `${el.dataset.wpx || ""}|${el.dataset.bin || el.dataset.key || el.dataset.tab || el.dataset.id || ""}`;
  function draw() {
    const panel = T.body && T.body.querySelector(".wpx-trop-panel");
    if (!panel) return;
    const focusKey = document.activeElement && panel.contains(document.activeElement) ? focusSignature(document.activeElement) : "";
    const scroll = panel.scrollTop;
    panel.innerHTML = panelHtml();
    panel.scrollTop = scroll;
    panel.querySelectorAll("img[data-fallbacks]").forEach(img => {
      img.addEventListener("error", () => {
        const rest = (img.dataset.fallbacks || "").split("|").filter(Boolean);
        if (rest.length) { img.dataset.fallbacks = rest.slice(1).join("|"); img.src = rest[0]; }
        else img.replaceWith(Object.assign(document.createElement("p"), { className: "wpx-note", textContent: "Satellite imagery for this view is not available right now." }));
      });
    });
    if (focusKey) {
      const again = [...panel.querySelectorAll("[data-wpx]")].find(el => focusSignature(el) === focusKey);
      if (again) again.focus({ preventScroll: true });
      else if (T.tv && X.tv) X.tv.focusFirst(panel);
    }
  }

  function mountInto(container) {
    T.body = container;
    container.innerHTML = `<div class="wpx-trop-layout"><div class="wpx-trop-map" id="wpxTropMap"></div><div class="wpx-trop-panel"></div></div>`;
    draw();
    requestAnimationFrame(() => initMap(container.querySelector("#wpxTropMap")));
    refresh(false);
  }
  function unmount() { clearTimeout(T.timer); try { T.map && T.map.remove(); } catch (_) {} T.map = null; T.body = null; }

  function open() {
    T.tv = false;
    const body = X.openOverlay({ id: "tropical", title: "Tropical Storm Center", className: "wpx-tropical", onClose: unmount });
    mountInto(body);
    return body;
  }
  // TV screens embed the same center in their own content area.
  function mount(container, options = {}) { T.tv = !!options.tv; mountInto(container); }

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
          const item = (action, title, detail, glyph, tab, then) => `<button class="tool" data-wpx="${action}"${tab ? ` data-tab="${tab}"` : ""}${then ? ` data-then="${then}"` : ""}><span class="wpx-more-glyph" aria-hidden="true">${glyph}</span><span><strong>${esc(title)}</strong><span>${esc(detail)}</span></span>${action === "openTropical" && T.storms.length ? `<span class="badge soon-badge">${T.storms.length} active</span>` : ""}<span class="chev">›</span></button>`;
          const section = document.createElement("section");
          section.className = "section wpx-more";
          section.innerHTML = `<div class="section-head"><h2>Radar 3.1 &amp; Tropics</h2><span>New</span></div><div class="tool-list">
            ${item("openTropical", "Tropical Storm Center", "Active storms, cones, tracks, watches/warnings, 7-day outlook and GOES satellite.", "🌀")}
            ${item("r31Open", "Radar products", "Any NEXRAD site: velocity, CC, ZDR, KDP, hydrometeor class, echo tops, VIL — every tilt.", "📡", "radar")}
            ${item("r31Open", "Storm damage layers", "NOAA MRMS hail swaths, rotation tracks and rainfall totals.", "🧊", "mrms")}
            ${item("r31Open", "Model Studio", "HRRR, NAM, GFS and ECMWF forecast maps on the radar.", "🧭", "models", "studioOpen")}
            ${item("r31Open", "Point soundings", "Skew-T and hodograph for any point, from HRRR and weather balloons.", "📈", "sounding")}
            ${item("r31Open", "Route weather", "Conditions and alerts along your drive, with gas and shelters on the way.", "🚗", "route")}
            ${item("r31Open", "Gas & tornado shelters", "Every U.S. gas station with area prices, and public shelters.", "⛽", "map")}
          </div>`;
          first.after(section);
        } else if (host) {
          const badgeHost = host.querySelector('.wpx-more [data-wpx="openTropical"]');
          if (badgeHost && T.storms.length && !badgeHost.querySelector(".badge")) badgeHost.querySelector(".chev").insertAdjacentHTML("beforebegin", `<span class="badge soon-badge">${T.storms.length} active</span>`);
        }
      } catch (error) { console.warn(error); }
      return out;
    };
    try { renderMore(); } catch (_) {}
  }

  async function loadStormsOnly() {
    if (!T.loaded) {
      try { await load(); T.fetchedAt = Date.now(); } catch (_) {}
      try { if (typeof renderMore === "function") renderMore(); } catch (_) {}
    }
    return T.storms;
  }

  X.tropical = { open, mount, unmount, refresh, state: T, activeCount: () => T.storms.length, loadStorms: loadStormsOnly };
})();
