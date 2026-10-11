/* The guide banner's coins, live: the same three coins as art/arena-coins.png (app/art-src/arena-coins.html),
   now floating in place, leaning toward the cursor and flipping when clicked, with a few motes of light
   drifting past. The PNG shows until the first frame is drawn, and stays for good with reduced motion,
   without WebGL, or if three.js can't load. */
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const img = document.querySelector(".gd-banner .gd-art");
const banner = img && img.closest(".gd-banner");
const ASPECT = 900 / 1400;
const MAX_DPR = 2;
const SPIN_MS = 1600;
const MOTES = 70;

if (banner && !matchMedia("(prefers-reduced-motion: reduce)").matches) start();

function start() {
  const canvas = document.createElement("canvas");
  canvas.className = "gd-art gd-live";
  canvas.setAttribute("aria-hidden", "true");
  canvas.hidden = true;
  let renderer;
  try {
    // preserveDrawingBuffer: the first frame is drawn while the canvas is still hidden, and must survive being shown.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch (e) {
    return; // No WebGL: the PNG stays.
  }
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  img.after(canvas);

  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.03).texture;
  const camera = new THREE.PerspectiveCamera(30, 1 / ASPECT, 0.1, 100);
  camera.position.set(0, 0, 13);

  const rig = new THREE.Group();
  scene.add(rig);
  const coins = placeCoins(rig);
  const motes = addMotes(scene);
  const front = addLights(scene);

  // Size: the canvas takes the PNG's place, so it measures whichever of the two is showing.
  function fit() {
    const w = (canvas.hidden ? img : canvas).getBoundingClientRect().width;
    const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
    // Resizing clears the canvas, so only when the size really changed.
    if (!w || (Math.round(w * dpr) === canvas.width && renderer.getPixelRatio() === dpr)) return;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, w * ASPECT, false);
  }
  fit();
  new ResizeObserver(fit).observe(banner);

  // The cursor: the coins lean toward it, and the one under it grows a touch and flips on click.
  const lean = { x: 0, y: 0, tx: 0, ty: 0 };
  const ray = new THREE.Raycaster();
  let hovered = null;
  banner.addEventListener("pointermove", (e) => {
    const r = banner.getBoundingClientRect();
    lean.tx = clamp(((e.clientX - r.left) / r.width) * 2 - 1);
    lean.ty = clamp(((e.clientY - r.top) / r.height) * 2 - 1);
    hovered = coinAt(e);
    canvas.style.cursor = hovered ? "pointer" : "";
  });
  banner.addEventListener("pointerleave", () => { lean.tx = lean.ty = 0; hovered = null; });
  canvas.addEventListener("click", (e) => { const c = coinAt(e); if (c) spin(c, 0); });

  function coinAt(e) {
    const r = canvas.getBoundingClientRect();
    if (canvas.hidden || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null;
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(coins.map((c) => c.group), true)[0];
    return hit ? coins.find((c) => c.group === hit.object.parent) : null;
  }
  function spin(c, delay) { c.spinFrom = performance.now() + delay; }

  // Each coin starts in its PNG pose and turns once, one after another, as it comes alive.
  let born = 0;
  function frame(now) {
    const t = now / 1000;
    if (!born) { born = now; coins.forEach((c, i) => spin(c, 250 + i * 160)); }
    const ramp = Math.min(1, (now - born) / 1200); // eases the float in from the still pose
    lean.x += (lean.tx - lean.x) * 0.06;
    lean.y += (lean.ty - lean.y) * 0.06;
    rig.rotation.y = lean.x * 0.22;
    rig.rotation.x = lean.y * 0.14;
    coins.forEach((c) => {
      const k = c.phase;
      const s = c.spinFrom ? easeOut(clamp01((now - c.spinFrom) / SPIN_MS)) : 0;
      c.group.position.set(c.p[0] + Math.sin(t * 0.6 + k) * 0.06 * ramp, c.p[1] + Math.sin(t * 0.9 + k) * 0.14 * ramp, c.p[2]);
      c.group.rotation.set(c.r[0] + Math.cos(t * 0.45 + k) * 0.08 * ramp, c.r[1] + Math.sin(t * 0.5 + k) * 0.2 * ramp + s * Math.PI * 2, c.r[2]);
      const target = c.s * (hovered === c ? 1.07 : 1);
      c.group.scale.setScalar(c.group.scale.x + (target - c.group.scale.x) * 0.12);
    });
    front.position.x = -1.5 + Math.sin(t * 0.35) * 3.2; // a sheen that slides across the faces
    driftMotes(motes, t);
    renderer.render(scene, camera);
    if (canvas.hidden) { canvas.hidden = false; img.hidden = true; fit(); }
  }

  // Only draw while the banner is on screen and the tab is showing.
  let onScreen = true;
  const run = () => renderer.setAnimationLoop(onScreen && !document.hidden ? frame : null);
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; run(); }).observe(banner);
  document.addEventListener("visibilitychange", run);
  run();
}

