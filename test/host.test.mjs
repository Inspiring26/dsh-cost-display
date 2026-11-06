import assert from "node:assert/strict";
import { beijingParts, isPeakBeijing } from "../src/cost-core.js";
import { apply, inject } from "../index.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const today = beijingParts(Date.now()).date;
// Beijing midnight expressed as an epoch millisecond.
const dayStart = Date.parse(today + "T00:00:00Z") - 8 * HOUR;
const tenAmToday = dayStart + 10 * HOUR;
const eightAmToday = dayStart + 8 * HOUR;
const lastMonth = dayStart - 40 * DAY + 10 * HOUR;
// 10:00 / 08:00 Beijing on the current weekday or weekend/holiday; the test
// computes the expected price instead of assuming a workday.
const expectedToday =
  (isPeakBeijing(tenAmToday) ? 2 : 1) + (isPeakBeijing(eightAmToday) ? 2 : 1);

function eventsFor(times) {
  const first = times[0];
  return [
    {
      time: first,
      type: "request/context",
      data: { provider: "deepseek-official", model: "deepseek-flash" },
    },
    ...times.flatMap((time, index) => [
      { time, type: "step/start", data: { turn: index + 1, step: 1 } },
      {
        time: time + 1000,
        type: "assistant/message",
        data: { turn: index + 1, step: 1, usage: { inputTokens: 1_000_000 } },
      },
    ]),
  ];
}

const sessions = [
  { header: { id: "session-a" }, events: eventsFor([tenAmToday, eightAmToday]) },
  { header: { id: "session-b" }, events: eventsFor([lastMonth]) },
  { header: { id: "session-broken" }, fail: true },
];

const query = {
  async listSessions() {
    return sessions.map((session) => ({ header: session.header }));
  },
  async readSession(id) {
    const session = sessions.find((candidate) => candidate.header.id === id);
    if (session.fail === true) throw new Error("corrupt session");
    return { events: session.events };
  },
};

let route;
const ctx = {
  logger: { warn() {} },
  get(name) {
    return name === "sessionQuery" ? query : undefined;
  },
  connection: {
    fetch: {
      register(value) {
        route = value;
      },
    },
  },
};

assert.deepEqual(inject, ["connection"]);
apply(ctx);
assert.equal(route.path, "/api/cost.summary");
assert.deepEqual(route.methods, ["GET"]);

const response = await route.fetch(new Request("http://127.0.0.1:3080/api/cost.summary"));
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type") ?? "", /application\/json/);
const summary = await response.json();
assert.equal(summary.today.cost, expectedToday, "the two calls made today");
assert.equal(summary.today.calls, 2);
assert.equal(summary.month.cost, expectedToday, "last month's call must not enter this month's total");
assert.equal(summary.month.calls, 2);
assert.equal(summary.sessions, 2);
assert.equal(summary.failed, 1, "the unreadable session is counted, not silently dropped");
assert.equal(summary.partial, true, "a skipped session makes the total a lower bound");
assert.equal(typeof summary.asOf, "number");

console.log("host tests passed");
