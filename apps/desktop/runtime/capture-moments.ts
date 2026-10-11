import { CAPTURE_MOMENTS_OPERATION, MAX_CAPTURE_MOMENTS } from "../shared/gateway-operations";
import { timeoutForTool } from "../shared/mcp-tools";
import { isClipId } from "../shared/reference-clip";
import type { CropBox } from "./clip-analysis";
import type { ClipManifest } from "./clip-store";
import type { StudioCaller } from "./local-operations";
import type { McpCallOptions, McpToolImage, McpToolOutcome } from "./mcp-types";
import { frameEffectTime, missingClip, nearestFrame, type ChatClips } from "./reference-clip";
import { frameLabel } from "./sheet-labels";

/**
 * `capture_moments`: a playing effect, seen at several moments, in one call.
 *
 * Checking an effect by eye used to take the model three calls a moment: hold
 * it at a time, capture, resume. Every model call re-reads the whole
 * conversation, so a run that looked at sixteen moments spent about forty
 * calls on it, each one more expensive than the last. Here the model sends the
 * code that starts the effect and the times it wants, and Roqer walks the
 * moments itself through the same bridge calls.
 *
 * It also sees what holding cannot. A trail ages in real time while its effect
 * is held, so a held frame shows no trail; with `hold: false` the effect keeps
 * playing slowly through each capture instead.
 *
 * And what cannot be held at all. An effect the game plays by itself in a
 * playtest (a cast, a hit) runs on the game's own clock, and a screenshot
 * taken from outside takes about a second to come back, so every moment after
 * the first was a second late. With `live: true` the client takes each
 * screenshot itself, from inside the game, as its moment passes, all in one
 * call; the slow part, reading the pictures back, comes after the effect.
 */

/** Real seconds one wait may take: under the bridge's 30 s budget for the call that waits. */
const MAX_WAIT_SECONDS = 20;
/** Waits one moment may take before it is captured wherever the clock got to. */
const MAX_WAITS_PER_MOMENT = 4;
/** Real seconds with the clock standing still before a wait gives up: the effect has ended. */
const STALLED_SECONDS = 1.5;
/**
 * Real seconds of the approach to each moment that are played at slow speed.
 * The rest of the way is played at normal speed, so a late moment costs its
 * own length in real time rather than that length divided by the slow speed:
 * at 0.04x, 1.2 s of effect is 30 s of waiting, past the bridge's budget.
 * Slowing down only for the last stretch keeps the stop precise and lets a
 * trail be drawn at the speed it is captured at.
 */
const SLOW_APPROACH_SECONDS = 1.5;
/**
 * Effect seconds before a moment that a trail capture (`hold: false`) plays
 * at slow speed, at most. A trail segment keeps the lifetime it was drawn
 * with, so the segments drawn at normal speed are gone within half a second of
 * real time, and only what was drawn slowly survives into the frame. The
 * approach covers the longest trail lifetime seen in the studied effects
 * (0.85 s), so the whole visible trail is drawn at the speed it is captured
 * at. It is also kept within one wait (`slow` x `MAX_WAIT_SECONDS`): the emit
 * module caps a slowed trail's lifetime at 20 s of real time, so nothing drawn
 * earlier than that would still show.
 */
const TRAIL_APPROACH_SECONDS = 0.9;
/**
 * Effect seconds a live capture may reach. Every moment is waited for in one
 * call, inside the bridge's 30 s budget, with room for the code that starts
 * the effect and for each screenshot to finish.
 */
const LIVE_MAX_SECONDS = 15;
/** Real seconds a screenshot may take to finish before the client is taken to be unable to render. */
const CAPTURE_FINISH_SECONDS = 3;
/** Milliseconds of a call's budget kept for the last screenshot, stopping the effect and tiling. */
const BUDGET_RESERVE_MS = 20_000;
const MAX_CODE_CHARS = 20_000;
const MAX_TIME_SECONDS = 60;
const HANDLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/**
 * Real seconds the effect is held at its start while its textures load.
 *
 * A texture fetched for the first time takes a moment to arrive, and an
 * uploaded one always is the first time: the explosion run's first capture
 * after its upload missed layers in its early frames and had to be taken
 * again, a whole call and a whole image for nothing. Holding the effect while
 * `ContentProvider` loads what it uses costs a few seconds instead. Kept well
 * under one wait so it never eats the budget the moments need.
 */
const PRELOAD_SECONDS = 10;
/** Effect objects a live capture loads first, at most: enough for any skill set, bounded for a large game. */
const PRELOAD_MAX_OBJECTS = 2000;

/**
 * Effect seconds past its time a moment may be captured at before it is
 * called late. A held approach overshoots by a frame at the slow speed, a few
 * milliseconds; a clock that runs on through a capture overshoots by the
 * capture's own length, about a second in a playtest.
 */
const LATE_SECONDS = 0.05;

