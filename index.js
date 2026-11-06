/**
 * Host half of the cost-display bundle.
 *
 * The browser half renders the cost UI. This half adds one aggregate route,
 * `/api/cost.summary`, used by the session usage dialog for the global
 * today/month figures: it folds every stored and live DSH session log with the
 * same core the client uses for one session, caches the result briefly, and
 * returns only aggregate amounts. Rendering the log still happens in the
 * browser for the current session; this route never returns prompts or tokens.
 */
import { beijingParts, foldSessionCost } from "./src/cost-core.js";

const SUMMARY_PATH = "/api/cost.summary";
const CACHE_MS = 15000;
const READ_CONCURRENCY = 4;

let cached;
let pending;

function connectionOf(ctx) {
	return Reflect.get(ctx, "connection");
}

function sessionQueryOf(ctx) {
	return typeof ctx.get === "function" ? ctx.get("sessionQuery") : undefined;
}

/** Run one async task per item with a small fixed concurrency. */
async function eachLimit(items, limit, task) {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			await task(items[index]);
		}
	});
	await Promise.all(workers);
}

/**
 * Fold every logical session and sum the Beijing-calendar buckets.
 * A session that cannot be read is skipped and counted; the amount is then a
 * lower bound (`partial`) rather than silently pretending to be complete.
 */
async function computeSummary(ctx) {
	const query = sessionQueryOf(ctx);
	if (query === undefined) throw new Error("session-query service is unavailable");
	const records = await query.listSessions();
	const today = beijingParts(Date.now()).date;
	const monthPrefix = today.slice(0, 7) + "-";
	let todayCost = 0;
	let todayCalls = 0;
	let monthCost = 0;
	let monthCalls = 0;
	let sessions = 0;
	let failed = 0;
	await eachLimit(records, READ_CONCURRENCY, async (record) => {
		try {
			const snapshot = await query.readSession(record.header.id);
			const data = foldSessionCost(snapshot.events, { inheritedEventCount: snapshot.inheritedEventCount });
			sessions += 1;
			const todayBucket = data.byDay[today];
			if (todayBucket !== undefined) {
				todayCost += todayBucket.cost;
				todayCalls += todayBucket.calls;
			}
			for (const [key, bucket] of Object.entries(data.byDay)) {
				if (!key.startsWith(monthPrefix)) continue;
				monthCost += bucket.cost;
				monthCalls += bucket.calls;
			}
		} catch {
			failed += 1;
		}
	});
	return {
		today: { cost: todayCost, calls: todayCalls },
		month: { cost: monthCost, calls: monthCalls },
		asOf: Date.now(),
		sessions,
		failed,
		partial: failed > 0
	};
}

function summary(ctx) {
	const now = Date.now();
	if (cached !== undefined && now - cached.at < CACHE_MS) return Promise.resolve(cached.value);
	if (pending !== undefined) return pending;
	pending = computeSummary(ctx)
		.then((value) => {
			cached = { at: Date.now(), value };
			return value;
		})
		.finally(() => {
			pending = undefined;
		});
	return pending;
}

export const inject = ["connection"];

export function apply(ctx) {
	const connection = connectionOf(ctx);
	if (connection === undefined || connection.fetch === undefined) {
		ctx.logger?.warn?.("cost-display: connection.fetch is unavailable; global cost summary disabled");
		return;
	}
	connection.fetch.register({
		path: SUMMARY_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: async () => {
			try {
				const value = await summary(ctx);
				return Response.json(value, { headers: { "cache-control": "no-store" } });
			} catch (error) {
				ctx.logger?.warn?.(`cost-display: global cost summary failed: ${error instanceof Error ? error.message : String(error)}`);
				return new Response("global cost summary unavailable", { status: 503 });
			}
		}
	});
}
