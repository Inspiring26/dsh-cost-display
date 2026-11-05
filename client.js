window.__ModuleLoader__.load({
	id: "@inspiring26/dsh-cost-display",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;

		/**
 * DSH 会话费用核心：官方人民币价目、北京峰谷/法定节假日判定、
 * 会话日志折叠，以及从 /api/session.export 的 ZIP 中取出根会话日志。
 *
 * 价目来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * - 单位：元 / 1M tokens。
 * - 高峰：北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00。
 * - 空闲：其余时段（含周末与法定节假日全天），价格恰为高峰的一半。
 * - 缓存写入不单独计价，已包含在 `inputTokens`（缓存未命中）里。
 *
 * 做法参考了社区插件 dsh-cost-breakdown 的官方价目表与峰谷判定
 * （Apache-2.0，https://github.com/liaimei/dsh-cost-breakdown）。
 */

/** 一个时段的费率，单位「元 / 1M token」。 */
const OFFICIAL_MODELS = [
  {
    id: "deepseek-flash",
    label: "DeepSeek-V4.1-Flash",
    aliases: [
      "deepseek-flash",
      "deepseek-v4.1-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4.1-flash-vision-exp",
    ],
    offPeak: { hit: 0.02, miss: 1, out: 4 },
    peak: { hit: 0.04, miss: 2, out: 8 },
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek-V4-Pro",
    aliases: ["deepseek-v4-pro", "deepseek-v4.1-pro", "deepseek-pro"],
    offPeak: { hit: 0.15, miss: 4.5, out: 13.5 },
    peak: { hit: 0.3, miss: 9, out: 27 },
  },
];

/** 北京峰时时段，左闭右开。 */
const PEAK_WINDOWS = [
  [9, 12],
  [14, 18],
];

/** 中国法定节假日（北京日期，YYYY-MM-DD）。这些日子全天按空闲价计。 */
const DEFAULT_HOLIDAYS = [
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
];

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const ROOT_LOG_RE = /^session(?:\.v\d+)?\.jsonl$/;
const decoder = new TextDecoder();

/** 北京时间的日历字段。北京固定 UTC+8，无夏令时。 */
function beijingParts(time) {
  const d = new Date((Number.isFinite(time) ? time : 0) + BEIJING_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    year,
    month,
    day,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** 某一时刻是否落在北京高峰时段。周末与法定节假日全天为空闲。 */
function isPeakBeijing(time, holidays = DEFAULT_HOLIDAYS) {
  const parts = beijingParts(time);
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  if (holidays.includes(parts.date)) return false;
  return PEAK_WINDOWS.some(([from, to]) => parts.hour >= from && parts.hour < to);
}

/** 匹配官方模型（大小写不敏感，精确 id/别名，不做子串猜测）。 */
function matchOfficialModel(model) {
  const name = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (name === "") return null;
  for (const row of OFFICIAL_MODELS) {
    if (row.id === name || row.aliases.includes(name)) return row;
  }
  return null;
}

/** 峰时时段的可读写法。 */
function peakWindowsText(separator = "、") {
  return PEAK_WINDOWS.map(([from, to]) => `${String(from).padStart(2, "0")}:00–${String(to).padStart(2, "0")}:00`).join(separator);
}

/** 人民币费用的紧凑显示。 */
function formatCny(cost) {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return "—";
  if (cost === 0) return "¥0";
  if (cost < 0) return "—";
  if (cost < 0.0001) return "<¥0.0001";
  const trim = (text) => text.replace(/0+$/, "").replace(/\.$/, "");
  if (cost < 1) return `¥${trim(cost.toFixed(4))}`;
  return `¥${cost.toFixed(2)}`;
}

function toCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 给一笔 provider 上报的 usage 定价。
 * @param usage - { inputTokens, cacheReadTokens, outputTokens, cacheWriteTokens?, reasoningTokens? }
 * @param model - 请求上报的模型 id。
 * @param at - 请求开始时刻（epoch ms），用于判断峰谷。
 * @param holidays - 法定节假日表。
 * @returns 定价结果；未收录的模型 priced=false，不会假装免费。
 */
function priceUsage(usage, model, at, holidays = DEFAULT_HOLIDAYS) {
  const row = matchOfficialModel(model);
  const peak = isPeakBeijing(at, holidays);
  const hitTokens = toCount(usage?.cacheReadTokens);
  // TurnTokenUsage 用 uncachedInputTokens，provider 原始 usage 用 inputTokens。
  const missTokens = toCount(usage?.inputTokens ?? usage?.uncachedInputTokens);
  const outTokens = toCount(usage?.outputTokens);
  if (row === null) {
    return {
      priced: false,
      cost: 0,
      peak,
      model: typeof model === "string" ? model : "",
      hitTokens,
      missTokens,
      outTokens,
    };
  }
  const rate = peak ? row.peak : row.offPeak;
  const cost = (hitTokens * rate.hit + missTokens * rate.miss + outTokens * rate.out) / 1e6;
  return {
    priced: true,
    cost,
    peak,
    model: row.id,
    label: row.label,
    rate,
    hitTokens,
    missTokens,
    outTokens,
  };
}

/** 空聚合桶。 */
function emptyBucket() {
  return {
    cost: 0,
    peakCost: 0,
    offPeakCost: 0,
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    peakCalls: 0,
    offPeakCalls: 0,
    hitTokens: 0,
    missTokens: 0,
    outTokens: 0,
  };
}

function addPriced(bucket, priced) {
  bucket.calls += 1;
  bucket.hitTokens += priced.hitTokens;
  bucket.missTokens += priced.missTokens;
  bucket.outTokens += priced.outTokens;
  if (!priced.priced) {
    bucket.unpricedCalls += 1;
    return;
  }
  bucket.pricedCalls += 1;
  bucket.cost += priced.cost;
  if (priced.peak) {
    bucket.peakCalls += 1;
    bucket.peakCost += priced.cost;
  } else {
    bucket.offPeakCalls += 1;
    bucket.offPeakCost += priced.cost;
  }
}

/**
 * 把一份完整的会话 JSONL 折叠成费用总计与逐 Turn 费用。
 *
 * 只统计 provider 真正上报了 usage 的 assistant/message 与
 * compaction/summary；不会从文本猜 token。fork 继承前缀（
 * `session/end-seed { inherited: true }` 之前）会被跳过，避免重复计费。
 *
 * @param jsonl - 会话导出文本（第一行 header，其余每行一个事件）。
 * @param options - { holidays?: string[] }
 * @returns { total, byTurn, calls, unpricedCalls, models, firstTime, lastTime }
 */
function computeSessionCost(jsonl, options = {}) {
  const holidays = options.holidays ?? DEFAULT_HOLIDAYS;
  const lines = typeof jsonl === "string" ? jsonl.split(/\r?\n/) : [];
  const events = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // 导出的日志应当逐行合法；坏行宁可跳过，也不要让整个费用面板失效。
    }
  }

  // 跳过 fork 继承前缀：取最后一个 inherited 标记之后的事件。
  let start = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === "session/end-seed" && event.data?.inherited === true) start = index + 1;
  }

  const total = emptyBucket();
  const byTurn = Object.create(null);
  const models = Object.create(null);
  const stepStarts = new Map();
  let provider = "";
  let model = "";
  let currentTurn = 0;
  let compactionTurn = null;
  let compactionStart = null;
  let firstTime = null;
  let lastTime = null;

  // fork 子会话可能不在自己的日志里重复 route：继承前缀里的最后一个
  // request/context 或 request/header 仍是子会话实际使用的路由。
  for (let index = 0; index < start; index += 1) {
    const event = events[index];
    const data = event.data ?? {};
    if (event.type === "request/header") {
      const config = data.header?.config;
      if (config !== undefined) {
        provider = config.provider ?? provider;
        model = config.model ?? model;
      }
    } else if (event.type === "request/context") {
      provider = data.provider ?? provider;
      model = data.model ?? model;
    }
  }

  const bucketFor = (turn) => {
    const key = String(Number.isFinite(turn) ? turn : 0);
    if (byTurn[key] === undefined) byTurn[key] = emptyBucket();
    return byTurn[key];
  };

  const record = (usage, at, turn, routeProvider, routeModel) => {
    if (usage === undefined || usage === null || typeof usage !== "object") return;
    const priced = priceUsage(usage, routeModel, at, holidays);
    addPriced(total, priced);
    addPriced(bucketFor(turn), priced);
    const modelKey = priced.priced ? priced.model : (priced.model || "(unknown)");
    if (models[modelKey] === undefined) {
      const label = priced.priced ? priced.label : priced.model || "(unknown)";
      models[modelKey] = { model: modelKey, label, provider: routeProvider || "", calls: 0, cost: 0, unpricedCalls: 0 };
    }
    const modelBucket = models[modelKey];
    modelBucket.calls += 1;
    modelBucket.cost += priced.cost;
    if (!priced.priced) modelBucket.unpricedCalls += 1;
    if (firstTime === null || at < firstTime) firstTime = at;
    if (lastTime === null || at > lastTime) lastTime = at;
  };

  for (let index = start; index < events.length; index += 1) {
    const event = events[index];
    const data = event.data ?? {};
    switch (event.type) {
      case "request/header": {
        const config = data.header?.config;
        if (config !== undefined) {
          provider = config.provider ?? provider;
          model = config.model ?? model;
        }
        break;
      }
      case "request/context": {
        provider = data.provider ?? provider;
        model = data.model ?? model;
        break;
      }
      case "turn/start": {
        currentTurn = data.turn ?? currentTurn;
        break;
      }
      case "step/start": {
        currentTurn = data.turn ?? currentTurn;
        stepStarts.set(`${data.turn}:${data.step}`, event.time);
        break;
      }
      case "compaction/start": {
        compactionTurn = data.turn ?? null;
        compactionStart = event.time;
        break;
      }
      case "compaction/end": {
        compactionTurn = null;
        compactionStart = null;
        break;
      }
      case "assistant/message": {
        const at = stepStarts.get(`${data.turn}:${data.step}`) ?? event.time;
        record(data.usage, at, data.turn ?? currentTurn, provider, model);
        break;
      }
      case "assistant/attempt": {
        // 失败/重试的 attempt 不会生成 assistant/message，但流里可能带有
        // provider 上报的 usage；按 attempt 自身的时间单独计费。
        const at = stepStarts.get(`${data.turn}:${data.step}`) ?? event.time;
        let attemptUsage = null;
        for (const item of data.stream ?? []) {
          if (item?.type === "chunk" && item.chunk?.type === "usage" && item.chunk.usage !== undefined) attemptUsage = item.chunk.usage;
        }
        if (attemptUsage !== null) record(attemptUsage, at, data.turn ?? currentTurn, provider, model);
        break;
      }
      case "compaction/summary": {
        // 摘要调用单独计费，但它不是 assistant/message；route 在事件上自带。
        record(data.usage, compactionStart ?? event.time, compactionTurn ?? currentTurn, data.provider ?? provider, data.model ?? model);
        break;
      }
      default:
        break;
    }
  }

  return {
    total,
    byTurn,
    calls: total.calls,
    unpricedCalls: total.unpricedCalls,
    models: Object.values(models),
    firstTime,
    lastTime,
  };
}

