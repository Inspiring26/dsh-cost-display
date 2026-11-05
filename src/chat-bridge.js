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
