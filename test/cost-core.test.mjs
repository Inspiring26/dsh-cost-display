import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  DEFAULT_HOLIDAYS,
  computeSessionCost,
  estimateTurnCost,
  formatCny,
  isPeakBeijing,
  matchOfficialModel,
  parseZipRootLog,
  priceUsage,
  readRootLogFromExportResponse,
} from "../src/cost-core.js";

const at = (iso) => Date.parse(iso);

/* ------------------------------------------------------------------ *
 * 峰谷与节假日
 * ------------------------------------------------------------------ */

assert.equal(isPeakBeijing(at("2026-11-04T02:00:00Z")), true, "周三 10:00 北京应为高峰");
assert.equal(isPeakBeijing(at("2026-11-04T03:59:59Z")), true, "11:59 仍为高峰");
assert.equal(isPeakBeijing(at("2026-11-04T04:00:00Z")), false, "12:00 起为空闲");
assert.equal(isPeakBeijing(at("2026-11-04T05:00:00Z")), false, "13:00 午休为空闲");
assert.equal(isPeakBeijing(at("2026-11-04T06:00:00Z")), true, "14:00 起为高峰");
assert.equal(isPeakBeijing(at("2026-11-04T09:59:59Z")), true, "17:59 仍为高峰");
assert.equal(isPeakBeijing(at("2026-11-04T10:00:00Z")), false, "18:00 起为空闲");
assert.equal(isPeakBeijing(at("2026-11-07T02:00:00Z")), false, "周六 10:00 为空闲");
assert.equal(isPeakBeijing(at("2026-10-01T02:00:00Z")), false, "国庆节 10:00 为空闲");
assert.equal(isPeakBeijing(at("2026-10-01T02:00:00Z"), []), true, "空白节假日表时 10:00 为高峰");

assert.equal(isPeakBeijing.length, 1, "函数只要求一个必填参数");

/* ------------------------------------------------------------------ *
 * 价目匹配与单笔定价
 * ------------------------------------------------------------------ */

assert.equal(matchOfficialModel("deepseek-flash")?.id, "deepseek-flash");
assert.equal(matchOfficialModel("DeepSeek-V4.1-Flash")?.id, "deepseek-flash");
assert.equal(matchOfficialModel("deepseek-v4-pro")?.id, "deepseek-v4-pro");
assert.equal(matchOfficialModel("deepseek-chat"), null, "不做子串/相似名猜测");
assert.equal(matchOfficialModel(""), null);

const peakMiss = priceUsage({ inputTokens: 1_000_000 }, "deepseek-flash", at("2026-11-04T02:00:00Z"));
assert.equal(peakMiss.cost, 2);
const offMiss = priceUsage({ inputTokens: 1_000_000 }, "deepseek-flash", at("2026-11-04T05:00:00Z"));
assert.equal(offMiss.cost, 1);
const peakHit = priceUsage({ cacheReadTokens: 1_000_000 }, "deepseek-flash", at("2026-11-04T02:00:00Z"));
assert.equal(peakHit.cost, 0.04);
assert.equal(priceUsage({ outputTokens: 1_000_000 }, "deepseek-flash", at("2026-11-04T02:00:00Z")).cost, 8);
assert.equal(
  priceUsage({ inputTokens: 1, cacheReadTokens: 1, outputTokens: 1 }, "deepseek-chat", at("2026-11-04T02:00:00Z")).priced,
  false,
);

const fallback = estimateTurnCost({ inputTokens: 1_000_000 }, { model: "deepseek-flash" }, at("2026-11-04T05:00:00Z"));
assert.equal(fallback.cost, 1);
assert.equal(fallback.approximate, true);

assert.equal(formatCny(0), "¥0");
assert.equal(formatCny(0.00004), "<¥0.0001");
assert.equal(formatCny(0.01234), "¥0.0123");
assert.equal(formatCny(1.234), "¥1.23");
assert.equal(formatCny(123.456), "¥123.46");

/* ------------------------------------------------------------------ *
 * 会话日志折叠
 * ------------------------------------------------------------------ */

function event(seq, time, type, data) {
  return { seq, time: at(time), type, data };
}

