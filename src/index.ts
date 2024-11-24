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
import airportHistory from "./files/my-visits.json";
import travelHistory from "./files/my-flights.json";
var renderer, camera, scene, controls;
let mouseX = 0;
let mouseY = 0;
let windowHalfX = window.innerWidth / 2;
let windowHalfY = window.innerHeight / 2;
var Globe;

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
      // if (
      //   ["BBI", "BLR", "HYD", "CHD"].includes(
      //     e.properties.ISO_A3
      //   )
      // ) {
      return "rgba(255,255,255, 1)";
      // } else return "rgba(255,255,255, 0.7)";
    });


  setTimeout(() => {
    Globe.pointsData(airportHistory.locations)
      .pointAltitude(0.02)
      .pointColor('white');

  }, 4000);


  setTimeout(() => {
    Globe.arcsData(travelHistory.flights)
      .arcColor((e) => {
        return e.status ? "#9cff00" : "#FF4000";
      })
      .arcAltitude((e) => {
        return e.arcAlt;
      })
      .arcStroke((e) => {
        return e.status ? 0.3 : 0.1;
      })
      .arcDashLength(0.9)
      .arcDashGap(4)
      .arcDashAnimateTime(1000)
      .arcsTransitionDuration(1000)
      .arcDashInitialGap((e) => e.order * 1)
      .labelsData(airportHistory.locations)
      .labelColor(() => "#f8f8f8")
      .labelDotOrientation('right')
      .labelDotRadius(0.3)
      .labelSize((e) => e.size)
      // .labelText("text")
      .labelResolution(6)
      .labelAltitude(0)
      .pointsData(airportHistory.locations)
      .pointColor(() => "#ffffff")
      .pointsMerge(true)
      .pointAltitude(0.07)
      .pointRadius(0.05);
  }, 1000);


  Globe.rotateY(-Math.PI * (4.2 / 9));
  // Globe.rotateZ(-Math.PI / 6);
  const globeMaterial = Globe.globeMaterial();
  globeMaterial.color = new Color(0x3a228a);
  globeMaterial.emissive = new Color(0x220038);
  globeMaterial.emissiveIntensity = 0.5;
  globeMaterial.shininess = 0.7;
  // globeMaterial.wireframe = true;


  airportHistory.locations.forEach(location => {
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
    });
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 32),
      sphereMaterial
    );
    const position = Globe.getCoords(location.lat, location.lng);
    sphere.position.set(position.x, position.y, position.z);
    sphere.userData = location;
    Globe.add(sphere);
  });

  scene.add(Globe);

}

function checkIntersection(event) {
  event.preventDefault();
  const mouse = new THREE.Vector2();
  if (event.touches && event.touches.length > 0) {
    mouse.x = (event.touches[0].clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.touches[0].clientY / window.innerHeight) * 2 + 1;
  } else {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  }

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);

  // Assuming the ThreeGlobe instance is named 'Globe'
  const globe = Globe;

  // Raycast against the Globe instance
  const intersects = raycaster.intersectObjects(globe.children, true);

  if (intersects.length > 0) {
    const object = intersects[0].object;
    const placeData = object.userData;

    if (placeData && placeData.text) {
      console.log(placeData);
      renderer.domElement.style.cursor = 'pointer';
      displayPlaceInformation(event, placeData);
    }
    else {

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
  // camera.position.x +=
  //   (mouseX / 2 - camera.position.x) * 0.005

  // camera.position.y += (-mouseY / 2 - camera.position.y) * 0.005;
  camera.lookAt(scene.position);
  controls.update();
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

function displayPlaceInformation(event, placeData) {
  let tooltip = document.getElementById("tooltip");
  tooltip.innerHTML = `
    <h5 class="card-title" style="font-size: 1rem"c>${placeData.city}</h5>
    <p class="card-text" style="font-size: 0.8rem">${placeData.desc}</p>
  `;
  if (event.touches && event.touches.length > 0) {
    tooltip.style.left = `${event.touches[0].clientX + 10}px`;
    tooltip.style.top = `${event.touches[0].clientY + 10}px`;
  } else {
    tooltip.style.left = `${event.clientX + 10}px`;
    tooltip.style.top = `${event.clientY + 10}px`;
  }

  tooltip.style.display = 'block';

  setTimeout(() => {
    tooltip.style.display = 'none';
  }
    , 60 * 1000);
}

function removePlaceInformation() {
  let tooltip = document.getElementById("tooltip");
  tooltip.style.display = 'none';
}