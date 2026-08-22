#!/usr/bin/env node
/**
 * Import a Google Timeline export into src/files/timeline.json.
 *
 * Usage:  node scripts/import-timeline.mjs <export.json> [--report]
 *
 * The raw export is NEVER copied into the repo. This reads it from wherever it
 * sits on disk and writes only aggregated, privacy-filtered data:
 *
 *   - visits collapse to per-place counts and date ranges (no coordinates,
 *     no clock times, no Google placeIDs)
 *   - leg endpoints snap to curated places in places.json and inherit *their*
 *     coordinates, so no raw position is emitted for a matched endpoint
 *   - path points are rounded to PATH_DECIMALS before being written
 *
 * Output is deterministic: same input + same places.json => byte-identical
 * timeline.json, so an automated PR shows a clean diff or none at all.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLACES = resolve(HERE, "../src/files/places.json");
const OUT = resolve(HERE, "../src/files/timeline.json");

// --- tuning -----------------------------------------------------------------
export const CONFIG = {
  SNAP_KM: 60,        // a visit within this radius counts as "that place"
  MIN_LEG_KM: 50,     // shorter movements become mode stats, not drawn legs
  // Google's mode label is unreliable at long range: this export calls an
  // 11,075km Seoul->New Jersey hop "in train" and repeated 4,124km coast-to-
  // coast trips "in passenger vehicle". Real ground legs here top out at
  // 395km, so anything past this was a flight regardless of the label.
  MAX_GROUND_KM: 1500,
  PATH_DECIMALS: 2,   // ~1.1km granularity for path points
  PATH_GAP_MIN: 30,   // minutes; larger gaps split one path into two
  MIN_PATH_POINTS: 3,

  // --- privacy ---
  // No emitted coordinate may fall within REDACT_KM of a private anchor.
  // Anchors are derived from the export at import time and never written out.
  REDACT_KM: 3,
  // Paths shorter than this are daily movement, not journeys. They are the
  // bulk of the home-proximate data and are invisible at globe scale anyway.
  MIN_PATH_SPAN_KM: 25,
  // Any spot dwelt at repeatedly is treated as private regardless of how
  // Google labelled it — that covers a workplace, a second residence, and a
  // hotel just as well as a home. An absolute threshold rather than a top-N
  // ranking, so which spots qualify does not drift as the export grows.
  ANCHOR_MIN_VISITS: 5,
  ANCHOR_GRID_DP: 2,
};

// --- helpers ----------------------------------------------------------------
const R_EARTH = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/** "geo:40.727691,-74.030904" -> { lat, lng } */
export function parseGeo(uri) {
  const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(uri);
  if (!m) throw new Error(`unparseable geo URI: ${uri}`);
  return { lat: Number(m[1]), lng: Number(m[2]) };
}

/** Local calendar date as recorded in the export, offset included. */
const localDate = (ts) => ts.slice(0, 10);
const round = (n, dp) => Number(n.toFixed(dp));

/** Arc height scaled to distance so short hops stay flat. */
const arcAltFor = (km) => round(Math.min(0.5, 0.05 + km / 30000), 3);

export function flattenPlaces(places) {
  return places.regions.flatMap((r) =>
    r.places.map((p) => ({ ...p, regionId: r.id, regionName: r.name }))
  );
}

/**
 * ARCHIVE places still absorb visits during snapping — that is the point of
 * archiving rather than deleting, since a deleted place would resurface in the
 * unmatched report on every single run. They are dropped afterwards, so they
 * contribute to no stat and no rollup.
 */
const isArchived = (place) => place && place.status === "ARCHIVE";

function nearest(coords, flat) {
  let best = null;
  let bestKm = Infinity;
  for (const p of flat) {
    const km = haversineKm(coords, p.coords);
    if (km < bestKm) {
      bestKm = km;
      best = p;
    }
  }
  return { place: best, km: bestKm };
}

// --- privacy ----------------------------------------------------------------

