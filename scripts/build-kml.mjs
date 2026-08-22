/**
 * Builds earth/latitude.kml — the globe, rebuilt for Google Earth.
 *
 * Reads the same two files the three.js renderer reads (places.json +
 * timeline.json) so the KML and the globe can never disagree. It deliberately
 * does NOT read the raw Google export: that file still carries private
 * anchors, and scripts/import-timeline.mjs is the only thing allowed to touch
 * it. Re-run the importer first if the export has changed.
 *
 *   node scripts/import-timeline.mjs ~/Desktop/location-history.json
 *   node scripts/build-kml.mjs
 *
 * Then in Google Earth Web: Projects -> New project -> Import KML file.
 *
 * Flags:
 *   --out <path>       output file (default earth/latitude.kml)
 *   --arc-scale <n>    multiply flight arc height (default 1 = same as globe)
 *   --arc-steps <n>    points per flight arc (default 96)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

const places = read("src/files/places.json");
const timeline = read("src/files/timeline.json");

// --- CLI --------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const OUT = resolve(ROOT, flag("--out", "earth/latitude.kml"));
const ARC_SCALE = Number(flag("--arc-scale", "1"));
const ARC_STEPS = Number(flag("--arc-steps", "96"));

// --- the globe's visual language, ported ------------------------------------

const EARTH_R_M = 6371000;

/** Straight from src/data/index.ts. Amber is spent on flights alone. */
const MODE_STYLE = {
  flying: { color: "#FFB000", width: 2.6 },
  "in train": { color: "#C6D2DE", width: 2.4 },
  "in passenger vehicle": { color: "#8C9AA8", width: 2.2 },
  motorcycling: { color: "#A3B0BD", width: 2.0 },
  "in bus": { color: "#75828F", width: 2.0 },
  cycling: { color: "#94A4B2", width: 1.8 },
};
const GROUND_DEFAULT = { color: "#8C9AA8", width: 2.2 };
const styleFor = (mode) => MODE_STYLE[mode] ?? GROUND_DEFAULT;

const MAX_VISITS = 361;
const exposureFor = (stats) =>
  !stats ? 0.3 : 0.4 + 0.6 * (Math.log1p(stats.visits) / Math.log1p(MAX_VISITS));

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const RECENT = hexToRgb("#FFB000");
const AGED = hexToRgb("#5B646E");
const latestSeen = timeline.source.coverage.to;

/** Recency as colour temperature — a visible timeline with no slider. */
function temperatureFor(stats) {
  if (!stats) return [0x49, 0x51, 0x5a];
  const span = Date.parse(latestSeen) - Date.parse(timeline.source.coverage.from);
  const age = Date.parse(latestSeen) - Date.parse(stats.lastSeen);
  const t = span > 0 ? Math.min(1, Math.max(0, age / span)) : 0;
  return RECENT.map((c, i) => Math.round(c + (AGED[i] - c) * t));
}

/**
 * KML colours are aabbggrr, not rrggbb — the byte order is reversed AND the
 * alpha leads. Getting this wrong silently swaps red and blue.
 */
const kmlColor = ([r, g, b], alpha = 255) =>
  [alpha, b, g, r].map((n) => n.toString(16).padStart(2, "0")).join("");
const kmlHex = (hex, alpha = 255) => kmlColor(hexToRgb(hex), alpha);

// --- great circles ----------------------------------------------------------

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

const toVec = (lat, lng) => {
  const [a, o] = [rad(lat), rad(lng)];
  return [Math.cos(a) * Math.cos(o), Math.cos(a) * Math.sin(o), Math.sin(a)];
};
const toLatLng = ([x, y, z]) => [deg(Math.asin(z)), deg(Math.atan2(y, x))];

/**
 * Spherical interpolation, so a flight follows the great circle the aircraft
 * actually flew. Linear interpolation of lat/lng would bow the JFK-BOM route
 * hundreds of km south of the polar path it really takes.
 */
function slerp(from, to, t) {
  const a = toVec(...from);
  const b = toVec(...to);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-9) return from;
  const s = Math.sin(omega);
  const wa = Math.sin((1 - t) * omega) / s;
  const wb = Math.sin(t * omega) / s;
  return toLatLng([0, 1, 2].map((i) => wa * a[i] + wb * b[i]));
}

/**
 * three-globe's arcAltitude is a fraction of the globe radius, so the same
 * number becomes a real altitude in metres here and the arc keeps exactly the
 * proportions it has on the globe. sin(pi*t) approximates three-globe's cubic
 * bezier closely enough that the two are indistinguishable side by side.
 */
function arcCoords(from, to, arcAlt) {
  const peak = arcAlt * EARTH_R_M * ARC_SCALE;
  const out = [];
  for (let i = 0; i <= ARC_STEPS; i++) {
    const t = i / ARC_STEPS;
    const [lat, lng] = slerp(from, to, t);
    out.push(`${lng.toFixed(6)},${lat.toFixed(6)},${Math.round(peak * Math.sin(Math.PI * t))}`);
  }
  return out.join(" ");
}

