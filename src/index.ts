import ThreeGlobe from "three-globe";
import { WebGLRenderer, Scene } from "three";
import * as THREE from "three";
import {
  PerspectiveCamera,
  AmbientLight,
  DirectionalLight,
  Color,
  Fog,
  PointLight,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import countries from "./files/globe-data-min.json";
import {
  archivedMarkers,
  flightArcs,
  groundPaths,
  placeMarkers,
  regionViews,
} from "./data/index";
import type { PlaceMarker, RegionView } from "./data/index";

var renderer: WebGLRenderer, camera: PerspectiveCamera, scene: Scene, controls: OrbitControls;
let mouseX = 0;
let mouseY = 0;
let windowHalfX = window.innerWidth / 2;
let windowHalfY = window.innerHeight / 2;
var Globe: any;

/**
 * three-globe binds each rendered object back onto the datum itself
 * (objBindAttr '__threeObj'). Handing the same array to two layers makes the
 * second overwrite the first's binding, and the next data swap then tries to
 * dispose an object the other layer owns — "Cannot read properties of
 * undefined (reading 'children')". Each layer gets its own shallow copies.
 */
const layerData = (zoomedIn: boolean) =>
  (zoomedIn ? placeMarkers : regionViews).map((d) => ({ ...d }));

// Which movement layers are on. Fresh copies go to three-globe on every
// change for the same __threeObj reason as layerData above.
const layerVisible = { flights: true, roads: true, verbose: false };

function applyLayerVisibility() {
  archivedDots.forEach((dot) => {
    dot.visible = layerVisible.verbose;
  });
  if (!Globe) return;
  Globe.arcsData(layerVisible.flights ? flightArcs.map((d) => ({ ...d })) : []).pathsData(
    layerVisible.roads ? groundPaths.map((d) => ({ ...d })) : []
  );
  routeMaterialsStale = true;
}

function initLayerToggles() {
  const wire = (id: string, key: keyof typeof layerVisible) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener("click", () => {
      layerVisible[key] = !layerVisible[key];
      btn.setAttribute("aria-pressed", String(layerVisible[key]));
      applyLayerVisibility();
    });
  };
  wire("toggle-flights", "flights");
  wire("toggle-roads", "roads");
  wire("toggle-verbose", "verbose");
  applyLayerVisibility();

  document.getElementById("tooltip-close")?.addEventListener("click", removePlaceInformation);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") removePlaceInformation();
  });
}

// Zoom-based city rendering
// Relative to the fitted framing, not an absolute distance — otherwise a
// phone that has to sit at ~430 to see the globe never crosses a fixed 180.
const ZOOM_REVEAL_FRACTION = 0.72;
let citySpheres: THREE.Mesh[] = []; // Collision spheres for cities
let regionSpheres: THREE.Mesh[] = [];
let archivedDots: THREE.Mesh[] = [];
// Only these are tested on hover; archived dots are deliberately absent.
let hoverTargets: THREE.Mesh[] = [];
let isZoomedIn = false;


/**
 * Countries holding a curated place read as warm paper; everywhere else sits
 * back in a dimmer tone. The map therefore states where life has actually
 * happened instead of being uniform decoration.
 */

/** three-globe draws the sphere at radius 100. */
const GLOBE_RADIUS = 100;

/**
 * Where the globe opens. Taken from places.json rather than hardcoded, so it
 * follows the record if home ever moves again.
 */
const HOME_VIEW = (() => {
  const home = placeMarkers.find((p) => p.city === "San Francisco");
  return home ? { lat: home.lat, lng: home.lng } : { lat: 37.7749, lng: -122.4194 };
})();

let sunLight: DirectionalLight;

/**
 * World position of the sun for the current clock, so the lit hemisphere is
 * the one actually in daylight right now and the terminator falls where it
 * really falls.
 *
 * Subsolar latitude comes from the axial tilt and the day of year; subsolar
 * longitude from UTC time of day, since the sun is overhead at the meridian
 * where it is local noon. Accurate to about a degree, which is far below what
 * is visible on a globe this size.
 */