/**
 * Private anchors: places whose exact position must not reach the repo.
 *
 * Two sources, because neither alone is sufficient — Google only tagged 33 of
 * 714 visits as "Home", and never tagged the second residence at all:
 *   1. every visit Google labelled Home
 *   2. any spot dwelt at ANCHOR_MIN_VISITS+ times, which is what a residence,
 *      a workplace, or a hotel looks like in the data
 *
 * Anchors are computed from the raw export on every run and exist only in
 * memory. Nothing derived from them is written to disk.
 */
export function detectAnchors(records, config = CONFIG) {
  const anchors = [];
  const density = new Map();

  for (const r of records) {
    if (!r.visit) continue;
    const c = parseGeo(r.visit.topCandidate.placeLocation);
    if (r.visit.topCandidate.semanticType === "Home") anchors.push(c);
    const key = `${round(c.lat, config.ANCHOR_GRID_DP)},${round(c.lng, config.ANCHOR_GRID_DP)}`;
    const cell = density.get(key) ?? { lat: 0, lng: 0, n: 0 };
    cell.lat += c.lat;
    cell.lng += c.lng;
    cell.n += 1;
    density.set(key, cell);
  }

  const densest = [...density.values()]
    .filter((c) => c.n >= config.ANCHOR_MIN_VISITS)
    .map((c) => ({ lat: c.lat / c.n, lng: c.lng / c.n }));

  // Dedupe anchors that describe the same spot.
  const out = [];
  for (const a of [...anchors, ...densest]) {
    if (!out.some((b) => haversineKm(a, b) < 1)) out.push(a);
  }
  return out;
}

const isPrivate = (coords, anchors, config = CONFIG) =>
  anchors.some((a) => haversineKm(coords, a) < config.REDACT_KM);

/** Greatest extent of a path, used to tell a journey from a commute. */
function spanKm(points) {
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  return haversineKm(
    { lat: Math.min(...lats), lng: Math.min(...lngs) },
    { lat: Math.max(...lats), lng: Math.max(...lngs) }
  );
}

/**
 * Final gate. Throws rather than writing a file that leaks — an automated
 * import should fail its PR, not quietly publish a home address.
 */
export function assertNoLeak(timeline, anchors, config = CONFIG) {
  const bad = [];
  for (const p of timeline.paths) {
    for (const [lat, lng] of p.points) {
      if (isPrivate({ lat, lng }, anchors, config)) bad.push(`${p.id} point ${lat},${lng}`);
    }
  }
  for (const l of timeline.legs) {
    for (const side of ["from", "to"]) {
      const e = l[side];
      if (e.placeId === null && isPrivate(e, anchors, config)) {
        bad.push(`${l.id} ${side} ${e.lat},${e.lng}`);
      }
    }
  }
  if (bad.length) {
    throw new Error(
      `privacy check failed: ${bad.length} emitted coordinate(s) within ` +
        `${config.REDACT_KM}km of a private anchor:\n  ${bad.slice(0, 10).join("\n  ")}`
    );
  }
}

