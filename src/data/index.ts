/**
 * Loads places.json + timeline.json, checks their shape, and joins them into
 * the view models the globe renders. Nothing here touches three.js; nothing in
 * the renderer reaches into the raw JSON.
 */
import placesJson from "../files/places.json";
import timelineJson from "../files/timeline.json";
import type {
  Leg,
  PathLine,
  PlaceMarker,
  PlaceStats,
  PlaceView,
  PlacesFile,
  RegionView,
  TimelineFile,
  TravelMode,
} from "./types";

export * from "./types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[data] ${msg}`);
}

/**
 * Cheap structural check at startup. The `as` casts below are only sound
 * because of this — a schema change that the types missed fails loudly here
 * instead of rendering an empty globe.
 */
function validate(p: any, t: any): void {
  assert(p?.type === "Places" && p.version === 2, "places.json: expected version 2 / type Places");
  assert(Array.isArray(p.regions) && p.regions.length > 0, "places.json: no regions");
  for (const r of p.regions) {
    assert(typeof r.id === "string" && Array.isArray(r.places), `places.json: bad region ${r?.id}`);
    assert(
      typeof r.center?.lat === "number" && typeof r.center?.lng === "number",
      `places.json: region ${r.id} center must be numeric`
    );
    for (const pl of r.places) {
      assert(
        typeof pl.coords?.lat === "number" && typeof pl.coords?.lng === "number",
        `places.json: place ${pl?.id} coords must be numeric`
      );
    }
  }
  assert(t?.type === "Timeline" && t.version === 2, "timeline.json: expected version 2 / type Timeline");
  assert(t.places && Array.isArray(t.legs) && Array.isArray(t.paths), "timeline.json: missing sections");

  // The join is the thing most likely to rot: a place renamed in places.json
  // without a re-import leaves orphaned stats keys.
  const ids = new Set<string>(p.regions.flatMap((r: any) => r.places.map((x: any) => x.id)));
  const orphans = Object.keys(t.places).filter((id) => !ids.has(id));
  if (orphans.length) {
    console.warn(`[data] timeline.json references ${orphans.length} unknown place id(s): ${orphans.join(", ")} — re-run the importer`);
  }
}

validate(placesJson, timelineJson);

export const places = placesJson as unknown as PlacesFile;
export const timeline = timelineJson as unknown as TimelineFile;

/** ARCHIVE places are excluded from everything the globe renders or counts. */
const isVisible = (p: { status?: string }) => p.status !== "ARCHIVE";

// --- Latitude encodings -----------------------------------------------------

/**
 * Intensity reads as exposure, not size: every marker keeps one radius and
 * accumulates light instead. Log-scaled because the range is 1..361 visits and
 * linear scaling would leave everything below Jersey City invisible.
 */
const MAX_VISITS = 361;
export function exposureFor(stats: PlaceStats | null): number {
  // Narrow band on purpose. Visit count is worth a hint of emphasis, but a
  // place must never be so faint that it disappears into the globe.
  if (!stats) return 0.82;
  return 0.86 + 0.14 * (Math.log1p(stats.visits) / Math.log1p(MAX_VISITS));
}

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
// Both ends of the ramp are BOLD. Age shifts hue, never visibility — a marker
// that fades into the globe has stopped doing its job, and the encoding is
// worth nothing if the thing it encodes cannot be seen.
const RECENT = hexToRgb("#FFB000");
const AGED = hexToRgb("#F4F8FC");

/**
 * Recency as colour temperature — a visible timeline with no slider. Warm
 * where life currently is, cooling as a place recedes into the past.
 */
export function temperatureFor(stats: PlaceStats | null, latestSeen: string): string {
  // Never recorded is not the same as unimportant — still bold, just cool.
  if (!stats) return "#DCE4EC";
  const span = Date.parse(latestSeen) - Date.parse(timeline.source.coverage.from);
  const age = Date.parse(latestSeen) - Date.parse(stats.lastSeen);
  const t = span > 0 ? Math.min(1, Math.max(0, age / span)) : 0;
  const mix = RECENT.map((c, i) => Math.round(c + (AGED[i] - c) * t));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
}

export const styleFor = (mode: TravelMode) => MODE_STYLE[mode] ?? GROUND_DEFAULT;

export const regionViews: RegionView[] = places.regions
  .map((region): RegionView | null => {
  const placeViews: PlaceView[] = region.places.filter(isVisible).map((p) => ({
    ...p,
    regionId: region.id,
    regionName: region.name,
    country: region.country.name,
    stats: timeline.places[p.id] ?? null,
  }));

  /**
   * The region marker sits on its most-visited place, not on region.center.
   *
   * The centres are auto-generated centroids, so drawing them produced a dot
   * in open country that was never actually visited — Karnataka's is 173km
   * from the nearest real place, Andhra Pradesh's 420km — inflating a
   * three-city region to four points on the globe. Anchoring to a real place
   * keeps the zoomed-out dot meaningful and makes it coincide exactly with
   * that city's own dot once the zoomed-in layer appears.
   */
  if (placeViews.length === 0) return null;

  const anchor = placeViews.reduce((best, p) =>
    (p.stats?.visits ?? 0) > (best.stats?.visits ?? 0) ? p : best
  );


  return {
    text: region.name,
    lat: anchor.coords.lat,
    lng: anchor.coords.lng,
    size: Math.min(0.5, 0.2 + region.places.length * 0.1),
    id: region.id,
    region: region.name,
    regionType: region.type,
    country: region.country.name,
    countryCode: region.country.code,
    anchorId: anchor.id,
    cities: placeViews.map((p) => p.name),
    places: placeViews,
    // Straight from the importer — never summed from placeViews, which would
    // double-count a day spent in two places in the same region.
    stats: timeline.regions[region.id] ?? null,
    exposure: exposureFor(timeline.regions[region.id] ?? null),
    color: temperatureFor(timeline.regions[region.id] ?? null, timeline.source.coverage.to),
    desc: placeViews.length === 1 ? placeViews[0].desc : `${placeViews.length} places visited`,
  };
})
  // A region whose every place is archived has no anchor and nothing to draw.
  .filter((r): r is RegionView => r !== null);

