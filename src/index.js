import ThreeGlobe from "three-globe";
import { WebGLRenderer, Scene } from "three";
import { PerspectiveCamera, AmbientLight, DirectionalLight, Color, Fog, 
// AxesHelper,
// DirectionalLightHelper,
// CameraHelper,
PointLight, } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import countries from "./files/globe-data-min.json";
import airportHistory from "./files/my-visits.json";
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
    // renderer.outputEncoding = THREE.sRGBEncoding;
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
    camera.position.z = 400;
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
    controls.minDistance = 200;
    controls.maxDistance = 500;
    controls.rotateSpeed = 0.8;
    controls.zoomSpeed = 1;
    controls.autoRotate = false;
    controls.minPolarAngle = Math.PI / 3.5;
    controls.maxPolarAngle = Math.PI - Math.PI / 3;
    window.addEventListener("resize", onWindowResize, false);
    document.addEventListener("mousemove", onMouseMove);
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
    Globe
        .labelsData(airportHistory.locations)
        .labelColor(() => "#ffcb21")
        .labelDotOrientation('right')
        .labelDotRadius(0.3)
        .labelSize((e) => e.size)
        // .labelText("text")
        .labelResolution(6)
        .labelAltitude(0.01)
        .pointsData(airportHistory.locations)
        .pointColor(() => "#ffffff")
        .pointsMerge(true)
        .pointAltitude(0.07)
        .pointRadius(0.05);
    Globe.rotateY(-Math.PI * (4.2 / 9));
    Globe.rotateZ(-Math.PI / 6);
    const globeMaterial = Globe.globeMaterial();
    globeMaterial.color = new Color(0x3a228a);
    globeMaterial.emissive = new Color(0x220038);
    globeMaterial.emissiveIntensity = 0.5;
    globeMaterial.shininess = 0.7;
    scene.add(Globe);
}
function onMouseMove(event) {
    mouseX = event.clientX - windowHalfX;
    mouseY = event.clientY - windowHalfY;
    // console.log("x: " + mouseX + " y: " + mouseY);
}
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    windowHalfX = window.innerWidth / 1.5;
    windowHalfY = window.innerHeight / 1.5;
    renderer.setSize(window.innerWidth, window.innerHeight);
}
function animate() {
    camera.position.x +=
        Math.abs(mouseX) <= windowHalfX / 2
            ? (mouseX / 2 - camera.position.x) * 0.005
            : 0;
    camera.position.y += (-mouseY / 2 - camera.position.y) * 0.005;
    camera.lookAt(scene.position);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}