type Moment = {
  requested: number;
  reached?: number;
  short?: "ended" | "waited";
  /** Effect seconds past `requested` it was captured at, when over `LATE_SECONDS`. */
  late?: number;
  /** False when the handle's clock went on running after it was held. */
  held?: false;
  image?: number;
  note?: string;
};

/** Where to aim the edit camera before the effect starts, as `selection` view takes it. */
export type CaptureView = Readonly<{ path: string; from?: number; angleY?: number; padding?: number }>;

/** A reference clip to pair the moments with, and the clip's time for each, in effect seconds. */
export type CaptureReference = Readonly<{ clip: string; times?: readonly number[] }>;

export type CaptureMomentsArgs = Readonly<{
  code: string;
  times: readonly number[];
  runtime: "edit" | "client";
  target?: string;
  handle: string;
  hold: boolean;
  slow: number;
  sheet: boolean;
  /** Played at the effect's own speed and captured from inside, nothing held. */
  live?: true;
  view?: CaptureView;
  reference?: CaptureReference;
}>;

/** The reference argument, checked against the moments, or why it cannot be used. */
function parseReference(value: unknown, times: readonly number[]): CaptureReference | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return "reference must be an object such as {clip, times}.";
  const { clip, times: clipTimes } = value as Record<string, unknown>;
  if (!isClipId(clip)) return "reference.clip must be a clip's id, exactly as its attachment gave it (12 hexadecimal characters).";
  if (clipTimes === undefined || clipTimes === null) return { clip };
  if (!Array.isArray(clipTimes) || clipTimes.length !== times.length ||
    !clipTimes.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0)) {
    return `reference.times must list one effect second of the clip for each of the ${times.length} moments, or be left out to use the same times.`;
  }
  return { clip, times: clipTimes as number[] };
}

/** The view argument, checked, or why it cannot be used. */
function parseView(value: unknown, runtime: string): CaptureView | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (runtime === "client") return "view aims the edit camera; with runtime client the frames are the player's own view, so leave view out.";
  if (typeof value !== "object" || Array.isArray(value)) return "view must be an object such as {path, from, angleY, padding}.";
  const { path, from, angleY, padding } = value as Record<string, unknown>;
  if (typeof path !== "string" || path === "") return "view.path must name the instance to frame, such as the effect's marker part.";
  const numbers = { from, angleY, padding };
  for (const [name, entry] of Object.entries(numbers)) {
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) return `view.${name} must be a number.`;
  }
  return {
    path,
    ...(from === undefined ? {} : { from: from as number }),
    ...(angleY === undefined ? {} : { angleY: angleY as number }),
    ...(padding === undefined ? {} : { padding: padding as number }),
  };
}

/**
 * Tiles frames into one image, `columns` to a row, or undefined when it
 * cannot. The host supplies it, since decoding images needs Electron; without
 * one, frames go back one image each. A frame may be cropped first, and a
 * tile may carry a label.
 */
export type ContactSheet = (
  images: readonly McpToolImage[],
  columns: number,
  options?: Readonly<{ crops?: readonly (CropBox | undefined)[]; labels?: readonly string[]; wide?: boolean }>,
) => Promise<McpToolImage | undefined>;

/** Frames to a row on a contact sheet: two show each frame at half the width it would have sent alone (1000 pixels on a wide viewport). */
const SHEET_COLUMNS = 2;

/** The call's arguments, checked, or why they cannot run. */
export function parseCaptureMoments(args: Record<string, unknown>): CaptureMomentsArgs | string {
  const { code, times, runtime = "edit", target, handle = "vfx", hold = true, slow, sheet = true, live = false } = args;
  if (typeof code !== "string" || code.trim() === "") return "code must be the Luau that starts the effect.";
  if (code.length > MAX_CODE_CHARS) return `code is ${code.length} characters; keep it under ${MAX_CODE_CHARS}: start the effect from a module rather than inlining it.`;
  if (!Array.isArray(times) || times.length === 0 || times.length > MAX_CAPTURE_MOMENTS) {
    return `times must list 1-${MAX_CAPTURE_MOMENTS} effect seconds.`;
  }
  if (!times.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0 && time <= MAX_TIME_SECONDS)) {
    return `every time must be a number of effect seconds from 0 to ${MAX_TIME_SECONDS}.`;
  }
  if (times.some((time, index) => index > 0 && time <= (times[index - 1] as number))) return "times must be in ascending order, with no repeats.";
  if (runtime !== "edit" && runtime !== "client") return "runtime must be edit or client.";
  if (target !== undefined && (typeof target !== "string" || target === "")) return "target must name a client peer, such as client-1.";
  if (typeof handle !== "string" || !HANDLE_NAME.test(handle)) return "handle must be a plain global name, such as vfx.";
  if (typeof hold !== "boolean") return "hold must be true or false.";
  if (typeof sheet !== "boolean") return "sheet must be true or false.";
  if (typeof live !== "boolean") return "live must be true or false.";
  if (live && (args.hold !== undefined || slow !== undefined)) return "live plays the effect at its own speed and holds nothing, so leave hold and slow out.";
  if (live && (times as number[]).some((time) => time > LIVE_MAX_SECONDS)) {
    return `with live, every time must be at most ${LIVE_MAX_SECONDS} s: the client waits for them all in one call.`;
  }
  const speed = slow === undefined ? (hold ? 0.1 : 0.04) : slow;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.01 || speed > 1) return "slow must be a playback speed from 0.01 to 1.";
  const view = parseView(args.view, runtime);
  if (typeof view === "string") return view;
  const reference = parseReference(args.reference, times as number[]);
  if (typeof reference === "string") return reference;
  return {
    code,
    times: times as number[],
    runtime,
    ...(runtime === "client" ? { target: typeof target === "string" ? target : "client-1" } : {}),
    handle,
    hold,
    slow: speed,
    sheet,
    ...(live ? { live: true as const } : {}),
    ...(view === undefined ? {} : { view }),
    ...(reference === undefined ? {} : { reference }),
  };
}