/** 从 usage 与单一 route 估算一个 Turn 的费用；用于日志尚未就绪时的兜底。 */
function estimateTurnCost(usage, route, at, holidays = DEFAULT_HOLIDAYS) {
  if (usage === undefined || usage === null || typeof usage !== "object") return null;
  const model = Array.isArray(route)
    ? route.length === 1
      ? route[0]?.model
      : undefined
    : route !== null && typeof route === "object"
      ? route.model
      : route;
  const priced = priceUsage(usage, model, at, holidays);
  return {
    ...priced,
    approximate: true,
  };
}

function concatBytes(parts) {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function inflateRawBrowser(bytes) {
  if (typeof DecompressionStream !== "function") throw new Error("当前浏览器不支持解压会话日志");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 从整份 ZIP 字节里取根会话日志（中央目录解析）。
 * 仅在流式读取不可用时使用；ZIP64 不支持，会明确报错。
 * @param input - ArrayBuffer 或 Uint8Array。
 * @param inflateRaw - 可选 deflate-raw 解压器（测试注入）。
 * @returns 根会话日志文本。
 */
async function parseZipRootLog(input, inflateRaw) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let index = bytes.byteLength - 22; index >= min; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 导出");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (ROOT_LOG_RE.test(name)) {
      if (compressedSize === 0xffffffff) throw new Error("暂不支持 ZIP64 会话导出");
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return decoder.decode(data);
      if (method !== 8) throw new Error(`不支持的 ZIP 压缩方式：${method}`);
      const inflated = await (inflateRaw ?? inflateRawBrowser)(data);
      return decoder.decode(inflated);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("ZIP 中找不到根会话日志");
}

const DESCRIPTOR_SIGNATURE = [0x50, 0x4b, 0x07, 0x08];

function findDescriptor(bytes, from) {
  const limit = bytes.byteLength - 4;
  for (let index = Math.max(0, from); index <= limit; index += 1) {
    if (
      bytes[index] === DESCRIPTOR_SIGNATURE[0] &&
      bytes[index + 1] === DESCRIPTOR_SIGNATURE[1] &&
      bytes[index + 2] === DESCRIPTOR_SIGNATURE[2] &&
      bytes[index + 3] === DESCRIPTOR_SIGNATURE[3]
    ) {
      return index;
    }
  }
  return -1;
}

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
  for (let index = 0; index < bytes.byteLength; index += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[index]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** 把一段完整的 deflate-raw 字节解压出来（写入端主动 close）。 */
async function inflateComplete(bytes, inflateRaw) {
  if (inflateRaw !== undefined) return inflateRaw(bytes);
  if (typeof DecompressionStream !== "function") throw new Error("当前浏览器不支持解压会话日志");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 直接从导出响应流中读取第一条 ZIP 条目（根会话日志）。
 *
 * fflate 的流式 ZIP 在本地头里把大小写成 0，并在压缩数据之后放 16 字节
 * data descriptor（PK\x07\x08 + CRC + 压缩大小 + 原始大小）。这里扫描到
 * 描述符并校验大小/CRC 后立即取消下载，因此不会把后续引用的大附件全部拉下来。
 *
 * @param response - /api/session.export 的 Response。
 * @param options - { maxLogBytes?, inflateRaw? }
 * @returns 根会话日志文本。
 */
async function readRootLogFromExportResponse(response, options = {}) {
  const maxLogBytes = options.maxLogBytes ?? 64 * 1024 * 1024;
  const maxCompressedBytes = options.maxCompressedBytes ?? 64 * 1024 * 1024;
  if (response.body === null || response.body === undefined || typeof response.body.getReader !== "function") {
    return parseZipRootLog(await response.arrayBuffer(), options.inflateRaw);
  }
  const reader = response.body.getReader();
  let pending = new Uint8Array(0);
  const readMore = async () => {
    const { done, value } = await reader.read();
    if (done) return false;
    if (value !== undefined && value.byteLength > 0) pending = concatBytes([pending, value]);
    return true;
  };
  const cancelRemaining = () => {
    reader.cancel().catch(() => {});
  };
  try {
    while (pending.byteLength < 30) {
      if (!(await readMore())) throw new Error("ZIP 头不完整");
    }
    const header = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
    if (header.getUint32(0, true) !== 0x04034b50) throw new Error("不是有效的 ZIP 导出");
    const flags = header.getUint16(6, true);
    const method = header.getUint16(8, true);
    const localCompressedSize = header.getUint32(18, true);
    const localUncompressedSize = header.getUint32(22, true);
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const headerEnd = 30 + nameLength + extraLength;
    while (pending.byteLength < headerEnd) {
      if (!(await readMore())) throw new Error("ZIP 头不完整");
    }
    const readAll = async () => {
      while (await readMore()) {
        // drain
      }
      return pending;
    };
    const name = decoder.decode(pending.subarray(30, 30 + nameLength));
    if (!ROOT_LOG_RE.test(name)) {
      // 不是预期的第一条根日志：退回整包解析（这条路径不会出现在正常导出里）。
      await readAll();
      return parseZipRootLog(pending, options.inflateRaw);
    }
    if (method !== 0 && method !== 8) throw new Error(`不支持的 ZIP 压缩方式：${method}`);

    let compressed = pending.subarray(headerEnd);
    const usesDescriptor = (flags & 0x0008) !== 0;

    if (!usesDescriptor) {
      if (method === 0) {
        if (localCompressedSize === 0xffffffff) throw new Error("暂不支持 ZIP64 会话导出");
        while (compressed.byteLength < localCompressedSize) {
          if (!(await readMore())) throw new Error("ZIP 数据不完整");
          compressed = pending.subarray(headerEnd);
        }
        return decoder.decode(compressed.subarray(0, localCompressedSize));
      }
      if (localCompressedSize === 0xffffffff) throw new Error("暂不支持 ZIP64 会话导出");
      while (compressed.byteLength < localCompressedSize) {
        if (!(await readMore())) throw new Error("ZIP 数据不完整");
        compressed = pending.subarray(headerEnd);
      }
      const raw = compressed.subarray(0, localCompressedSize);
      if (raw.byteLength > maxCompressedBytes) throw new Error("会话日志过大，费用暂不可用");
      return decoder.decode(await inflateComplete(raw, options.inflateRaw));
    }

    // 有 data descriptor：扫描描述符签名，并用压缩大小 + 解压长度 + CRC 校验。
    let scanFrom = 0;
    let candidate = -1;
    let descriptor = null;
    while (true) {
      candidate = findDescriptor(compressed, scanFrom);
      if (candidate >= 0) {
        if (candidate + 16 > compressed.byteLength) {
          // 描述符跨在下一个响应块里：补读后从同一个候选重新判断。
          if (!(await readMore())) throw new Error("ZIP 数据不完整");
          compressed = pending.subarray(headerEnd);
          continue;
        }
        const size = compressed.byteLength;
        const view = new DataView(compressed.buffer, compressed.byteOffset, size);
        const crc = view.getUint32(candidate + 4, true);
        const compressedSize = view.getUint32(candidate + 8, true);
        const uncompressedSize = view.getUint32(candidate + 12, true);
        if (compressedSize === candidate) {
          descriptor = { crc, compressedSize, uncompressedSize, end: candidate };
          break;
        }
        scanFrom = candidate + 1;
        continue;
      }
      if (compressed.byteLength > maxCompressedBytes) throw new Error("会话日志过大，费用暂不可用");
      if (!(await readMore())) {
        // 没有描述符：流已经读完，退回整包解析，让中央目录给出准确大小。
        return parseZipRootLog(pending, options.inflateRaw);
      }
      compressed = pending.subarray(headerEnd);
    }

    const raw = compressed.subarray(0, descriptor.end);
    let unpacked;
    if (method === 0) unpacked = raw;
    else unpacked = await inflateComplete(raw, options.inflateRaw);
    if (unpacked.byteLength > maxLogBytes) throw new Error("会话日志过大，费用暂不可用");
    if (descriptor.uncompressedSize !== 0 && descriptor.uncompressedSize !== unpacked.byteLength) {
      throw new Error("ZIP 会话日志校验失败（长度）");
    }
    if (descriptor.crc !== 0 && descriptor.crc !== crc32(unpacked)) {
      throw new Error("ZIP 会话日志校验失败（CRC）");
    }
    return decoder.decode(unpacked);
  } finally {
    cancelRemaining();
  }
}

		/* ------------------------------------------------------------------ *
		 * Per-Session cost state: fetch the root session log, fold it once, and
		 * share the result between the turn usage dialog and the composer pill.
		 * ------------------------------------------------------------------ */

		const CACHE = new Map();
		const LISTENERS = new Set();
		const MAX_AGE_MS = 15000;
		const MIN_INTERVAL_MS = 4000;
		const FETCH_TIMEOUT_MS = 30000;
		const MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };

		function sessionKey(sessionId) {
			return sessionId === undefined || sessionId === null ? "" : String(sessionId);
		}

		function emit(id) {
			for (const listener of [...LISTENERS]) listener(id);
		}

		function snapshot(sessionId) {
			return CACHE.get(sessionKey(sessionId));
		}

		function request(sessionId, options = {}) {
			const id = sessionKey(sessionId);
			if (id === "") return;
			const now = Date.now();
			const current = CACHE.get(id);
			const fresh = options.force === true || options.maxAgeMs === 0;
			if (current !== undefined && current.status === "loading") {
				if (fresh) current.pending = true;
				return;
			}
			if (!fresh && current !== undefined && current.status === "ready" && now - current.fetchedAt < (options.maxAgeMs ?? MAX_AGE_MS)) return;
			if (!fresh && current !== undefined && current.lastRequestAt !== undefined && now - current.lastRequestAt < MIN_INTERVAL_MS) return;

			const next = {
				status: "loading",
				data: current === undefined ? undefined : current.data,
				fetchedAt: current === undefined ? 0 : current.fetchedAt,
				lastRequestAt: now,
				error: null,
				pending: false
			};
			CACHE.set(id, next);
			emit(id);

			(async () => {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
				try {
					const url = new URL("api/session.export", document.baseURI);
					url.searchParams.set("sessionId", id);
					url.searchParams.set("includeDescendants", "false");
					const response = await fetch(url, {
						credentials: "same-origin",
						cache: "no-store",
						signal: controller.signal
					});
					if (!response.ok) throw new Error("HTTP " + response.status);
					const text = await readRootLogFromExportResponse(response);
					const data = computeSessionCost(text);
					const pending = CACHE.get(id) !== undefined && CACHE.get(id).pending === true;
					CACHE.set(id, {
						status: "ready",
						data,
						fetchedAt: Date.now(),
						lastRequestAt: now,
						error: null,
						pending
					});
					if (pending) request(id, { force: true });
				} catch (error) {
					const pending = CACHE.get(id) !== undefined && CACHE.get(id).pending === true;
					CACHE.set(id, {
						status: "error",
						data: current === undefined ? undefined : current.data,
						fetchedAt: current === undefined ? 0 : current.fetchedAt,
						lastRequestAt: now,
						error: error instanceof Error ? error.message : String(error),
						pending
					});
					if (pending) request(id, { force: true });
				} finally {
					clearTimeout(timer);
				}
				emit(id);
			})();
		}

		function useSessionCost(sessionId, refreshKey) {
			const id = sessionKey(sessionId);
			const [state, setState] = React.useState(() => (id === "" ? undefined : CACHE.get(id)));
			const lastRefresh = React.useRef({ id: "", key: undefined });
			React.useEffect(() => {
				if (id === "") return undefined;
				setState(CACHE.get(id));
				const listener = (changed) => {
					if (changed === undefined || changed === id) setState(CACHE.get(id));
				};
				LISTENERS.add(listener);
				request(id, { maxAgeMs: 3000 });
				return () => {
					LISTENERS.delete(listener);
				};
			}, [id]);
			React.useEffect(() => {
				if (id === "" || refreshKey === undefined) {
					lastRefresh.current = { id, key: undefined };
					return undefined;
				}
				const previous = lastRefresh.current;
				lastRefresh.current = { id, key: refreshKey };
				if (previous.id !== id || previous.key === undefined || previous.key === refreshKey) return undefined;
				const timer = setTimeout(() => request(id, { maxAgeMs: 0 }), 1200);
				return () => clearTimeout(timer);
			}, [id, refreshKey]);
			return state;
		}

		function usageRefreshKey(usage) {
			if (usage === undefined || usage === null) return undefined;
			return (usage.inputTokens ?? usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
		}

		/* ------------------------------------------------------------------ *
		 * Cost presentation helpers.
		 * ------------------------------------------------------------------ */

		function costLabel(bucket) {
			if (bucket === undefined) return null;
			if (bucket.pricedCalls === 0 && bucket.unpricedCalls > 0) return null;
			const text = formatCny(bucket.cost);
			return bucket.unpricedCalls > 0 ? "≥" + text : text;
		}

		function resolveTurnBucket(entry, turn, usage, time, node) {
			if (turn !== undefined) {
				const bucket = entry?.data?.byTurn?.[String(turn)];
				if (bucket !== undefined) return { bucket, approximate: false };
			}
			// A ready log is authoritative: a Turn missing from it belongs to the
			// inherited fork prefix or had no reported usage.
			if (entry?.status === "ready") return { bucket: undefined, approximate: false };
			if (time === undefined || usage === undefined || usage === null) return { bucket: undefined, approximate: false };
			const route = node?.requestConfig ?? node?.providerMetadata;
			const model = route?.model ?? (Array.isArray(usage.routes) && usage.routes.length === 1 ? usage.routes[0]?.model : undefined);
			if (model === undefined) return { bucket: undefined, approximate: false };
			const fallback = estimateTurnCost(usage, { model }, time);
			if (fallback === null) return { bucket: undefined, approximate: false };
			return {
				bucket: {
					cost: fallback.cost,
					peakCost: fallback.priced && fallback.peak ? fallback.cost : 0,
					offPeakCost: fallback.priced && !fallback.peak ? fallback.cost : 0,
					calls: 1,
					pricedCalls: fallback.priced ? 1 : 0,
					unpricedCalls: fallback.priced ? 0 : 1,
					peakCalls: fallback.priced && fallback.peak ? 1 : 0,
					offPeakCalls: fallback.priced && !fallback.peak ? 1 : 0,
					hitTokens: fallback.hitTokens,
					missTokens: fallback.missTokens,
					outTokens: fallback.outTokens
				},
				approximate: true
			};
		}

		function routeText(routes) {
			return routes.map((route) => (route.provider === "" ? route.model : route.provider + "/" + route.model)).join(", ");
		}

		function routeList(routes) {
			const seen = new Set();
			const list = [];
			for (const route of routes ?? []) {
				const provider = typeof route?.provider === "string" ? route.provider : "";
				const model = typeof route?.model === "string" ? route.model : "";
				if (model === "") continue;
				const key = provider + "/" + model;
				if (seen.has(key)) continue;
				seen.add(key);
				list.push({ provider, model });
			}
			return list;
		}

		function displayAmount(bucket, approximate) {
			const text = costLabel(bucket);
			if (text === null) return null;
			return (approximate ? "≈" : "") + text;
		}

		/* ------------------------------------------------------------------ *
		 * Popover anchoring shared by the two usage dialogs.
		 * ------------------------------------------------------------------ */

		function usePopover() {
			const [open, setOpen] = React.useState(false);
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const [pos, setPos] = React.useState(null);

			React.useLayoutEffect(() => {
				if (!open) {
					setPos(null);
					return undefined;
				}
				let frame = 0;
				const place = () => {
					frame = 0;
					const anchor = rootRef.current;
					const panel = panelRef.current;
					if (anchor === null || panel === null) return;
					const rect = anchor.getBoundingClientRect();
					const width = panel.offsetWidth;
					const height = panel.offsetHeight;
					const viewportWidth = window.innerWidth;
					const viewportHeight = window.innerHeight;
					let left = rect.left + rect.width / 2 - width / 2;
					left = Math.max(12, Math.min(left, viewportWidth - width - 12));
					let top = rect.top - height - 8;
					if (top < 12) top = rect.bottom + 8;
					if (top + height > viewportHeight - 12) top = Math.max(12, viewportHeight - height - 12);
					setPos({ left: Math.round(left) + "px", top: Math.round(top) + "px" });
				};
				const schedule = () => {
					if (frame === 0) frame = window.requestAnimationFrame(place);
				};
				schedule();
				window.addEventListener("resize", schedule);
				window.addEventListener("scroll", schedule, true);
				return () => {
					if (frame !== 0) window.cancelAnimationFrame(frame);
					window.removeEventListener("resize", schedule);
					window.removeEventListener("scroll", schedule, true);
				};
			}, [open]);

			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					if (rootRef.current !== null && rootRef.current.contains(target)) return;
					if (panelRef.current !== null && panelRef.current.contains(target)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			return { open, setOpen, rootRef, panelRef, pos };
		}

		/* ------------------------------------------------------------------ *
 * Chat bridge: cost-aware copies of the shipped turn-tail renderer and
 * session usage pill. The copies keep the shipped markup, CSS classes and
 * action row (copy / feedback / branch / usage), and only append the cost.
 * ------------------------------------------------------------------ */

function IconDatabase() {
	return h("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true }, h("ellipse", {
		cx: 8,
		cy: 4,
		rx: 4.75,
		ry: 1.9,
		stroke: "currentColor",
		strokeWidth: 1.25
	}), h("path", {
		d: "M3.25 4v3.6c0 1.05 2.13 1.9 4.75 1.9s4.75-.85 4.75-1.9V4",
		stroke: "currentColor",
		strokeWidth: 1.25
	}), h("path", {
		d: "M3.25 7.6v3.6c0 1.05 2.13 1.9 4.75 1.9s4.75-.85 4.75-1.9V7.6",
		stroke: "currentColor",
		strokeWidth: 1.25
	}));
}

function IconCopy() {
	return h("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true }, h("rect", {
		x: 5.5,
		y: 5.5,
		width: 7,
		height: 7,
		rx: 1.5,
		stroke: "currentColor",
		strokeWidth: 1.25
	}), h("path", {
		d: "M10.5 5.5V4.5A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1",
		stroke: "currentColor",
		strokeWidth: 1.25,
		strokeLinecap: "round"
	}));
}