function subsolarPosition(date = new Date()): THREE.Vector3 {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - start) / 86400000;

  // Declination: 23.44 deg tilt, zero at the equinox near day 81.
  const declination = -23.44 * Math.cos(((2 * Math.PI) / 365.24) * (dayOfYear + 10));

  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const longitude = 180 - utcHours * 15;

  if (!Globe) return new THREE.Vector3(-420, 340, 520);

  // getCoords returns GLOBE-LOCAL coordinates, but the light lives in the
  // scene — and the globe carries a static -84 deg rotateY. Without converting
  // frames the terminator lands 84 degrees off, which is why daylight sat on
  // California while it should have been over India.
  const p = Globe.getCoords(declination, longitude, 2.2);
  // localToWorld reads the object's world matrix, which three.js only refreshes
  // during render — on the first call, right after scene.add(), it is still
  // identity and the globe's -84 deg rotation gets silently dropped.
  Globe.updateMatrixWorld(true);
  return Globe.localToWorld(new THREE.Vector3(p.x, p.y, p.z));
}

let routeMaterials: any[] = [];
let routeMaterialsStale = true;

/**
 * Re-collected whenever the paths layer is rebuilt.
 *
 * The datum is NOT on the object that owns the material: three-globe binds
 * __data to a wrapping Group and adds the Line2 as a child. Reading
 * obj.__data directly therefore missed every stroke and fell back to
 * LineMaterial's default of 1 — which then got written back, clamping every
 * route to a 1px hairline regardless of its configured width.
 */
function findDatumStroke(obj: any): number | undefined {
  for (let node = obj; node; node = node.parent) {
    const stroke = node.__data?.stroke;
    if (typeof stroke === "number") return stroke;
  }
  return undefined;
}

function collectRouteMaterials() {
  routeMaterials = [];
  if (!Globe) return;
  Globe.traverse((obj: any) => {
    const mat = obj.material;
    if (!mat || typeof mat.linewidth !== "number") return;
    const stroke = findDatumStroke(obj);
    // No datum stroke means this is not one of ours — never touch its width.
    if (stroke === undefined) return;
    mat.__baseWidth = stroke;
    routeMaterials.push(mat);
  });
}

function updateRouteWeights() {
  if (!Globe || !camera) return;
  if (routeMaterialsStale) {
    collectRouteMaterials();
    routeMaterialsStale = false;
  }
  const scale = fitDistance() / camera.position.length();
  for (const mat of routeMaterials) mat.linewidth = mat.__baseWidth * scale;
}

(window as any).__routeDebug = () => {
  const byBase: Record<string, number> = {};
  for (const m of routeMaterials) {
    const k = String(m.__baseWidth);
    byBase[k] = (byBase[k] ?? 0) + 1;
  }
  const d = camera.position.length();
  return {
    materials: routeMaterials.length,
    baseWidths: byBase, // expect { "0.34": 9 flights, "3": roads, "3.2": rail }
    sample: routeMaterials.slice(0, 3).map((m) => ({ base: m.__baseWidth, now: +m.linewidth.toFixed(2) })),
    distance: Math.round(d),
    fitted: Math.round(fitDistance()),
    scale: +(fitDistance() / d).toFixed(3),
  };
};

/** Re-aim the sun periodically so a page left open keeps drifting with the day. */
function trackSun() {
  if (sunLight && Globe) sunLight.position.copy(subsolarPosition());
}

/**
 * How far routes sit off the surface, in globe radii (x100 for units).
 *
 * Narrow band to hit. Too low and the hex dots — which sit at surface level
 * and have real width — occlude most of the line, so it reads as a thin
 * sliver rather than a route. Too high (0.012 was) and it visibly detaches
 * at the limb and floats. 0.006 clears the dot layer with the full stroke
 * showing, while staying close enough to read as painted on.
 */
