/**
 * Zoom viewer for omp-image-render. The Herdr plugin runs it in a popup when you
 * Ctrl+click a picture card title in omp; `OMP_IMG_URL` is the clicked `file://` URL.
 *
 * The PNG is sent to the terminal once (kitty graphics). Zoom and pan only re-place it
 * with a kitty source rectangle (`x,y,w,h`), so the terminal crops at full resolution
 * and nothing is re-encoded.
 *
 * Keys: + / - zoom, arrows or h j k l pan, 0 fit, o open in Preview, q or Esc close.
 * Mouse: the wheel (or a two-finger trackpad scroll) zooms toward the pointer, and a left
 * drag moves the picture.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pngSize, readHistory } from "../media";

const IMAGE_ID = 1;
const PLACEMENT_ID = 1;
const ZOOM_STEP = 1.5;
/** Smaller step for the wheel: one trackpad gesture sends many wheel events. */
const WHEEL_STEP = 1.15;
/** Deepest zoom: screen pixels per picture pixel. */
const MAX_SCALE = 8;
/** One arrow press moves this share of the visible part. */
const PAN_SHARE = 0.2;
/** Rows outside the picture: the header and the key hints. */
const CHROME_ROWS = 2;

const out = (s: string) => process.stdout.write(s);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const file = fileURLToPath(process.env.OMP_IMG_URL ?? "");
const size = pngSize(file);
const title = readHistory().findLast(e => e.output === file)?.title ?? "picture";
const base64 = fs.readFileSync(file).toString("base64");

process.stdin.setRawMode(true);
process.stdin.resume();

/**
 * Cell size in pixels from the terminal (`CSI 16 t` → `CSI 6 ; h ; w t`).
 * ponytail: falls back to an 8×16 cell when the terminal does not answer in 300 ms;
 * only the aspect ratio matters, so a wrong guess stretches the picture slightly.
 */