function IconCheck() {
	return h("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true }, h("path", {
		d: "M3.5 8.5 6.4 11.3 12.5 5",
		stroke: "currentColor",
		strokeWidth: 1.5,
		strokeLinecap: "round",
		strokeLinejoin: "round"
	}));
}

function IconBranch() {
	return h("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true }, h("circle", {
		cx: 4.5,
		cy: 3.5,
		r: 1.6,
		stroke: "currentColor",
		strokeWidth: 1.2
	}), h("circle", {
		cx: 4.5,
		cy: 12.5,
		r: 1.6,
		stroke: "currentColor",
		strokeWidth: 1.2
	}), h("circle", {
		cx: 11.5,
		cy: 6.5,
		r: 1.6,
		stroke: "currentColor",
		strokeWidth: 1.2
	}), h("path", {
		d: "M4.5 5.1v5.8M6.1 6.5h1.8a2 2 0 0 1 2 2v.6",
		stroke: "currentColor",
		strokeWidth: 1.2,
		strokeLinecap: "round"
	}));
}

async function writeClipboard(text) {
	try {
		if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Fall through to the textarea path.
	}
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

function startOfLocalDay(ms) {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function msUntilNextLocalMidnight(ms) {
	const next = new Date(ms);
	next.setHours(24, 0, 0, 0);
	return Math.max(next.getTime() - ms, 1);
}

function useCalendarDay() {
	const [day, setDay] = React.useState(() => startOfLocalDay(Date.now()));
	React.useEffect(() => {
		let timer;
		const arm = () => {
			const now = Date.now();
			setDay(startOfLocalDay(now));
			timer = setTimeout(arm, msUntilNextLocalMidnight(now));
		};
		timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()));
		return () => {
			clearTimeout(timer);
		};
	}, []);
	return day;
}

