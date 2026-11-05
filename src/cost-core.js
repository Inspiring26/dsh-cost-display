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
export const OFFICIAL_MODELS = [
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
export const PEAK_WINDOWS = [
  [9, 12],
  [14, 18],
];

/** 中国法定节假日（北京日期，YYYY-MM-DD）。这些日子全天按空闲价计。 */
export const DEFAULT_HOLIDAYS = [
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
export function beijingParts(time) {
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
export function isPeakBeijing(time, holidays = DEFAULT_HOLIDAYS) {
  const parts = beijingParts(time);
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  if (holidays.includes(parts.date)) return false;
  return PEAK_WINDOWS.some(([from, to]) => parts.hour >= from && parts.hour < to);
}

/** 匹配官方模型（大小写不敏感，精确 id/别名，不做子串猜测）。 */
export function matchOfficialModel(model) {
  const name = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (name === "") return null;
  for (const row of OFFICIAL_MODELS) {
    if (row.id === name || row.aliases.includes(name)) return row;
  }
  return null;
}

/** 峰时时段的可读写法。 */
export function peakWindowsText(separator = "、") {
  return PEAK_WINDOWS.map(([from, to]) => `${String(from).padStart(2, "0")}:00–${String(to).padStart(2, "0")}:00`).join(separator);
}

/** 人民币费用的紧凑显示。 */
export function formatCny(cost) {
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
export function priceUsage(usage, model, at, holidays = DEFAULT_HOLIDAYS) {
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
export function computeSessionCost(jsonl, options = {}) {
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
export function estimateTurnCost(usage, route, at, holidays = DEFAULT_HOLIDAYS) {
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
export async function parseZipRootLog(input, inflateRaw) {
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
export async function readRootLogFromExportResponse(response, options = {}) {
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
