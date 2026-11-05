import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));
const localRequire = createRequire(resolve(here, "../package.json"));
const React = localRequire("react");
const { renderToStaticMarkup } = localRequire("react-dom/server");
const { zipSync, strToU8 } = localRequire("fflate");

const at = (iso) => Date.parse(iso);
const lines = [
  JSON.stringify({ type: "session", version: 4, id: "session-test" }),
  JSON.stringify({ seq: 0, time: at("2026-11-04T01:59:00Z"), type: "request/context", data: { provider: "deepseek-official", model: "deepseek-flash" } }),
  JSON.stringify({ seq: 1, time: at("2026-11-04T02:00:00Z"), type: "step/start", data: { turn: 1, step: 1 } }),
  JSON.stringify({ seq: 2, time: at("2026-11-04T02:00:01Z"), type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000 } } }),
  JSON.stringify({ seq: 3, time: at("2026-11-04T14:00:00Z"), type: "step/start", data: { turn: 2, step: 1 } }),
  JSON.stringify({ seq: 4, time: at("2026-11-04T14:00:01Z"), type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 1_000_000 } } }),
];
const zip = zipSync({ "session.v4.jsonl": strToU8(lines.join("\n")) });
let fetchUrl = "";
globalThis.fetch = async (url) => {
  fetchUrl = String(url);
  return new Response(zip, { status: 200 });
};

const styleTags = [];
globalThis.document = {
  baseURI: "http://127.0.0.1:3080/",
  head: { appendChild: (tag) => styleTags.push(tag) },
  body: {},
  createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
  addEventListener() {},
  removeEventListener() {},
};
const captured = [];
globalThis.__DSH_COST_TEST__ = true;
globalThis.window = {
  innerWidth: 1200,
  innerHeight: 800,
  requestAnimationFrame: (fn) => {
    fn();
    return 1;
  },
  cancelAnimationFrame() {},
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load: (spec) => captured.push(spec) },
};

new Function("window", readFileSync(resolve(here, "../client.js"), "utf8"))(globalThis.window);
assert.equal(captured.length, 1);
const module = captured[0].factory((id) => {
  if (id === "react") return React;
  if (id === "react-dom") return { createPortal: (node) => node };
  throw new Error(`unexpected require ${id}`);
});