function formatMessageClock(time, t, now = Date.now()) {
	const d = new Date(time);
	const n = new Date(now);
	const clock = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
	if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock;
	const params = {
		y: d.getFullYear(),
		m: d.getMonth() + 1,
		d: d.getDate()
	};
	return (d.getFullYear() === n.getFullYear() ? t("clock.md", params) : t("clock.ymd", params)) + " " + clock;
}

function formatTokens(value, t) {
	const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10));
	if (value < 1e3) return String(value);
	if (value < 1e6) return t("number.thousand", { value: scaled(value / 1e3) });
	return t("number.million", { value: scaled(value / 1e6) });
}

function formatExactTokens(value, t) {
	const digits = String(value);
	const groups = [];
	for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
	return groups.join(t("number.groupSeparator"));
}

function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
	const scale = (decimalPlaces === 0 ? 1 : 10) * 100;
	const doubledScale = scale * 2;
	const denominatorQuotient = Math.floor(denominator / doubledScale);
	const denominatorRemainder = denominator % doubledScale;
	let lower = 0;
	let upper = scale;
	while (lower < upper) {
		const candidate = Math.floor((lower + upper + 1) / 2);
		const factor = candidate * 2 - 1;
		if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate;
		else upper = candidate - 1;
	}
	return lower;
}