const ROUTE_ALTITUDE = 0.006;

/**
 * Distance at which the whole globe fits the viewport.
 *
 * On a phone the limiting field is the HORIZONTAL one, and it is much narrower
 * than the vertical, so a distance that framed the globe on a desktop crops it
 * badly in portrait. Derive it instead of hardcoding.
 */
let fittedDistance = 0;

function computeFitDistance(): number {
  const fovY = ((camera?.fov ?? 50) * Math.PI) / 180;
  const aspect = window.innerWidth / window.innerHeight;
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
  const limiting = Math.min(fovY, fovX);
  // 1.06 keeps a wide desktop at ~250, the framing that was already right,
  // while still pulling back far enough to fit the globe on a phone.
  return (GLOBE_RADIUS / Math.sin(limiting / 2)) * 1.06;
}

/** Cached; recomputed only on resize rather than every frame. */
function fitDistance(): number {
  if (fittedDistance === 0) fittedDistance = computeFitDistance();
  return fittedDistance;
}

/**
 * Starfield.
 *
 * Points on a sphere well outside the camera's reach, distributed by sampling
 * cos(phi) uniformly rather than phi — sampling the angle directly clumps
 * stars at the poles, which reads as a seam once the globe is rotated.
 *
 * Sizes and brightnesses are drawn from a skewed distribution so most stars
 * are faint and a handful carry, which is what stops it looking like evenly
 * scattered noise. Fog is disabled or the far ones would be washed out by it.
 */
function createStarfield(count = 550, radius = 900): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const cosPhi = Math.random() * 2 - 1;
    const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
    const theta = Math.random() * Math.PI * 2;
    // Jitter the shell so they do not read as a hollow ball edge-on.
    const r = radius * (0.8 + Math.random() * 0.3);

    positions[i * 3] = r * sinPhi * Math.cos(theta);
    positions[i * 3 + 1] = r * cosPhi;
    positions[i * 3 + 2] = r * sinPhi * Math.sin(theta);

    // Mostly dim, a few bright. Slight cool/warm spread keeps it from reading
    // as flat grey without introducing a second accent.
    // Heavier skew than before: almost every star sits near the floor and
    // only a few carry, so the field reads as depth rather than as content.
    const mag = Math.pow(Math.random(), 3.6);
    const level = 0.14 + mag * 0.5;
    const warm = Math.random() < 0.18 ? 1.06 : 1.0;
    colors[i * 3] = Math.min(1, level * warm);
    colors[i * 3 + 1] = level * (warm > 1 ? 0.99 : 1.0);
    colors[i * 3 + 2] = Math.min(1, level * (warm > 1 ? 0.92 : 1.04));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 1.5,
    sizeAttenuation: false, // constant on screen, so zoom does not swell them
    vertexColors: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    fog: false,
  });

  const stars = new THREE.Points(geometry, material);
  stars.name = "starfield";
  // Never a hover target, and never culled when the globe fills the frame.
  stars.frustumCulled = false;
  return stars;
}

