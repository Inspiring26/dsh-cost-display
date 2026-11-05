window.__ModuleLoader__.load({
	id: "@inspiring26/dsh-cost-display",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;

		/*__COST_CORE__*/

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

		/*__CHAT_BRIDGE__*/

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