const cell = await new Promise<{ w: number; h: number }>(resolve => {
	const done = (v: { w: number; h: number }) => {
		clearTimeout(timer);
		process.stdin.off("data", onData);
		resolve(v);
	};
	const onData = (d: Buffer) => {
		const m = /\x1b\[6;(\d+);(\d+)t/.exec(d.toString());
		if (m) done({ h: Number(m[1]), w: Number(m[2]) });
	};
	const timer = setTimeout(() => done({ w: 8, h: 16 }), 300);
	process.stdin.on("data", onData);
	out("\x1b[16t");
});

let zoom = 1;
let cx = size.widthPx / 2;
let cy = size.heightPx / 2;
let status = "";
/** Where the picture was last placed, in cells, and the source rectangle it shows. Maps the pointer to picture pixels. */
let placed = { col: 1, row: 1, c: 1, r: 1, x: 0, y: 0, sw: size.widthPx, sh: size.heightPx };
/** Pointer cell and picture center when a left drag started. */
let drag: { mx: number; my: number; cx: number; cy: number } | undefined;

/**
 * Clear the screen and send the picture. A screen clear deletes kitty images in Herdr,
 * so the send comes after it. Autowrap is off, so a long title cannot spill onto the picture.
 * Mouse reports are on (button and drag tracking, SGR encoding) for wheel zoom and drag pan.
 */
function transmit(): void {
	let s = "\x1b[?25l\x1b[?7l\x1b[?1002h\x1b[?1006h\x1b[2J";
	for (let i = 0; i < base64.length; i += 4096) {
		const lead = i === 0 ? `a=t,f=100,i=${IMAGE_ID},` : "";
		s += `\x1b_G${lead}q=2,m=${i + 4096 < base64.length ? 1 : 0};${base64.slice(i, i + 4096)}\x1b\\`;
	}
	out(s);
}

/** Visible picture rectangle and its cell size for the current zoom, pan and terminal size. */
function view() {
	const cols = process.stdout.columns;
	const rows = Math.max(1, process.stdout.rows - CHROME_ROWS);
	const areaW = cols * cell.w;
	const areaH = rows * cell.h;
	const fit = Math.min(areaW / size.widthPx, areaH / size.heightPx);
	zoom = clamp(zoom, 1, Math.max(1, MAX_SCALE / fit));
	const scale = fit * zoom;
	const sw = Math.min(size.widthPx, areaW / scale);
	const sh = Math.min(size.heightPx, areaH / scale);
	cx = clamp(cx, sw / 2, size.widthPx - sw / 2);
	cy = clamp(cy, sh / 2, size.heightPx - sh / 2);
	return {
		cols,
		rows,
		sw,
		sh,
		x: Math.round(cx - sw / 2),
		y: Math.round(cy - sh / 2),
		c: clamp(Math.round((sw * scale) / cell.w), 1, cols),
		r: clamp(Math.round((sh * scale) / cell.h), 1, rows),
	};
}

/** Header, the picture placement (same ids, so it replaces the last one), and the key hints. */
function draw(): void {
	const v = view();
	const col = Math.floor((v.cols - v.c) / 2) + 1;
	const row = Math.floor((v.rows - v.r) / 2) + 2;
	placed = { col, row, c: v.c, r: v.r, x: v.x, y: v.y, sw: v.sw, sh: v.sh };
	const zoomText = zoom === 1 ? "fit" : `${zoom.toFixed(1)}×`;
	const header = `\x1b[1m${title}\x1b[0m  \x1b[2m${size.widthPx}×${size.heightPx} · ${zoomText}\x1b[0m  ${status}`;
	const hints = "\x1b[2m+/- or wheel zoom · drag or arrows/hjkl pan · 0 fit · o Preview · q close\x1b[0m";
	const place = `a=p,q=2,C=1,i=${IMAGE_ID},p=${PLACEMENT_ID},x=${v.x},y=${v.y},w=${Math.round(v.sw)},h=${Math.round(v.sh)},c=${v.c},r=${v.r}`;
	out(`\x1b[1;1H\x1b[2K${header}\x1b[${row};${col}H\x1b_G${place}\x1b\\\x1b[${v.rows + 2};1H\x1b[2K${hints}`);
}

function quit(): void {
	out(`\x1b_Ga=d,d=I,i=${IMAGE_ID},q=2\x1b\\\x1b[?1002l\x1b[?1006l\x1b[?7h\x1b[?25h`);
	process.stdin.setRawMode(false);
	process.exit(0);
}

/** Pan by a share of the visible part, so a press moves the same amount at every zoom. */
function pan(dx: number, dy: number): void {
	const v = view();
	cx += dx * v.sw * PAN_SHARE;
	cy += dy * v.sh * PAN_SHARE;
}

/** Zoom by `factor` and keep picture point (ix, iy) at the same place on screen. */
function zoomAt(factor: number, ix: number, iy: number): void {
	const before = zoom;
	zoom *= factor;
	view(); // clamps zoom to its limits
	const k = before / zoom;
	cx = ix + (cx - ix) * k;
	cy = iy + (cy - iy) * k;
}

/** SGR mouse reports, arrow keys in normal (`ESC [`) and application (`ESC O`) cursor mode, then single characters. */
const KEYS = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b[[O][A-D]|[^]/g;

/** Handle one SGR mouse report: wheel zooms toward the pointer, a left drag moves the picture. */
function mouse(button: number, mx: number, my: number, release: boolean): void {
	const pxPerCol = placed.sw / placed.c;
	const pxPerRow = placed.sh / placed.r;
	const base = button & ~28; // drop the shift, alt and ctrl bits
	if (base === 64 || base === 65) {
		const ix = clamp(placed.x + (mx - placed.col + 0.5) * pxPerCol, 0, size.widthPx);
		const iy = clamp(placed.y + (my - placed.row + 0.5) * pxPerRow, 0, size.heightPx);
		zoomAt(base === 64 ? WHEEL_STEP : 1 / WHEEL_STEP, ix, iy);
	} else if (base === 66 || base === 67) {
		pan(base === 66 ? -0.25 : 0.25, 0);
	} else if (base === 0 && !release) {
		drag = { mx, my, cx, cy };
	} else if (base === 32 && drag) {
		cx = drag.cx - (mx - drag.mx) * pxPerCol;
		cy = drag.cy - (my - drag.my) * pxPerRow;
	} else if (release) {
		drag = undefined;
	}
}

// Fast key repeat, a paste or a trackpad gesture can deliver several events in one chunk.
process.stdin.on("data", (d: Buffer) => {
	status = "";
	for (const m of d.toString().matchAll(KEYS)) {
		const key = m[0];
		if (m[1]) {
			mouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === "m");
			continue;
		}
		const arrow = key.length === 3 ? key[2] : "";
		if (key === "q" || key === "\x1b" || key === "\x03") return quit();
		if (key === "+" || key === "=") zoomAt(ZOOM_STEP, cx, cy);
		else if (key === "-" || key === "_") zoomAt(1 / ZOOM_STEP, cx, cy);
		else if (key === "0") {
			zoom = 1;
			cx = size.widthPx / 2;
			cy = size.heightPx / 2;
		} else if (arrow === "D" || key === "h") pan(-1, 0);
		else if (arrow === "C" || key === "l") pan(1, 0);
		else if (arrow === "A" || key === "k") pan(0, -1);
		else if (arrow === "B" || key === "j") pan(0, 1);
		else if (key === "o") {
			Bun.spawn(["open", file], { stdout: "ignore", stderr: "ignore" });
			status = "\x1b[33mOpened in Preview\x1b[0m";
		}
	}
	draw();
});

// A resize clears the screen, which deletes the picture, so send it again.
process.stdout.on("resize", () => {
	transmit();
	draw();
});

transmit();
draw();