function displayPercentUnits(units, decimalPlaces) {
	if (decimalPlaces === 0) return String(units);
	const whole = Math.floor(units / 10);
	const tenths = units % 10;
	return tenths === 0 ? String(whole) : whole + "." + tenths;
}

function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
	if (promptTokens === 0) return null;
	const missedInputTokens = promptTokens - cacheReadTokens;
	if (missedInputTokens === 0) return "100";
	const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
	if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces);
	let distinguishingPlaces = 1;
	let scaledDoubleGap = missedInputTokens * 200;
	const denominatorTens = Math.floor(promptTokens / 10);
	while (scaledDoubleGap <= denominatorTens) {
		scaledDoubleGap *= 10;
		distinguishingPlaces += 1;
	}
	const denominatorOnes = promptTokens % 10;
	let roundedLoss = 5;
	for (let loss = 1; loss < 5; loss += 1) {
		const factor = loss * 2 + 1;
		const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
		if (scaledDoubleGap <= threshold) {
			roundedLoss = loss;
			break;
		}
	}
	return "99." + "9".repeat(distinguishingPlaces - 1) + String(10 - roundedLoss);
}

function billedInputTokens(usage) {
	return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function cacheHitPercent(usage) {
	return formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage));
}

function exactCount(value, t) {
	return t("message.turnUsage.count", { count: formatExactTokens(value, t) });
}

