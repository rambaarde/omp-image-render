/**
 * omp-image-render: show images and play videos inside the omp terminal.
 *
 * Registers two model tools (`show_image`, `show_video`) and three commands
 * (`/img`, `/video`, `/media`). Pictures are drawn with the kitty graphics protocol
 * through omp's own Image component, so they cost no model tokens: the model only
 * receives a one-line text confirmation. Videos play in a full-screen player with a
 * timeline, change markers, live checks, synced before/after, and version history.
 *
 * Needs a kitty-protocol terminal (Ghostty, kitty, WezTerm, Warp) and ffmpeg.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, Container, Image, type ImageBudget, Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import {
	addHistory,
	type Check,
	framePath,
	type HistoryEntry,
	type Marker,
	pngSize,
	prepareImage,
	prepareVideo,
	readHistory,
	resolvePath,
	saveToDownloads,
	trimCache,
	VIDEO_EXT,
	versionsOf,
} from "./media";
import { imageLeftPad, VideoPlayer } from "./player";

const IMAGE_MESSAGE = "omp-image-render.image";
/** Rows a picture may take in the transcript before it is scaled down. */
const TRANSCRIPT_IMAGE_ROWS = 24;
/** Widget key used once per session to borrow the TUI; removed right after. */
const PROBE_WIDGET = "omp-image-render.probe";
/** The TUI's inline-image budget. One TUI per process, so one module-level handle. */
let imageBudget: ImageBudget | undefined;

/** What the image renderers need to draw a saved picture. */
interface ImageView {
	png: string;
	/** Stable graphics key for this card, so a re-render replaces the picture instead of stacking a copy. */
	key?: string;
	title: string;
	labels: string[];
	version: number;
	versions: number;
}

/** What the video result renderer needs: a poster frame and the review notes. */
interface VideoView {
	poster: string;
	/** Stable graphics key for this card (see ImageView.key). */
	key?: string;
	title: string;
	url?: string;
	duration: number;
	version: number;
	versions: number;
	compare: boolean;
	changes: Marker[];
	checks: Check[];
}

/** The colouring the renderers use; matches omp's Theme.fg. */
interface Fg {
	fg(color: "accent" | "dim" | "muted" | "success" | "error" | "text", text: string): string;
}

/** Footer actions under every picture card; each one is a `/img` subcommand on the latest picture. */
const CARD_ACTIONS = "↗ /img view · /img save · /img copy";

/**
 * A framed picture: a top rule with the title and the pixel size, the picture, and a bottom
 * rule with the actions. Side borders are left out on purpose: kitty placements draw from
 * the cursor column, so a left border would shift the picture and a right one cannot be
 * aligned to its unknown width.
 */
class PictureCard implements Component {
	#theme: Fg;
	#title: string;
	#meta: string;
	#footer: string;
	#body: Component;
	/** Picture size in pixels; undefined when the cached PNG is gone and the body is text. */
	#size: { widthPx: number; heightPx: number } | undefined;

	constructor(theme: Fg, png: string, key: string, title: string, meta: string, footer: string) {
		this.#theme = theme;
		this.#title = title;
		this.#meta = meta;
		this.#footer = footer;
		this.#size = fs.existsSync(png) ? pngSize(png) : undefined;
		this.#body = this.#size
			? new Image(
					fs.readFileSync(png).toString("base64"),
					"image/png",
					{ fallbackColor: s => theme.fg("dim", s) },
					// The TUI's budget gives the picture a stable kitty id: repaints move one placement
					// and scrolled-away copies are purged. Without it every redraw left a ghost copy.
					{ maxHeightCells: TRANSCRIPT_IMAGE_ROWS, filename: path.basename(png), budget: imageBudget, imageKey: `omp-image-render:${key}` },
					this.#size,
				)
			: new Text(theme.fg("dim", "(picture no longer in cache)"), 0, 0);
	}

	/** `╭─ left ──── right ─╮`-style rule; the left part is cut first when the row is narrow. */
	#rule(width: number, open: string, close: string, left: string, right: string): string {
		const t = this.#theme;
		const rightPart = right ? ` ${right} ` : "";
		const room = Math.max(0, width - 4 - visibleWidth(rightPart));
		const leftPart = truncateToWidth(` ${left} `, room);
		const fill = "─".repeat(Math.max(0, width - 4 - visibleWidth(leftPart) - visibleWidth(rightPart)));
		return t.fg("dim", `${open}─`) + leftPart + t.fg("dim", fill) + t.fg("muted", rightPart) + t.fg("dim", `─${close}`);
	}

	render(width: number): readonly string[] {
		const pad = " ".repeat(this.#size ? imageLeftPad(width, this.#size, TRANSCRIPT_IMAGE_ROWS) : 0);
		return [
			this.#rule(width, "╭", "╮", this.#title, this.#meta),
			...this.#body.render(width).map(line => pad + line),
			this.#rule(width, "╰", "╯", this.#theme.fg("dim", this.#footer), ""),
		];
	}

	invalidate(): void {
		this.#body.invalidate?.();
	}
}