const jsonl = [
  JSON.stringify({ type: "session", version: 4, id: "session-test", createdAt: 0, isSeeded: false }),
  JSON.stringify(event(0, "2026-11-04T01:59:00Z", "request/context", { provider: "deepseek-official", model: "deepseek-flash" })),
  // 继承前缀：必须跳过
  JSON.stringify(event(1, "2026-11-04T02:00:00Z", "step/start", { turn: 99, step: 1 })),
  JSON.stringify(event(2, "2026-11-04T02:00:01Z", "assistant/message", { turn: 99, step: 1, usage: { inputTokens: 9_000_000, outputTokens: 9_000_000 } })),
  JSON.stringify(event(3, "2026-11-04T02:00:02Z", "session/end-seed", { inherited: true })),
  // Turn 1：高峰未命中 1M（¥2）、空闲未命中 1M（¥1）、高峰命中 1M（¥0.04）、高峰输出 1M（¥8）
  JSON.stringify(event(4, "2026-11-04T02:00:00Z", "step/start", { turn: 1, step: 1 })),
  JSON.stringify(event(5, "2026-11-04T02:00:30Z", "assistant/message", { turn: 1, step: 1, usage: { inputTokens: 1_000_000 } })),
  JSON.stringify(event(6, "2026-11-04T05:00:00Z", "step/start", { turn: 1, step: 2 })),
  JSON.stringify(event(7, "2026-11-04T05:00:30Z", "assistant/message", { turn: 1, step: 2, usage: { inputTokens: 1_000_000 } })),
  JSON.stringify(event(8, "2026-11-04T02:10:00Z", "step/start", { turn: 1, step: 3 })),
  JSON.stringify(event(9, "2026-11-04T02:10:30Z", "assistant/message", { turn: 1, step: 3, usage: { cacheReadTokens: 1_000_000 } })),
  JSON.stringify(event(10, "2026-11-04T02:20:00Z", "step/start", { turn: 1, step: 4 })),
  JSON.stringify(event(11, "2026-11-04T02:20:30Z", "assistant/message", { turn: 1, step: 4, usage: { outputTokens: 1_000_000, reasoningTokens: 500_000 } })),
  // Turn 2：切换 pro，空闲 1M miss + 1M hit + 1M out = 4.5 + 0.15 + 13.5 = 18.15
  JSON.stringify(event(12, "2026-11-04T05:10:00Z", "request/context", { provider: "deepseek-official", model: "deepseek-v4-pro" })),
  JSON.stringify(event(13, "2026-11-04T05:10:00Z", "step/start", { turn: 2, step: 1 })),
  JSON.stringify(event(14, "2026-11-04T05:10:30Z", "assistant/message", {
    turn: 2,
    step: 1,
    usage: { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
  })),
  // 未定价模型：计入调用次数，但不假装免费
  JSON.stringify(event(15, "2026-11-04T05:20:00Z", "request/context", { provider: "other", model: "some-other-model" })),
  JSON.stringify(event(16, "2026-11-04T05:20:00Z", "step/start", { turn: 2, step: 2 })),
  JSON.stringify(event(17, "2026-11-04T05:20:30Z", "assistant/message", { turn: 2, step: 2, usage: { inputTokens: 1_000_000 } })),
  // 压缩摘要调用：独立计费，route 在事件上自带
  JSON.stringify(event(18, "2026-11-04T05:30:00Z", "compaction/start", { turn: 2, compactionId: "c1" })),
  JSON.stringify(event(19, "2026-11-04T05:30:01Z", "compaction/summary", {
    compactionId: "c1",
    provider: "deepseek-official",
    model: "deepseek-flash",
    usage: { inputTokens: 1_000_000 },
  })),
  JSON.stringify(event(20, "2026-11-04T05:30:02Z", "compaction/end", { turn: 2, compactionId: "c1" })),
  // 失败/重试 attempt：流里带 usage，也要计费
  JSON.stringify(event(21, "2026-11-04T05:40:00Z", "request/context", { provider: "deepseek-official", model: "deepseek-flash" })),
  JSON.stringify(event(22, "2026-11-04T05:40:00Z", "step/start", { turn: 3, step: 1 })),
  JSON.stringify(event(23, "2026-11-04T05:40:01Z", "assistant/attempt", {
    turn: 3,
    step: 1,
    stream: [{ type: "chunk", time: at("2026-11-04T05:40:01Z"), chunk: { type: "usage", usage: { inputTokens: 1_000_000 } } }],
  })),
].join("\n");

const result = computeSessionCost(jsonl);
assert.equal(result.calls, 8, "6 个 assistant/message + 1 个 compaction/summary + 1 个 attempt");
assert.equal(result.unpricedCalls, 1);
assert.equal(result.total.calls, 8);
assert.equal(result.total.pricedCalls, 7);
assert.equal(result.total.peakCalls, 3);
assert.equal(result.total.offPeakCalls, 4);
assert.equal(result.total.peakCost, 2 + 0.04 + 8);
assert.equal(result.total.offPeakCost, 1 + 18.15 + 1 + 1);
assert.equal(Math.round(result.total.cost * 1000) / 1000, Math.round((2 + 0.04 + 8 + 1 + 18.15 + 1 + 1) * 1000) / 1000);
assert.equal(result.byTurn["99"], undefined, "继承前缀必须被跳过");
assert.equal(result.byTurn["1"].calls, 4);
assert.equal(result.byTurn["1"].peakCost, 2 + 0.04 + 8);
assert.equal(result.byTurn["1"].offPeakCost, 1);
assert.equal(result.byTurn["2"].calls, 3, "Turn 2 含 pro 调用、未定价调用和摘要调用");
assert.equal(result.byTurn["2"].unpricedCalls, 1);
assert.equal(result.byTurn["2"].offPeakCost, 18.15 + 1);
assert.equal(result.byTurn["3"].calls, 1);
assert.equal(result.byTurn["3"].cost, 1);
assert.equal(result.models.find((entry) => entry.model === "deepseek-flash").calls, 6);
assert.equal(result.models.find((entry) => entry.model === "deepseek-v4-pro").calls, 1);
assert.equal(result.models.find((entry) => entry.model === "some-other-model").unpricedCalls, 1);
assert.equal(result.firstTime, at("2026-11-04T02:00:00Z"));
assert.equal(result.lastTime, at("2026-11-04T05:40:00Z"));

// 空日志与坏行不应抛错
assert.equal(computeSessionCost("").calls, 0);
assert.equal(computeSessionCost("not json\n{}\n").calls, 0);

/* ------------------------------------------------------------------ *
 * ZIP 提取（模拟 /api/session.export 的 data descriptor 形态）
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const compressed = new Uint8Array(deflateRawSync(raw));
    const crc = crc32(raw);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0808), ...u16(8), ...u16(0), ...u16(0),
      ...u32(0), ...u32(0), ...u32(0), ...u16(nameBytes.length), ...u16(0),
    ]);
    chunks.push(local, nameBytes, compressed);
    const descriptor = new Uint8Array([...u32(0x08074b50), ...u32(crc), ...u32(compressed.length), ...u32(raw.length)]);
    chunks.push(descriptor);
    central.push({ nameBytes, crc, compressedSize: compressed.length, size: raw.length, offset });
    offset += local.length + nameBytes.length + compressed.length + descriptor.length;
  }
  const centralStart = offset;
  let centralLength = 0;
  for (const entry of central) {
    const record = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0808), ...u16(8), ...u16(0), ...u16(0),
      ...u32(entry.crc), ...u32(entry.compressedSize), ...u32(entry.size),
      ...u16(entry.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(entry.offset), ...entry.nameBytes,
    ]);
    chunks.push(record);
    centralLength += record.length;
  }
  chunks.push(new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(centralLength), ...u32(centralStart), ...u16(0),
  ]));
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

const logText = jsonl + "\n";
const big = new Uint8Array(4 * 1024 * 1024);
for (let index = 0; index < big.length; index += 1) big[index] = (index * 2654435761) >>> 24;
const zip = makeZip([
  ["session.v4.jsonl", new TextEncoder().encode(logText)],
  ["media/big.bin", big],
]);

// 整包解析
assert.equal(await parseZipRootLog(zip), logText);

// 流式提取：只应拉取根日志附近的数据，不应把 4MB 附件全读完
let pulled = 0;
let pullOffset = 0;
const stream = new ReadableStream({
  pull(controller) {
    if (pullOffset >= zip.length) {
      controller.close();
      return;
    }
    const chunk = zip.subarray(pullOffset, Math.min(pullOffset + 64 * 1024, zip.length));
    pullOffset += chunk.byteLength;
    pulled += chunk.byteLength;
    controller.enqueue(chunk);
  },
});
const response = new Response(stream);
assert.equal(await readRootLogFromExportResponse(response), logText);
assert.ok(pulled < 512 * 1024, `应提前取消下载，实际拉取 ${pulled} 字节`);

// 压缩方式 0（直接存储）也应能读
function makeStoredZip(name, raw) {
  const nameBytes = new TextEncoder().encode(name);
  const crc = crc32(raw);
  const local = new Uint8Array([
    ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(raw.length), ...u32(raw.length), ...u16(nameBytes.length), ...u16(0),
  ]);
  const central = new Uint8Array([
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(raw.length), ...u32(raw.length),
    ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(0), ...nameBytes,
  ]);
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1),
    ...u32(central.length), ...u32(local.length + nameBytes.length + raw.length), ...u16(0),
  ]);
  return new Uint8Array([...local, ...nameBytes, ...raw, ...central, ...eocd]);
}
const stored = makeStoredZip("session.v4.jsonl", new TextEncoder().encode(logText));
assert.equal(await parseZipRootLog(stored), logText);
assert.equal(await readRootLogFromExportResponse(new Response(stored)), logText);

// 节假日覆盖：同一时刻在默认表下为空闲，清空表后为高峰
const holidayLog = [
  JSON.stringify({ type: "session", version: 4, id: "session-holiday" }),
  JSON.stringify(event(0, "2026-10-01T01:59:00Z", "request/context", { provider: "deepseek-official", model: "deepseek-flash" })),
  JSON.stringify(event(1, "2026-10-01T02:00:00Z", "step/start", { turn: 1, step: 1 })),
  JSON.stringify(event(2, "2026-10-01T02:00:01Z", "assistant/message", { turn: 1, step: 1, usage: { inputTokens: 1_000_000 } })),
].join("\n");
assert.equal(computeSessionCost(holidayLog).byTurn["1"].peakCalls, 0, "国庆当天默认按空闲");
assert.equal(computeSessionCost(holidayLog, { holidays: [] }).byTurn["1"].peakCalls, 1, "清空节假日表后按高峰");
assert.ok(DEFAULT_HOLIDAYS.length > 0);

console.log("cost-core tests passed");