// SECTION Initializing core ThreeJS elements
function init() {
  // Initialize renderer
  renderer = new WebGLRenderer({ antialias: true });
  // Uncapped devicePixelRatio renders 9x the pixels on a 3x phone for no
  // visible gain, and this scene is already fill-bound.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Initialize scene, light
  scene = new Scene();
  scene.add(new AmbientLight(0xBFCAD6, 0.44));
  scene.background = new Color(0x08090B);

  // Initialize camera, light
  camera = new PerspectiveCamera();
  camera.aspect = window.innerWidth / window.innerHeight;
  // The default 0.1/2000 near-far pair is a 20,000:1 ratio, which leaves the
  // depth buffer almost no resolution at globe distance — that is what shreds
  // the country polygons against the sphere. The camera orbits between 150
  // and ~315 from a radius-100 globe, so it never gets nearer than ~50.
  camera.near = 20;
  // Far has to clear the starfield shell (~720-990 units) with headroom.
  camera.far = 2400;
  camera.updateProjectionMatrix();

  // Lights live in WORLD space, not on the camera. Parenting them to the
  // camera meant the globe was lit identically from every angle, so rotating
  // it produced no change in shading at all — the single biggest reason it
  // read as a flat sphere rather than a lit body.
  const keyLight = new DirectionalLight(0xFFF3DC, 1.2); // the sun
  keyLight.position.copy(subsolarPosition());
  scene.add(keyLight);
  sunLight = keyLight;

  // Cool bounce, but only just. A saturated blue fill pushed the unlit
  // hemisphere to B > R — measurably violet — which fights a palette whose
  // whole premise is a warm film base.
  const fillLight = new DirectionalLight(0x46545F, 0.34);
  fillLight.position.set(560, -220, -360);
  scene.add(fillLight);

  const rimLight = new PointLight(0xFFB000, 0.5, 1800);
  rimLight.position.set(240, 420, -560);
  scene.add(rimLight);

  // Raised so the home latitude sits centred rather than the equator.
  const homeLat = THREE.MathUtils.degToRad(HOME_VIEW.lat);
  const d = fitDistance();
  camera.position.set(0, d * Math.sin(homeLat), d * Math.cos(homeLat));

  scene.add(camera);

  // Additional effects
  scene.fog = new Fog(0x0C0F13, 420, 1900);

  scene.add(createStarfield());

  // Helpers
  // const axesHelper = new AxesHelper(800);
  // scene.add(axesHelper);
  // var helper = new DirectionalLightHelper(dLight);
  // scene.add(helper);
  // var helperCamera = new CameraHelper(dLight.shadow.camera);
  // scene.add(helperCamera);

  // Initialize controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dynamicDampingFactor = 0.01;
  controls.enablePan = false;
  controls.minDistance = 150;
  // Always leave room to pull back far enough to see the whole sphere. A flat
  // 300 was fine on a wide desktop and impossible on a phone, where the narrow
  // horizontal field is what actually crops the globe.
  controls.maxDistance = Math.max(300, fitDistance() * 1.25);
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 1;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.18;
  // Any deliberate input ends the drift for good — it is an invitation to
  // look, not an animation to sit through.
  const stopDrift = () => {
    controls.autoRotate = false;
  };
  renderer.domElement.addEventListener("pointerdown", stopDrift, { once: true });
  renderer.domElement.addEventListener("wheel", stopDrift, { once: true, passive: true });

  // controls.minPolarAngle = Math.PI / 3.5;
  // controls.maxPolarAngle = Math.PI - Math.PI / 3;
  controls.minPolarAngle = 0; // Allow looking straight up
  controls.maxPolarAngle = Math.PI; // Allow looking straight down

  window.addEventListener("resize", onWindowResize, false);
  document.addEventListener("mousemove", onMouseMove);
  // Pointer inside the panel is reading, not aiming at the globe.
  document.getElementById("tooltip")?.addEventListener("mousemove", (e) => e.stopPropagation());
  renderer.domElement.addEventListener('touchmove', onTouchMove, false);
  renderer.domElement.addEventListener('touchstart', onTouchStart, false);
}


// SECTION Initializing the globe

