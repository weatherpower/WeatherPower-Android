/* WeatherPower travel layers (Radar 3.1): gas stations, public tornado shelters and route weather.
 * Stations: every U.S. gas station from OpenStreetMap, built on the render service (gas/dots.js + per-degree tiles).
 * Prices: U.S. EIA weekly retail averages by state / PADD region — EIA does not publish per-station prices,
 * so each station shows its area's average, labeled that way. Shelters: FindYourTornadoShelter.com registry.
 * Route weather: Mapbox driving route, NWS hourly forecast at each point's estimated arrival + active alerts. */
(function () {
  "use strict";
  const X = window.WPX;
  if (!X || !X.r31) return;
  const R = X.r31;
  const { API, esc, escA, getJson, getText, loadScript } = X;
  const T = X.prefs.travel = Object.assign({ gas: false, shelters: false }, X.prefs.travel || {});
  const save = () => X.savePrefs();
  const kmBetween = (a, b) => { // [lat, lon]
    const R0 = 6371, d1 = (b[0] - a[0]) * Math.PI / 180, d2 = (b[1] - a[1]) * Math.PI / 180;
    const s = Math.sin(d1 / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(d2 / 2) ** 2;
    return 2 * R0 * Math.asin(Math.sqrt(s));
  };

  /* ================================================================ EIA prices */
  const PRODUCTS = { EPMR: "Regular", EPMM: "Midgrade", EPMP: "Premium", EPD2D: "Diesel" };
  const STATE_SERIES = { CA: "SCA", CO: "SCO", FL: "SFL", MA: "SMA", MN: "SMN", NY: "SNY", OH: "SOH", TX: "STX", WA: "SWA" };
  const PADD = {
    R1X: ["CT", "ME", "MA", "NH", "RI", "VT"], R1Y: ["DE", "DC", "MD", "NJ", "NY", "PA"], R1Z: ["FL", "GA", "NC", "SC", "VA", "WV"],
    R20: ["IL", "IN", "IA", "KS", "KY", "MI", "MN", "MO", "NE", "ND", "SD", "OH", "OK", "TN", "WI"], R30: ["AL", "AR", "LA", "MS", "NM", "TX"],
    R40: ["CO", "ID", "MT", "UT", "WY"], R5XCA: ["AK", "AZ", "HI", "NV", "OR", "WA"], SCA: ["CA"]
  };
  const AREA_NAME = { NUS: "U.S. average", R1X: "New England", R1Y: "Central Atlantic", R1Z: "Lower Atlantic", R20: "Midwest (PADD 2)",
    R30: "Gulf Coast (PADD 3)", R40: "Rocky Mountain (PADD 4)", R5XCA: "West Coast excl. California", SCA: "California", SCO: "Colorado",
    SFL: "Florida", SMA: "Massachusetts", SMN: "Minnesota", SNY: "New York", SOH: "Ohio", STX: "Texas", SWA: "Washington" };
  const STATE_TO_PADD = {};
  Object.keys(PADD).forEach(a => PADD[a].forEach(s => { STATE_TO_PADD[s] = STATE_TO_PADD[s] || a; }));
  const PRICE_TTL = 6 * 3600e3;
  let prices = null, pricePromise = null;

  const areaFor = st => { st = String(st || "").toUpperCase(); return STATE_SERIES[st] || STATE_TO_PADD[st] || "NUS"; };
  // State series lack some grades (e.g. Texas diesel): fill each missing product from the region, then the U.S.
  function priceFor(st) {
    if (!prices) return null;
    st = String(st || "").toUpperCase();
    const chain = [STATE_SERIES[st], STATE_TO_PADD[st], "NUS"].filter(Boolean), out = { period: null, src: {} };
    Object.keys(PRODUCTS).forEach(k => {
      chain.some(a => { const p = prices[a]; if (p && p[k] != null) { out[k] = p[k]; out.src[k] = a; out.period = out.period || p.period; return true; } return false; });
    });
    return out;
  }

  function loadPrices() {
    if (prices) return Promise.resolve(prices);
    try { const c = JSON.parse(localStorage.getItem("wpGasEIA") || "null"); if (c && Date.now() - c.t < PRICE_TTL) return Promise.resolve(prices = c.d); } catch (_) {}
    if (pricePromise) return pricePromise;
    pricePromise = getJson(API.eiaGas(), { label: "EIA gas prices" }).then(j => {
      const d = {};
      ((j.response && j.response.data) || []).forEach(r => {
        const a = r.duoarea, p = r.product, v = Number(r.value);
        if (!PRODUCTS[p] || !Number.isFinite(v)) return;
        d[a] = d[a] || { period: r.period };
        if (d[a][p] == null && r.period >= d[a].period) d[a][p] = v;
      });
      prices = d;
      try { localStorage.setItem("wpGasEIA", JSON.stringify({ t: Date.now(), d })); } catch (_) {}
      R.refreshTab("map");
      return d;
    }).catch(error => { pricePromise = null; throw error; });
    return pricePromise;
  }

  /* ================================================================ gas stations */
  const LABEL_ZOOM = 13, DETAIL_ZOOM = 11, MAX_DOTS = 25000;
  const G = { dots: null, dotsPromise: null, cellSet: {}, tiles: {}, tileWait: {}, error: "", inView: 0, key: "" };

  // Feed format (render service gas_build.py): WPGasDots(count, delta-encoded [lat*1e4, lon*1e4, …], cellsWithTiles)
  window.WPGasDots = function (n, flat, cells) {
    const lat = new Float32Array(n), lon = new Float32Array(n);
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) { a += flat[2 * i]; b += flat[2 * i + 1]; lat[i] = a / 1e4; lon[i] = b / 1e4; }
    (cells || []).forEach(c => { G.cellSet[c] = 1; });
    G.dots = { n, lat, lon };
  };
  // WPGasTile("lat_lon", rows): rows are [lat, lon, name, brand, street, city, state, postcode]
  window.WPGasTile = function (key, rows) {
    G.tiles[key] = rows || [];
    if (G.tileWait[key]) { G.tileWait[key].forEach(f => f(G.tiles[key])); delete G.tileWait[key]; }
  };

  function loadDots() {
    if (G.dots) return Promise.resolve(G.dots);
    G.dotsPromise = G.dotsPromise || loadScript(API.gasDots()).then(() => {
      if (!G.dots) throw new Error("Station data is still building on the server");
      return G.dots;
    }).catch(error => { G.dotsPromise = null; throw error; });
    return G.dotsPromise;
  }

  function loadTile(key) {
    if (G.tiles[key]) return Promise.resolve(G.tiles[key]);
    if (!G.cellSet[key]) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      if (G.tileWait[key]) { G.tileWait[key].push(resolve); return; }
      G.tileWait[key] = [resolve];
      loadScript(API.gasTile(key)).catch(error => { delete G.tileWait[key]; reject(error); });
    });
  }

  function visibleCells(b) {
    const out = [];
    for (let y = Math.floor(b.getSouth()); y <= Math.floor(b.getNorth()); y++) {
      for (let x = Math.floor(b.getWest()); x <= Math.floor(b.getEast()); x++) { const k = `${y}_${x}`; if (G.cellSet[k]) out.push(k); }
    }
    return out;
  }

  // Stations within km of a point, nearest first (used by route weather).
  function gasNear(lat, lon, km) {
    return loadDots().then(() => {
      const d = Math.ceil(km / 90) || 1, keys = [];
      for (let y = Math.floor(lat) - d; y <= Math.floor(lat) + d; y++) for (let x = Math.floor(lon) - d; x <= Math.floor(lon) + d; x++) keys.push(`${y}_${x}`);
      return Promise.all(keys.map(k => loadTile(k).catch(() => [])));
    }).then(sets => {
      const out = [], kx = 111.32 * Math.cos(lat * Math.PI / 180);
      sets.forEach(rows => rows.forEach(s => {
        const dk = Math.hypot((s[0] - lat) * 110.57, (s[1] - lon) * kx);
        if (dk <= km) out.push({ lat: s[0], lon: s[1], name: s[2], brand: s[3], addr: [s[4], s[5]].filter(Boolean).join(", "), state: s[6], km: dk });
      }));
      return out.sort((a, b) => a.km - b.km);
    });
  }

  function stationHtml(s) {
    const st = { name: s[2], brand: s[3], addr: [s[4], [s[5], s[6]].filter(Boolean).join(", "), s[7]].filter(Boolean).join(" · ") };
    const area = areaFor(s[6]), p = priceFor(s[6]);
    const name = st.brand && st.name && st.brand !== st.name ? `${st.name} (${st.brand})` : (st.name || st.brand || "Gas station");
    const cells = Object.keys(PRODUCTS).map(k => {
      const alt = p && p.src[k] && p.src[k] !== area;
      return `<div><small>${PRODUCTS[k]}${alt ? " *" : ""}</small><b>${p && p[k] != null ? `$${p[k].toFixed(2)}` : "—"}</b></div>`;
    }).join("");
    return `<strong>${esc(name)}</strong>${st.addr ? `<br><small>${esc(st.addr)}</small>` : ""}<div class="wpx-gas-grid">${cells}</div><small>Area average retail price for <b>${esc(AREA_NAME[area] || area)}</b>, week of ${esc((p && p.period) || "?")}. * = regional average. Source: U.S. EIA weekly survey (no free source publishes each station's posted price). Station © OpenStreetMap contributors.</small>`;
  }

  function gasFeatures(map) {
    const z = map.getZoom();
    const b = map.getBounds();
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    const padLat = (n - s) * 0.05, padLon = (e - w) * 0.05;
    const features = [];
    // Street level: exact rows (with names) from the per-degree tiles.
    if (z >= DETAIL_ZOOM) {
      const keys = visibleCells(b);
      if (keys.length && keys.length <= 6 && keys.every(k => G.tiles[k])) {
        keys.forEach(k => G.tiles[k].forEach(row => {
          if (row[0] < s - padLat || row[0] > n + padLat || row[1] < w - padLon || row[1] > e + padLon) return;
          features.push({ type: "Feature", geometry: { type: "Point", coordinates: [row[1], row[0]] }, properties: { label: String(row[3] || row[2] || "").slice(0, 18) } });
        }));
        G.inView = features.length;
        return features;
      }
      if (keys.length && keys.length <= 6) Promise.all(keys.map(k => loadTile(k).catch(() => []))).then(() => R.apply());
    }
    const d = G.dots;
    if (!d) return features;
    const idx = [];
    for (let i = 0; i < d.n; i++) {
      const la = d.lat[i], lo = d.lon[i];
      if (la >= s - padLat && la <= n + padLat && lo >= w - padLon && lo <= e + padLon) idx.push(i);
    }
    G.inView = idx.length;
    const stride = Math.max(1, Math.ceil(idx.length / MAX_DOTS)); // thin only when the whole country is in view
    for (let j = 0; j < idx.length; j += stride) {
      const i = idx[j];
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [d.lon[i], d.lat[i]] }, properties: {} });
    }
    return features;
  }

  R.addLayer(map => {
    if (!T.gas || !G.dots) {
      X.removeLayerAndSource(map, "wpx-gas", ["wpx-gas-dot", "wpx-gas-lbl"]);
      return;
    }
    const b = map.getBounds(), z = map.getZoom();
    const detailReady = z >= DETAIL_ZOOM && (() => { const k = visibleCells(b); return k.length && k.length <= 6 && k.every(c => G.tiles[c]); })();
    const key = `${b.toArray().flat().map(v => v.toFixed(2)).join(",")}|${Math.floor(z)}|${detailReady}`;
    const had = !!map.getSource("wpx-gas");
    if (!had || G.key !== key) {
      G.key = key;
      map.__wpxDataKeys = map.__wpxDataKeys || {};
      map.__wpxDataKeys["wpx-gas"] = undefined;
      X.setGeoJson(map, "wpx-gas", X.fc(gasFeatures(map)));
    }
    if (!had && map.getSource("wpx-gas")) {
      X.addLayerOnce(map, { id: "wpx-gas-dot", type: "circle", source: "wpx-gas", paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 0.9, 6, 1.3, 8, 2, 10, 3, 13, 5],
        "circle-color": "#ffb020", "circle-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.55, 6, 0.9],
        "circle-stroke-color": "rgba(10,13,20,.85)", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 0, 9, 1] } });
      X.addLayerOnce(map, { id: "wpx-gas-lbl", type: "symbol", source: "wpx-gas", minzoom: LABEL_ZOOM, filter: ["has", "label"], layout: {
        "text-field": ["get", "label"], "text-size": 11, "text-offset": [0.9, 0], "text-anchor": "left", "text-optional": true }, paint: { "text-color": "#ffe2a8", "text-halo-color": "#0a0d14", "text-halo-width": 1.3 } });
    }
    syncGasStatus();
  });

  R.onMove(() => { if (T.gas) R.apply(); });

  // Tapping near a dot opens that station (details come from the per-degree tiles around the tap).
  R.addClick(async (map, event) => {
    if (!T.gas || !G.dots || !map.getLayer("wpx-gas-dot")) return false;
    const pt = event.point;
    const near = map.queryRenderedFeatures([[pt.x - 12, pt.y - 12], [pt.x + 12, pt.y + 12]], { layers: ["wpx-gas-dot"] });
    if (!near.length) return false;
    const y = Math.floor(event.lngLat.lat), x = Math.floor(event.lngLat.lng), keys = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keys.push(`${y + dy}_${x + dx}`);
    loadPrices().catch(() => {});
    const sets = await Promise.all(keys.map(k => loadTile(k).catch(() => [])));
    let best = null, bd = 14;
    sets.forEach(rows => rows.forEach(s => {
      const p = map.project([s[1], s[0]]);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bd) { bd = d; best = s; }
    }));
    if (!best) return false;
    await loadPrices().catch(() => {});
    R.popup(map, { lng: best[1], lat: best[0] }, stationHtml(best));
    return true;
  }, 20);

  function gasStatusText() {
    if (!T.gas) return "Off";
    if (G.error) return G.error;
    if (!G.dots) return "Loading stations…";
    const map = R.map();
    let avg = "";
    if (map && prices) {
      const c = map.getCenter();
      let nearRow = null, best = 1e9;
      (G.tiles[`${Math.floor(c.lat)}_${Math.floor(c.lng)}`] || []).forEach(s => { const d = Math.abs(s[0] - c.lat) + Math.abs(s[1] - c.lng); if (d < best) { best = d; nearRow = s; } });
      const p = nearRow ? priceFor(nearRow[6]) : priceFor("");
      if (p && p.EPMR != null) avg = ` · ${nearRow ? "area" : "U.S."} avg $${p.EPMR.toFixed(2)}`;
    }
    return `${G.inView.toLocaleString()} stations in view${avg}${map && map.getZoom() < LABEL_ZOOM ? " · zoom in for names" : ""}`;
  }
  function syncGasStatus() { const el = document.getElementById("wpxGasStatus"); if (el) el.textContent = gasStatusText(); }

  function setGas(on) {
    T.gas = !!on;
    save();
    if (!T.gas) { R.apply(); R.refreshTab("map"); return; }
    G.error = "";
    loadPrices().catch(error => console.warn("EIA gas prices failed", error));
    loadDots().then(() => { G.key = ""; R.apply(); R.refreshTab("map"); })
      .catch(error => { G.error = error.message || "Station data still building on server"; R.refreshTab("map"); });
    R.refreshTab("map");
  }

  /* ================================================================ tornado shelters */
  const SH_COLORS = { g1: "#558b2f", g2: "#097138", tq: "#006064", b1: "#01579b", b2: "#1a237e", s1: "#bdbdbd", s2: "#757575", s3: "#424242" };
  const SH_CAP = { g1: "Approx. capacity: up to 59", g2: "Approx. capacity: 60–149", tq: "Approx. capacity: 150–399", b1: "Approx. capacity: 400–999", b2: "Approx. capacity: 1,000+",
    s1: "School-hours limited · capacity up to 399", s2: "School-hours limited · capacity 400–999", s3: "School-hours limited · capacity 1,000+" };
  const SH = { rows: null, promise: null, error: "" };

  // Rows: [lat, lng, name, description, capacityCode]
  function loadShelters() {
    if (SH.rows) return Promise.resolve(SH.rows);
    SH.promise = SH.promise || getText(API.shelters(), { label: "Tornado shelters" }).then(text => {
      const rows = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Error("Unexpected shelter data");
      SH.rows = rows.filter(r => Array.isArray(r) && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])));
      return SH.rows;
    }).catch(error => { SH.promise = null; throw error; });
    return SH.promise;
  }

  R.addLayer(map => {
    if (!T.shelters || !SH.rows) { X.removeLayerAndSource(map, "wpx-shelters", ["wpx-shelters-dot"]); return; }
    const had = !!map.getSource("wpx-shelters");
    X.setGeoJson(map, "wpx-shelters", X.fc(SH.rows.map((r, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [Number(r[1]), Number(r[0])] }, properties: { i, color: SH_COLORS[r[4]] || SH_COLORS.g1 } }))), `shelters:${SH.rows.length}`);
    if (!had && map.getSource("wpx-shelters")) {
      X.addLayerOnce(map, { id: "wpx-shelters-dot", type: "circle", source: "wpx-shelters", paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3, 8, 5, 12, 8], "circle-color": ["get", "color"],
        "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2 } });
    }
  });

  R.addClick((map, event) => {
    if (!T.shelters || !SH.rows || !map.getLayer("wpx-shelters-dot")) return false;
    const pt = event.point;
    const hit = map.queryRenderedFeatures([[pt.x - 8, pt.y - 8], [pt.x + 8, pt.y + 8]], { layers: ["wpx-shelters-dot"] })[0];
    if (!hit) return false;
    const r = SH.rows[hit.properties.i];
    if (!r) return false;
    const codeKey = r[4] || "g1";
    R.popup(map, { lng: Number(r[1]), lat: Number(r[0]) }, `<strong>${esc(r[2] || "Tornado shelter")}</strong>${r[3] ? `<br><small>${esc(r[3])}</small>` : ""}<br><b>${esc(SH_CAP[codeKey] || "Public tornado shelter")}</b>${/^s/.test(codeKey) ? "<br><small>Gray locations are generally limited to students and staff during school hours, although some limited public capacity may be available.</small>" : ""}<br><small>Shelter availability is not guaranteed. Verify with local emergency management before relying on a location, and allow enough time to arrive before dangerous weather reaches you.</small>`);
    return true;
  }, 21);

  function setShelters(on) {
    T.shelters = !!on;
    save();
    if (T.shelters) {
      SH.error = "";
      loadShelters().then(() => { R.apply(); R.refreshTab("map"); }).catch(error => { SH.error = `Shelter list unavailable: ${error.message || error}`; R.refreshTab("map"); });
    } else R.apply();
    R.refreshTab("map");
  }

  function mapBody() {
    const legend = ["g1", "g2", "tq", "b1", "b2", "s1"].map(k => `<span><i style="background:${SH_COLORS[k]}"></i>${esc(SH_CAP[k].replace("Approx. capacity: ", "").replace("School-hours limited · capacity", "School"))}</span>`).join("");
    return `
      <div class="wpx-row"><div><strong>Gas stations</strong><small>Every U.S. station · EIA weekly area prices</small></div><label class="wpx-switch"><input type="checkbox" id="wpxGasOn"${T.gas ? " checked" : ""}><span></span></label></div>
      ${T.gas ? `<p class="wpx-note" id="wpxGasStatus">${esc(gasStatusText())}</p><p class="wpx-note">Tap a station for its area's average Regular, Midgrade, Premium and Diesel prices.</p>` : ""}
      <div class="wpx-row"><div><strong>Tornado shelters</strong><small>Public shelters from FindYourTornadoShelter.com</small></div><label class="wpx-switch"><input type="checkbox" id="wpxShelterOn"${T.shelters ? " checked" : ""}><span></span></label></div>
      ${T.shelters ? (SH.error ? `<p class="wpx-note">${esc(SH.error)}</p>` : !SH.rows ? `<p class="wpx-note">Loading shelters…</p>` : `<p class="wpx-note">${SH.rows.length.toLocaleString()} registered shelters. Check access rules before relying on one.</p><div class="wpx-classes">${legend}</div>`) : ""}`;
  }

  R.addTab({
    id: "map", label: "Gas & shelters", order: 70, body: mapBody,
    onChange: e => {
      if (e.target.id === "wpxGasOn") setGas(e.target.checked);
      else if (e.target.id === "wpxShelterOn") setShelters(e.target.checked);
    }
  });

  if (T.gas) setGas(true);
  if (T.shelters) setShelters(true);

  /* ================================================================ route weather */
  const CAT = [
    { id: "clear", label: "Dry", color: "#2fb36b" }, { id: "clouds", label: "Cloudy", color: "#6c8aa8" },
    { id: "fog", label: "Fog", color: "#a3a9b8" }, { id: "rain", label: "Rain", color: "#2f7bff" },
    { id: "heavy", label: "Heavy rain", color: "#7b5cff" }, { id: "snow", label: "Snow / ice", color: "#d8e8ff" },
    { id: "storm", label: "Thunderstorms", color: "#ffb020" }, { id: "warn", label: "Warning", color: "#ff3b4e" }];
  const CI = {};
  CAT.forEach((c, i) => { CI[c.id] = i; });
  const N = 12;
  const RT = { from: null, to: null, fromResults: [], toResults: [], dep: 0, route: null, samples: null, loading: false, error: "", stopMode: "gas", stops: null, stopsError: "", rev: 0, seq: 0 };
  const pointCache = {};

  const tfmt = d => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  function classify(p) {
    const s = String(p.shortForecast || "").toLowerCase(), pop = (p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value) || 0;
    if (/thunder|t-storm/.test(s) && pop >= 30) return "storm";
    if (/snow|sleet|freezing|ice|wintry|blizzard|flurr/.test(s) && pop >= 30) return "snow";
    if (/heavy rain|heavy showers/.test(s) || (/rain|shower/.test(s) && pop >= 70)) return "heavy";
    if (/rain|shower|drizzle/.test(s) && pop >= 30) return "rain";
    if (/fog|haze|smoke/.test(s)) return "fog";
    if (/cloud|overcast/.test(s) && !/partly|mostly sunny|mostly clear/.test(s)) return "clouds";
    return "clear";
  }

  function at(frac) {
    const r = RT.route, target = r.km * frac, c = r.cum;
    let i = 1;
    while (i < c.length - 1 && c[i] < target) i++;
    const a = r.pts[i - 1], b = r.pts[i], w = (target - c[i - 1]) / Math.max(1e-9, c[i] - c[i - 1]);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  }

  function pointInfo(lat, lon) {
    const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (!pointCache[k]) {
      pointCache[k] = getJson(API.nwsPoint(lat, lon), { label: "NWS point", headers: X.NWS.headers }).then(j => {
        const p = j.properties || {}, rl = p.relativeLocation && p.relativeLocation.properties;
        return getJson(p.forecastHourly, { label: "NWS hourly", headers: X.NWS.headers }).then(h => ({ periods: (h.properties || {}).periods || [], place: rl ? `${rl.city}, ${rl.state}` : "" }));
      });
      pointCache[k].catch(() => { delete pointCache[k]; });
    }
    return pointCache[k];
  }

  function sample(i, dep) {
    const frac = i / (N - 1), ll = at(frac), eta = new Date(dep + RT.route.ms * frac);
    const s = { i, lat: ll[0], lon: ll[1], frac, eta, mile: RT.route.km * frac * 0.621371, cat: "clouds", temp: null, text: "Forecast unavailable (outside NWS coverage)", pop: null, wind: "", place: "", alerts: [] };
    return Promise.all([
      pointInfo(ll[0], ll[1]).then(pi => {
        s.place = pi.place;
        const per = pi.periods.find(p => new Date(p.startTime) <= eta && eta < new Date(p.endTime)) || pi.periods[0];
        if (per) { s.cat = classify(per); s.temp = per.temperature; s.text = per.shortForecast; s.pop = per.probabilityOfPrecipitation && per.probabilityOfPrecipitation.value; s.wind = `${per.windSpeed || ""} ${per.windDirection || ""}`.trim(); }
      }).catch(() => {}),
      getJson(API.nwsAlertsPoint(ll[0], ll[1]), { label: "NWS alerts", headers: X.NWS.headers }).then(j => {
        s.alerts = (j.features || []).map(f => f.properties || {}).filter(p => new Date(p.ends || p.expires || 0) > eta && new Date(p.onset || p.effective || 0) <= eta);
        if (s.alerts.some(p => /warning/i.test(p.event || ""))) s.cat = "warn";
      }).catch(() => {})
    ]).then(() => s);
  }

  async function geocode(query) { return typeof searchLocationsRaw === "function" ? searchLocationsRaw(query, 5) : []; }

  async function buildRoute() {
    const from = RT.from || { name: `${state.location.name}`, latitude: state.location.latitude, longitude: state.location.longitude };
    const to = RT.to;
    if (!to) { X.say("Pick a destination first."); return; }
    const seq = ++RT.seq;
    RT.loading = true; RT.error = ""; RT.samples = null; RT.stops = null; RT.route = null;
    R.refreshTab("route");
    try {
      let pts, ms, straight = "";
      try {
        const json = await getJson(API.mapboxDirections(from, to), { label: "Directions" });
        const best = json && json.routes && json.routes[0];
        if (!best || !best.geometry) throw new Error((json && json.message) || "No drivable route was found");
        pts = best.geometry.coordinates.map(c => [c[1], c[0]]);
        ms = best.duration * 1000;
      } catch (routeError) {
        // Directions unavailable: fall back to the direct line at a 55 mph average, and say so.
        straight = String(routeError.message || routeError);
        pts = [];
        for (let k = 0; k <= 40; k++) pts.push([from.latitude + (to.latitude - from.latitude) * k / 40, from.longitude + (to.longitude - from.longitude) * k / 40]);
        ms = kmBetween(pts[0], pts[pts.length - 1]) / 88.5 * 3600000;
      }
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + kmBetween(pts[i - 1], pts[i]));
      if (seq !== RT.seq) return;
      RT.route = { pts, cum, km: cum[cum.length - 1], ms, from: from.name, to: to.name, straight };
      fitRoute();
      await Promise.all([runWeather(seq), runStops(seq)]);
    } catch (error) {
      if (seq === RT.seq) RT.error = `Route unavailable: ${error.message || error}`;
    }
    if (seq !== RT.seq) return;
    RT.loading = false;
    RT.rev++;
    R.apply();
    R.refreshTab("route");
  }

  async function runWeather(seq) {
    if (!RT.route) return;
    const dep = Date.now() + RT.dep * 3600000;
    const list = await Promise.all(Array.from({ length: N }, (_, i) => sample(i, dep)));
    if (seq !== RT.seq) return;
    RT.samples = list;
    RT.rev++;
    R.apply();
    R.refreshTab("route");
  }

  async function runStops(seq) {
    if (!RT.route) return;
    RT.stops = null; RT.stopsError = "";
    const route = RT.route;
    const probe = [];
    for (let d = 0; d <= route.km; d += 5) probe.push({ ll: at(d / route.km), km: d });
    const offRoute = (lat, lon) => { let best = { km: 1e9, along: 0 }; probe.forEach(p => { const k = kmBetween(p.ll, [lat, lon]); if (k < best.km) best = { km: k, along: p.km }; }); return best; };
    try {
      let list;
      if (RT.stopMode === "gas") {
        // one lookup per ~60 km of route, then the closest station to the road in each ~40 km stretch
        const centers = [];
        for (let c = 0; c <= route.km; c += 60) centers.push(at(Math.min(1, c / route.km)));
        await loadPrices().catch(() => {});
        const sets = await Promise.all(centers.map(ll => gasNear(ll[0], ll[1], 45)));
        const seen = {}, all = [];
        sets.forEach(rows => rows.forEach(s => {
          const k = `${s.lat},${s.lon}`;
          if (seen[k]) return;
          seen[k] = 1;
          const o = offRoute(s.lat, s.lon);
          if (o.km <= 3) { s.off = o.km; s.along = o.along; all.push(s); }
        }));
        const bins = {};
        all.forEach(s => { const b = Math.floor(s.along / 40); if (!bins[b] || s.off < bins[b].off) bins[b] = s; });
        list = Object.keys(bins).map(k => bins[k]).sort((a, b) => a.along - b.along);
      } else {
        const rows = await loadShelters();
        list = rows.map(r => { const o = offRoute(Number(r[0]), Number(r[1])); return { lat: Number(r[0]), lon: Number(r[1]), name: r[2], addr: r[3], off: o.km, along: o.along }; })
          .filter(s => s.off <= 16).sort((a, b) => a.along - b.along);
      }
      if (seq !== RT.seq) return;
      RT.stops = list.slice(0, 25);
    } catch (error) {
      if (seq !== RT.seq) return;
      RT.stops = [];
      RT.stopsError = "Couldn't load stops right now.";
    }
    RT.rev++;
    R.apply();
    R.refreshTab("route");
  }

  function fitRoute() {
    const map = R.map();
    if (!map || !RT.route) return;
    const lats = RT.route.pts.map(p => p[0]), lons = RT.route.pts.map(p => p[1]);
    try { map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, maxZoom: 9, duration: 600 }); } catch (_) {}
  }

  function routeFeatures() {
    const f = [];
    if (!RT.route) return X.fc(f);
    const r = RT.route, s = RT.samples;
    const line = coords => ({ type: "LineString", coordinates: coords.map(p => [p[1], p[0]]) });
    f.push({ type: "Feature", geometry: line(r.pts), properties: { kind: "casing" } });
    if (s && s.length) {
      // each stretch takes the worse condition of its two ends
      for (let i = 0; i < s.length - 1; i++) {
        const a = s[i], b = s[i + 1], c = CAT[Math.max(CI[a.cat], CI[b.cat])];
        const fa = a.frac * r.km, fb = b.frac * r.km, seg = [[a.lat, a.lon]];
        r.pts.forEach((p, k) => { if (r.cum[k] > fa && r.cum[k] < fb) seg.push(p); });
        seg.push([b.lat, b.lon]);
        f.push({ type: "Feature", geometry: line(seg), properties: { kind: "seg", color: c.color } });
      }
      s.forEach((x, k) => {
        if (k % 2 && k !== s.length - 1) return;
        f.push({ type: "Feature", geometry: { type: "Point", coordinates: [x.lon, x.lat] }, properties: { kind: "pin", color: CAT[CI[x.cat]].color, label: `${x.temp != null ? `${x.temp}°` : "—"} · ${tfmt(x.eta)}`, i: x.i } });
      });
    } else f.push({ type: "Feature", geometry: line(r.pts), properties: { kind: "seg", color: "#52e0fa" } });
    (RT.stops || []).forEach((st, k) => f.push({ type: "Feature", geometry: { type: "Point", coordinates: [st.lon, st.lat] }, properties: { kind: "stop", color: RT.stopMode === "gas" ? "#ffb020" : "#2fd35a", k } }));
    return X.fc(f);
  }

  R.addLayer(map => {
    if (!RT.route) { X.removeLayerAndSource(map, "wpx-route", ["wpx-route-casing", "wpx-route-seg", "wpx-route-stop", "wpx-route-pin", "wpx-route-lbl"]); return; }
    const had = !!map.getSource("wpx-route");
    X.setGeoJson(map, "wpx-route", routeFeatures(), `route:${RT.rev}`);
    if (!had && map.getSource("wpx-route")) {
      X.addLayerOnce(map, { id: "wpx-route-casing", type: "line", source: "wpx-route", filter: ["==", ["get", "kind"], "casing"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#05111f", "line-width": 9, "line-opacity": 0.85 } });
      X.addLayerOnce(map, { id: "wpx-route-seg", type: "line", source: "wpx-route", filter: ["==", ["get", "kind"], "seg"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 6, "line-opacity": 0.95 } });
      X.addLayerOnce(map, { id: "wpx-route-stop", type: "circle", source: "wpx-route", filter: ["==", ["get", "kind"], "stop"], paint: { "circle-radius": 6, "circle-color": ["get", "color"], "circle-stroke-color": "#0a0d14", "circle-stroke-width": 2 } });
      X.addLayerOnce(map, { id: "wpx-route-pin", type: "circle", source: "wpx-route", filter: ["==", ["get", "kind"], "pin"], paint: { "circle-radius": 5, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 } });
      X.addLayerOnce(map, { id: "wpx-route-lbl", type: "symbol", source: "wpx-route", filter: ["==", ["get", "kind"], "pin"], layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, -1.3], "text-allow-overlap": false }, paint: { "text-color": "#ffffff", "text-halo-color": ["get", "color"], "text-halo-width": 2 } });
    }
  });

  function routeBody() {
    const from = RT.from || { name: `${state.location.name} (current)` };
    const s = RT.samples;
    let timeline = "";
    if (RT.route && s && s.length) {
      const worst = s.reduce((w, x) => (CI[x.cat] > CI[w.cat] ? x : w), s[0]), wc = CAT[CI[worst.cat]];
      const callout = CI[worst.cat] <= 1 ? "No rain, snow or storms expected along the way." :
        `<b>${esc(wc.label)}</b> near ${esc(worst.place || `mile ${Math.round(worst.mile)}`)} around ${esc(tfmt(worst.eta))} · ${esc(worst.text)}${worst.alerts.length ? ` · <b>${esc(worst.alerts[0].event)}</b>` : ""}`;
      const temps = s.filter((x, k) => k % 2 === 0 || k === s.length - 1);
      timeline = `
        <div class="wpx-callout" style="--c:${wc.color}">${callout}</div>
        <div class="wpx-temps">${temps.map(x => `<span>${x.temp != null ? `${x.temp}°` : "—"}</span>`).join("")}</div>
        <div class="wpx-ribbon">${s.map(x => `<i class="${x.alerts.length ? "alert" : ""}" style="background:${CAT[CI[x.cat]].color}" title="${escA(`${tfmt(x.eta)} · ${x.place || ""} · ${x.text}`)}"></i>`).join("")}</div>
        <div class="wpx-times"><span>Leave ${esc(tfmt(s[0].eta))}</span><span>${Math.round(RT.route.km * 0.621371)} mi</span><span>Arrive ${esc(tfmt(s[s.length - 1].eta))}</span></div>
        <div class="wpx-classes">${CAT.map(c => `<span><i style="background:${c.color}"></i>${esc(c.label)}</span>`).join("")}</div>
        <div class="wpx-route-cards">${s.map(x => `<button class="wpx-route-card" data-wpx="routeFly" data-i="${x.i}" style="--c:${CAT[CI[x.cat]].color}"><small>${esc(tfmt(x.eta))} · mi ${Math.round(x.mile)}</small><span>${esc(x.place || "En route")}</span><b>${x.temp != null ? `${x.temp}°` : "—"}${x.pop != null ? ` <small>${x.pop}%</small>` : ""}</b><em>${esc(x.alerts.length ? x.alerts[0].event : x.text)}</em></button>`).join("")}</div>`;
    } else if (RT.route) timeline = `<p class="wpx-note">Checking the forecast along your drive${RT.dep ? ` (leaving in ${RT.dep} hr)` : ""}…</p>`;
    const stops = RT.route ? `
      <div class="wpx-label">Along your route</div>
      <div class="wpx-chips">${R.chip("routeStops", "Gas", RT.stopMode === "gas", 'data-m="gas"')}${R.chip("routeStops", "Tornado shelters", RT.stopMode === "shelter", 'data-m="shelter"')}</div>
      ${RT.stops === null ? `<p class="wpx-note">Finding ${RT.stopMode === "gas" ? "gas stations" : "tornado shelters"} along the route…</p>` :
        RT.stopsError ? `<p class="wpx-note">${esc(RT.stopsError)}</p>` :
        !RT.stops.length ? `<p class="wpx-note">${RT.stopMode === "gas" ? "No gas stations mapped within 2 miles of this route." : "No public tornado shelters within 10 miles of this route."}</p>` :
        `<div class="wpx-results">${RT.stops.map((st, k) => {
          const p = RT.stopMode === "gas" ? priceFor(st.state) : null;
          return `<button class="wpx-result" data-wpx="routeStop" data-k="${k}"><span>${esc(st.brand || st.name || (RT.stopMode === "gas" ? "Gas station" : "Tornado shelter"))}</span><small>${esc(String(st.addr || (st.name && st.name !== st.brand ? st.name : "")).slice(0, 90))}${st.off > 0.3 ? ` · ${(st.off * 0.621).toFixed(1)} mi off route` : " · on route"}${p && p.EPMR != null ? ` · area avg $${p.EPMR.toFixed(2)}` : ""} · mile ${Math.round(st.along * 0.621)}</small></button>`;
        }).join("")}</div><p class="wpx-note">${RT.stopMode === "gas" ? "Opening hours aren't known, so call ahead late at night." : "Public shelters from FindYourTornadoShelter.com. Check access rules before relying on one."}</p>`}` : "";
    return `
      <div class="wpx-label">From</div>
      <div class="wpx-inline"><input type="search" id="wpxRouteFrom" placeholder="${escA(from.name)}" aria-label="Start"><button class="wpx-btn" data-wpx="routeFromHere">Here</button></div>
      ${RT.fromResults.length ? `<div class="wpx-results">${RT.fromResults.map((r, i) => `<button class="wpx-result" data-wpx="routePick" data-which="from" data-i="${i}"><span>${esc(r.name)}</span><small>${esc(r.subtitle || "")}</small></button>`).join("")}</div>` : `<p class="wpx-note">${esc(from.name)}</p>`}
      <div class="wpx-label">To</div>
      <input type="search" id="wpxRouteTo" placeholder="${escA(RT.to ? RT.to.name : "City, state, or ZIP")}" aria-label="Destination">
      ${RT.toResults.length ? `<div class="wpx-results">${RT.toResults.map((r, i) => `<button class="wpx-result" data-wpx="routePick" data-which="to" data-i="${i}"><span>${esc(r.name)}</span><small>${esc(r.subtitle || "")}</small></button>`).join("")}</div>` : RT.to ? `<p class="wpx-note">${esc(RT.to.name)}${RT.to.subtitle ? `, ${esc(RT.to.subtitle)}` : ""}</p>` : ""}
      <div class="wpx-label">Leave</div>
      <div class="wpx-chips">${[0, 1, 2, 3].map(h => R.chip("routeDepart", h ? `+${h} hr` : "Leave now", RT.dep === h, `data-h="${h}"`)).join("")}</div>
      <div class="wpx-btnrow"><button class="wpx-btn primary" data-wpx="routeGo"${RT.loading ? " disabled" : ""}>${RT.loading ? "Checking route…" : "Get route weather"}</button>${RT.route ? `<button class="wpx-btn subtle" data-wpx="routeClear">Clear</button>` : ""}</div>
      ${RT.error ? `<p class="wpx-note">${esc(RT.error)}</p>` : ""}
      ${RT.route ? `<p class="wpx-note">${esc(RT.route.from)} → ${esc(RT.route.to)} · ${Math.round(RT.route.km * 0.621371)} mi · about ${(RT.route.ms / 3600000).toFixed(1)} h. NWS hourly forecast at your estimated arrival time.</p>${RT.route.straight ? `<p class="wpx-note err">Driving directions are unavailable (${esc(RT.route.straight)}), so this uses a straight line at a 55 mph average.</p>` : ""}` : ""}
      ${timeline}${stops}`;
  }

  let searchTimer = 0;
  R.addTab({
    id: "route", label: "Route", order: 40, body: routeBody,
    onInput: e => {
      const t = e.target;
      if (t.id !== "wpxRouteFrom" && t.id !== "wpxRouteTo") return;
      clearTimeout(searchTimer);
      const which = t.id === "wpxRouteFrom" ? "fromResults" : "toResults", q = t.value, id = t.id;
      searchTimer = setTimeout(async () => {
        try { RT[which] = q.trim().length >= 2 ? await geocode(q) : []; } catch (_) { RT[which] = []; }
        R.renderSheet();
        const input = document.getElementById(id);
        if (input) { input.value = q; input.focus(); }
      }, 350);
    }
  });

  Object.assign(X.actions, {
    routeFromHere: () => { RT.from = null; RT.fromResults = []; R.renderSheet(); },
    routePick: el => {
      const list = el.dataset.which === "from" ? RT.fromResults : RT.toResults;
      const item = list[Number(el.dataset.i)];
      if (!item) return;
      RT[el.dataset.which] = item;
      RT.fromResults = []; RT.toResults = [];
      R.renderSheet();
    },
    routeDepart: el => { RT.dep = Number(el.dataset.h) || 0; if (RT.route) { RT.samples = null; R.renderSheet(); runWeather(RT.seq); } else R.renderSheet(); },
    routeGo: () => buildRoute(),
    routeClear: () => { RT.seq++; RT.route = null; RT.samples = null; RT.stops = null; RT.error = ""; RT.loading = false; RT.rev++; R.apply(); R.renderSheet(); },
    routeStops: el => { RT.stopMode = el.dataset.m; if (RT.route) runStops(RT.seq); R.renderSheet(); },
    routeFly: el => { const x = (RT.samples || [])[Number(el.dataset.i)]; const map = R.map(); if (x && map) map.flyTo({ center: [x.lon, x.lat], zoom: Math.max(map.getZoom(), 9), duration: 600 }); },
    routeStop: el => { const st = (RT.stops || [])[Number(el.dataset.k)]; const map = R.map(); if (st && map) map.flyTo({ center: [st.lon, st.lat], zoom: 14, duration: 600 }); }
  });

  X.travel = { gasNear, priceFor, loadPrices, loadShelters };
})();
