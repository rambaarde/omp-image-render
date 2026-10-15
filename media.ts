/**
 * Media preparation for omp-image-render: probing, PNG conversion, side-by-side
 * composites, video frame extraction, the version history index, and cache trim.
 *
 * Every heavy step shells out to ffmpeg/ffprobe under `nice` with two threads, so
 * a long clip cannot pin every core. All output lives in one cache folder that
 * this module owns and trims.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Root of everything this extension writes. */
export const CACHE_ROOT = path.join(os.homedir(), ".cache", "omp-image-render");
const HISTORY_FILE = path.join(CACHE_ROOT, "history.json");
/** Trim the cache below this size; the newest two entries always survive. */
const CACHE_LIMIT_BYTES = 1024 ** 3;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Frames a clip is cut into at most, and the highest playback rate. */
const MAX_FRAMES = 900;
const MAX_FPS = 12;
/** Frame width cap in pixels; kitty needs PNG, so smaller frames keep each paint cheap. */
const MAX_FRAME_WIDTH = 1280;
const SIDE_BY_SIDE_HEIGHT = 720;
/** Grid cell for four or more pictures, the gap between cells, and the gap colour. */
const GRID_CELL_W = 900;
const GRID_CELL_H = 600;
const GRID_GAP = 12;
const GRID_FILL = "0x1e1e1e";

export const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|gif)$/i;

/** A prepared clip: PNG frames on disk plus what the player needs to show them. */
export interface PreparedVideo {
	key: string;
	frameDir: string;
	frameCount: number;
	fps: number;
	duration: number;
	widthPx: number;
	heightPx: number;
}

/** One saved version of a titled piece of work. */
export interface HistoryEntry {
	kind: "image" | "video";
	title: string;
	createdAt: number;
	/** Display PNG for images, or the frame folder for videos. */
	output: string;
	source: string;
	compare?: string;
	/** Video-only metadata, kept so a version can be replayed without the tool call. */
	video?: Omit<PreparedVideo, "key" | "frameDir"> & { key: string; frameDir: string };
	changes?: Marker[];
	checks?: Check[];
	url?: string;
}

/** A change and the second it shows up in the recording. */
export interface Marker {
	title: string;
	at: number;
}

/** A test check result; `at` is when the recording reaches it. */
export interface Check {
	label: string;
	ok: boolean;
	passed?: number;
	total?: number;
	at?: number;
}