// SECTION Globe
function initGlobe() {
  // Configure EVERY accessor up front, and set data separately below.
  //
  // These used to live inside the setTimeout together with the data, but
  // initLayerToggles() calls applyLayerVisibility() during bootstrap — so
  // pathsData arrived while pathPoints was still three-globe's default
  // identity accessor, which handed calcPath the datum object instead of an
  // array of points and threw "points.map is not a function".
  Globe = new ThreeGlobe({
    waitForGlobeReady: true,
    animateIn: true,
  })
    .hexPolygonsData(countries.features)
    .hexPolygonResolution(4)
    .hexPolygonMargin(0.7)
    .showAtmosphere(true)
    .atmosphereColor("#4A6B85")
    .atmosphereAltitude(0.26)
    // Warm paper land on a dark base — the whole read of the direction.
    .hexPolygonColor(() => "rgba(214,222,230,0.78)")

    .arcColor((e: any) => e.color)
    .arcAltitude((e: any) => e.arcAlt)
    .arcStroke((e: any) => e.stroke)
    .arcDashLength(0.6)
    .arcDashGap(2.2)
    .arcDashAnimateTime(4200)
    .arcsTransitionDuration(1000)
    .arcDashInitialGap((e: any) => e.order * 1)

    // Ground travel hugs the surface — road and rail never arc.
    .pathPoints((d: any) => d.points)
    .pathPointLat((pt: any) => pt[0])
    .pathPointLng((pt: any) => pt[1])
    .pathColor((d: any) => d.color)
    .pathStroke((d: any) => d.stroke)
    .pathPointAlt(ROUTE_ALTITUDE)
    // Solid, not dashed: these are trails showing where a route went, and a
    // slow crawling dash reads as an animation with no meaning behind it.
    .pathDashLength(1)
    .pathDashGap(0)
    .pathDashAnimateTime(0)
    .pathTransitionDuration(0)

    .labelColor(() => "#EDF1F5")
    .labelDotOrientation("right")
    // Text only. The mark is drawn separately and carries the encoding;
    // a fixed-radius label dot sat on top of it and erased the difference
    // between a place visited once and one visited 361 times.
    .labelDotRadius(0)
    .labelSize((e: any) => e.size)
    .labelResolution(6)
    .labelAltitude(0)
    .labelsTransitionDuration(0)

    .pointColor((e: any) => e.color ?? "#FFB000")
    // Not merged: the zoom swap replaces this layer's data, and a merged
    // layer disposes the single combined mesh out from under three-globe's
    // digest. A few dozen points cost nothing unmerged.
    .pointsMerge(false)
    .pointAltitude(0.002)
    .pointRadius((e: any) => 0.045 + 0.05 * (e.exposure ?? 0.4))
    .pointsTransitionDuration(0);

  // Data only, once the build-in animation has played.
  setTimeout(() => {
    Globe.labelsData(layerData(false)).pointsData(layerData(false));
    applyLayerVisibility();
    routeMaterialsStale = true;
  }, 1000);

  // three-globe puts a point at longitude L at angle L from +Z, and the camera
  // sits on +Z — so rotating by -L brings that longitude to face the viewer.
  // The old -84 deg was centring longitude 84E, i.e. central India.
  Globe.rotateY(THREE.MathUtils.degToRad(-HOME_VIEW.lng));
  const globeMaterial = Globe.globeMaterial();
  globeMaterial.color = new Color(0x12161A);
  globeMaterial.emissive = new Color(0x121C24);
  globeMaterial.emissiveIntensity = 0.3;
  globeMaterial.shininess = 0.15;

  // Invisible collision spheres for region markers (hover detection)
  regionViews.forEach((marker: RegionView) => {
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
    });
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 32),
      sphereMaterial
    );
    const position = Globe.getCoords(marker.lat, marker.lng);
    sphere.position.set(position.x, position.y, position.z);
    sphere.userData = marker;
    Globe.add(sphere);
    regionSpheres.push(sphere);
    hoverTargets.push(sphere);
  });

  // Create city dots and collision spheres (initially hidden, shown when zoomed in)
  // Hover targets only. The visible mark comes from the points layer, which
  // already carries exposure and temperature — drawing a circle here too put
  // a second disc on top of every place.
  placeMarkers.forEach((city: PlaceMarker) => {
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 16), sphereMaterial);
    const position = Globe.getCoords(city.lat, city.lng, 0.005);
    sphere.position.set(position.x, position.y, position.z);
    sphere.visible = false;
    sphere.userData = city;
    Globe.add(sphere);
    citySpheres.push(sphere);
    hoverTargets.push(sphere);
  });

  // Archived stops: the minor pauses a journey was assembled from. They get
  // NO userData, so a raycast hit falls through to the "nothing here" branch
  // and no tooltip appears — they are texture, not destinations.
  archivedMarkers.forEach((stop) => {
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.22, 16),
      new THREE.MeshBasicMaterial({
        color: 0xD6DEE6,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.5,
      })
    );
    const position = Globe.getCoords(stop.lat, stop.lng, 0.004);
    dot.position.set(position.x, position.y, position.z);
    dot.lookAt(0, 0, 0);
    dot.rotateX(Math.PI);
    dot.visible = false;
    Globe.add(dot);
    archivedDots.push(dot);
  });

  scene.add(Globe);

  trackSun();
  window.setInterval(trackSun, 60_000);
}

