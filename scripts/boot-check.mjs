/**
 * Boots the real bundle under a minimal DOM/WebGL stub. It will not render,
 * but every module-level initialisation runs — which is exactly where the
 * TDZ errors were hiding, and they are invisible to tsc.
 */
import { readFileSync } from "node:fs";

const noop = () => {};
const el = () => ({
  style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop },
  appendChild: noop, addEventListener: noop, removeEventListener: noop,
  setAttribute: noop, getAttribute: () => null, getContext: () => null,
  querySelector: () => null, innerHTML: "", textContent: "",
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1512, height: 800 }),
});
globalThis.window = {
  innerWidth: 390, innerHeight: 844, devicePixelRatio: 3,
  addEventListener: noop, removeEventListener: noop,
  requestAnimationFrame: () => 0, setTimeout: noop, clearTimeout: noop,
};
globalThis.document = {
  createElement: el, createElementNS: el, getElementById: () => el(),
  querySelector: () => null, addEventListener: noop, body: el(),
  documentElement: el(),
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.self = globalThis.window;

let threw = null;
try {
  const src = readFileSync("dist/main.js", "utf8");
  new Function(src)();
} catch (e) {
  threw = e;
}
const msg = threw ? String(threw.message) : "";
if (/before initialization|is not defined/i.test(msg)) {
  console.log("FAIL — initialisation error still present:\n  " + msg);
  process.exit(1);
}
console.log("PASS — no TDZ / undefined-reference error at module load");
console.log(threw ? `  (stopped later at a WebGL stub as expected: ${msg.slice(0, 80)})` : "  (ran to completion)");
