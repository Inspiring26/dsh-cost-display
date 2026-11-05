import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));
const captured = [];
globalThis.__DSH_COST_TEST__ = true;
globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
new Function("window", readFileSync(resolve(here, "../client.js"), "utf8"))(globalThis.window);
assert.equal(captured.length, 1, "expected one client module");
const spec = captured[0];
assert.equal(spec.id, pkg.name);

const react = new Proxy({
  createElement: (type, props) => ({ type, props }),
  Fragment: Symbol("Fragment"),
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
}, {
  get(target, property) {
    if (property in target) return target[property];
    return () => {};
  },
});
const reactDom = { createPortal: (node) => node };
const module = spec.factory((id) => {
  if (id === "react") return react;
  if (id === "react-dom") return reactDom;
  throw new Error(`unexpected require ${id}`);
});
assert.deepEqual(module.inject, ["slots", "locale"]);
assert.equal(typeof module.apply, "function");
assert.equal(typeof module.__test.request, "function");
console.log("plugin client factory loaded; exports:", Object.keys(module).join(", "));