function formatCompactCount(value, t) {
	return t("message.turnUsage.count", { count: formatTokens(value, t) });
}

function formatExactCount(value, t) {
	return t("message.turnUsage.count", { count: formatExactTokens(value, t) });
}

function joined(first, second) {
	if (second === null || second === undefined) return first;
	return h(React.Fragment, null, first, h("span", {
		className: "bOPqQW_sep",
		"aria-hidden": true
	}, "·"), second);
}

function row(key, label, value, valueClassName) {
	return h(React.Fragment, { key }, h("dt", null, label), h("dd", valueClassName === undefined ? null : { className: valueClassName }, value));
}

function appendCostRows(rows, bucket, tCost, approximate) {
	const amount = displayAmount(bucket, approximate);
	rows.push(row("cost", tCost("detail.cost"), amount === null ? tCost("turn.unpriced") : amount));
	if (bucket.peakCalls > 0) {
		rows.push(row("peak", tCost("detail.peak"), formatCny(bucket.peakCost) + " · " + tCost("detail.calls", { count: bucket.peakCalls })));
	}
	if (bucket.offPeakCalls > 0) {
		rows.push(row("offpeak", tCost("detail.offPeak"), formatCny(bucket.offPeakCost) + " · " + tCost("detail.calls", { count: bucket.offPeakCalls })));
	}
	if (bucket.unpricedCalls > 0) {
		rows.push(row("unpriced", tCost("detail.unpriced"), tCost("detail.calls", { count: bucket.unpricedCalls })));
	}
}

function UsageDialog({ popover, icon, title, titleValue, rows, detailsAttr, bucket, approximate, tCost }) {
	return h("div", {
		ref: popover.panelRef,
		className: "bRhRbq_panel",
		role: "dialog",
		"aria-label": title,
		style: popover.pos ?? MEASURE_STYLE
	}, h("div", { className: "bRhRbq_title" }, h("span", { className: "bRhRbq_titleLabel" }, icon, title), titleValue !== undefined && h("span", { className: "bRhRbq_titleValue" }, titleValue)), h("div", {
		className: "bRhRbq_titleRule",
		"aria-hidden": true
	}), h("dl", Object.assign({ className: "bRhRbq_details" }, detailsAttr), rows), bucket !== undefined && h("p", {
		className: "dsh-cost-note"
	}, tCost("detail.estimate")), bucket !== undefined && h("p", {
		className: "dsh-cost-note"
	}, tCost("detail.peakWindows")), approximate && h("p", {
		className: "dsh-cost-note"
	}, tCost("detail.approximate")));
}

/* ------------------------------------------------------------------ *
 * Turn usage: the original `用量 45.2K tok` trigger with `·¥1.49`
 * appended, and the original dialog rows plus cost rows.
 * ------------------------------------------------------------------ */

function TurnUsagePanel({ usage, t, tCost, turn, time, sessionId }) {
	const popover = usePopover();
	const entry = useSessionCost(sessionId, usageRefreshKey(usage));
	const resolved = resolveTurnBucket(entry, turn, usage, time, undefined);
	const bucket = resolved.bucket !== undefined && resolved.bucket.calls > 0 ? resolved.bucket : undefined;
	const cacheHit = usage.cacheReadTokens === undefined ? null : formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1);
	const total = formatCompactCount(usage.totalTokens, t);
	const costText = bucket === undefined ? null : displayAmount(bucket, resolved.approximate) ?? tCost("turn.unpriced");
	const label = joined(t("message.turnUsage.consumed", { total }), costText);
	const aria = [t("message.turnUsage.consumed", { total }), costText].filter((value) => value !== null && value !== undefined).join(" · ");

	const rows = [];
	const routes = routeText(routeList(usage.routes));
	if (routes !== "") rows.push(row("model", t("message.turnUsage.model"), routes, "bRhRbq_route"));
	if (cacheHit !== null) rows.push(row("cacheHit", t("message.turnUsage.cacheHit"), cacheHit + "%"));
	rows.push(row("input", t("message.turnUsage.input"), formatExactCount(usage.uncachedInputTokens, t)));
	if (usage.cacheReadTokens !== undefined) rows.push(row("cacheRead", t("message.turnUsage.cacheRead"), formatExactCount(usage.cacheReadTokens, t)));
	if (usage.cacheWriteTokens !== undefined) rows.push(row("cacheWrite", t("message.turnUsage.cacheWrite"), formatExactCount(usage.cacheWriteTokens, t)));
	rows.push(row("output", t("message.turnUsage.output"), usage.reasoningTokens === undefined ? formatExactCount(usage.outputTokens, t) : h(React.Fragment, null, formatExactCount(usage.outputTokens, t), h("span", {
		className: "bRhRbq_reasoning"
	}, t("message.turnUsage.reasoning", { tokens: formatExactCount(usage.reasoningTokens, t) })))));
	if (bucket !== undefined) appendCostRows(rows, bucket, tCost, resolved.approximate);

	return h("span", { ref: popover.rootRef, className: "Q51KRG_root" }, h("button", {
		type: "button",
		className: "Q51KRG_trigger",
		"aria-haspopup": "dialog",
		"aria-expanded": popover.open,
		"aria-label": aria,
		title: aria,
		onClick: () => popover.setOpen(!popover.open)
	}, h(IconDatabase), h("span", { className: "Q51KRG_label" }, label)), popover.open && ReactDOM.createPortal(h(UsageDialog, {
		popover,
		icon: h(IconDatabase),
		title: t("message.turnUsage.title"),
		titleValue: formatExactCount(usage.totalTokens, t),
		rows,
		detailsAttr: { "data-turn-usage-details": true },
		bucket,
		approximate: resolved.approximate,
		tCost
	}), document.body));
}

/* ------------------------------------------------------------------ *
 * Message action row: a faithful copy of the shipped row (copy,
 * feedback slot, branch, usage, clock) with native titles instead of the
 * private Tooltip wrapper.
 * ------------------------------------------------------------------ */