// --- XML --------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** places.json prose uses *asterisks* for emphasis. */
const prose = (s) => esc(s).replace(/\*([^*]+)\*/g, "<i>$1</i>");
const cdata = (s) => `<![CDATA[${s}]]>`;

// --- lookup tables -----------------------------------------------------------

const placeById = new Map();
for (const r of places.regions) {
  for (const p of r.places) placeById.set(p.id, { ...p, region: r });
}
const label = (e) => (e.placeId && placeById.get(e.placeId)?.name) || "elsewhere";
const isVisible = (p) => p.status !== "ARCHIVE";

const fmtDate = (iso) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

// --- styles -----------------------------------------------------------------

const styles = [];

// One icon style per place, because colour and scale both carry meaning here
// and KML has no way to express either as a per-placemark override.
const ICON = "https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png";

for (const [id, p] of placeById) {
  if (!isVisible(p)) continue;
  const stats = timeline.places[id] ?? null;
  const scale = (0.7 + 0.9 * exposureFor(stats)).toFixed(2);
  styles.push(`  <Style id="pl-${esc(id)}">
    <IconStyle>
      <color>${kmlColor(temperatureFor(stats))}</color>
      <scale>${scale}</scale>
      <Icon><href>${ICON}</href></Icon>
    </IconStyle>
    <LabelStyle><color>ffF5F1ED</color><scale>0.85</scale></LabelStyle>
  </Style>`);
}

styles.push(`  <Style id="archived">
    <IconStyle>
      <color>ff5A5149</color><scale>0.5</scale>
      <Icon><href>${ICON}</href></Icon>
    </IconStyle>
    <LabelStyle><scale>0</scale></LabelStyle>
  </Style>`);

styles.push(`  <Style id="region">
    <IconStyle>
      <color>ffB0A08C</color><scale>1.1</scale>
      <Icon><href>https://maps.google.com/mapfiles/kml/shapes/donut.png</href></Icon>
    </IconStyle>
    <LabelStyle><color>ffF5F1ED</color><scale>0.9</scale></LabelStyle>
  </Style>`);

for (const [mode, s] of Object.entries({ ...MODE_STYLE, default: GROUND_DEFAULT })) {
  styles.push(`  <Style id="line-${esc(mode.replace(/\s+/g, "-"))}">
    <LineStyle><color>${kmlHex(s.color, mode === "flying" ? 255 : 220)}</color><width>${s.width}</width></LineStyle>
    <IconStyle><scale>0</scale></IconStyle>
    <LabelStyle><scale>0</scale></LabelStyle>
  </Style>`);
}
const lineStyleId = (mode) =>
  `line-${(MODE_STYLE[mode] ? mode : "default").replace(/\s+/g, "-")}`;

// --- flights ----------------------------------------------------------------

const flights = timeline.legs
  .filter((l) => l.mode === "flying")
  .map((leg) => {
    const name = `${label(leg.from)} → ${label(leg.to)}`;
    const desc = `<p><b>${esc(fmtDate(leg.date))}</b><br/>
${esc(leg.distanceKm.toLocaleString())} km${leg.modeSource === "inferred" ? " · mode inferred from distance" : ""}</p>`;
    return `    <Placemark>
      <name>${esc(name)}</name>
      <description>${cdata(desc)}</description>
      <styleUrl>#line-flying</styleUrl>
      <LineString>
        <tessellate>0</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${arcCoords(
          [leg.from.lat, leg.from.lng],
          [leg.to.lat, leg.to.lng],
          leg.arcAlt
        )}</coordinates>
      </LineString>
    </Placemark>`;
  });

// --- ground routes ----------------------------------------------------------

const routes = timeline.paths.map((p) => {
  const coords = p.points.map(([lat, lng]) => `${lng},${lat},0`).join(" ");
  return `    <Placemark>
      <name>${esc(fmtDate(p.date))}${p.mode ? ` · ${esc(p.mode)}` : ""}</name>
      <styleUrl>#${lineStyleId(p.mode)}</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>`;
});

// --- places, grouped country -> region --------------------------------------

function placemark(p) {
  const stats = timeline.places[p.id] ?? null;
  const lines = [];
  if (p.status === "UNMARKED") lines.push(`<p><i>Not yet written up.</i></p>`);
  else if (p.desc) lines.push(`<p>${prose(p.desc)}</p>`);
  if (stats) {
    lines.push(`<p><b>${stats.visits}</b> visit${stats.visits === 1 ? "" : "s"} · <b>${stats.days}</b> day${stats.days === 1 ? "" : "s"}<br/>
${esc(fmtDate(stats.firstSeen))} — ${esc(fmtDate(stats.lastSeen))}</p>`);
  }
  lines.push(`<p style="color:#8C9AA8">${esc(p.region.name)}, ${esc(p.region.country.name)}</p>`);
  return `      <Placemark>
        <name>${esc(p.name)}</name>
        <description>${cdata(lines.join("\n"))}</description>
        <styleUrl>#pl-${esc(p.id)}</styleUrl>
        <Point><coordinates>${p.coords.lng},${p.coords.lat},0</coordinates></Point>
      </Placemark>`;
}

