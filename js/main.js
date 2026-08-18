(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Map setup — satellite basemap. View state (center/zoom) is only ever
  // changed by explicit user actions (initial load, coordinate search).
  // Switching between timeline dates NEVER touches the view — only which
  // imagery capture and which polygon are shown, via layer swapping and
  // toggling, so the user keeps their place on the map through time.
  // ---------------------------------------------------------------------
  const map = L.map("map", { zoomControl: true }).setView([20, 0], 3);

  const CURRENT_IMAGERY_URL =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

  const IMAGERY_LAYER_OPTIONS = {
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    maxZoom: 20,
  };

  // .fallback (not plain L.tileLayer) so that missing tiles — common in
  // older/rural Wayback captures — fall back to a scaled-up tile from the
  // nearest lower zoom level instead of leaving a blank gap.
  let satelliteLayer = L.tileLayer.fallback(CURRENT_IMAGERY_URL, IMAGERY_LAYER_OPTIONS).addTo(map);

  let imageryHasFallbackTiles = false;
  satelliteLayer.on("tilefallback", handleTileFallback);

  function handleTileFallback() {
    if (imageryHasFallbackTiles) return;
    imageryHasFallbackTiles = true;
    renderImageryLabel();
  }

  // Swaps in a new imagery URL without ever showing a blank map: the new
  // tile layer loads in on top of the current one, and only once it has
  // fully rendered do we remove the old layer. A plain setUrl()/redraw()
  // tears down all existing tiles immediately and waits for replacements
  // to load in afterwards, which flashes the whole map blank — this
  // crossfade avoids that.
  function swapImageryLayer(urlTemplate) {
    const oldLayer = satelliteLayer;
    const newLayer = L.tileLayer.fallback(urlTemplate, IMAGERY_LAYER_OPTIONS);
    newLayer.on("tilefallback", handleTileFallback);
    newLayer.once("load", () => {
      if (map.hasLayer(oldLayer)) map.removeLayer(oldLayer);
    });
    newLayer.addTo(map);
    satelliteLayer = newLayer;
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  // Each entry: { date, vertices: [[lat,lng], ...], group: L.LayerGroup,
  //               imageryRelease: {rNum, dateStr, urlTemplate} | null }
  let dates = [];
  let currentIndex = -1;
  let visibleEntry = null; // tracked by reference, not index — indices shift on sort/splice

  const dom = {
    itemName: document.getElementById("item-name"),
    coordSearch: document.getElementById("coord-search"),
    coordSearchBtn: document.getElementById("coord-search-btn"),
    newItemBtn: document.getElementById("new-item-btn"),
    submitBtn: document.getElementById("submit-btn"),
    imageryLabel: document.getElementById("imagery-label"),
    dateList: document.getElementById("date-list"),
    newDate: document.getElementById("new-date"),
    newDateFallback: document.getElementById("new-date-fallback"),
    addDateBtn: document.getElementById("add-date-btn"),
    sliderRow: document.getElementById("slider-row"),
    slider: document.getElementById("date-slider"),
    sliderLabel: document.getElementById("date-slider-label"),
    vertexCount: document.getElementById("vertex-count"),
    undoBtn: document.getElementById("undo-vertex-btn"),
    clearBtn: document.getElementById("clear-vertices-btn"),
    itemsList: document.getElementById("items-list"),
    reviewBtn: document.getElementById("review-btn"),
    reviewInput: document.getElementById("review-input"),
    status: document.getElementById("status"),
    modalBackdrop: document.getElementById("modal-backdrop"),
    modalCancel: document.getElementById("modal-cancel-btn"),
    modalConfirm: document.getElementById("modal-confirm-btn"),
    modalDescription: document.getElementById("modal-description"),
    modalSignature: document.getElementById("modal-signature"),
  };

  let statusTimer = null;
  function showStatus(message, kind) {
    dom.status.textContent = message;
    dom.status.className = "status visible" + (kind ? " " + kind : "");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      dom.status.classList.remove("visible");
    }, 4500);
  }

  // ---------------------------------------------------------------------
  // Historical satellite imagery (Esri World Imagery Wayback). Each
  // "release" is a full archived capture from some date. The timeline's
  // date field is populated directly from this release list, so every
  // date you can add already has a matching capture — no nearest-match
  // guessing needed. Picking one crossfades the basemap to that release's
  // tiles (see swapImageryLayer below) — map center/zoom are never
  // touched, so the continuity guarantee for switching dates still holds.
  // (nearestRelease below still backs the rare fallback-picker case, where
  // the release list itself failed to load.)
  // ---------------------------------------------------------------------
  const WAYBACK_CONFIG_URL =
    "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";

  let waybackReleases = []; // sorted ascending by date
  let waybackReady = false;

  async function fetchWaybackReleases() {
    const resp = await fetch(WAYBACK_CONFIG_URL);
    if (!resp.ok) throw new Error(`Wayback config fetch failed (${resp.status})`);
    const config = await resp.json();
    const releases = [];
    for (const rNum in config) {
      const entry = config[rNum];
      const match = /\((?:Wayback )?(\d{4}-\d{2}-\d{2})\)/.exec(entry.itemTitle || "");
      if (!match || !entry.itemURL) continue;
      releases.push({
        rNum,
        dateStr: match[1],
        date: new Date(match[1] + "T00:00:00Z"),
        urlTemplate: entry.itemURL
          .replace("{level}", "{z}")
          .replace("{row}", "{y}")
          .replace("{col}", "{x}"),
      });
    }
    releases.sort((a, b) => a.date - b.date);
    return releases;
  }

  function nearestRelease(dateStr) {
    if (!waybackReleases.length) return null;
    const target = new Date(dateStr + "T00:00:00Z").getTime();
    let best = waybackReleases[0];
    let bestDiff = Math.abs(best.date.getTime() - target);
    for (const release of waybackReleases) {
      const diff = Math.abs(release.date.getTime() - target);
      if (diff < bestDiff) {
        best = release;
        bestDiff = diff;
      }
    }
    return best;
  }

  function assignImageryRelease(entry) {
    if (!waybackReady) return;
    entry.imageryRelease = nearestRelease(entry.date);
  }

  let currentRelease = null;
  let currentUrlTemplate = CURRENT_IMAGERY_URL;
  // Raw "YYYY-MM-DD" from the date picker while its value is being changed
  // but hasn't been committed via "Add date" yet — lets the calendar drive
  // a live imagery preview before a timeline entry exists for it.
  let previewDate = null;

  function renderImageryLabel() {
    if (!currentRelease) {
      dom.imageryLabel.textContent = waybackReady ? "Imagery: current" : "Imagery: loading…";
      return;
    }
    // Timeline dates are picked directly from the list of real Wayback
    // captures, so the shown release always exactly matches the active
    // date — no "nearest capture to X" hedging needed here anymore.
    const isExplicit = previewDate || visibleEntry;
    const base = isExplicit
      ? `Imagery: ${currentRelease.dateStr}`
      : `Imagery: ${currentRelease.dateStr} (latest)`;
    dom.imageryLabel.textContent = imageryHasFallbackTiles
      ? `${base} — some tiles at lower resolution`
      : base;
  }

  function applyImageryRelease(release) {
    currentRelease = release;
    imageryHasFallbackTiles = false;
    if (!release) {
      renderImageryLabel();
      return;
    }
    if (release.urlTemplate !== currentUrlTemplate) {
      currentUrlTemplate = release.urlTemplate;
      swapImageryLayer(release.urlTemplate);
    }
    renderImageryLabel();
  }

  function updateImageryLayer() {
    previewDate = null;
    let release = null;
    if (visibleEntry && visibleEntry.imageryRelease) {
      release = visibleEntry.imageryRelease;
    } else if (waybackReady && waybackReleases.length) {
      release = waybackReleases[waybackReleases.length - 1]; // most recent = "current"
    }
    applyImageryRelease(release);
  }

  // Live preview as the date picker's value changes, before "Add date" is
  // clicked — lets you browse imagery across time without committing a
  // timeline entry for every date you look at.
  function previewImageryForDate(dateStr) {
    if (!waybackReady) return;
    if (!dateStr) {
      updateImageryLayer();
      return;
    }
    const release = nearestRelease(dateStr);
    if (!release) return;
    previewDate = dateStr;
    applyImageryRelease(release);
  }

  // The timeline's date field only offers dates that actually have a
  // Wayback capture — populated straight from the release list, in
  // whatever cadence Esri published them (weekly in some periods/regions,
  // months apart in others), rather than letting you pick an arbitrary
  // date and snapping it to the nearest capture after the fact.
  function populateDateOptions() {
    const select = dom.newDate;
    const previousValue = select.value;
    select.innerHTML = "";

    if (!waybackReleases.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No imagery dates available";
      select.appendChild(opt);
      select.disabled = true;
      return;
    }

    select.disabled = false;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a capture date…";
    select.appendChild(placeholder);

    // waybackReleases stays sorted ascending (other code relies on that
    // order) — reverse just for display, so the newest capture is at the
    // top of the dropdown instead of buried at the bottom of a long list.
    const displayOrder = waybackReleases.slice().reverse();
    displayOrder.forEach((release) => {
      const opt = document.createElement("option");
      opt.value = release.dateStr;
      const alreadyUsed = dates.some((d) => d.date === release.dateStr);
      opt.textContent = alreadyUsed ? `${release.dateStr} (already added)` : release.dateStr;
      opt.disabled = alreadyUsed;
      select.appendChild(opt);
    });

    if (previousValue && Array.from(select.options).some((o) => o.value === previousValue)) {
      select.value = previousValue;
    }
  }

  // If the Wayback config can't be fetched at all, there's no capture list
  // to offer — fall back to a plain date picker so the tool stays usable
  // (just without historical imagery matching), rather than blocking
  // "Add date" entirely.
  function enableFallbackDatePicker() {
    dom.newDate.style.display = "none";
    dom.newDate.disabled = true;
    dom.newDateFallback.style.display = "";
  }

  function getNewDateValue() {
    return dom.newDateFallback.style.display !== "none"
      ? dom.newDateFallback.value
      : dom.newDate.value;
  }

  function clearNewDateValue() {
    if (dom.newDateFallback.style.display !== "none") {
      dom.newDateFallback.value = "";
    } else {
      dom.newDate.value = "";
    }
  }

  fetchWaybackReleases()
    .then((releases) => {
      waybackReleases = releases;
      waybackReady = true;
      dates.forEach(assignImageryRelease);
      populateDateOptions();
      refreshDateChips();
      updateImageryLayer();
    })
    .catch(() => {
      showStatus(
        "Historical imagery unavailable — pick any date; the satellite view won't change with it.",
        "error"
      );
      dom.imageryLabel.textContent = "Imagery: current (history unavailable)";
      enableFallbackDatePicker();
    });

  // ---------------------------------------------------------------------
  // Layer rebuilding for a date entry
  // ---------------------------------------------------------------------
  function rebuildLayer(entry) {
    entry.group.clearLayers();

    entry.vertices.forEach((latlng, i) => {
      const marker = L.circleMarker(latlng, {
        radius: 5,
        className: "vertex-marker",
        color: "#7a5b00",
        weight: 2,
        fillColor: "#ffcc33",
        fillOpacity: 1,
      });
      marker.on("click", (evt) => L.DomEvent.stopPropagation(evt));
      marker.on("contextmenu", (evt) => {
        L.DomEvent.stopPropagation(evt);
        L.DomEvent.preventDefault(evt);
        entry.vertices.splice(i, 1);
        rebuildLayer(entry);
        refreshVertexUI();
      });
      entry.group.addLayer(marker);
    });

    if (entry.vertices.length >= 3) {
      entry.group.addLayer(
        L.polygon(entry.vertices, {
          color: "#3fa9f5",
          weight: 2,
          fillColor: "#3fa9f5",
          fillOpacity: 0.2,
        })
      );
    } else if (entry.vertices.length === 2) {
      entry.group.addLayer(
        L.polyline(entry.vertices, { color: "#3fa9f5", weight: 2, dashArray: "6,4" })
      );
    }
  }

  function currentEntry() {
    return currentIndex >= 0 ? dates[currentIndex] : null;
  }

  // ---------------------------------------------------------------------
  // Adding vertices by clicking the map
  // ---------------------------------------------------------------------
  map.on("click", (e) => {
    const entry = currentEntry();
    if (!entry) {
      showStatus("Add a date on the timeline before placing vertices.", "error");
      return;
    }
    entry.vertices.push([e.latlng.lat, e.latlng.lng]);
    rebuildLayer(entry);
    refreshVertexUI();
    refreshDateChips();
  });

  dom.undoBtn.addEventListener("click", () => {
    const entry = currentEntry();
    if (!entry || entry.vertices.length === 0) return;
    entry.vertices.pop();
    rebuildLayer(entry);
    refreshVertexUI();
    refreshDateChips();
  });

  dom.clearBtn.addEventListener("click", () => {
    const entry = currentEntry();
    if (!entry || entry.vertices.length === 0) return;
    entry.vertices = [];
    rebuildLayer(entry);
    refreshVertexUI();
    refreshDateChips();
  });

  function refreshVertexUI() {
    const entry = currentEntry();
    const count = entry ? entry.vertices.length : 0;
    dom.vertexCount.textContent = `(${count})`;
    dom.undoBtn.disabled = count === 0;
    dom.clearBtn.disabled = count === 0;
  }

  // ---------------------------------------------------------------------
  // Timeline: date list + slider. Selecting a date only toggles which
  // layer group is shown on the map — the view (center/zoom) is untouched.
  // ---------------------------------------------------------------------
  function selectDate(index) {
    if (index < 0 || index >= dates.length) return;
    const entry = dates[index];
    if (visibleEntry && visibleEntry !== entry) {
      map.removeLayer(visibleEntry.group);
    }
    if (!map.hasLayer(entry.group)) {
      entry.group.addTo(map);
    }
    visibleEntry = entry;
    currentIndex = index;
    dom.slider.value = String(index);
    dom.sliderLabel.textContent = entry.date;
    updateImageryLayer();
    refreshVertexUI();
    refreshDateChips();
  }

  function refreshDateChips() {
    dom.dateList.innerHTML = "";
    dates.forEach((entry, i) => {
      const chip = document.createElement("div");
      chip.className =
        "date-chip" +
        (i === currentIndex ? " active" : "") +
        (entry.vertices.length >= 3 ? " has-shape" : "");

      const label = document.createElement("span");
      label.textContent = entry.date;
      chip.appendChild(label);

      const status = document.createElement("span");
      status.className = "chip-status";
      const ptsText =
        entry.vertices.length >= 3
          ? `${entry.vertices.length} pts`
          : entry.vertices.length > 0
          ? `${entry.vertices.length} pts (need 3+)`
          : "empty";
      status.textContent =
        entry.imageryRelease && entry.imageryRelease.dateStr !== entry.date
          ? `${ptsText} · img ${entry.imageryRelease.dateStr}`
          : ptsText;
      chip.appendChild(status);

      const remove = document.createElement("span");
      remove.className = "chip-remove";
      remove.textContent = "✕";
      remove.title = "Remove this date";
      remove.addEventListener("click", (evt) => {
        evt.stopPropagation();
        removeDate(i);
      });
      chip.appendChild(remove);

      chip.addEventListener("click", () => selectDate(i));
      dom.dateList.appendChild(chip);
    });
  }

  function removeDate(index) {
    const entry = dates[index];
    if (!entry) return;
    map.removeLayer(entry.group);
    if (visibleEntry === entry) visibleEntry = null;
    dates.splice(index, 1);
    populateDateOptions();

    if (dates.length === 0) {
      currentIndex = -1;
      dom.sliderRow.style.display = "none";
      updateImageryLayer();
      refreshVertexUI();
      refreshDateChips();
    } else {
      dom.slider.max = String(dates.length - 1);
      const nextIndex = Math.min(index, dates.length - 1);
      selectDate(nextIndex);
    }
  }

  dom.newDate.addEventListener("change", () => {
    previewImageryForDate(dom.newDate.value);
  });
  dom.newDateFallback.addEventListener("input", () => {
    previewImageryForDate(dom.newDateFallback.value);
  });

  dom.addDateBtn.addEventListener("click", () => {
    const value = getNewDateValue();
    if (!value) {
      showStatus("Pick a date first.", "error");
      return;
    }
    if (dates.some((d) => d.date === value)) {
      showStatus("That date is already on the timeline.", "error");
      return;
    }
    const entry = { date: value, vertices: [], group: L.layerGroup(), imageryRelease: null };
    assignImageryRelease(entry);
    dates.push(entry);
    dates.sort((a, b) => a.date.localeCompare(b.date));
    const newIndex = dates.findIndex((d) => d.date === value);

    dom.slider.max = String(Math.max(dates.length - 1, 0));
    dom.sliderRow.style.display = dates.length > 1 ? "flex" : "none";

    selectDate(newIndex);
    clearNewDateValue();
    populateDateOptions();
  });

  dom.slider.addEventListener("input", () => {
    selectDate(parseInt(dom.slider.value, 10));
  });

  // ---------------------------------------------------------------------
  // Search coordinates — explicit navigation, so moving the view here is
  // expected (unlike switching between timeline dates).
  //
  // Accepts decimal degrees, degrees-decimal-minutes, and full DMS, with
  // N/S/E/W as either a prefix or suffix on either value, any of the usual
  // degree/minute/second symbols (°, ′, ', ″, ", ''), and pretty much any
  // separator between the two values (comma, space, slash, semicolon...).
  // A single regex pass pulls out up to two "coordinate tokens"; each is
  // converted to signed decimal degrees, then assigned to lat/lon using
  // hemisphere letters when present, falling back to input order.
  // ---------------------------------------------------------------------
  const COORD_COMPONENT_RE =
    /([NSEW])?\s*(-?\d{1,3}(?:\.\d+)?)\s*[°º]?\s*(?:(\d{1,2}(?:\.\d+)?)\s*[′']?\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:″|"|'')?)?)?\s*([NSEW])?(?!\d)/gi;

  function parseCoordinatePair(raw) {
    const text = raw.trim();
    if (!text) return null;

    const tokens = [];
    let match;
    COORD_COMPONENT_RE.lastIndex = 0;
    while ((match = COORD_COMPONENT_RE.exec(text)) !== null) {
      const deg = parseFloat(match[2]);
      if (Number.isNaN(deg)) continue;
      const min = match[3] ? parseFloat(match[3]) : 0;
      const sec = match[4] ? parseFloat(match[4]) : 0;
      const hemi = (match[1] || match[5] || "").toUpperCase();

      let value = Math.abs(deg) + min / 60 + sec / 3600;
      if (deg < 0) value = -value;
      if (hemi === "S" || hemi === "W") value = -Math.abs(value);
      else if (hemi === "N" || hemi === "E") value = Math.abs(value);

      let axis = null;
      if (hemi === "N" || hemi === "S") axis = "lat";
      else if (hemi === "E" || hemi === "W") axis = "lon";

      tokens.push({ value, axis });
    }

    if (tokens.length !== 2) return null;
    const [a, b] = tokens;

    let lat, lon;
    if (a.axis === "lat" && b.axis === "lon") {
      lat = a.value;
      lon = b.value;
    } else if (a.axis === "lon" && b.axis === "lat") {
      lat = b.value;
      lon = a.value;
    } else {
      // No usable hemisphere hints — assume input order is lat, lon.
      lat = a.value;
      lon = b.value;
    }

    // Recover from an accidental lat/lon swap (only possible to detect
    // when the out-of-range value would fit the other slot).
    if ((lat < -90 || lat > 90) && lon >= -90 && lon <= 90 && lat >= -180 && lat <= 180) {
      [lat, lon] = [lon, lat];
    }

    if (Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return null;
    }
    return { lat, lon };
  }

  dom.coordSearchBtn.addEventListener("click", goToCoords);
  dom.coordSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goToCoords();
  });

  function goToCoords() {
    const raw = dom.coordSearch.value;
    const parsed = parseCoordinatePair(raw);
    if (!parsed) {
      showStatus(
        "Couldn't read those coordinates. Try '40.71, -74.01' or '40°42'47\"N 74°0'22\"W'.",
        "error"
      );
      return;
    }
    map.flyTo([parsed.lat, parsed.lon], Math.max(map.getZoom(), 17));
    showStatus(`Jumped to ${parsed.lat.toFixed(5)}, ${parsed.lon.toFixed(5)}`, "success");
  }

  // ---------------------------------------------------------------------
  // New item — clears the workspace but never touches the map view.
  // ---------------------------------------------------------------------
  dom.newItemBtn.addEventListener("click", () => {
    const hasWork = dates.some((d) => d.vertices.length > 0) || dom.itemName.value.trim();
    if (hasWork && !window.confirm("Discard the current item and start a new one?")) {
      return;
    }
    resetWorkspace();
  });

  function resetWorkspace() {
    dates.forEach((entry) => map.removeLayer(entry.group));
    dates = [];
    currentIndex = -1;
    visibleEntry = null;
    dom.itemName.value = "";
    dom.slider.max = "0";
    dom.slider.value = "0";
    dom.sliderRow.style.display = "none";
    clearNewDateValue();
    populateDateOptions();
    updateImageryLayer();
    refreshVertexUI();
    refreshDateChips();
  }

  // ---------------------------------------------------------------------
  // Review mode — load a previously-downloaded submission zip back into
  // the workspace so its grave can be edited. Vertices are recovered by
  // parsing the real .shp binary (a single-ring POLYGON record, per
  // writeDateShapefile below) rather than trusting a separate copy of the
  // coordinates, since the shapefile itself is the authoritative record.
  // Everything else — item name, grave type, description, signature —
  // comes straight from metadata.json and pre-fills the same fields the
  // submit flow reads from, so re-submitting only requires touching
  // whatever actually needs to change.
  // ---------------------------------------------------------------------
  function readPolygonVertices(buffer) {
    const view = new DataView(buffer);
    if (buffer.byteLength < 108) throw new Error("file is too short to be a shapefile");
    if (view.getInt32(32, true) !== 5) throw new Error("not a POLYGON shapefile");

    let offset = 100 + 8; // 100-byte file header + 8-byte record header
    if (view.getInt32(offset, true) !== 5) throw new Error("unexpected shape type in record");
    offset += 4 + 32; // record shape type + bounding box
    const numParts = view.getInt32(offset, true);
    offset += 4;
    const numPoints = view.getInt32(offset, true);
    offset += 4;
    offset += numParts * 4; // parts array — writeDateShapefile always writes one ring

    const points = [];
    for (let i = 0; i < numPoints; i++) {
      if (offset + 16 > buffer.byteLength) throw new Error("truncated point data");
      const x = view.getFloat64(offset, true);
      const y = view.getFloat64(offset + 8, true);
      offset += 16;
      points.push([y, x]); // toClosedRingXY wrote [lng, lat] — flip back to [lat, lng]
    }
    // toClosedRingXY closes the ring (first vertex repeated at the end) —
    // drop that repeat so this matches the open-ring shape entries use
    // while vertices are being clicked in.
    if (points.length > 1) {
      const [firstLat, firstLng] = points[0];
      const [lastLat, lastLng] = points[points.length - 1];
      if (firstLat === lastLat && firstLng === lastLng) points.pop();
    }
    return points;
  }

  // Only checks what's needed to safely load the zip into the workspace —
  // item name and a shapefile-backed date list. grave_type/description/
  // signature are deliberately NOT required here: fixing up a submission
  // that's missing one of those is exactly what review mode is for, so
  // rejecting it for being incomplete would defeat the point.
  function validateReviewMetadata(metadata) {
    if (!metadata || typeof metadata !== "object") {
      return "metadata.json is missing or malformed.";
    }
    if (!metadata.item_name || typeof metadata.item_name !== "string") {
      return "metadata.json has no item_name.";
    }
    if (!Array.isArray(metadata.dates) || metadata.dates.length === 0) {
      return "metadata.json lists no dates.";
    }
    for (const d of metadata.dates) {
      if (!d || typeof d.date !== "string" || !d.date) {
        return "metadata.json has a date entry with no date.";
      }
    }
    return null;
  }

  async function loadReviewZip(file) {
    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch (err) {
      throw new Error("That file isn't a valid zip archive.");
    }

    const metaFile = zip.file("metadata.json");
    if (!metaFile) throw new Error("Zip has no metadata.json — not a Khthon submission.");

    let metadata;
    try {
      metadata = JSON.parse(await metaFile.async("string"));
    } catch (err) {
      throw new Error("metadata.json isn't valid JSON.");
    }

    const metaError = validateReviewMetadata(metadata);
    if (metaError) throw new Error(metaError);

    const entries = [];
    for (const d of metadata.dates) {
      // Same sanitization writeDateShapefile's caller applies to the date
      // when naming the file, so lookup matches regardless of date format.
      const safeDate = d.date.replace(/[^0-9A-Za-z_-]/g, "-");
      const shpFile = zip.file(`${safeDate}.shp`);
      if (!shpFile) throw new Error(`Missing ${safeDate}.shp for a date listed in metadata.json.`);
      const buffer = await shpFile.async("arraybuffer");
      let vertices;
      try {
        vertices = readPolygonVertices(buffer);
      } catch (err) {
        throw new Error(`Couldn't read ${d.date}.shp (${err.message}).`);
      }
      if (vertices.length < 3) {
        throw new Error(`${d.date}.shp has fewer than 3 vertices.`);
      }
      entries.push({ date: d.date, vertices, group: L.layerGroup(), imageryRelease: null });
    }

    return { metadata, entries };
  }

  dom.reviewBtn.addEventListener("click", () => dom.reviewInput.click());

  dom.reviewInput.addEventListener("change", async () => {
    const file = dom.reviewInput.files[0];
    dom.reviewInput.value = ""; // let the same file be re-picked later if needed
    if (!file) return;

    const hasWork = dates.some((d) => d.vertices.length > 0) || dom.itemName.value.trim();
    if (hasWork && !window.confirm("Discard the current item and load this zip for review?")) {
      return;
    }

    let loaded;
    try {
      loaded = await loadReviewZip(file);
    } catch (err) {
      showStatus(err.message || "Could not read that zip.", "error");
      return;
    }

    resetWorkspace();
    const { metadata, entries } = loaded;

    entries.forEach((entry) => {
      assignImageryRelease(entry);
      rebuildLayer(entry);
      dates.push(entry);
    });
    dates.sort((a, b) => a.date.localeCompare(b.date));

    dom.itemName.value = metadata.item_name;
    if (["clandestine", "informal", "formal", "unsure"].includes(metadata.grave_type)) {
      document.querySelector(`input[name="grave-type"][value="${metadata.grave_type}"]`).checked = true;
    }
    if (["yes", "no", "unsure"].includes(metadata.cemetery)) {
      document.querySelector(`input[name="cemetery"][value="${metadata.cemetery}"]`).checked = true;
    }
    dom.modalDescription.value = typeof metadata.description === "string" ? metadata.description : "";
    dom.modalSignature.value = typeof metadata.signature === "string" ? metadata.signature : "";

    dom.slider.max = String(Math.max(dates.length - 1, 0));
    dom.sliderRow.style.display = dates.length > 1 ? "flex" : "none";
    populateDateOptions();
    selectDate(dates.length - 1);

    const allVertices = entries.reduce((acc, e) => acc.concat(e.vertices), []);
    if (allVertices.length) {
      map.fitBounds(L.latLngBounds(allVertices), { padding: [40, 40], maxZoom: 18 });
    }

    showStatus(`Loaded "${metadata.item_name}" for review — edit as needed, then Submit.`, "success");
  });

  // ---------------------------------------------------------------------
  // Shapefile generation, entirely client-side (github.io has no server).
  // shpwrite.write() runs synchronously and hands back real .shp/.shx/.dbf
  // DataViews plus the standard WGS84 .prj text — one call per date, so
  // each date on the timeline still becomes its own shapefile, matching
  // "multiple shapefiles per item" rather than one multi-feature file.
  // ---------------------------------------------------------------------
  function ringArea(coords) {
    let area = 0;
    for (let i = 0; i < coords.length; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[(i + 1) % coords.length];
      area += x1 * y2 - x2 * y1;
    }
    return area / 2;
  }

  function toClosedRingXY(verticesLatLng) {
    const ring = verticesLatLng.map(([lat, lng]) => [lng, lat]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    if (ringArea(ring) > 0) ring.reverse();
    return ring;
  }

  function slugify(value) {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "item";
  }

  function writeDateShapefile(row, ring) {
    return new Promise((resolve, reject) => {
      window.shpwrite.write([row], "POLYGON", [[ring]], (err, files) => {
        if (err) reject(err);
        else resolve(files);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Nearest-city lookup — best effort. Uses the centroid of every vertex
  // across all dates (a grave's outline should stay roughly in place over
  // time, so this is a stable single point) and reverse-geocodes it via
  // OpenStreetMap Nominatim. Never blocks submission on failure.
  // ---------------------------------------------------------------------
  function computeCentroid(entries) {
    let sumLat = 0;
    let sumLng = 0;
    let count = 0;
    entries.forEach((entry) => {
      entry.vertices.forEach(([lat, lng]) => {
        sumLat += lat;
        sumLng += lng;
        count++;
      });
    });
    if (count === 0) return null;
    return { lat: sumLat / count, lng: sumLng / count };
  }

  async function fetchNearestCity(lat, lng) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (!resp.ok) return null;
      const data = await resp.json();
      const addr = data.address || {};
      return (
        addr.city ||
        addr.town ||
        addr.village ||
        addr.hamlet ||
        addr.municipality ||
        addr.county ||
        null
      );
    } catch (err) {
      return null;
    }
  }

  async function buildSubmissionZip(itemName, graveType, cemetery, description, signature, entries, createdAt) {
    const zip = new JSZip();

    for (const entry of entries) {
      const ring = toClosedRingXY(entry.vertices);
      const row = {
        item: itemName,
        date: entry.date,
        grave_type: graveType,
        cemetery: cemetery,
        created_at: createdAt,
        img_date: entry.imageryDate || "",
      };
      const files = await writeDateShapefile(row, ring);
      const safeDate = entry.date.replace(/[^0-9A-Za-z_-]/g, "-");
      zip.file(`${safeDate}.shp`, files.shp.buffer);
      zip.file(`${safeDate}.shx`, files.shx.buffer);
      zip.file(`${safeDate}.dbf`, files.dbf.buffer);
      zip.file(`${safeDate}.prj`, files.prj);
    }

    const centroid = computeCentroid(entries);
    const nearestCity = centroid ? await fetchNearestCity(centroid.lat, centroid.lng) : null;

    const metadata = {
      item_name: itemName,
      grave_type: graveType,
      cemetery: cemetery,
      description: description,
      signature: signature,
      created_at: createdAt,
      nearest_city: nearestCity,
      dates: entries.map((e) => ({ date: e.date, imagery_date: e.imageryDate || null })),
    };
    zip.file("metadata.json", JSON.stringify(metadata, null, 2));

    return zip.generateAsync({ type: "blob" });
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ---------------------------------------------------------------------
  // Submit flow
  // ---------------------------------------------------------------------
  dom.submitBtn.addEventListener("click", () => {
    const itemName = dom.itemName.value.trim();
    if (!itemName) {
      showStatus("Give this item a name before submitting.", "error");
      dom.itemName.focus();
      return;
    }
    if (dates.length === 0) {
      showStatus("Add at least one date and draw its shape first.", "error");
      return;
    }
    const incomplete = dates.filter((d) => d.vertices.length < 3);
    if (incomplete.length > 0) {
      showStatus(
        `These dates need at least 3 vertices: ${incomplete.map((d) => d.date).join(", ")}`,
        "error"
      );
      return;
    }
    dom.modalBackdrop.classList.remove("hidden");
  });

  dom.modalCancel.addEventListener("click", () => {
    dom.modalBackdrop.classList.add("hidden");
  });

  dom.modalConfirm.addEventListener("click", async () => {
    const graveType = document.querySelector('input[name="grave-type"]:checked').value;
    const cemetery = document.querySelector('input[name="cemetery"]:checked').value;
    const description = dom.modalDescription.value.trim();
    const signature = dom.modalSignature.value.trim();
    if (!description) {
      showStatus("Add a description (with citation) before submitting.", "error");
      dom.modalDescription.focus();
      return;
    }
    if (!signature) {
      showStatus("Sign before submitting.", "error");
      dom.modalSignature.focus();
      return;
    }

    const itemName = dom.itemName.value.trim();
    const entries = dates.map((d) => ({
      date: d.date,
      vertices: d.vertices,
      imageryDate: d.imageryRelease ? d.imageryRelease.dateStr : null,
    }));
    const createdAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");

    dom.modalConfirm.disabled = true;
    try {
      const blob = await buildSubmissionZip(itemName, graveType, cemetery, description, signature, entries, createdAt);
      const slug = slugify(itemName);
      const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      const filename = `${slug}_${stamp}.zip`;
      triggerDownload(blob, filename);

      saveItemToStorage({
        item_name: itemName,
        grave_type: graveType,
        cemetery: cemetery,
        created_at: createdAt,
        dates: entries.map((e) => e.date),
        filename,
      });

      dom.modalBackdrop.classList.add("hidden");
      dom.modalDescription.value = "";
      showStatus(`Downloaded ${entries.length} shapefile(s) as ${filename}`, "success");
      resetWorkspace();
      renderPreviousItems();
    } catch (err) {
      showStatus(err.message || "Could not generate shapefiles.", "error");
    } finally {
      dom.modalConfirm.disabled = false;
    }
  });

  // ---------------------------------------------------------------------
  // Previous items list — basic convenience for orientation. There's no
  // server on GitHub Pages, so this is remembered per-browser via
  // localStorage; the actual data lives in each downloaded zip.
  // ---------------------------------------------------------------------
  const STORAGE_KEY = "khthon_items";

  function loadItemsFromStorage() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch (err) {
      return [];
    }
  }

  function saveItemToStorage(meta) {
    const items = loadItemsFromStorage();
    items.unshift(meta);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  function renderPreviousItems() {
    const items = loadItemsFromStorage();
    dom.itemsList.innerHTML = "";
    if (items.length === 0) {
      dom.itemsList.innerHTML = '<span class="muted">None yet</span>';
      return;
    }
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "item-entry";
      const created = new Date(item.created_at);
      const cemeteryNote = item.cemetery ? ` &middot; cemetery: ${escapeHtml(item.cemetery)}` : "";
      row.innerHTML = `
        <div class="name">${escapeHtml(item.item_name)}</div>
        <div class="meta">${escapeHtml(item.grave_type)}${cemeteryNote} &middot; ${item.dates.length} date(s) &middot; ${created.toLocaleDateString()}</div>
      `;
      dom.itemsList.appendChild(row);
    });
  }

  document.getElementById("clear-items-btn").addEventListener("click", () => {
    if (!window.confirm("Clear this browser's remembered item list? Downloaded zips are unaffected.")) {
      return;
    }
    localStorage.removeItem(STORAGE_KEY);
    renderPreviousItems();
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  refreshVertexUI();
  renderPreviousItems();
})();