function MessageIconActions({ text, time, clock, onBranch, branchUnavailable = false, className, extraActions, usageAction, t }) {
	const day = useCalendarDay();
	const reasonId = React.useId();
	const [copied, setCopied] = React.useState(false);
	const copyPending = React.useRef(false);
	const copyTimer = React.useRef(null);
	const copyEpoch = React.useRef(0);
	React.useEffect(() => () => {
		copyEpoch.current += 1;
		copyPending.current = false;
		if (copyTimer.current !== null) clearTimeout(copyTimer.current);
	}, []);
	const onCopy = React.useCallback(() => {
		if (copied || copyPending.current) return;
		const epoch = copyEpoch.current;
		copyPending.current = true;
		writeClipboard(text).then((ok) => {
			if (epoch !== copyEpoch.current) return;
			copyPending.current = false;
			if (!ok) return;
			setCopied(true);
			copyTimer.current = window.setTimeout(() => {
				copyTimer.current = null;
				setCopied(false);
			}, 1000);
		});
	}, [copied, text]);
	const clockEl = time === undefined ? null : h("span", {
		className: clock === "start" ? "xzv4MW_timeStart" : "xzv4MW_timeEnd"
	}, formatMessageClock(time, t, day));
	return h("div", {
		className: className === undefined ? "xzv4MW_actions" : "xzv4MW_actions " + className,
		"data-clock": clock
	}, clock === "start" ? clockEl : null, h("button", {
		type: "button",
		className: "xzv4MW_action",
		"aria-label": copied ? t("copied") : t("copy"),
		title: copied ? t("copied") : t("copy"),
		onClick: onCopy
	}, copied ? h(IconCheck) : h(IconCopy)), extraActions, onBranch !== undefined && h("button", {
		type: "button",
		className: "xzv4MW_action",
		"aria-label": t("message.branch"),
		title: branchUnavailable ? t("message.branchUnavailable") : t("message.branch"),
		"aria-disabled": branchUnavailable || undefined,
		"aria-describedby": branchUnavailable ? reasonId : undefined,
		"data-unavailable": branchUnavailable || undefined,
		onClick: branchUnavailable ? undefined : onBranch
	}, h(IconBranch)), onBranch !== undefined && branchUnavailable && h("span", {
		id: reasonId,
		className: "xzv4MW_visuallyHidden"
	}, t("message.branchUnavailable")), clock === "end" ? h("span", {
		className: "xzv4MW_endInfo"
	}, usageAction, clockEl) : usageAction);
}

/* ------------------------------------------------------------------ *
 * Turn-tail renderer: the shipped structure, with the cost-aware usage
 * action and the untouched assistant-actions / turnTail slots.
 * ------------------------------------------------------------------ */

function lastContent(snapshot, turn, skipWarning) {
	const keys = snapshot.locations.getTurn(turn);
	for (let index = keys.length - 1; index >= 0; index--) {
		const node = snapshot.nodes.get(keys[index]);
		if (node === undefined || node.kind === "turn-tail" || node.kind === "turn-process" || (skipWarning && node.kind === "turn-max-tokens")) continue;
		return node;
	}
}

function assistantText(blocks) {
	return blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("");
}

function hasAssistantReplyContent(blocks) {
	return blocks.some((block) => {
		if (block.kind === "reasoning" || block.kind === "tool-call") return false;
		if (block.kind === "text") return block.text.trim() !== "";
		return true;
	});
}

const TurnTailNodeView = React.memo(function TurnTailNodeView({ node, openFile, forkAt, renderSlot, t, tCost, useAccess, useChat, usePerformanceUsage, sessionId }) {
	const forkAllowed = useAccess("session/fork");
	const detailed = usePerformanceUsage === undefined || usePerformanceUsage((mode) => mode) === "detailed";
	const data = node.data;
	const hasLaterChatNode = useChat((snapshot) => (lastContent(snapshot, data.turn, true)?.anchorSeq ?? -1) > (data.closing?.finalNode.seq ?? data.seq));
	const endsWithResponse = useChat((snapshot) => {
		if (snapshot.timeline.turnOrder.at(-1) !== data.turn) return false;
		const last = lastContent(snapshot, data.turn, false);
		const block = last?.kind === "assistant-step" ? last.data.blocks.findLast((candidate) => (candidate.kind !== "text" && candidate.kind !== "reasoning") || candidate.text.trim() !== "") : undefined;
		return block !== undefined && hasAssistantReplyContent([block]);
	});
	const turn = node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : undefined;
	if (turn === undefined) return null;
	const closing = data.closing;
	const tail = renderSlot("conversation.chat.turnTail", {
		turn,
		seq: closing?.finalNode.seq ?? data.seq,
		openFile
	});
	if (closing === null) return tail === null ? null : h("div", {
		className: "TS9iAW_root",
		"data-turn-tail": data.turn
	}, tail);
	const messageId = closing.finalNode.messageId;
	const assistantActions = messageId === undefined ? null : renderSlot("conversation.chat.assistant-actions", { messageId });
	return h("div", {
		className: "TS9iAW_root",
		"data-turn-tail": data.turn,
		"data-actions-reveal": endsWithResponse ? "always" : "hover"
	}, tail, h(MessageIconActions, {
		text: assistantText(closing.blocks),
		time: closing.time,
		clock: "end",
		onBranch: forkAllowed ? () => {
			forkAt(data.seq);
		} : undefined,
		branchUnavailable: data.branchUnavailable || hasLaterChatNode,
		className: "TS9iAW_actions",
		extraActions: assistantActions,
		usageAction: detailed && data.tokenUsage !== undefined ? h(TurnUsagePanel, {
			usage: data.tokenUsage,
			turn: data.turn,
			time: closing.time,
			sessionId,
			t,
			tCost
		}) : null,
		t
	}));
});

/* ------------------------------------------------------------------ *
 * Session usage pill: the original composer-dock style with the cost
 * appended and cost rows in the same dialog.
 * ------------------------------------------------------------------ */