export const latestSeen: string = timeline.source.coverage.to;

export const placeMarkers: PlaceMarker[] = regionViews.flatMap((region) =>
  region.places.map((p) => ({
    // Latitude labels places by name, not by code — this is a record to be
    // read, and BBI says nothing to anyone who was not there.
    text: p.name,
    city: p.name,
    status: p.status,
    country: p.country,
    lat: p.coords.lat,
    lng: p.coords.lng,
    desc: p.desc,
    size: 0.2,
    stats: p.stats,
    exposure: exposureFor(p.stats),
    color: temperatureFor(p.stats, latestSeen),
    parentRegion: region,
  }))
);

// --- movement ---------------------------------------------------------------

/**
 * Flights are the only mode drawn as arcs. Ground travel stays on the surface,
 * because an arc implies leaving it — a road trip lifted 30km into the air
 * reads as a flight.
 */
const MODE_STYLE: Record<string, { color: string; stroke: number }> = {
  // NOTE ON UNITS: arcStroke is a world-space tube radius, but pathStroke is
  // a fat-line width in PIXELS — the shader does `offset *= linewidth;
  // offset /= resolution.y`. The two numbers below are therefore on totally
  // different scales, and a path stroke under ~1 is a sub-pixel hairline.
  //
  // Amber is the only accent in the system, so it is spent on flights alone.
  // Ground modes separate by lightness within one cool neutral family rather
  // than by introducing competing hues.
  flying: { color: "#FFB000", stroke: 0.34 }, // world units (arc tube)
  "in train": { color: "#C6D2DE", stroke: 3.2 }, // pixels (fat line)
  "in passenger vehicle": { color: "#8C9AA8", stroke: 3.0 },
  motorcycling: { color: "#A3B0BD", stroke: 2.6 },
  "in bus": { color: "#75828F", stroke: 2.6 },
  cycling: { color: "#94A4B2", stroke: 2.2 },
};
const GROUND_DEFAULT = { color: "#8C9AA8", stroke: 3.0 };

export interface FlightArc extends Leg {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  color: string;
  stroke: number;
  order: number;
}

/** Arcs: flights only. */
export const flightArcs: FlightArc[] = timeline.legs
  .filter((leg) => leg.mode === "flying")
  .map((leg, i) => {
    const style = styleFor(leg.mode);
    return {
      ...leg,
      startLat: leg.from.lat,
      startLng: leg.from.lng,
      endLat: leg.to.lat,
      endLng: leg.to.lng,
      color: style.color,
      stroke: style.stroke,
      order: i,
    };
  });

export interface GroundPath {
  id: string;
  mode: TravelMode | null;
  points: [number, number][];
  color: string;
  stroke: number;
  date: string;
}

/**
 * Ground travel is drawn ONLY from recorded GPS traces.
 *
 * The tempting alternative — a straight line between a leg's two endpoints —
 * is fabricated geometry: nobody travels the great-circle line from Jersey
 * City to Philadelphia, and rendering one asserts a route that never existed.
 * Legs without a trace are still counted in modeStats; they just aren't drawn.
 */
export const groundPaths: GroundPath[] = timeline.paths.map((p) => {
  const style = p.mode ? styleFor(p.mode) : GROUND_DEFAULT;
  return {
    id: p.id,
    points: p.points,
    mode: p.mode,
    color: style.color,
    stroke: style.stroke,
    date: p.date,
  };
});

export const pathLines: PathLine[] = timeline.paths;

/** Human-readable place name for a leg endpoint, for tooltips. */
const placeNameById = new Map<string, string>(
  regionViews.flatMap((r) => r.places.map((p) => [p.id, p.name] as [string, string]))
);
export const endpointLabel = (e: { placeId: string | null }) =>
  (e.placeId && placeNameById.get(e.placeId)) || "elsewhere";

/**
 * Archived stops, as bare geometry. Deliberately NOT PlaceView — no name, no
 * desc, no stats — so there is nothing for a tooltip to read even by accident.
 */
export interface ArchivedMarker {
  id: string;
  lat: number;
  lng: number;
}

export const archivedMarkers: ArchivedMarker[] = places.regions.flatMap((r) =>
  r.places
    .filter((p) => p.status === "ARCHIVE")
    .map((p) => ({ id: p.id, lat: p.coords.lat, lng: p.coords.lng }))
);

/** Places imported from a report but not yet written up. */
export const unmarkedPlaces: PlaceView[] = regionViews.flatMap((r) =>
  r.places.filter((p) => p.status === "UNMARKED")
);

if (unmarkedPlaces.length) {
  console.info(
    `[data] ${unmarkedPlaces.length} place(s) marked UNMARKED and awaiting a write-up: ` +
      unmarkedPlaces.map((p) => `${p.name} (${p.id})`).join(", ") +
      ` — edit the desc and drop the status field, or set status to "ARCHIVE" to hide it.`
  );
}

/**
 * ISO-2 codes of every country with a curated place in it, so the map can
 * distinguish land that has been stood on from land that has not.
 */
export const visitedCountries: Set<string> = new Set(
  places.regions.map((r) => r.country.code)
);

export const coverage = timeline.source.coverage;
export const modeStats = timeline.modeStats;
