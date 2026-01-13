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
import visitsData from "./files/my-visits.json";
import travelHistory from "./files/my-flights.json";

// Transform regions data to flat locations for rendering
interface Visit {
  city: string;
  code: string;
  lat: string;
  lng: string;
  desc: string;
}

interface Region {
  id: string;
  country: string;
  countryCode: string;
  region: string;
  regionType: string;
  lat: string;
  lng: string;
  visits: Visit[];
}

interface VisitsData {
  type: string;
  regions: Region[];
}

// Create region-level markers (state/region as the marker)
const regionMarkers = (visitsData as VisitsData).regions.map((region) => ({
  text: region.region,
  size: Math.min(0.5, 0.2 + region.visits.length * 0.1), // Size based on number of cities
  country: region.country,
  countryCode: region.countryCode,
  region: region.region,
  regionType: region.regionType,
  lat: region.lat,
  lng: region.lng,
  cities: region.visits.map(v => v.city),
  visits: region.visits,
  // For tooltip: show first city's desc or combine
  desc: region.visits.length === 1
    ? region.visits[0].desc
    : `${region.visits.length} places visited`
}));

// Flatten all cities with parent region data for city-level rendering
const cityMarkers = (visitsData as VisitsData).regions.flatMap((region) => {
  // Find the parent region marker to attach to city
  const parentRegion = regionMarkers.find(r => r.region === region.region);
  return region.visits.map((visit) => ({
    text: visit.code,
    city: visit.city,
    country: region.country,
    lat: visit.lat,
    lng: visit.lng,
    desc: visit.desc,
    size: 0.2,
    // Attach full parent region data for tooltip
    parentRegion: parentRegion,
  }));
});

var renderer: WebGLRenderer, camera: PerspectiveCamera, scene: Scene, controls: OrbitControls;
let mouseX = 0;
let mouseY = 0;
let windowHalfX = window.innerWidth / 2;
let windowHalfY = window.innerHeight / 2;
var Globe: any;

// Zoom-based city rendering
const ZOOM_THRESHOLD = 180; // Distance at which city dots appear
let cityDots: THREE.Mesh[] = [];
let citySpheres: THREE.Mesh[] = []; // Collision spheres for cities
let isZoomedIn = false;

init();
initGlobe();
onWindowResize();
animate();

// SECTION Initializing core ThreeJS elements
function init() {
  // Initialize renderer
  renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Initialize scene, light
  scene = new Scene();
  scene.add(new AmbientLight(0xbbbbbb, 0.3));
  scene.background = new Color(0x040d21);

  // Initialize camera, light
  camera = new PerspectiveCamera();
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  var dLight = new DirectionalLight(0xffffff, 0.8);
  dLight.position.set(-800, 2000, 400);
  camera.add(dLight);

  var dLight1 = new DirectionalLight(0x7982f6, 1);
  dLight1.position.set(-200, 500, 200);
  camera.add(dLight1);

  var dLight2 = new PointLight(0x8566cc, 0.5);
  dLight2.position.set(-200, 500, 200);
  camera.add(dLight2);

  camera.position.z = 250;
  camera.position.x = 0;
  camera.position.y = 0;

  scene.add(camera);

  // Additional effects
  scene.fog = new Fog(0x535ef3, 400, 2000);

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
  if (window.innerWidth < 768) {
    controls.maxDistance = 500;
  } else {
    controls.maxDistance = 300;
  }
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 1;
  controls.autoRotate = false;

  // controls.minPolarAngle = Math.PI / 3.5;
  // controls.maxPolarAngle = Math.PI - Math.PI / 3;
  controls.minPolarAngle = 0; // Allow looking straight up
  controls.maxPolarAngle = Math.PI; // Allow looking straight down

  window.addEventListener("resize", onWindowResize, false);
  document.addEventListener("mousemove", onMouseMove);
  renderer.domElement.addEventListener('touchmove', onTouchMove, false);
  renderer.domElement.addEventListener('touchstart', onTouchStart, false);
}


// SECTION Initializing the globe