/**
 * Luau that holds the effect where it is and waits, for at most
 * `PRELOAD_SECONDS`, for everything under its root to load: "loaded",
 * "loading" when the wait ran out, or "no-root" for a handle that does not
 * say what it is playing. The first moment's playback sets the speed again.
 */
export function preloadLuau(handle: string): string {
  return [
    `local h = _G[${JSON.stringify(handle)}]`,
    `if type(h) ~= "table" or type(h.setTimeScale) ~= "function" then return "no-handle" end`,
    "local root = h.root",
    `if typeof(root) ~= "Instance" then return "no-root" end`,
    "if h.finished ~= true then h:setTimeScale(0) end",
    `local ContentProvider = game:GetService("ContentProvider")`,
    "local done = false",
    "task.spawn(function()",
    "\tpcall(function() ContentProvider:PreloadAsync({ root }) end)",
    "\tdone = true",
    "end)",
    "local started = os.clock()",
    `while not done and os.clock() - started < ${PRELOAD_SECONDS} do task.wait() end`,
    `return done and "loaded" or "loading"`,
  ].join("\n");
}

/**
 * Luau that plays the effect on to `time`, at normal speed until the last
 * stretch and at `slow` for it, holds it there when asked, and says where it
 * got to and why it stopped: "done", "stalled" (the clock stood still, so the
 * effect has ended) or "capped" (this call's wait ran out first). A held
 * effect's clock is read again two frames later: "runs" when it moved, so
 * the handle's setTimeScale(0) does not stop it and the capture that follows
 * lands late.
 */
export function momentLuau(handle: string, time: number, slow: number, hold: boolean): string {
  const trail = Math.min(TRAIL_APPROACH_SECONDS, slow * MAX_WAIT_SECONDS);
  const approach = Math.round(Math.max(slow * SLOW_APPROACH_SECONDS, hold ? 0 : trail) * 1000) / 1000;
  return [
    `local h = _G[${JSON.stringify(handle)}]`,
    `if type(h) ~= "table" or type(h.setTimeScale) ~= "function" then return "no-handle" end`,
    `local target = ${time}`,
    "local function clock() return tonumber(h.time) or 0 end",
    // A finished handle has put back what it changed (an effect played in
    // place restores its emitters and trails); scaling it again would undo that.
    "local function scale(speed) if h.finished ~= true then h:setTimeScale(speed) end end",
    // An effect that has ended stops its clock; waiting on for the full cap would only cost time.
    "local started, last, moved = os.clock(), clock(), os.clock()",
    "local function playTo(stop, speed)",
    "\tscale(speed)",
    `\twhile clock() < stop and h.finished ~= true and os.clock() - started < ${MAX_WAIT_SECONDS} and os.clock() - moved < ${STALLED_SECONDS} do`,
    "\t\ttask.wait()",
    "\t\tlocal now = clock()",
    "\t\tif now ~= last then last, moved = now, os.clock() end",
    "\tend",
    "end",
    `if clock() < target - ${approach} then playTo(target - ${approach}, 1) end`,
    `playTo(target, ${slow})`,
    ...(hold ? ["scale(0)"] : []),
    `local status = clock() >= target and "done" or ((h.finished == true or os.clock() - moved >= ${STALLED_SECONDS}) and "stalled" or "capped")`,
    "local reached = clock()",
    // Two frames, so a clock stepped before or after this thread resumes is seen either way.
    ...(hold
      ? [`local holding = "held"`, `if h.finished ~= true then task.wait() task.wait() if clock() ~= reached then holding = "runs" end end`]
      : [`local holding = "playing"`]),
    `return string.format("%.3f|%s|%s", reached, status, holding)`,
  ].join("\n");
}

/** Luau that ends the effect, so nothing it made is left in the place. */
export function stopLuau(handle: string): string {
  return [
    `local h = _G[${JSON.stringify(handle)}]`,
    `if type(h) == "table" and type(h.stop) == "function" then pcall(h.stop, h) end`,
    `_G[${JSON.stringify(handle)}] = nil`,
    `return "stopped"`,
  ].join("\n");
}