/** Run a command under `nice`; throw with stderr when it fails. */
async function run(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(["nice", "-n", "10", ...cmd], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${err.trim().split("\n").slice(-3).join(" | ")}`);
	return out;
}

/** Throw a clear error when ffmpeg is missing instead of a spawn ENOENT. */
export function requireFfmpeg(): void {
	if (!Bun.which("ffmpeg") || !Bun.which("ffprobe")) {
		throw new Error("ffmpeg and ffprobe are required. Install them with: brew install ffmpeg");
	}
}

/** Resolve a user or model path against the session cwd; `~` expands. */
export function resolvePath(p: string, cwd: string): string {
	const trimmed = p.trim().replace(/^(['"])(.*)\1$/, "$2");
	const expanded = trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
	const abs = path.resolve(cwd, expanded);
	if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
	return abs;
}

/** Stable cache key for a set of inputs: path + size + mtime, so an edited file gets a new key. */
function keyFor(parts: string[]): string {
	const h = createHash("sha1");
	for (const p of parts) {
		const st = fs.statSync(p);
		h.update(`${p}\0${st.size}\0${st.mtimeMs}\0`);
	}
	return h.digest("hex").slice(0, 16);
}

/** Video facts from ffprobe: duration in seconds and the first video stream's size. */
async function probe(file: string): Promise<{ duration: number; width: number; height: number }> {
	const out = await run([
		"ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height:format=duration", "-of", "default=nw=1", file,
	]);
	const num = (name: string) => Number(new RegExp(`^${name}=([0-9.]+)`, "m").exec(out)?.[1] ?? Number.NaN);
	const duration = num("duration");
	return { duration: Number.isFinite(duration) ? duration : 0, width: num("width") || 0, height: num("height") || 0 };
}

/**
 * Produce one display PNG for an image request.
 * One path: converted to PNG if needed. Two or three paths (or `compare` + path): scaled to
 * the same height and placed side by side, in the given order. Four or more: a grid
 * (2×2 for four, 3 columns up to nine), each picture fitted into an equal cell.
 */
export async function prepareImage(paths: string[]): Promise<string> {
	requireFfmpeg();
	fs.mkdirSync(CACHE_ROOT, { recursive: true });
	const key = keyFor(paths);
	const out = path.join(CACHE_ROOT, `p-${key}.png`);
	if (fs.existsSync(out)) return out;
	if (paths.length === 1 && paths[0].toLowerCase().endsWith(".png")) {
		fs.copyFileSync(paths[0], out);
		return out;
	}
	const inputs = paths.flatMap(p => ["-i", p]);
	if (paths.length === 1) {
		await run(["ffmpeg", "-v", "error", "-y", ...inputs, "-frames:v", "1", "-threads", "2", out]);
		return out;
	}
	let filter: string;
	if (paths.length <= 3) {
		const scaled = paths.map((_, i) => `[${i}:v]scale=-2:${SIDE_BY_SIDE_HEIGHT},setsar=1[s${i}]`).join(";");
		filter = `${scaled};${paths.map((_, i) => `[s${i}]`).join("")}hstack=inputs=${paths.length}`;
	} else {
		const cols = Math.ceil(Math.sqrt(paths.length));
		const cellW = GRID_CELL_W + GRID_GAP;
		const cellH = GRID_CELL_H + GRID_GAP;
		const cells = paths
			.map((_, i) => `[${i}:v]scale=${GRID_CELL_W}:${GRID_CELL_H}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=${GRID_FILL},setsar=1[s${i}]`)
			.join(";");
		const layout = paths.map((_, i) => `${(i % cols) * cellW}_${Math.floor(i / cols) * cellH}`).join("|");
		filter = `${cells};${paths.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${paths.length}:layout=${layout}:fill=${GRID_FILL}`;
	}
	await run(["ffmpeg", "-v", "error", "-y", ...inputs, "-filter_complex", filter, "-frames:v", "1", "-threads", "2", out]);
	return out;
}

/** Pixel size of a PNG, read from its IHDR header (big-endian width at byte 16, height at 20). */
export function pngSize(file: string): { widthPx: number; heightPx: number } {
	const head = Buffer.alloc(24);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, head, 0, 24, 0);
	} finally {
		fs.closeSync(fd);
	}
	return { widthPx: head.readUInt32BE(16), heightPx: head.readUInt32BE(20) };
}

/**
 * Cut a clip into PNG frames. With `compare`, the old run is placed left of the new run
 * in every frame, so both always play in sync; the shorter one holds its last frame.
 */
export async function prepareVideo(
	file: string,
	compare: string | undefined,
	onProgress?: (text: string) => void,
): Promise<PreparedVideo> {
	requireFfmpeg();
	const inputs = compare ? [compare, file] : [file];
	const key = keyFor(inputs);
	const frameDir = path.join(CACHE_ROOT, `v-${key}`);
	const metaFile = path.join(frameDir, "meta.json");
	if (fs.existsSync(metaFile)) return JSON.parse(fs.readFileSync(metaFile, "utf8")) as PreparedVideo;

	const facts = await Promise.all(inputs.map(probe));
	const duration = Math.max(...facts.map(f => f.duration), 0.1);
	const fps = Math.max(1, Math.min(MAX_FPS, Math.floor(MAX_FRAMES / duration) || 1));
	const perWidth = Math.floor(MAX_FRAME_WIDTH / inputs.length / 2) * 2;
	onProgress?.(`Cutting ${duration.toFixed(1)}s into frames at ${fps} fps…`);

	fs.mkdirSync(frameDir, { recursive: true });
	const pattern = path.join(frameDir, "f%05d.png");
	const args = ["ffmpeg", "-v", "error", "-y", ...inputs.flatMap(i => ["-i", i])];
	if (compare) {
		// Same height on both sides; tpad holds the last frame so the longer run decides the length.
		const h = Math.min(...facts.map(f => f.height || 720), 720);
		const filter = inputs
			.map((_, i) => `[${i}:v]fps=${fps},scale=-2:${h},scale='min(iw,${perWidth})':-2,pad=${perWidth}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${Math.ceil(duration)}[s${i}]`)
			.join(";");
		args.push("-filter_complex", `${filter};[s0][s1]hstack=inputs=2`, "-t", duration.toFixed(3));
	} else {
		args.push("-vf", `fps=${fps},scale='min(iw,${MAX_FRAME_WIDTH})':-2`);
	}
	args.push("-frames:v", String(MAX_FRAMES), "-threads", "2", pattern);
	try {
		await run(args);
	} catch (err) {
		fs.rmSync(frameDir, { recursive: true, force: true });
		throw err;
	}

	const frames = fs.readdirSync(frameDir).filter(n => /^f\d+\.png$/.test(n)).sort();
	if (frames.length === 0) {
		fs.rmSync(frameDir, { recursive: true, force: true });
		throw new Error("ffmpeg produced no frames");
	}
	const prepared: PreparedVideo = {
		key,
		frameDir,
		frameCount: frames.length,
		fps,
		duration: frames.length / fps,
		...pngSize(path.join(frameDir, frames[0])),
	};
	fs.writeFileSync(metaFile, JSON.stringify(prepared));
	return prepared;
}

/** Path of frame `index` (0-based) in a prepared clip. */
export function framePath(video: PreparedVideo, index: number): string {
	return path.join(video.frameDir, `f${String(index + 1).padStart(5, "0")}.png`);
}

/** Read the saved history; a missing or broken file is an empty history. */
export function readHistory(): HistoryEntry[] {
	try {
		return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")) as HistoryEntry[];
	} catch {
		return [];
	}
}

/** Append a version and drop entries whose output was trimmed away. */
export function addHistory(entry: HistoryEntry): void {
	fs.mkdirSync(CACHE_ROOT, { recursive: true });
	const kept = readHistory().filter(e => fs.existsSync(e.output));
	kept.push(entry);
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(kept.slice(-200)));
}

/** All versions with the same title and kind, oldest first. */
export function versionsOf(entry: Pick<HistoryEntry, "kind" | "title">): HistoryEntry[] {
	return readHistory().filter(e => e.kind === entry.kind && e.title === entry.title && fs.existsSync(e.output));
}

/** Total size of a file or folder in bytes. */
function sizeOf(p: string): number {
	const st = fs.statSync(p);
	if (!st.isDirectory()) return st.size;
	return fs.readdirSync(p).reduce((sum, n) => sum + fs.statSync(path.join(p, n)).size, 0);
}

/**
 * Delete cache entries older than a week, then the oldest ones until the cache is under
 * 1 GB. Only `p-*` / `v-*` entries this module created are touched; the newest two stay.
 */
export function trimCache(): void {
	if (!fs.existsSync(CACHE_ROOT)) return;
	const now = Date.now();
	const entries = fs
		.readdirSync(CACHE_ROOT)
		.filter(n => /^(p-[0-9a-f]{16}\.png|v-[0-9a-f]{16})$/.test(n))
		.map(n => {
			const p = path.join(CACHE_ROOT, n);
			return { p, mtime: fs.lstatSync(p).mtimeMs, size: sizeOf(p) };
		})
		.sort((a, b) => a.mtime - b.mtime);
	let total = entries.reduce((s, e) => s + e.size, 0);
	entries.slice(0, Math.max(0, entries.length - 2)).forEach(e => {
		if (now - e.mtime > CACHE_MAX_AGE_MS || total > CACHE_LIMIT_BYTES) {
			fs.rmSync(e.p, { recursive: true, force: true });
			total -= e.size;
		}
	});
}

/**
 * Copy a file to ~/Downloads without overwriting; returns the new path.
 * `title` names the copy (`<title> <YYYY-MM-DD>.<ext>`), so cache hash names never reach
 * the user; without it the source file name is kept.
 */
export function saveToDownloads(file: string, title?: string): string {
	const dir = path.join(os.homedir(), "Downloads");
	const ext = path.extname(file);
	const clean = title?.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[/:\\]/g, "-").trim();
	const name = clean ? `${clean} ${new Date().toISOString().slice(0, 10)}` : path.parse(file).name;
	let dest = path.join(dir, `${name}${ext}`);
	for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${name}-${n}${ext}`);
	fs.copyFileSync(file, dest);
	return dest;
}
