/**
 * Full-screen video player for omp-image-render.
 *
 * Plays a prepared clip (PNG frames) as kitty graphics on the alternate screen, with a
 * timeline, change markers you can jump to, checks that resolve as playback reaches
 * them, a synced before/after layout, and stepping through earlier versions.
 */
import * as fs from "node:fs";
import { type Component, getCellDimensions, Image, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { framePath, type HistoryEntry, saveToDownloads } from "./media";

/** The theme surface the player needs: foreground colouring only. */
interface PlayerTheme {
	fg(color: "accent" | "dim" | "muted" | "success" | "error" | "warning" | "text", text: string): string;
}

/** Rows used by everything except the picture: header, labels, timeline, hints, gaps. */
const CHROME_ROWS = 7;
const SEEK_SECONDS = 5;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Columns of left padding that center a picture in a row of `width` cells.
 * Mirrors pi-tui's image fit: Image caps the width at `width - 2` and the height at
 * `maxRows`, then keeps the aspect ratio. Kitty draws from the cursor column, so leading
 * spaces on every image row move the picture right.
 */
export function imageLeftPad(width: number, size: { widthPx: number; heightPx: number }, maxRows: number): number {
	const cell = getCellDimensions();
	const maxCols = Math.max(1, width - 2);
	const scale = Math.min((maxCols * cell.widthPx) / size.widthPx, (maxRows * cell.heightPx) / size.heightPx);
	const cols = Math.min(maxCols, Math.max(1, Math.floor((size.widthPx * scale) / cell.widthPx)));
	return Math.max(0, Math.floor((width - cols) / 2));
}

/**
 * Overlay component that plays one version and can step to the others.
 * `versions` must be video entries of the same title, oldest first.
 */
export class VideoPlayer implements Component {
	#tui: TUI;
	#theme: PlayerTheme;
	#versions: HistoryEntry[];
	#versionIndex: number;
	#done: () => void;
	#frame = 0;
	#playing = true;
	#timer: Timer | undefined;
	#image: Image | undefined;
	#imageFrame = -1;
	#status = "";

	constructor(tui: TUI, theme: PlayerTheme, versions: HistoryEntry[], versionIndex: number, done: () => void) {
		this.#tui = tui;
		this.#theme = theme;
		this.#versions = versions;
		this.#versionIndex = versionIndex;
		this.#done = done;
		this.#startTimer();
	}

	get #entry(): HistoryEntry {
		return this.#versions[this.#versionIndex];
	}

	get #video() {
		const video = this.#entry.video;
		if (!video) throw new Error("History entry has no prepared video");
		return video;
	}

	/** Advance one frame per tick; stop on the last frame. Errors stop playback, not omp. */
	#startTimer(): void {
		this.#stopTimer();
		this.#timer = setInterval(() => {
			try {
				if (!this.#playing) return;
				if (this.#frame >= this.#video.frameCount - 1) {
					this.#playing = false;
				} else {
					this.#frame++;
				}
				this.#tui.requestRender();
			} catch (err) {
				this.#playing = false;
				this.#status = `Playback stopped: ${err instanceof Error ? err.message : String(err)}`;
			}
		}, 1000 / this.#video.fps);
	}

	#stopTimer(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#seek(seconds: number): void {
		const target = Math.round(seconds * this.#video.fps);
		this.#frame = Math.max(0, Math.min(this.#video.frameCount - 1, target));
	}

	#switchVersion(delta: number): void {
		const next = this.#versionIndex + delta;
		if (next < 0 || next >= this.#versions.length) return;
		this.#versionIndex = next;
		this.#frame = 0;
		this.#playing = true;
		this.#imageFrame = -1;
		this.#startTimer();
	}

	handleInput(data: string): void {
		const video = this.#video;
		const now = this.#frame / video.fps;
		const changes = this.#entry.changes ?? [];
		if (matchesKey(data, "escape") || data === "q") {
			this.dispose();
			this.#done();
			return;
		}
		if (matchesKey(data, "space")) {
			if (!this.#playing && this.#frame >= video.frameCount - 1) this.#frame = 0;
			this.#playing = !this.#playing;
		} else if (matchesKey(data, "left")) {
			this.#seek(now - SEEK_SECONDS);
		} else if (matchesKey(data, "right")) {
			this.#seek(now + SEEK_SECONDS);
		} else if (data === ",") {
			this.#playing = false;
			this.#seek((this.#frame - 1) / video.fps);
		} else if (data === ".") {
			this.#playing = false;
			this.#seek((this.#frame + 1) / video.fps);
		} else if (/^[1-9]$/.test(data) && changes[Number(data) - 1]) {
			this.#seek(changes[Number(data) - 1].at);
		} else if (data === "[") {
			this.#switchVersion(-1);
		} else if (data === "]") {
			this.#switchVersion(1);
		} else if (data === "o") {
			const files = [this.#entry.compare, this.#entry.source].filter((f): f is string => !!f);
			Bun.spawn(["open", "-a", "QuickTime Player", ...files], { stdout: "ignore", stderr: "ignore" });
			this.#status = "Opened in QuickTime Player";
		} else if (data === "s") {
			try {
				this.#status = `Saved to ${saveToDownloads(this.#entry.source, this.#entry.title)}`;
			} catch (err) {
				this.#status = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
			}
		} else {
			return;
		}
		this.#tui.requestRender();
	}

	/** The current frame as an Image; a new frame gets a new graphics id so it retransmits. */
	#frameImage(width: number, maxRows: number): Image {
		if (!this.#image || this.#imageFrame !== this.#frame) {
			const video = this.#video;
			const data = fs.readFileSync(framePath(video, this.#frame)).toString("base64");
			this.#image = new Image(
				data,
				"image/png",
				{ fallbackColor: s => this.#theme.fg("dim", s) },
				{
					budget: this.#tui.imageBudget,
					imageKey: `omp-image-render:${video.key}:${this.#frame}`,
					maxWidthCells: width,
					maxHeightCells: maxRows,
				},
				{ widthPx: video.widthPx, heightPx: video.heightPx },
			);
			this.#imageFrame = this.#frame;
		}
		return this.#image;
	}

	/** One-row timeline with a playhead and a ◆ at every change marker. */
	#timeline(width: number): string {
		const video = this.#video;
		const label = ` ${clock(this.#frame / video.fps)} / ${clock(video.duration)}`;
		const icon = this.#playing ? "▶ " : "❚❚ ";
		const barWidth = Math.max(10, width - visibleWidth(icon) - label.length);
		const head = Math.round((this.#frame / Math.max(1, video.frameCount - 1)) * (barWidth - 1));
		const marks = new Set((this.#entry.changes ?? []).map(c => Math.round((c.at / video.duration) * (barWidth - 1))));
		let bar = "";
		for (let i = 0; i < barWidth; i++) {
			if (i === head) bar += this.#theme.fg("accent", "●");
			else if (marks.has(i)) bar += this.#theme.fg("warning", "◆");
			else bar += i < head ? this.#theme.fg("accent", "━") : this.#theme.fg("dim", "─");
		}
		return icon + bar + this.#theme.fg("muted", label);
	}

	render(width: number): readonly string[] {
		const t = this.#theme;
		const entry = this.#entry;
		const video = this.#video;
		const now = this.#frame / video.fps;
		const changes = entry.changes ?? [];
		const checks = entry.checks ?? [];
		const lines: string[] = [];

		const version = this.#versions.length > 1 ? t.fg("muted", `  v${this.#versionIndex + 1} of ${this.#versions.length}`) : "";
		lines.push(truncateToWidth(t.fg("accent", entry.title) + version + (entry.url ? t.fg("dim", `  ${entry.url}`) : ""), width));
		if (entry.compare) {
			const half = Math.floor(width / 2);
			lines.push(t.fg("muted", "Before".padEnd(half)) + t.fg("muted", "After"));
		}

		const sideRows = changes.length + checks.length + (changes.length ? 1 : 0) + (checks.length ? 1 : 0);
		const maxRows = Math.max(6, this.#tui.terminal.rows - CHROME_ROWS - sideRows);
		const pad = " ".repeat(imageLeftPad(width, { widthPx: video.widthPx, heightPx: video.heightPx }, maxRows));
		lines.push(...this.#frameImage(width, maxRows).render(width).map(line => pad + line));

		lines.push(this.#timeline(width));
		if (changes.length) {
			lines.push(t.fg("muted", "Changes"));
			changes.forEach((c, i) => {
				const reached = now >= c.at;
				const row = `${i + 1}  ${clock(c.at)}  ${c.title}`;
				lines.push(truncateToWidth(reached ? t.fg("text", row) : t.fg("dim", row), width));
			});
		}
		if (checks.length) {
			lines.push(t.fg("muted", "Checks"));
			for (const c of checks) {
				const reached = c.at === undefined || now >= c.at;
				const count = c.total !== undefined ? `  ${c.passed ?? 0}/${c.total}` : "";
				const row = reached
					? t.fg(c.ok ? "success" : "error", `${c.ok ? "✓" : "✗"} ${c.label}${count}`)
					: t.fg("dim", `○ ${c.label}`);
				lines.push(truncateToWidth(row, width));
			}
		}
		if (this.#status) lines.push(truncateToWidth(t.fg("warning", this.#status), width));
		lines.push(
			truncateToWidth(
				t.fg("dim", "space play/pause · ←/→ 5s · ,/. frame · 1-9 change · [/] version · o QuickTime · s save · q close"),
				width,
			),
		);
		return lines;
	}

	invalidate(): void {
		this.#image?.invalidate();
	}

	dispose(): void {
		this.#stopTimer();
	}
}