/** The card for a saved picture: title, how many pictures it holds, version, and pixel size. */
function imageCard(theme: Fg, view: ImageView): PictureCard {
	const count = view.labels.length;
	const what = view.labels[0] === "Before" ? "before | after" : count > 1 ? `${count} images` : "";
	const version = view.versions > 1 ? `v${view.version} of ${view.versions}` : "";
	const title = [theme.fg("accent", view.title), what, version].filter(Boolean).join(theme.fg("dim", " · "));
	const size = fs.existsSync(view.png) ? pngSize(view.png) : undefined;
	return new PictureCard(theme, view.png, view.key ?? view.png, title, size ? `${size.widthPx}×${size.heightPx}` : "", CARD_ACTIONS);
}

/** Prepare a picture, save it as a version, and return its view. */
async function showImage(cwd: string, inputPaths: string[], title: string | undefined, compare?: string): Promise<ImageView> {
	const paths = [...(compare ? [compare] : []), ...inputPaths].map(p => resolvePath(p, cwd));
	const png = await prepareImage(paths);
	// Several pictures without a title are named after their folder; the card adds the count.
	const last = paths[paths.length - 1];
	const name = title ?? (paths.length > 1 && !compare ? path.basename(path.dirname(last)) : path.basename(last));
	addHistory({ kind: "image", title: name, createdAt: Date.now(), output: png, source: last, compare: compare ? paths[0] : undefined });
	trimCache();
	const versions = versionsOf({ kind: "image", title: name });
	const labels = compare ? ["Before", "After"] : paths.map(p => path.basename(p));
	return { png, key: crypto.randomUUID(), title: name, labels, version: versions.length, versions: versions.length };
}

/** Prepare a clip and save it as a version; returns the history entry. */
async function prepareEntry(
	cwd: string,
	file: string,
	opts: { compare?: string; title?: string; url?: string; changes?: Marker[]; checks?: Check[] },
	onProgress?: (text: string) => void,
): Promise<HistoryEntry> {
	const source = resolvePath(file, cwd);
	const compare = opts.compare ? resolvePath(opts.compare, cwd) : undefined;
	const video = await prepareVideo(source, compare, onProgress);
	const entry: HistoryEntry = {
		kind: "video",
		title: opts.title ?? path.basename(source),
		createdAt: Date.now(),
		output: video.frameDir,
		source,
		compare,
		video,
		changes: [...(opts.changes ?? [])].sort((a, b) => a.at - b.at),
		checks: opts.checks ?? [],
		url: opts.url,
	};
	addHistory(entry);
	trimCache();
	return entry;
}

/** Open the full-screen player without blocking the caller; only in the interactive TUI. */
function openPlayer(ctx: ExtensionContext, entry: HistoryEntry): boolean {
	if (ctx.mode !== "tui" || !ctx.hasUI) return false;
	const saved = versionsOf(entry);
	const versions = saved.length ? saved : [entry];
	const index = Math.max(0, versions.findIndex(v => v.createdAt === entry.createdAt));
	ctx.ui
		.custom<void>((tui, theme, _keys, done) => new VideoPlayer(tui, theme, versions, index, () => done()), {
			overlay: true,
			overlayOptions: { fullscreen: true, anchor: "top-left", width: "100%", maxHeight: "100%" },
		})
		.catch(err => ctx.ui.notify(`Player failed: ${err instanceof Error ? err.message : String(err)}`, "error"));
	return true;
}