const t = (key, params) => {
  if (params === undefined) return key;
  if (key === "message.turnUsage.count") return `${params.count} tok`;
  if (key === "message.turnUsage.consumed") return `用量 ${params.total}`;
  if (key === "stats.cacheHit") return `缓存命中 ${params.percent}%`;
  if (key === "number.million") return `${params.value}M`;
  if (key === "number.thousand") return `${params.value}K`;
  return `${key} ${JSON.stringify(params)}`;
};
const tCost = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`);

const originalTurn = () => null;
const originalUsage = () => null;
const slotEntries = {
  "conversation.chat.node": [{ options: { key: "turn-tail", locale: "chat" }, component: originalTurn, children: {} }],
  "conversation.composer.dock": [{ options: { id: "usage", order: 1 }, component: originalUsage }],
};
const ctx = {
  effect(fn) {
    return fn();
  },
  locale: {
    register: () => () => {},
    bind: () => tCost,
  },
  slots: {
    entries(key) {
      return slotEntries[key] ?? [];
    },
    register() {
      throw new Error("cost-display must override an existing entry, not add one");
    },
  },
};
module.apply(ctx);

assert.equal(styleTags.length, 1);
assert.equal(styleTags[0].dataset.plugin, pkg.name);
const turnEntry = slotEntries["conversation.chat.node"][0];
const usageEntry = slotEntries["conversation.composer.dock"][0];
assert.notEqual(turnEntry.component, originalTurn, "turn-tail component should be overridden");
assert.notEqual(usageEntry.component, originalUsage, "usage pill component should be overridden");
assert.equal(turnEntry.options.key, "turn-tail");
assert.equal(usageEntry.options.id, "usage");

module.__test.request("session-test", { force: true });
for (let attempt = 0; attempt < 200; attempt += 1) {
  if (module.__test.snapshot("session-test")?.status === "ready") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(module.__test.snapshot("session-test")?.status, "ready");
assert.match(fetchUrl, /api\/session\.export\?sessionId=session-test/);
assert.equal(module.__test.snapshot("session-test")?.data?.total?.cost, 3);

const tokenUsage = {
  totalTokens: 1_000_000,
  uncachedInputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  routes: [{ provider: "deepseek-official", model: "deepseek-flash" }],
};

// 1. The per-turn dialog component: original token rows + cost rows.
const turnUsageHtml = renderToStaticMarkup(React.createElement(module.__test.TurnUsagePanel, {
  usage: tokenUsage,
  turn: 1,
  time: at("2026-11-04T02:00:01Z"),
  sessionId: "session-test",
  t,
  tCost,
}));
assert.ok(turnUsageHtml.includes("用量"), turnUsageHtml);
assert.ok(turnUsageHtml.includes("¥2.00"), "turn usage label should append the cost");
assert.ok(turnUsageHtml.includes("Q51KRG_trigger"), "turn usage should keep the shipped trigger");

// 2. The replacement turn-tail renderer keeps copy, feedback, branch and usage.
const snapshot = {
  locations: { getTurn: () => ["n1"] },
  nodes: { get: () => ({ kind: "assistant-step", anchorSeq: 9, data: { blocks: [{ kind: "text", text: "hello" }] } }) },
  timeline: { turnOrder: [1] },
};
const useChat = (selector) => selector(snapshot);
const useAccess = () => true;
const renderSlot = (name) => (name === "conversation.chat.assistant-actions" ? React.createElement("span", { "data-feedback": true }, "FEEDBACK") : null);
const tailHtml = renderToStaticMarkup(React.createElement(turnEntry.component, {
  node: {
    location: { kind: "turn", turn: 1 },
    data: {
      turn: 1,
      seq: 10,
      tokenUsage,
      branchUnavailable: false,
      closing: {
        time: at("2026-11-04T02:00:01Z"),
        blocks: [{ kind: "text", text: "hello" }],
        finalNode: { seq: 10, messageId: "msg-1" },
      },
    },
  },
  openFile: () => {},
  forkAt: () => {},
  renderSlot,
  t,
  useAccess,
  useChat,
  sessionId: "session-test",
}));
assert.ok(tailHtml.includes("xzv4MW_actions"), "action row should render");
assert.ok(tailHtml.includes("data-feedback"), "feedback (like/dislike) slot should render");
assert.equal((tailHtml.match(/class="xzv4MW_action"/g) ?? []).length, 2, "copy and branch buttons should render");
assert.ok(tailHtml.includes("message.branch"), "branch button should render");
assert.ok(tailHtml.includes("Q51KRG_trigger"), "usage trigger should render");
assert.ok(tailHtml.includes("¥2.00"), "usage trigger should append the per-turn cost");
assert.ok(tailHtml.includes("TS9iAW_root"), "turn tail root should render");

// 3. The composer usage pill keeps its shipped style and appends the session cost.
const pillHtml = renderToStaticMarkup(React.createElement(usageEntry.component, {
  useProjection: () => tokenUsage,
  sessionId: "session-test",
  t,
}));
assert.ok(pillHtml.includes("bOPqQW_pill"), "session usage pill should keep the shipped class");
assert.ok(pillHtml.includes("¥3.00"), "session usage label should append the total cost");
assert.ok(pillHtml.includes("data-composer-stat=\"usage\""), "session usage should keep the shipped stat id");

// 4. The shared dialog renders both peak and off-peak cost rows.
const total = module.__test.snapshot("session-test").data.total;
const rows = [];
module.__test.appendCostRows(rows, total, tCost, false);
const dialogHtml = renderToStaticMarkup(React.createElement(module.__test.UsageDialog, {
  popover: { panelRef: { current: null }, pos: { left: "10px", top: "20px" } },
  icon: null,
  title: "usage",
  titleValue: "3",
  rows,
  detailsAttr: { "data-session-stats-usage": true },
  bucket: total,
  approximate: false,
  tCost,
}));
assert.ok(dialogHtml.includes("bRhRbq_panel"), "dialog should use the shipped panel class");
assert.ok(dialogHtml.includes("¥2.00"), "peak row should render");
assert.ok(dialogHtml.includes("¥1.00"), "off-peak row should render");
assert.ok(dialogHtml.includes("detail.peak"));
assert.ok(dialogHtml.includes("detail.offPeak"));
assert.ok(dialogHtml.includes("detail.cost"));
assert.ok(dialogHtml.includes("dsh-cost-note"));

console.log("client tests passed");