// The coins, built and placed exactly as in app/art-src/arena-coins.html.
function placeCoins(rig) {
  const R = 1.6, T = 0.34;
  const prof = [
    [0, T * 0.36], [R * 0.80, T * 0.36], [R * 0.84, T * 0.5], [R * 0.95, T * 0.5], [R, T * 0.38],
    [R, -T * 0.38], [R * 0.95, -T * 0.5], [R * 0.84, -T * 0.5], [R * 0.80, -T * 0.36], [0, -T * 0.36],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const body = new THREE.LatheGeometry(prof, 160);
  body.rotateX(Math.PI / 2);
  const disc = new THREE.CircleGeometry(R * 0.8, 128);
  const metal = new THREE.MeshPhysicalMaterial({ color: 0x77738a, metalness: 0.95, roughness: 0.3, envMapIntensity: 1.3, clearcoat: 0.7, clearcoatRoughness: 0.2 });
  const face = new THREE.MeshPhysicalMaterial({ color: 0x3c3a4a, metalness: 0.85, roughness: 0.5, envMapIntensity: 0.9, bumpMap: markTexture(), bumpScale: 4, clearcoat: 0.45, clearcoatRoughness: 0.35 });
  return [
    { p: [-2.6, 1.05, 0], r: [0.25, 0.55, -0.2], s: 1.0, phase: 0 },
    { p: [2.75, 1.75, -1.2], r: [0.15, -0.55, 0.25], s: 0.92, phase: 2.1 },
    { p: [1.15, -1.95, 0.6], r: [0.45, -0.25, 0.12], s: 0.98, phase: 4.2 },
  ].map((c) => {
    const group = new THREE.Group();
    const front = new THREE.Mesh(disc, face);
    front.position.z = T * 0.36 + 0.001;
    const back = new THREE.Mesh(disc, face);
    back.rotation.y = Math.PI;
    back.position.z = -T * 0.36 - 0.001;
    group.add(new THREE.Mesh(body, metal), front, back);
    group.position.set(...c.p);
    group.rotation.set(...c.r);
    group.scale.setScalar(c.s);
    rig.add(group);
    return { ...c, group, spinFrom: 0 };
  });
}

// Arena's lock with a check, as a bump map for the face, with an engraved ring inside the rim.
function markTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 1024;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, 1024, 1024);
  g.save();
  g.translate(512, 512); g.scale(26, 26); g.translate(-12, -12.6);
  g.filter = "blur(3px)";
  g.strokeStyle = "#fff"; g.lineWidth = 2.1; g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath(); g.roundRect(4.5, 10, 15, 10.5, 2.2); g.stroke();
  g.beginPath(); g.moveTo(8, 10); g.lineTo(8, 7.6); g.arc(12, 7.6, 4, Math.PI, 0); g.lineTo(16, 10); g.stroke();
  g.beginPath(); g.moveTo(9.3, 15.3); g.lineTo(11.2, 17.2); g.lineTo(14.8, 13.6); g.stroke();
  g.restore();
  g.strokeStyle = "#7a7a7a"; g.lineWidth = 6;
  g.beginPath(); g.arc(512, 512, 470, 0, Math.PI * 2); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}

// The art's lights; the soft front light is returned so it can slide.
function addLights(scene) {
  const key = new THREE.DirectionalLight(0xe9e6ff, 2.4); key.position.set(-5, 6, 8);
  const rim = new THREE.DirectionalLight(0x8b6cff, 5.5); rim.position.set(6, 2, -6);
  const rim2 = new THREE.DirectionalLight(0x6f5cff, 2.2); rim2.position.set(-6, -3, -4);
  const front = new THREE.PointLight(0xc9c2ff, 60, 30, 1.6); front.position.set(-1.5, 4.5, 7);
  scene.add(key, rim, rim2, front, new THREE.AmbientLight(0x1a1630, 0.6));
  return front;
}

// Motes: small violet and green lights rising slowly through the coins.
function addMotes(scene) {
  const pos = new Float32Array(MOTES * 3), col = new Float32Array(MOTES * 3), seed = [];
  const violet = new THREE.Color(0xb3a2ff), green = new THREE.Color(0x3ddc97);
  for (let i = 0; i < MOTES; i++) {
    seed.push({ x: (Math.random() - 0.5) * 11, y: Math.random() * 7, z: (Math.random() - 0.5) * 4 - 0.5, v: 0.12 + Math.random() * 0.2, w: Math.random() * 6 });
    (Math.random() < 0.2 ? green : violet).toArray(col, i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const dot = document.createElement("canvas");
  dot.width = dot.height = 64;
  const g = dot.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(0.35, "rgba(255,255,255,.35)"); grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const mat = new THREE.PointsMaterial({ size: 0.16, map: new THREE.CanvasTexture(dot), vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  return { pts, pos, seed };
}

function driftMotes({ pts, pos, seed }, t) {
  seed.forEach((m, i) => {
    pos[i * 3] = m.x + Math.sin(t * 0.4 + m.w) * 0.25;
    pos[i * 3 + 1] = ((m.y + t * m.v) % 7) - 3.5;
    pos[i * 3 + 2] = m.z;
  });
  pts.geometry.attributes.position.needsUpdate = true;
}

function clamp(v) { return Math.max(-1, Math.min(1, v)); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function easeOut(x) { return 1 - Math.pow(1 - x, 3); }