function checkIntersection(event: MouseEvent | TouchEvent) {
  event.preventDefault();
  const mouse = new THREE.Vector2();
  if ('touches' in event && event.touches.length > 0) {
    mouse.x = (event.touches[0].clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.touches[0].clientY / window.innerHeight) * 2 + 1;
  } else if ('clientX' in event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  }

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);

  // Only the collision spheres are hoverable. Intersecting Globe.children
  // recursively walked the entire scene — including the hex-polygon layer's
  // tens of thousands of points — on every single mousemove.
  const intersects = raycaster.intersectObjects(hoverTargets, false);

  if (intersects.length === 0) {
    renderer.domElement.style.cursor = 'default';
    return;
  }

  {
    const object = intersects[0].object;
    const placeData = object.userData;

    // Check for region data (has 'region' property) or legacy city data (has 'text')
    if (placeData && (placeData.region || placeData.text)) {
      renderer.domElement.style.cursor = 'pointer';
      displayPlaceInformation(event, placeData);
    } else {
      renderer.domElement.style.cursor = 'default';
    }
  }
}

let pendingHover: MouseEvent | TouchEvent | null = null;

/**
 * A raycast per mousemove is wasted work — the browser fires them faster than
 * the scene redraws. Keep only the newest and resolve it once per frame.
 */
function queueHover(event: MouseEvent | TouchEvent) {
  const isFirst = pendingHover === null;
  pendingHover = event;
  if (!isFirst) return;
  requestAnimationFrame(() => {
    const queued = pendingHover;
    pendingHover = null;
    if (queued) checkIntersection(queued);
  });
}