// --- the import -------------------------------------------------------------
export function buildTimeline(records, places, config = CONFIG) {
  const flat = flattenPlaces(places);
  const anchors = detectAnchors(records, config);
  const unmatched = [];

  // 1. visits -> per-place aggregates, plus per-region aggregates.
  //
  // Region totals are accumulated independently rather than summed from the
  // per-place ones: a day spent in two places in the same region is ONE day in
  // that region, and that fact is unrecoverable once each place holds only a
  // count. Same reasoning for firstSeen/lastSeen.
  const stats = new Map();
  const regionStats = new Map();
  for (const r of records) {
    if (!r.visit) continue;
    const coords = parseGeo(r.visit.topCandidate.placeLocation);
    const { place, km } = nearest(coords, flat);
    if (!place || km > config.SNAP_KM) {
      unmatched.push({
        coords: { lat: round(coords.lat, 2), lng: round(coords.lng, 2) },
        date: localDate(r.startTime),
        hours: (Date.parse(r.endTime) - Date.parse(r.startTime)) / 3600000,
        nearest: place ? place.name : null,
        km: Math.round(km),
      });
      continue;
    }
    if (isArchived(place)) continue;

    let s = stats.get(place.id);
    if (!s) {
      s = { visits: 0, days: new Set(), first: null, last: null };
      stats.set(place.id, s);
    }
    const day = localDate(r.startTime);
    s.visits += 1;
    s.days.add(day);
    if (!s.first || day < s.first) s.first = day;
    if (!s.last || day > s.last) s.last = day;

    let rs = regionStats.get(place.regionId);
    if (!rs) {
      rs = { visits: 0, days: new Set(), first: null, last: null };
      regionStats.set(place.regionId, rs);
    }
    rs.visits += 1;
    rs.days.add(day);
    if (!rs.first || day < rs.first) rs.first = day;
    if (!rs.last || day > rs.last) rs.last = day;
  }

  const freeze = (m) => {
    const out = {};
    for (const id of [...m.keys()].sort()) {
      const s = m.get(id);
      out[id] = { visits: s.visits, days: s.days.size, firstSeen: s.first, lastSeen: s.last };
    }
    return out;
  };
  const placeStats = freeze(stats);
  const regionStatsOut = freeze(regionStats);

  // 2. activities -> significant legs + mode totals
  const legs = [];
  const modeTotals = new Map();
  for (const r of records) {
    if (!r.activity) continue;
    const mode = r.activity.topCandidate.type;
    const km = Number(r.activity.distanceMeters) / 1000;

    const t = modeTotals.get(mode) ?? { count: 0, km: 0 };
    t.count += 1;
    t.km += km;
    modeTotals.set(mode, t);

    if (km < config.MIN_LEG_KM) continue;

    const from = nearest(parseGeo(r.activity.start), flat);
    const to = nearest(parseGeo(r.activity.end), flat);
    // Both ends in the same place is an intra-city loop, not a journey.
    if (from.place && to.place && from.km <= config.SNAP_KM &&
        to.km <= config.SNAP_KM && from.place.id === to.place.id) continue;

    // Snapped endpoints inherit the curated coordinate, so no raw position is
    // emitted. An unmatched endpoint falls back to a rounded raw position —
    // unless it sits inside a private anchor, in which case it is pulled to
    // the nearest curated place however far that is, rather than published.
    const endpoint = (hit, raw) => {
      if (hit.place && hit.km <= config.SNAP_KM && !isArchived(hit.place)) {
        return { placeId: hit.place.id, lat: hit.place.coords.lat, lng: hit.place.coords.lng };
      }
      if (isPrivate(raw, anchors, config) && hit.place && !isArchived(hit.place)) {
        return { placeId: hit.place.id, lat: hit.place.coords.lat, lng: hit.place.coords.lng };
      }
      return {
        placeId: null,
        lat: round(raw.lat, config.PATH_DECIMALS),
        lng: round(raw.lng, config.PATH_DECIMALS),
      };
    };

    // Reclassify implausible ground travel rather than drawing a train across
    // an ocean. Flagged so the inference stays visible in the data.
    const implausible = mode !== "flying" && km > config.MAX_GROUND_KM;
    legs.push({
      mode: implausible ? "flying" : mode,
      modeSource: implausible ? "inferred" : "google",
      date: localDate(r.startTime),
      distanceKm: Math.round(km),
      arcAlt: arcAltFor(km),
      from: endpoint(from, parseGeo(r.activity.start)),
      to: endpoint(to, parseGeo(r.activity.end)),
    });
  }

  legs.sort((a, b) =>
    a.date === b.date ? a.distanceKm - b.distanceKm : a.date < b.date ? -1 : 1
  );
  legs.forEach((l, i) => {
    l.id = `leg-${String(i + 1).padStart(3, "0")}`;
  });

  const modeStats = {};
  for (const mode of [...modeTotals.keys()].sort()) {
    const t = modeTotals.get(mode);
    modeStats[mode] = { count: t.count, km: Math.round(t.km) };
  }

  // 3. timelinePath -> coarse polylines
  //
  // A trace carries no mode of its own, but it shares a clock with the
  // activity records. Attributing each trace to the mode it most overlaps in
  // time is inference from the export rather than invention — unlike a
  // straight line between endpoints, which asserts a route that never existed.
  const activities = records
    .filter((r) => r.activity)
    .map((r) => ({
      start: Date.parse(r.startTime),
      end: Date.parse(r.endTime),
      mode: r.activity.topCandidate.type,
      km: Number(r.activity.distanceMeters) / 1000,
    }));

  const addOverlap = (into, startMs, endMs) => {
    for (const a of activities) {
      const overlap = Math.min(endMs, a.end) - Math.max(startMs, a.start);
      if (overlap <= 0) continue;
      // Same reclassification as the legs: no ground mode covers 1500km.
      const mode = a.mode !== "flying" && a.km > config.MAX_GROUND_KM ? "flying" : a.mode;
      into.set(mode, (into.get(mode) ?? 0) + overlap);
    }
  };

  const dominant = (overlaps) => {
    let best = null;
    let bestMs = 0;
    for (const [mode, ms] of overlaps) {
      if (ms > bestMs) {
        best = mode;
        bestMs = ms;
      }
    }
    return best;
  };

  const paths = [];
  let current = null;
  let prevEnd = null;
  for (const r of records) {
    if (!r.timelinePath) continue;
    const startMs = Date.parse(r.startTime);
    const gapMin = prevEnd === null ? Infinity : (startMs - prevEnd) / 60000;
    if (gapMin > config.PATH_GAP_MIN) {
      if (current && current.points.length >= config.MIN_PATH_POINTS) paths.push(current);
      current = { date: localDate(r.startTime), points: [], overlaps: new Map() };
    }
    addOverlap(current.overlaps, startMs, Date.parse(r.endTime));
    for (const p of r.timelinePath) {
      const g = parseGeo(p.point);
      const pt = [round(g.lat, config.PATH_DECIMALS), round(g.lng, config.PATH_DECIMALS)];
      const last = current.points[current.points.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) current.points.push(pt);
    }
    prevEnd = Date.parse(r.endTime);
  }
  if (current && current.points.length >= config.MIN_PATH_POINTS) paths.push(current);

  // Two filters, in order. The span filter does the heavy lifting: a commute
  // is short, and short paths are both the privacy risk and invisible at globe
  // scale. Redaction then trims anything still touching an anchor, which is
  // typically the first or last few points of a trip that began at home.
  const kept = [];
  for (const p of paths) {
    if (spanKm(p.points) < config.MIN_PATH_SPAN_KM) continue;
    const points = p.points.filter(([lat, lng]) => !isPrivate({ lat, lng }, anchors, config));
    if (points.length >= config.MIN_PATH_POINTS) {
      kept.push({ date: p.date, mode: dominant(p.overlaps), points });
    }
  }
  kept.forEach((p, i) => {
    p.id = `path-${String(i + 1).padStart(4, "0")}`;
  });
  const unattributed = kept.filter((p) => !p.mode).length;
  paths.length = 0;
  paths.push(...kept);

  const times = records.flatMap((r) => [r.startTime, r.endTime]).sort();

  const timeline = {
    version: 2,
    type: "Timeline",
    source: {
      export: "google-timeline",
      coverage: { from: localDate(times[0]), to: localDate(times[times.length - 1]) },
      precision: {
        pathDecimals: config.PATH_DECIMALS,
        snapKm: config.SNAP_KM,
        minLegKm: config.MIN_LEG_KM,
      },
      privacy: {
        redactKm: config.REDACT_KM,
        minPathSpanKm: config.MIN_PATH_SPAN_KM,
        note: "Coordinates near private anchors are removed at import; anchors themselves are never written.",
      },
    },
    places: placeStats,
    regions: regionStatsOut,
    legs,
    paths,
    modeStats,
  };

  assertNoLeak(timeline, anchors, config);
  return { timeline, unmatched, anchorCount: anchors.length };
}