/**
 * Luau run before a live capture. It first loads the textures of the effect
 * objects the context holds (particles, beams, trails, decals and textures
 * under ReplicatedStorage, ReplicatedFirst and the local player's scripts and
 * backpack), for at most `PRELOAD_SECONDS`: an emitter whose texture has not
 * arrived draws nothing, and a fireball run's first two live captures, right
 * after its textures were uploaded, showed no effect at all. Then it takes
 * one screenshot and says whether it could: "ok|id|loaded|count" (or
 * "loading" when the wait ran out), "timeout" when the screenshot never
 * finished (the window is not rendering), or "error|why" when this context
 * may not take one. Its capture is read back too, so a context whose
 * captures cannot be had never starts the effect.
 */
export function liveProbeLuau(): string {
  return [
    `local ContentProvider = game:GetService("ContentProvider")`,
    `local CaptureService = game:GetService("CaptureService")`,
    "local kinds = { ParticleEmitter = true, Beam = true, Trail = true, Decal = true, Texture = true }",
    "local found = {}",
    "local function gather(root)",
    "\tif root == nil then return end",
    `\tfor _, item in ipairs(root:GetDescendants()) do if kinds[item.ClassName] and #found < ${PRELOAD_MAX_OBJECTS} then table.insert(found, item) end end`,
    "end",
    `pcall(gather, game:GetService("ReplicatedStorage"))`,
    `pcall(gather, game:GetService("ReplicatedFirst"))`,
    `local player = game:GetService("Players").LocalPlayer`,
    `if player then pcall(gather, player:FindFirstChild("PlayerScripts")) pcall(gather, player:FindFirstChild("Backpack")) end`,
    "local loaded = false",
    "task.spawn(function()",
    "\tpcall(function() ContentProvider:PreloadAsync(found) end)",
    "\tloaded = true",
    "end)",
    "local waited = os.clock()",
    `while not loaded and os.clock() - waited < ${PRELOAD_SECONDS} do task.wait() end`,
    "local id",
    "local ok, err = pcall(function() CaptureService:CaptureScreenshot(function(contentId) id = contentId end) end)",
    `if not ok then return "error|" .. tostring(err) end`,
    "local asked = os.clock()",
    `while id == nil and os.clock() - asked < ${CAPTURE_FINISH_SECONDS} do task.wait() end`,
    `if id == nil then return "timeout" end`,
    `return string.format("ok|%s|%s|%d", id, loaded and "loaded" or "loading", #found)`,
  ].join("\n");
}

/**
 * Luau that runs the code that starts the effect, then waits for each time and
 * takes a screenshot there with CaptureService, from inside the context the
 * effect plays in, holding nothing. Its clock is the handle's `time` when the
 * code stored a new handle with one, otherwise real seconds since the code
 * returned. It answers in JSON: whether the code ran, and for each moment the
 * clock when the screenshot was asked for (`at`), the clock when it finished
 * (`done`) and the capture's temporary id, or why there is none. It stops at
 * the first screenshot that fails: the next would fail the same way.
 */
export function liveLuau(code: string, handle: string, times: readonly number[]): string {
  return [
    // Defined before anything of Roqer's, so the code cannot see or overwrite it.
    "local function start()",
    code,
    "end",
    `local CaptureService = game:GetService("CaptureService")`,
    `local HttpService = game:GetService("HttpService")`,
    `local name = ${JSON.stringify(handle)}`,
    `local times = { ${times.join(", ")} }`,
    "local before = _G[name]",
    "local started, startError = pcall(start)",
    "if not started then return HttpService:JSONEncode({ started = false, error = tostring(startError) }) end",
    "local origin = os.clock()",
    "local h = _G[name]",
    `local own = h ~= before and type(h) == "table" and tonumber(h.time) ~= nil`,
    "local function clock() if own then return tonumber(h.time) or 0 end return os.clock() - origin end",
    // A handle's clock that stops has ended its effect; what is left is captured where it stopped.
    "local last, moved = clock(), os.clock()",
    `local function ended() return own and (h.finished == true or os.clock() - moved >= ${STALLED_SECONDS}) end`,
    "local shots = {}",
    "for i, target in ipairs(times) do",
    `\twhile clock() < target and not ended() and os.clock() - origin < ${LIVE_MAX_SECONDS + 1} do`,
    "\t\ttask.wait()",
    "\t\tlocal now = clock()",
    "\t\tif now ~= last then last, moved = now, os.clock() end",
    "\tend",
    "\tlocal at, id = clock(), nil",
    "\tlocal ok, err = pcall(function() CaptureService:CaptureScreenshot(function(contentId) id = contentId end) end)",
    "\tif not ok then shots[i] = { at = at, error = tostring(err) } break end",
    "\tlocal asked = os.clock()",
    `\twhile id == nil and os.clock() - asked < ${CAPTURE_FINISH_SECONDS} do task.wait() end`,
    "\tshots[i] = { at = at, done = clock(), id = id }",
    "\tif id == nil then break end",
    // Waiting for the screenshot is not the clock standing still.
    "\tlast, moved = clock(), os.clock()",
    "end",
    "return HttpService:JSONEncode({ started = true, own = own, shots = shots })",
  ].join("\n");
}