// SECTION Globe
function initGlobe() {
  // Initialize the Globe
  Globe = new ThreeGlobe({
    waitForGlobeReady: true,
    animateIn: true,
  })
    .hexPolygonsData(countries.features)
    .hexPolygonResolution(4)
    .hexPolygonMargin(0.7)
    .showAtmosphere(true)
    .atmosphereColor("#3a228a")
    .atmosphereAltitude(0.25)
    .hexPolygonColor(() => {
      return "rgba(255,255,255, 1)";
    });

  setTimeout(() => {
    Globe.arcsData(travelHistory.flights)
      .arcColor((e: any) => {
        return e.status ? "#9cff00" : "#FF4000";
      })
      .arcAltitude((e: any) => {
        return e.arcAlt;
      })
      .arcStroke((e: any) => {
        return e.status ? 0.3 : 0.1;
      })
      .arcDashLength(0.9)
      .arcDashGap(4)
      .arcDashAnimateTime(1000)
      .arcsTransitionDuration(1000)
      .arcDashInitialGap((e: any) => e.order * 1)
      .labelsData(regionMarkers)
      .labelColor(() => "#f8f8f8")
      .labelDotOrientation('right')
      .labelDotRadius(0.3)
      .labelSize((e: any) => e.size)
      .labelResolution(6)
      .labelAltitude(0)
      .pointsData(regionMarkers)
      .pointColor(() => "#ffffff")
      .pointsMerge(true)
      .pointAltitude(0.015)
      .pointRadius(0.05);
  }, 1000);

  Globe.rotateY(-Math.PI * (4.2 / 9));
  const globeMaterial = Globe.globeMaterial();
  globeMaterial.color = new Color(0x3a228a);
  globeMaterial.emissive = new Color(0x220038);
  globeMaterial.emissiveIntensity = 0.5;
  globeMaterial.shininess = 0.7;

  // Add invisible collision spheres for region markers (hover detection)
  regionMarkers.forEach(marker => {
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
  });

  // Create city dots and collision spheres (initially hidden, shown when zoomed in)
  cityMarkers.forEach(city => {
    // Visible city dot - flat circle on the globe surface
    const dotMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 32),
      dotMaterial
    );
    const position = Globe.getCoords(city.lat, city.lng, 0.005); // Very slight altitude to avoid z-fighting
    dot.position.set(position.x, position.y, position.z);
    // Orient the circle to face outward from the globe center
    dot.lookAt(0, 0, 0);
    dot.rotateX(Math.PI); // Flip to face outward
    dot.visible = false; // Hidden by default
    dot.userData = { isCity: true, ...city };
    Globe.add(dot);
    cityDots.push(dot);

    // Invisible collision sphere for city (larger for easier hover)
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
    });
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 16, 16),
      sphereMaterial
    );
    sphere.position.set(position.x, position.y, position.z);
    sphere.visible = false; // Hidden by default
    // Attach parent region data so hovering shows region tooltip
    sphere.userData = city.parentRegion;
    Globe.add(sphere);
    citySpheres.push(sphere);
  });

  scene.add(Globe);
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

  const globe = Globe;
  const intersects = raycaster.intersectObjects(globe.children, true);

  if (intersects.length > 0) {
    const object = intersects[0].object;
    const placeData = object.userData;

    // Check for region data (has 'region' property) or legacy city data (has 'text')
    if (placeData && (placeData.region || placeData.text)) {
      renderer.domElement.style.cursor = 'pointer';
      displayPlaceInformation(event, placeData);
    } else {
      renderer.domElement.style.cursor = 'default';
      removePlaceInformation();
    }
  }
}

function onMouseMove(event) {
  mouseX = event.clientX - windowHalfX;
  mouseY = event.clientY - windowHalfY;
  checkIntersection(event);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  windowHalfX = window.innerWidth / 1.5;
  windowHalfY = window.innerHeight / 1.5;
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  camera.lookAt(scene.position);
  controls.update();

  // Check zoom level and toggle city dots visibility
  const distance = camera.position.length();
  const shouldShowCities = distance < ZOOM_THRESHOLD;

  if (shouldShowCities !== isZoomedIn) {
    isZoomedIn = shouldShowCities;
    // Toggle visibility of city dots and collision spheres
    cityDots.forEach(dot => { dot.visible = shouldShowCities; });
    citySpheres.forEach(sphere => { sphere.visible = shouldShowCities; });
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function onTouchStart(event) {
  if (event.touches.length == 1) {
    checkIntersection(event);
  }
}

function onTouchMove(event) {
  event.preventDefault();

  if (event.touches.length == 1) {
    checkIntersection(event);
  }
}

function displayPlaceInformation(event: MouseEvent | TouchEvent, placeData: any) {
  const tooltip = document.getElementById("tooltip");
  if (!tooltip) return;

  // Check if this is region data (new format) or legacy city data
  if (placeData.cities && placeData.visits) {
    // Region-based data - show state/region with cities list
    const citiesList = placeData.cities.join(', ');
    const visitCount = placeData.visits.length;

    // Build visits detail HTML - show full descriptions
    let visitsHtml = '';
    if (visitCount > 1) {
      visitsHtml = placeData.visits.map((v: any) =>
        `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.2);">
          <strong>${v.city}</strong>: <span style="font-size: 0.8rem;">${v.desc}</span>
        </div>`
      ).join('');
    } else {
      visitsHtml = `<p class="card-text" style="font-size: 0.8rem; margin-top: 8px;">${placeData.visits[0].desc}</p>`;
    }

    tooltip.innerHTML = `
      <div style="max-width: 350px; max-height: 400px; overflow-y: auto;">
        <h5 class="card-title" style="font-size: 1.1rem; margin-bottom: 4px;">${placeData.region}</h5>
        <p style="font-size: 0.75rem; color: #9cff00; margin-bottom: 8px;">${placeData.country} · ${visitCount} ${visitCount === 1 ? 'place' : 'places'}</p>
        <p style="font-size: 0.85rem; color: #ccc; margin-bottom: 8px;">${citiesList}</p>
        ${visitsHtml}
      </div>
    `;
  } else {
    // Legacy city data format
    tooltip.innerHTML = `
      <h5 class="card-title" style="font-size: 1rem">${placeData.city || placeData.text}</h5>
      <p class="card-text" style="font-size: 0.8rem">${placeData.desc}</p>
    `;
  }

  if ('touches' in event && event.touches.length > 0) {
    tooltip.style.left = `${event.touches[0].clientX + 10}px`;
    tooltip.style.top = `${event.touches[0].clientY + 10}px`;
  } else if ('clientX' in event) {
    tooltip.style.left = `${event.clientX + 10}px`;
    tooltip.style.top = `${event.clientY + 10}px`;
  }

  tooltip.style.display = 'block';

  setTimeout(() => {
    tooltip.style.display = 'none';
  }, 60 * 1000);
}

function removePlaceInformation() {
  const tooltip = document.getElementById("tooltip");
  if (tooltip) {
    tooltip.style.display = 'none';
  }
}