export default function ompImageRender(pi: ExtensionAPI) {
	const z = pi.zod;
	pi.setLabel("omp-image-render");

	// Extensions get no TUI handle in tool renderers, so borrow it once: a widget factory runs
	// synchronously with the TUI, then the empty widget is removed in the same tick.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		ctx.ui.setWidget(PROBE_WIDGET, tui => {
			imageBudget = tui.imageBudget;
			return { render: () => [] };
		});
		ctx.ui.setWidget(PROBE_WIDGET, undefined);
	});

	pi.registerMessageRenderer<ImageView>(IMAGE_MESSAGE, (message, _opts, theme) =>
		message.details ? imageCard(theme, message.details) : undefined,
	);

	pi.registerTool({
		name: "show_image",
		label: "Show image",
		// Always in the tool list, so the agent calls it directly instead of looking it up first.
		loadMode: "essential",
		description: [
			"Show one or more images to the user, inline in the terminal. The user sees the picture; you receive only a confirmation.",
			"Use this tool after you make or change something visual: a screenshot, a design, a chart, a generated image.",
			"Give several paths to show them side by side, for example design directions or breakpoints.",
			"Give `compare` (the old image) to show before and after side by side.",
			"Use the same `title` for new versions of the same work, so the versions stay together.",
		].join(" "),
		parameters: z.object({
			paths: z.array(z.string()).min(1).describe("Image files (PNG, JPEG, WebP, ...). Relative paths start at the working directory."),
			title: z.string().optional().describe("Name of the work. Default: the file name."),
			compare: z.string().optional().describe("Old image for a before/after view. It shows on the left."),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Preparing image…" }] });
			const view = await showImage(ctx.cwd, params.paths, params.title, params.compare);
			return {
				content: [{ type: "text", text: `Shown to the user: "${view.title}" (${view.labels.length} image(s), version ${view.version}).` }],
				details: view,
			};
		},
		renderResult(result, options, theme) {
			const view = result.details as ImageView | undefined;
			if (options.isPartial || !view) return new Text(theme.fg("dim", "Preparing image…"), 0, 0);
			return imageCard(theme, view);
		},
	});

	pi.registerTool({
		name: "show_video",
		label: "Show video",
		loadMode: "essential",
		description: [
			"Play a video to the user in a full-screen terminal player. The user sees the video; you receive only a confirmation.",
			"Use this tool for screen recordings, Playwright test runs, animations, and ads.",
			"For a bug fix or a change, record the same steps on the old and the new version. Give the old recording as `compare`: the player shows both side by side, in sync.",
			"Give `changes` with the second where each change shows, and `summary` with the test results. A check with `at` shows its result when playback reaches that second.",
			"Use the same `title` for new versions of the same work.",
		].join(" "),
		parameters: z.object({
			path: z.string().describe("The video (MP4, MOV, WebM, GIF, ...). For a before/after, this is the new version."),
			compare: z.string().optional().describe("The same steps recorded on the old version. It shows on the left."),
			title: z.string().optional().describe("Name of the work. Default: the file name."),
			url: z.string().optional().describe("The page that was recorded."),
			changes: z
				.array(z.object({ title: z.string(), at: z.number().min(0).describe("Second where the change shows.") }))
				.optional()
				.describe("What changed, and when it shows in the video."),
			summary: z
				.array(
					z.object({
						label: z.string(),
						ok: z.boolean(),
						passed: z.number().int().min(0).optional(),
						total: z.number().int().min(0).optional(),
						at: z.number().min(0).optional().describe("Second where the recording reaches this check."),
					}),
				)
				.optional()
				.describe("Test results. Keep it to three lines or fewer."),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			const entry = await prepareEntry(
				ctx.cwd,
				params.path,
				{ compare: params.compare, title: params.title, url: params.url, changes: params.changes, checks: params.summary },
				text => onUpdate?.({ content: [{ type: "text", text }] }),
			);
			const video = entry.video!;
			const versions = versionsOf(entry).length;
			const opened = openPlayer(ctx, entry);
			const view: VideoView = {
				key: crypto.randomUUID(),
				poster: framePath(video, Math.min(video.frameCount - 1, Math.round((entry.changes?.[0]?.at ?? 0) * video.fps))),
				title: entry.title,
				url: entry.url,
				duration: video.duration,
				version: versions,
				versions,
				compare: !!entry.compare,
				changes: entry.changes ?? [],
				checks: entry.checks ?? [],
			};
			const how = opened ? "Opened in the player" : "Prepared (no interactive terminal, so the player did not open)";
			return {
				content: [
					{
						type: "text",
						text: `${how}: "${entry.title}", ${video.duration.toFixed(1)}s, version ${versions}${entry.compare ? ", before/after" : ""}. The user can replay it with /video.`,
					},
				],
				details: view,
			};
		},
		renderResult(result, options, theme) {
			const view = result.details as VideoView | undefined;
			if (options.isPartial || !view) {
				const text = result.content.find(c => c.type === "text");
				return new Text(theme.fg("dim", text && "text" in text ? text.text : "Preparing video…"), 0, 0);
			}
			const title = [
				theme.fg("accent", `▶ ${view.title}`),
				view.compare ? "before | after" : "",
				view.versions > 1 ? `v${view.version} of ${view.versions}` : "",
			]
				.filter(Boolean)
				.join(theme.fg("dim", " · "));
			const meta = `${view.duration.toFixed(1)}s${view.url ? ` · ${view.url}` : ""}`;
			const box = new Container();
			box.addChild(new PictureCard(theme, view.poster, view.key ?? view.poster, title, meta, "▶ /video replays it · /media lists every version"));
			for (const c of view.changes) box.addChild(new Text(theme.fg("text", `  ◆ ${c.at.toFixed(1)}s  ${c.title}`), 0, 0));
			for (const c of view.checks) {
				const count = c.total !== undefined ? `  ${c.passed ?? 0}/${c.total}` : "";
				box.addChild(new Text(theme.fg(c.ok ? "success" : "error", `  ${c.ok ? "✓" : "✗"} ${c.label}${count}`), 0, 0));
			}
			return box;
		},
	});

	pi.registerCommand("img", {
		description: "Show an image inline: /img <path> [more paths]; /img view|save|copy acts on the latest picture",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "view" || action === "save" || action === "copy") {
				const latest = readHistory().filter(e => e.kind === "image" && fs.existsSync(e.output)).at(-1);
				if (!latest) return ctx.ui.notify("No picture yet. Usage: /img <path>", "warning");
				if (action === "view") {
					Bun.spawn(["open", latest.output], { stdout: "ignore", stderr: "ignore" });
					return ctx.ui.notify(`Opened ${latest.title} in Preview`, "info");
				}
				if (action === "save") return ctx.ui.notify(`Saved to ${saveToDownloads(latest.output, latest.title)}`, "info");
				const copy = Bun.spawn(["pbcopy"], { stdin: new Blob([latest.output]) });
				await copy.exited;
				return ctx.ui.notify(`Copied ${latest.output}`, "info");
			}
			const paths = action.split(/\s+(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/).filter(Boolean);
			if (paths.length === 0) return ctx.ui.notify("Usage: /img <path> [path ...] or /img view|save|copy", "warning");
			if (paths.some(p => VIDEO_EXT.test(p))) return ctx.ui.notify("That is a video. Use /video <path>.", "warning");
			try {
				const view = await showImage(ctx.cwd, paths, undefined);
				pi.sendMessage({ customType: IMAGE_MESSAGE, content: `Showed ${view.title} to the user.`, display: true, details: view });
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	pi.registerCommand("video", {
		description: "Play a video: /video <path> [--compare <old>]; no path replays the latest video",
		handler: async (args, ctx) => {
			const match = /^(.*?)(?:\s+--compare\s+(.+))?$/.exec(args.trim());
			const file = match?.[1]?.trim();
			try {
				if (!file) {
					const latest = readHistory().filter(e => e.kind === "video" && fs.existsSync(e.output)).at(-1);
					if (!latest) return ctx.ui.notify("No video yet. Usage: /video <path>", "warning");
					openPlayer(ctx, latest);
					return;
				}
				ctx.ui.notify("Preparing video…", "info");
				openPlayer(ctx, await prepareEntry(ctx.cwd, file, { compare: match?.[2]?.trim() }));
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	pi.registerCommand("media", {
		description: "Pick any saved image or video version to show again",
		handler: async (_args, ctx) => {
			const entries = readHistory()
				.filter(e => fs.existsSync(e.output))
				.reverse();
			if (entries.length === 0) return ctx.ui.notify("Nothing shown yet.", "info");
			const labels = entries.map(e => `${e.kind === "video" ? "▶" : "▣"} ${e.title}  ·  ${new Date(e.createdAt).toLocaleString()}`);
			const picked = await ctx.ui.select("Saved media", labels);
			const entry = picked ? entries[labels.indexOf(picked)] : undefined;
			if (!entry) return;
			if (entry.kind === "video") {
				openPlayer(ctx, entry);
				return;
			}
			const versions = versionsOf(entry);
			const view: ImageView = {
				png: entry.output,
				key: crypto.randomUUID(),
				title: entry.title,
				labels: entry.compare ? ["Before", "After"] : [path.basename(entry.source)],
				version: versions.findIndex(v => v.createdAt === entry.createdAt) + 1,
				versions: versions.length,
			};
			pi.sendMessage({ customType: IMAGE_MESSAGE, content: `Showed ${entry.title} to the user.`, display: true, details: view });
		},
	});
}