function failure(text: string, started: number, images: readonly McpToolImage[] = []): McpToolOutcome {
  return { ok: false, data: undefined, text, httpStatus: 200, durationMs: Date.now() - started, ...(images.length > 0 ? { images } : {}) };
}

function returned(outcome: McpToolOutcome): string {
  const data = outcome.data;
  if (typeof data === "object" && data !== null) {
    for (const key of ["returnValue", "result"]) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  return outcome.text;
}

/**
 * The moments beside a reference clip's frames at the matching times, as one
 * image: for each moment, the clip's frame (cropped to where the clip changes)
 * then Studio's, labelled R and S with the pair's number and time, two pairs
 * to a row. Undefined when the clip's frames cannot be read or tiled; the
 * moments then go back on their own.
 */
async function pairWithReference(
  parsed: CaptureMomentsArgs & { reference: CaptureReference },
  manifest: ClipManifest,
  moments: readonly Moment[],
  images: readonly McpToolImage[],
  references: ChatClips,
  contactSheet: ContactSheet,
): Promise<{ sheet: McpToolImage; lines: Map<Moment, string> } | undefined> {
  const tiles: McpToolImage[] = [];
  const labels: string[] = [];
  const crops: (CropBox | undefined)[] = [];
  const lines = new Map<Moment, string>();
  for (const moment of moments) {
    if (moment.image === undefined) continue;
    // A late frame is paired with the clip where the effect really was.
    const at = (parsed.reference.times?.[parsed.times.indexOf(moment.requested)] ?? moment.requested) + (moment.late ?? 0);
    const index = nearestFrame(manifest, at);
    const clipTime = frameEffectTime(manifest, index);
    // A time past either end of the clip shows its nearest frame, and says so.
    const last = frameEffectTime(manifest, manifest.frames.length - 1);
    const outside = at > last + 0.02 ? ` (the clip ends at ${last.toFixed(2)} s; its last frame is shown)` : "";
    const frame = await references.frame(manifest, index);
    const pair = lines.size + 1;
    tiles.push({ data: frame.toString("base64"), mediaType: "image/jpeg" }, images[moment.image - 1] as McpToolImage);
    labels.push(frameLabel(pair, clipTime, "R"), frameLabel(pair, moment.reached ?? moment.requested, "S"));
    crops.push(manifest.analysis.crop, undefined);
    lines.set(moment, `pair ${pair}, beside the clip at ${clipTime.toFixed(2)} s${outside}`);
  }
  if (lines.size === 0) return undefined;
  const sheet = await contactSheet(tiles, lines.size === 1 ? 2 : 4, { labels, crops, wide: true });
  return sheet === undefined ? undefined : { sheet, lines };
}

type LiveShot = { at?: unknown; done?: unknown; id?: unknown; error?: unknown };

/**
 * A live capture: checks that the context can take its own screenshots, runs
 * the code and the moments in one call (`liveLuau`), then reads each capture
 * back. Nothing is held or stopped: the effect plays out as it would in the
 * game. Gives the moments and frames, or why nothing was captured.
 */
async function captureLive(
  parsed: CaptureMomentsArgs,
  options: McpCallOptions,
  studio: StudioCaller,
  run: (code: string) => Promise<McpToolOutcome>,
): Promise<Pick<Captured, "moments" | "images" | "how" | "notes" | "footer" | "ok" | "data"> | string> {
  const where = parsed.runtime === "client" ? `the playtest client (${parsed.target})` : "Studio";
  // A context whose captures cannot be taken or read never starts the effect: a cast would be spent for nothing.
  const probe = await run(liveProbeLuau());
  if (options.signal?.aborted) throw new Error("Run was cancelled.");
  const probed = probe.ok ? returned(probe).trim() : "";
  if (!probed.startsWith("ok|")) {
    const why = !probe.ok
      ? probe.message ?? probe.text
      : probed === "timeout"
        ? `its screenshot never finished within ${CAPTURE_FINISH_SECONDS} s, so Studio's window is likely minimized or covered`
        : probed.replace(/^error\|/, "");
    return `${CAPTURE_MOMENTS_OPERATION} was not run: live capture needs ${where} to take its own screenshots, and it could not (${why}). Nothing was started; capture with hold instead.`;
  }
  const [, captureId = "", loadState, found] = probed.split("|");
  const probeArgs = { capture_id: captureId };
  const readable = await studio("capture_screenshot", probeArgs, { signal: options.signal, timeoutMs: timeoutForTool("capture_screenshot", probeArgs) });
  if (options.signal?.aborted) throw new Error("Run was cancelled.");
  if (!readable.ok) {
    return `${CAPTURE_MOMENTS_OPERATION} was not run: live capture needs Studio to read back what ${where} captures, and it could not (${readable.message ?? readable.text}). Nothing was started; capture with hold instead.`;
  }
  const reply = await run(liveLuau(parsed.code, parsed.handle, parsed.times));
  if (options.signal?.aborted) throw new Error("Run was cancelled.");
  let result: { started?: unknown; error?: unknown; own?: unknown; shots?: unknown } | undefined;
  try {
    result = reply.ok ? JSON.parse(returned(reply)) as typeof result : undefined;
  } catch {
    result = undefined;
  }
  if (result === undefined) return `The live capture failed, so nothing was captured: ${reply.message ?? reply.text}`;
  if (result.started !== true) return `The code that starts the effect failed, so nothing was captured: ${String(result.error)}`;

  const shots = Array.isArray(result.shots) ? result.shots as LiveShot[] : [];
  const moments: Moment[] = [];
  const images: McpToolImage[] = [];
  let slowest = 0;
  for (const [index, time] of parsed.times.entries()) {
    const moment: Moment = { requested: time };
    moments.push(moment);
    const shot = shots[index];
    if (shot === undefined) {
      moment.note = "not captured: an earlier screenshot failed";
      continue;
    }
    if (typeof shot.at === "number" && Number.isFinite(shot.at)) {
      moment.reached = Math.round(shot.at * 1000) / 1000;
      if (shot.at + 0.005 < time) moment.short = "ended";
      if (shot.at - time > LATE_SECONDS) moment.late = Math.round((shot.at - time) * 1000) / 1000;
      // Only a screenshot that finished says how long one takes.
      if (typeof shot.done === "number" && typeof shot.id === "string") slowest = Math.max(slowest, shot.done - shot.at);
    }
    if (typeof shot.id !== "string") {
      moment.note = typeof shot.error === "string"
        ? `capture failed: ${shot.error}`.slice(0, 300)
        : `capture failed: the screenshot never finished within ${CAPTURE_FINISH_SECONDS} s (Studio's window may be minimized or covered)`;
      continue;
    }
    if (options.signal?.aborted) throw new Error("Run was cancelled.");
    // The client took the picture at its moment; reading it back is the slow part, and comes after.
    const readArgs = { capture_id: shot.id };
    const read = await studio("capture_screenshot", readArgs, { signal: options.signal, timeoutMs: timeoutForTool("capture_screenshot", readArgs) });
    const image = read.ok ? read.images?.[0] : undefined;
    if (image === undefined) {
      moment.note = `reading the capture back failed: ${read.message ?? read.text}`.slice(0, 300);
      continue;
    }
    images.push(image);
    moment.image = images.length;
  }
  const clock = result.own === true ? `its times are _G.${parsed.handle}'s time field` : "its times are real seconds since the code returned";
  const late = moments.filter((moment) => moment.late !== undefined);
  return {
    moments,
    images,
    how: ` live: the effect played at its own speed, and ${where} took each frame itself as its time came (${clock})`,
    notes: [
      loadState === "loading"
        ? `The textures of the effect objects the client holds were still loading after ${PRELOAD_SECONDS} s, so frames may be missing layers; if they are, capture again.`
        : Number(found) > 0
          ? `Before the code ran, Roqer loaded the textures of the ${found} particle, beam, trail and decal objects the client holds, so an effect seen for the first time is not missing layers.`
          : "Roqer found no particle, beam, trail or decal objects to load first, so a texture shown for the first time may be missing from early frames.",
      // A screenshot taken inside the game takes about a third of a second to finish; the next waits for it.
      ...(late.length === 0 || slowest <= 0 ? [] : [`Each screenshot took up to ${slowest.toFixed(2)} s to finish and the next waits for it, so ${late.map((moment) => `${moment.requested} s`).join(", ")} came late. One play gives at most one frame per ${slowest.toFixed(2)} s: capture those times in another call to see them on time.`]),
    ],
    footer: ["The effect was left to play out, as it would in the game."],
    ok: true,
    data: { live: true },
  };
}

/** What a capture produced, for `deliver` to tile, pair and describe. */
type Captured = Readonly<{
  parsed: CaptureMomentsArgs;
  manifest?: ClipManifest;
  references?: ChatClips;
  contactSheet?: ContactSheet;
  moments: readonly Moment[];
  images: readonly McpToolImage[];
  started: number;
  /** How the moments were captured, as it follows "Captured N of M moments". */
  how: string;
  /** Lines after the first, before the moments. */
  notes: readonly string[];
  /** Lines after the moments. */
  footer: readonly string[];
  ok: boolean;
  data?: Readonly<Record<string, unknown>>;
}>;

/** The frames tiled, or paired with a reference clip, and the text that says which is which. */
async function deliver(captured: Captured): Promise<McpToolOutcome> {
  const { parsed, manifest, references, contactSheet, moments, images, started } = captured;
  // A sheet of up to eight frames costs the model about what two frames do, so the frames go as one unless asked otherwise.
  let delivered = images;
  let tiled = false;
  let paired: Map<Moment, string> | undefined;
  let pairingNote: string | undefined;
  if (parsed.reference !== undefined && manifest !== undefined && references !== undefined && contactSheet !== undefined && images.length > 0) {
    const comparison = await pairWithReference({ ...parsed, reference: parsed.reference }, manifest, moments, images, references, contactSheet)
      .catch(() => undefined);
    if (comparison === undefined) {
      pairingNote = "Roqer could not pair the frames with the clip's, so they come back on their own.";
    } else {
      delivered = [comparison.sheet];
      paired = comparison.lines;
    }
  }
  if (paired === undefined && parsed.sheet && contactSheet !== undefined && images.length > 1) {
    const sheet = await contactSheet(images, SHEET_COLUMNS).catch(() => undefined);
    if (sheet !== undefined) {
      delivered = [sheet];
      tiled = true;
    }
  }
  const lines = moments.map((moment) => {
    const at = moment.reached === undefined ? "" : `, at ${moment.reached.toFixed(3)} s`;
    const short = moment.short === "ended"
      ? ` (the clock stopped short of ${moment.requested} s: the effect had ended)`
      : moment.short === "waited"
        ? ` (still short of ${moment.requested} s when the waiting ran out)`
        : moment.late !== undefined
          ? ` (${moment.late.toFixed(2)} s late)`
          : "";
    const picture = moment.image === undefined
      ? moment.note ?? "not captured"
      : paired?.get(moment) ?? `${tiled ? "frame" : "image"} ${moment.image}`;
    return `- ${moment.requested} s${at}${short}: ${picture}`;
  });
  const layout = paired !== undefined
    ? `Each moment is paired with reference clip ${manifest!.id} in one image, two pairs to a row, left to right then top to bottom: the clip's frame at the matching time (labelled R${manifest!.analysis.crop === undefined ? "" : ", cropped to where the clip changes"}), then Studio's (labelled S), each label carrying the pair's number and time. Compare each pair for when it starts, peaks and fades, its size against the frame, its colours and its shape; the clip was filmed from its own camera, so compare proportions rather than position.`
    : tiled
      ? `The frames are tiled into one image, ${SHEET_COLUMNS} to a row, left to right then top to bottom. For one frame at full size, call again with sheet: false and just that time.`
      : "The images follow in this order:";
  const text = [
    `Captured ${images.length} of ${parsed.times.length} moments${captured.how}. ${layout}`,
    ...captured.notes,
    ...(pairingNote === undefined ? [] : [pairingNote]),
    ...lines,
    ...captured.footer,
  ].join("\n");
  if (images.length === 0) return failure(text, started);
  return {
    ok: captured.ok,
    data: { moments, ...captured.data, ...(paired === undefined ? {} : { comparedWith: manifest!.id }) },
    text,
    images: delivered,
    httpStatus: 200,
    durationMs: Date.now() - started,
  };
}


export async function captureMoments(
  args: Record<string, unknown>,
  options: McpCallOptions,
  studio: StudioCaller,
  contactSheet?: ContactSheet,
  references?: ChatClips,
): Promise<McpToolOutcome> {
  const started = Date.now();
  const parsed = parseCaptureMoments(args);
  if (typeof parsed === "string") return failure(`${CAPTURE_MOMENTS_OPERATION} was not run: ${parsed}`, started);
  // A clip to compare with is found before anything starts in Studio, so a
  // wrong id costs nothing but this answer.
  let manifest: ClipManifest | undefined;
  if (parsed.reference !== undefined) {
    if (references === undefined) {
      return failure(`${CAPTURE_MOMENTS_OPERATION} was not run: this chat holds no reference clips to compare with. Leave reference out.`, started);
    }
    manifest = await references.read(parsed.reference.clip);
    if (manifest === undefined) return failure(`${CAPTURE_MOMENTS_OPERATION} was not run: ${await missingClip(references, parsed.reference.clip)}`, started);
  }
  const runner = parsed.runtime === "client" ? "eval_client_runtime" : "execute_luau";
  // Clean-up runs even after a cancel, so it is the one call without the run's signal.
  const run = (code: string, cleanup = false) => {
    const runArgs = { code, ...(parsed.target === undefined ? {} : { target: parsed.target }) };
    return studio(runner, runArgs, { ...(cleanup ? {} : { signal: options.signal }), timeoutMs: timeoutForTool(runner, runArgs) });
  };

  if (parsed.view !== undefined) {
    // The same read a separate selection call makes, without a model turn of its own.
    const viewArgs = { action: "view", ...parsed.view };
    const aimed = await studio("selection", viewArgs, { signal: options.signal, timeoutMs: timeoutForTool("selection", viewArgs) });
    if (!aimed.ok) return failure(`Aiming the camera at ${parsed.view.path} failed, so nothing was started or captured: ${aimed.message ?? aimed.text}`, started);
  }

  if (parsed.live === true) {
    const captured = await captureLive(parsed, options, studio, run);
    return typeof captured === "string" ? failure(captured, started) : deliver({ ...captured, parsed, manifest, references, contactSheet, started });
  }

  const start = await run(parsed.code);
  if (!start.ok) {
    // It may have failed after making something, so the effect is ended either way.
    await run(stopLuau(parsed.handle), true).catch(() => undefined);
    return failure(`The code that starts the effect failed, so nothing was captured: ${start.message ?? start.text}`, started);
  }

  // A failed or unanswered preload only costs the frames it would have
  // filled in, so the moments are captured either way.
  const preload = await run(preloadLuau(parsed.handle)).catch(() => undefined);
  const stillLoading = preload?.ok === true && returned(preload).trim() === "loading";

  // The whole call stays inside the budget the engine gave it, with room left
  // for the last screenshot and for stopping the effect.
  const deadline = started + (options.timeoutMs ?? timeoutForTool(CAPTURE_MOMENTS_OPERATION)) - BUDGET_RESERVE_MS;
  const canWait = () => Date.now() + MAX_WAIT_SECONDS * 1000 <= deadline;
  const moments: Moment[] = [];
  const images: McpToolImage[] = [];
  const skipped: number[] = [];
  const shotSeconds: number[] = [];
  let stopped: string | undefined;
  try {
    for (const time of parsed.times) {
      if (options.signal?.aborted) throw new Error("Run was cancelled.");
      if (!canWait()) {
        skipped.push(time);
        continue;
      }
      const moment: Moment = { requested: time };
      moments.push(moment);
      // A wait that ran out of its call's budget carries on in another call, up to a limit.
      let reply = "";
      let status = "";
      let failed: McpToolOutcome | undefined;
      for (let attempt = 0; attempt < MAX_WAITS_PER_MOMENT; attempt++) {
        const step = await run(momentLuau(parsed.handle, time, parsed.slow, parsed.hold));
        reply = returned(step).trim();
        status = reply.split("|")[1] ?? "";
        if (!step.ok) failed = step;
        if (!step.ok || status !== "capped" || !canWait()) break;
      }
      if (failed !== undefined || reply === "no-handle") {
        stopped = failed !== undefined
          ? `Moving to ${time} s failed: ${failed.message ?? failed.text}`
          : `_G.${parsed.handle} is not a handle with setTimeScale after the code ran; store the effect's handle there.`;
        break;
      }
      const [reachedText, , holding] = reply.split("|");
      const value = Number(reachedText);
      if (Number.isFinite(value) && value >= 0) {
        moment.reached = value;
        // A handle whose clock stopped, or that the waits outran, is captured anyway, and said so.
        if (value + 0.005 < time) moment.short = status === "capped" ? "waited" : "ended";
        // So is one whose clock was already past the time: it ran on through the capture before.
        if (value - time > LATE_SECONDS) moment.late = Math.round((value - time) * 1000) / 1000;
      }
      if (holding === "runs") moment.held = false;
      const shot = await studio("capture_screenshot", {}, { signal: options.signal, timeoutMs: timeoutForTool("capture_screenshot") });
      shotSeconds.push(shot.durationMs / 1000);
      const image = shot.ok ? shot.images?.[0] : undefined;
      if (image === undefined) {
        moment.note = `capture failed: ${shot.message ?? shot.text}`.slice(0, 300);
        continue;
      }
      images.push(image);
      moment.image = images.length;
    }
  } finally {
    // Always end the effect, so its clones and a held clock are not left behind.
    await run(stopLuau(parsed.handle), true).catch(() => undefined);
  }

  const runOn = moments.some((moment) => moment.held === false);
  const how = !parsed.hold
    ? `kept playing at ${parsed.slow}x through each capture, so a frame may run a little past its time`
    : runOn ? "meant to be held still for each capture" : "held still for each capture";
  // A clock that runs on through every capture reaches each later moment a capture's length late.
  const perShot = shotSeconds.length === 0 ? 0 : [...shotSeconds].sort((a, b) => a - b)[Math.floor(shotSeconds.length / 2)] as number;
  const ranOn = runOn
    ? `_G.${parsed.handle}'s clock kept running while it was held: its setTimeScale(0) does not stop its time field. The effect played on through each capture (about ${perShot.toFixed(1)} s each), so every frame shows it later than asked, and each moment after the first is reached about that much late, as the times below say. To see the times asked for, pass live: true, store a handle whose setTimeScale(0) stops both its time and what it draws, as the emit module's does, or capture one moment per call.`
    : undefined;
  return deliver({
    parsed, manifest, references, contactSheet, moments, images, started,
    how: `, ${how}`,
    notes: [
      ...(ranOn === undefined ? [] : [ranOn]),
      ...(stillLoading ? [`Its textures were still loading after ${PRELOAD_SECONDS} s, so early frames may be missing layers; if they are, capture again.`] : []),
    ],
    footer: [
      ...(skipped.length === 0 ? [] : [`Not captured, because this call's time ran out first: ${skipped.map((time) => `${time} s`).join(", ")}. Capture them in another call.`]),
      ...(stopped === undefined ? [] : [stopped]),
      "Roqer stopped the effect afterwards.",
    ],
    ok: stopped === undefined,
  });
}
