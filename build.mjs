#!/usr/bin/env node
/**
 * Inline src/cost-core.js and src/chat-bridge.js into src/client.js and emit
 * the self-contained browser artifact at the package root (`./client`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(here, path), "utf8");
const core = read("src/cost-core.js").replace(/^export /gm, "").trim();
const bridge = read("src/chat-bridge.js").trim();
const template = read("src/client.js");

for (const marker of ["/*__COST_CORE__*/", "/*__CHAT_BRIDGE__*/"]) {
  if (!template.includes(marker)) throw new Error(`src/client.js is missing ${marker}`);
}
const output = template.replace("/*__COST_CORE__*/", core).replace("/*__CHAT_BRIDGE__*/", bridge);
writeFileSync(resolve(here, "client.js"), output);
console.log(`built client.js (${output.length} chars)`);