function onMouseMove(event) {
  mouseX = event.clientX - windowHalfX;
  mouseY = event.clientY - windowHalfY;
  queueHover(event);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  // Rotating a phone changes which field limits the framing, so the reachable
  // range has to move with it.
  fittedDistance = computeFitDistance();
  if (controls) controls.maxDistance = Math.max(300, fittedDistance * 1.25);
  windowHalfX = window.innerWidth / 1.5;
  windowHalfY = window.innerHeight / 1.5;
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  camera.lookAt(scene.position);
  controls.update();

  // Check zoom level and toggle city dots visibility
  const distance = camera.position.length();
  const shouldShowCities = distance < fitDistance() * ZOOM_REVEAL_FRACTION;

  if (shouldShowCities !== isZoomedIn) {
    isZoomedIn = shouldShowCities;
    // States and cities are two views of the same thing, so they swap rather
    // than stack — showing both drew a state marker next to its own cities and
    // made a three-city region look like four places.
    citySpheres.forEach((sphere) => { sphere.visible = shouldShowCities; });
    regionSpheres.forEach((sphere) => { sphere.visible = !shouldShowCities; });
    if (Globe) {
      Globe.labelsData(layerData(shouldShowCities)).pointsData(layerData(shouldShowCities));
    }
  }

  updateRouteWeights();

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function onTouchStart(event) {
  if (event.touches.length == 1) {
    queueHover(event);
  }
}

function onTouchMove(event) {
  event.preventDefault();

  if (event.touches.length == 1) {
    queueHover(event);
  }
}

/** Badge for a place still awaiting a write-up. */
const unmarkedBadge = (status?: string) =>
  status === "UNMARKED" ? `<span class="badge-unmarked">UNMARKED</span>` : "";

/** "Mar 2025" or "Mar 2025 – Jul 2025" for a stats range. */
function formatSpan(stats: { firstSeen: string; lastSeen: string }): string {
  const fmt = (d: string) =>
    new Date(d + "T00:00:00Z").toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  const from = fmt(stats.firstSeen);
  const to = fmt(stats.lastSeen);
  return from === to ? from : `${from} – ${to}`;
}

function displayPlaceInformation(_event: MouseEvent | TouchEvent, placeData: any) {
  const tooltip = document.getElementById("tooltip");
  const body = document.getElementById("tooltip-body");
  if (!tooltip || !body) return;

  // Latitude leads with the writing. The phone's record is a footnote under
  // it, never a headline, and a place with no record says so in words rather
  // than showing an empty stat block.
  const era = (stats: any) => (stats ? formatSpan(stats).toUpperCase() : "BEFORE THE RECORD");

  if (placeData.places && placeData.cities) {
    const region = placeData as RegionView;
    const count = region.places.length;

    const entries = region.places
      .map(
        (p) => `<div class="sheet-entry">
            <span class="sheet-entry-name">${p.name}</span>${unmarkedBadge(p.status)}
            ${p.stats ? `<span class="sheet-entry-meta">${p.stats.days}d · ${formatSpan(p.stats)}</span>` : ""}
            <p class="sheet-prose">${p.desc}</p>
          </div>`
      )
      .join("");

    body.innerHTML = `
      <div class="sheet-era"><span>${region.country}</span><span>${era(region.stats)}</span></div>
      <h5 class="sheet-name">${region.region}</h5>
      <div class="sheet-region">${count} ${count === 1 ? "place" : "places"}</div>
      ${entries}
      ${
        region.stats
          ? `<div class="sheet-record">${region.stats.visits} visits · ${region.stats.days} days recorded</div>`
          : ""
      }
    `;
  } else {
    const stats = placeData.stats;
    body.innerHTML = `
      <div class="sheet-era">
        <span>${placeData.parentRegion ? placeData.parentRegion.region : placeData.country}</span>
        <span>${era(stats)}</span>
      </div>
      <h5 class="sheet-name">${placeData.city || placeData.text}${unmarkedBadge(placeData.status)}</h5>
      <div class="sheet-region">${placeData.country}</div>
      <p class="sheet-prose">${placeData.desc}</p>
      ${
        stats
          ? `<div class="sheet-record">${stats.visits} ${stats.visits === 1 ? "visit" : "visits"} · ${stats.days} ${stats.days === 1 ? "day" : "days"} · first ${formatSpan({ firstSeen: stats.firstSeen, lastSeen: stats.firstSeen })}</div>`
          : `<div class="sheet-record"><em>Before the record begins.</em></div>`
      }
    `;
  }

  // Docked: no positioning, and no auto-hide. The panel persists until
  // another marker replaces its contents or the reader dismisses it, which
  // is what lets them move the pointer onto it and scroll.
  tooltip.style.display = 'block';
  tooltip.scrollTop = 0;
}

function removePlaceInformation() {
  const tooltip = document.getElementById("tooltip");
  if (tooltip) {
    tooltip.style.display = 'none';
  }
}

// --- bootstrap ---------------------------------------------------------------
// Deliberately the LAST statements in the module. Function declarations hoist,
// but `const`/`let` do not, so calling init() from the middle of the file put
// every constant declared below it in the temporal dead zone — which is how
// both GLOBE_RADIUS and fittedDistance blew up at startup. Running last means
// no declaration can be unreachable, whatever gets added later.
init();
initGlobe();
initLayerToggles();
onWindowResize();
animate();