/**
 * Pretty-printed, except [lat, lng] pairs stay on one line — otherwise the
 * path points alone triple the file size and make PR diffs unreadable.
 */
export function serialize(obj) {
  return (
    JSON.stringify(obj, null, 2).replace(
      /\[\s*\n\s*(-?\d+(?:\.\d+)?),\s*\n\s*(-?\d+(?:\.\d+)?)\s*\n\s*\]/g,
      "[$1, $2]"
    ) + "\n"
  );
}

// --- CLI --------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const report = args.includes("--report");
  const input = args.find((a) => !a.startsWith("--"));
  if (!input) {
    console.error("usage: node scripts/import-timeline.mjs <export.json> [--report]");
    process.exit(1);
  }

  const raw = readFileSync(resolve(input), "utf8");
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error("expected a top-level array of records");
  const places = JSON.parse(readFileSync(PLACES, "utf8"));

  const { timeline, unmatched, anchorCount } = buildTimeline(records, places);
  timeline.source.inputSha256 = createHash("sha256").update(raw).digest("hex").slice(0, 16);

  writeFileSync(OUT, serialize(timeline));

  const drawn = timeline.legs.length;
  const totalActs = Object.values(timeline.modeStats).reduce((a, m) => a + m.count, 0);
  console.log(`records          ${records.length}`);
  console.log(`places matched   ${Object.keys(timeline.places).length}/${flattenPlaces(places).length}`);
  console.log(`legs drawn       ${drawn} of ${totalActs} activities (>=${CONFIG.MIN_LEG_KM}km)`);
  console.log(`paths            ${timeline.paths.length} (${timeline.paths.reduce((a, p) => a + p.points.length, 0)} points @${CONFIG.PATH_DECIMALS}dp, span>=${CONFIG.MIN_PATH_SPAN_KM}km)`);
  console.log(`path modes      ${JSON.stringify(timeline.paths.reduce((a, p) => ((a[p.mode ?? "unattributed"] = (a[p.mode ?? "unattributed"] ?? 0) + 1), a), {}))}`);
  console.log(`privacy          ${anchorCount} anchors redacted @${CONFIG.REDACT_KM}km, leak check passed`);
  const unmarked = flattenPlaces(places).filter((p) => p.status === "UNMARKED");
  const archived = flattenPlaces(places).filter(isArchived);
  console.log(`unmatched visits ${unmatched.length}`);
  console.log(`review queue     ${unmarked.length} UNMARKED, ${archived.length} ARCHIVE (hidden)`);
  console.log(`-> ${OUT}`);

  if (unmatched.length && report) {
    // Cluster nearby dwells and lead with hours spent. Count and distance
    // alone cannot tell a destination from a highway rest stop; a single
    // 6-minute dwell and a 20-hour overnight both show up as "1x".
    const clusters = [];
    for (const u of unmatched) {
      const hit = clusters.find((c) => haversineKm(u.coords, c.coords) < 25);
      if (hit) {
        hit.n += 1;
        hit.hours += u.hours;
        hit.days.add(u.date);
      } else {
        clusters.push({ ...u, n: 1, days: new Set([u.date]) });
      }
    }
    clusters.sort((a, b) => b.hours - a.hours);
    console.log("\nunmatched dwells (candidates for places.json):");
    console.log("  hours  dwells  days  location");
    for (const c of clusters) {
      const verdict = c.hours >= 2 ? "  <- likely a real stop" : "";
      console.log(
        `  ${c.hours.toFixed(1).padStart(5)}  ${String(c.n).padStart(6)}  ${String(c.days.size).padStart(4)}  ` +
          `${c.coords.lat},${c.coords.lng}  ${c.km}km from ${c.nearest}, first ${[...c.days].sort()[0]}${verdict}`
      );
    }
  } else if (unmatched.length) {
    console.log("   re-run with --report to list them");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