const UsagePill = React.memo(function UsagePill({ useProjection, usePerformanceUsage, sessionId, t, tCost }) {
	const usage = useProjection("tokenUsage");
	const total = usage === undefined ? 0 : billedInputTokens(usage) + usage.outputTokens;
	const entry = useSessionCost(sessionId, usage === undefined ? undefined : total);
	const bucket = entry?.data?.total !== undefined && entry.data.total.calls > 0 ? entry.data.total : undefined;
	const popover = usePopover();
	if (usage === undefined || total === 0) return null;
	const mode = usePerformanceUsage === undefined ? "detailed" : usePerformanceUsage((value) => value);
	const cacheHit = cacheHitPercent(usage);
	const cacheHitText = cacheHit === null ? null : t("stats.cacheHit", { percent: cacheHit });
	const totalText = t("message.turnUsage.count", { count: formatTokens(total, t) });
	const costText = bucket === undefined ? null : displayAmount(bucket, false) ?? tCost("session.unpriced");
	const label = mode === "compact" ? joined(cacheHitText, costText) : joined(joined(totalText, cacheHitText), costText);
	if (label === null || label === undefined) return null;
	const aria = (mode === "compact" ? [cacheHitText, costText] : [totalText, cacheHitText, costText]).filter((value) => value !== null && value !== undefined).join(" · ");

	const rows = [];
	if (cacheHit !== null) rows.push(row("cacheHit", t("message.turnUsage.cacheHit"), cacheHit + "%"));
	rows.push(row("input", t("message.turnUsage.input"), exactCount(usage.uncachedInputTokens, t)));
	rows.push(row("cacheRead", t("message.turnUsage.cacheRead"), exactCount(usage.cacheReadTokens, t)));
	if (usage.cacheWriteTokens !== 0) rows.push(row("cacheWrite", t("message.turnUsage.cacheWrite"), exactCount(usage.cacheWriteTokens, t)));
	rows.push(row("output", t("message.turnUsage.output"), exactCount(usage.outputTokens, t)));
	if (bucket !== undefined) appendCostRows(rows, bucket, tCost, false);

	return h("span", { ref: popover.rootRef, className: "bOPqQW_anchor", "data-composer-stat": "usage" }, h("button", {
		type: "button",
		className: "bOPqQW_pill",
		"aria-haspopup": "dialog",
		"aria-expanded": popover.open,
		"aria-label": aria,
		title: aria,
		onClick: () => popover.setOpen(!popover.open)
	}, h(IconDatabase), h("span", { className: "bOPqQW_label" }, label)), popover.open && ReactDOM.createPortal(h(UsageDialog, {
		popover,
		icon: h(IconDatabase),
		title: t("stats.dialog.usageTitle"),
		titleValue: exactCount(total, t),
		rows,
		detailsAttr: { "data-session-stats-usage": true },
		bucket,
		approximate: false,
		tCost
	}), document.body));
});

		/* ------------------------------------------------------------------ *
		 * Locale and plugin wiring.
		 * ------------------------------------------------------------------ */

		const NS = "dsh-cost";

		const zh = {
			"turn.unpriced": "未定价",
			"session.unpriced": "费用未定价",
			"detail.cost": "费用",
			"detail.models": "模型路由",
			"detail.peak": "高峰费用",
			"detail.offPeak": "空闲费用",
			"detail.unpriced": "未定价调用",
			"detail.calls": "{count} 次",
			"detail.estimate": "按 DeepSeek 官方人民币峰谷价估算，不是账单。",
			"detail.peakWindows": "高峰：北京时间工作日 09:00–12:00、14:00–18:00；周末和法定节假日按空闲价。",
			"detail.approximate": "≈ 表示会话日志尚未就绪，暂按已加载消息估算。"
		};

		const en = {
			"turn.unpriced": "Unpriced",
			"session.unpriced": "Cost unpriced",
			"detail.cost": "Cost",
			"detail.models": "Model routes",
			"detail.peak": "Peak cost",
			"detail.offPeak": "Off-peak cost",
			"detail.unpriced": "Unpriced calls",
			"detail.calls": "{count} calls",
			"detail.estimate": "Estimated from DeepSeek's official CNY peak/off-peak rates; not a bill.",
			"detail.peakWindows": "Peak: Beijing weekdays 09:00–12:00 and 14:00–18:00; weekends and statutory holidays are off-peak.",
			"detail.approximate": "≈ means the session log is not ready yet; estimated from loaded messages."
		};

		const CSS = [
			".dsh-cost-note{border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);margin:12px 0 0;padding-top:10px}",
			".dsh-cost-note+.dsh-cost-note{border-top:0;margin-top:4px;padding-top:0}"
		].join("");

		/**
		 * Swap one shipped slot entry's component while keeping that entry's
		 * declared children, inject face and locale namespace. Re-registering the
		 * same key/id cannot work: the slot core rejects a second entry at the
		 * same priority, and a new entry cannot re-declare the child slots that
		 * supply `renderSlot`. Overriding the component keeps all of that intact.
		 */
		function overrideEntry(ctx, slotKey, match, component) {
			if (typeof ctx.slots.entries !== "function") {
				console.warn(`cost-display: slots.entries is unavailable; cost UI disabled`);
				return undefined;
			}
			const tryOverride = () => {
				const entry = ctx.slots.entries(slotKey).find(match);
				if (entry === undefined) return undefined;
				const original = entry.component;
				entry.component = component;
				return () => {
					if (entry.component === component) entry.component = original;
				};
			};
			const immediate = tryOverride();
			if (immediate !== undefined) return immediate;
			if (typeof ctx.slots.subscribe !== "function") {
				console.warn(`cost-display: no ${slotKey} entry matched; cost UI disabled`);
				return undefined;
			}
			// The slot is declared before the owning plugin registers its entries in
			// some boot orders. Wait for the entry, then swap it in place.
			let disposeOverride;
			const unsubscribe = ctx.slots.subscribe(slotKey, () => {
				if (disposeOverride !== undefined) return;
				disposeOverride = tryOverride();
				if (disposeOverride !== undefined) unsubscribe();
			});
			// Close the registration race between the first lookup and subscribing.
			disposeOverride = tryOverride();
			if (disposeOverride !== undefined) unsubscribe();
			return () => {
				if (disposeOverride !== undefined) disposeOverride();
				unsubscribe();
			};
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "cost-display: dictionaries");
			const tCost = ctx.locale.bind(NS);
			ctx.effect(() => {
				if (typeof document === "undefined") return undefined;
				const tag = document.createElement("style");
				tag.dataset.plugin = "@inspiring26/dsh-cost-display";
				tag.dataset.pluginCss = "@inspiring26/dsh-cost-display/styles";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					if (typeof tag.remove === "function") tag.remove();
					else if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
				};
			}, "cost-display: styles");
			ctx.effect(() => overrideEntry(ctx, "conversation.chat.node", (entry) => entry.options.key === "turn-tail", (props) => h(TurnTailNodeView, Object.assign({}, props, { tCost }))), "cost-display: turn-tail");
			ctx.effect(() => overrideEntry(ctx, "conversation.composer.dock", (entry) => entry.options.id === "usage", (props) => h(UsagePill, Object.assign({}, props, { tCost }))), "cost-display: usage pill");
		}

		const api = {
			inject: ["slots", "locale"],
			apply
		};

		// Test-only surface, enabled by the package tests via a global flag.
		if (globalThis.__DSH_COST_TEST__ === true) {
			api.__test = {
				request,
				snapshot,
				resolveTurnBucket,
				appendCostRows,
				TurnTailNodeView,
				UsagePill,
				TurnUsagePanel,
				UsageDialog
			};
		}

		return api;
	}
});