const byCountry = new Map();
for (const r of places.regions) {
  const key = r.country.name;
  if (!byCountry.has(key)) byCountry.set(key, []);
  byCountry.get(key).push(r);
}

const countryFolders = [...byCountry.entries()].map(([country, regions]) => {
  const folders = regions
    .map((r) => {
      const marks = r.places.filter(isVisible).map((p) => placemark(placeById.get(p.id)));
      if (!marks.length) return null;
      const stats = timeline.regions[r.id] ?? null;
      return `    <Folder>
      <name>${esc(r.name)}${stats ? ` (${stats.days}d)` : ""}</name>
      <open>0</open>
${marks.join("\n")}
    </Folder>`;
    })
    .filter(Boolean);
  return `  <Folder>
    <name>${esc(country)}</name>
    <open>0</open>
${folders.join("\n")}
  </Folder>`;
});

// --- region markers (the globe's zoomed-out layer) --------------------------

const regionMarks = places.regions
  .map((r) => {
    const visible = r.places.filter(isVisible);
    if (!visible.length) return null;
    // Anchored to the most-visited place, not the centroid — a centroid puts a
    // dot in open country nobody stood in.
    const anchor = visible.reduce((best, p) =>
      (timeline.places[p.id]?.visits ?? 0) > (timeline.places[best.id]?.visits ?? 0) ? p : best
    );
    const stats = timeline.regions[r.id] ?? null;
    const desc = `<p>${esc(visible.map((p) => p.name).join(" · "))}</p>${
      stats ? `<p><b>${stats.days}</b> days · ${esc(fmtDate(stats.firstSeen))} — ${esc(fmtDate(stats.lastSeen))}</p>` : ""
    }`;
    return `    <Placemark>
      <name>${esc(r.name)}</name>
      <description>${cdata(desc)}</description>
      <styleUrl>#region</styleUrl>
      <Point><coordinates>${anchor.coords.lng},${anchor.coords.lat},0</coordinates></Point>
    </Placemark>`;
  })
  .filter(Boolean);

// --- archived stops (the globe's Verbose layer) -----------------------------

const archived = places.regions
  .flatMap((r) => r.places.filter((p) => p.status === "ARCHIVE"))
  .map(
    (p) => `    <Placemark>
      <name></name>
      <styleUrl>#archived</styleUrl>
      <Point><coordinates>${p.coords.lng},${p.coords.lat},0</coordinates></Point>
    </Placemark>`
  );

// --- document ---------------------------------------------------------------

const folder = (name, children, { open = 0, visibility = 1 } = {}) =>
  !children.length
    ? ""
    : `  <Folder>
    <name>${esc(name)}</name>
    <open>${open}</open>
    <visibility>${visibility}</visibility>
${children.join("\n")}
  </Folder>`;

const visibleCount = [...placeById.values()].filter(isVisible).length;
const totalDays = Object.values(timeline.regions).reduce((a, s) => a + s.days, 0);
const flightKm = timeline.legs
  .filter((l) => l.mode === "flying")
  .reduce((a, l) => a + l.distanceKm, 0);

const overview = `<p>${visibleCount} places across ${byCountry.size} countries.<br/>
${flights.length} flights · ${Math.round(flightKm).toLocaleString()} km · ${totalDays} recorded days.</p>
<p>${esc(fmtDate(timeline.source.coverage.from))} — ${esc(fmtDate(timeline.source.coverage.to))}</p>
<p style="color:#8C9AA8">Marker warmth is recency, marker size is how often. Amber arcs are flights, drawn at true altitude proportion; grey lines are recorded ground traces.</p>`;

const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Latitude</name>
  <description>${cdata(overview)}</description>
  <open>1</open>
  <LookAt>
    <longitude>44.68891537</longitude>
    <latitude>-2.24790032</latitude>
    <altitude>0</altitude>
    <heading>359.40434519</heading>
    <tilt>0</tilt>
    <range>32649636.9</range>
    <altitudeMode>absolute</altitudeMode>
  </LookAt>
${styles.join("\n")}
${folder("Flights", flights, { open: 0 })}
${folder("Ground routes", routes, { open: 0 })}
${folder("Places", countryFolders, { open: 1 })}
${folder("Regions", regionMarks, { visibility: 0 })}
${folder("Archived stops", archived, { visibility: 0 })}
</Document>
</kml>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, kml);

const features = flights.length + routes.length + visibleCount + regionMarks.length + archived.length;
console.log(
  `[kml] ${OUT}\n` +
    `      ${flights.length} flights, ${routes.length} ground routes, ` +
    `${visibleCount} places, ${regionMarks.length} regions — ${features} features, ` +
    `${(kml.length / 1024).toFixed(0)} KB`
);
