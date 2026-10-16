import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Saving a file an MCP server's result linked to.
 *
 * Generation servers hand back a short-lived link rather than the file: an
 * ElevenLabs sound is a URL to an MP3. Roblox uploads read a file on disk, so
 * Roqer saves it first, into a folder of its own, under a name it chooses.
 * Only HTTPS to a public host, at most `MAX_DOWNLOAD_BYTES`, and the name's
 * extension comes from what the server says the file is, because that is how
 * the upload decides what kind of asset it holds. A private, loopback, or
 * link-local address is refused, including one a redirect lands on.
 */

export const MAX_DOWNLOAD_BYTES = 50 * 1_024 * 1_024;
/** Downloads older than this are removed when a run next saves one. */
export const DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** The extension a saved file gets for each kind of content Roqer can use. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/flac": ".flac",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "model/gltf-binary": ".glb",
  "application/octet-stream": "",
};

const KNOWN_EXTENSION = /\.(mp3|ogg|wav|flac|png|jpe?g|webp|gif|mp4|glb|gltf|fbx|obj)$/i;

export class McpDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpDownloadError";
  }
}

export type DownloadedFile = Readonly<{ path: string; bytes: number; contentType: string }>;

function decodeFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new McpDownloadError("The link's file name is not valid.");
  }
}

/** An address a third-party server must not be able to point a download at. */
function isBlockedHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const dotted = ipv4Parts(host);
  if (dotted !== undefined) return isPrivateIPv4(dotted);
  if (!host.includes(":")) return false;
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mappedDotted !== null) {
    const parts = ipv4Parts(mappedDotted[1]);
    return parts !== undefined && isPrivateIPv4(parts);
  }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex !== null) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  if (host === "::" || host === "::1") return true;
  const head = Number.parseInt(host.split(":")[0] ?? "", 16);
  if (!Number.isFinite(head)) return false;
  // fe80::/10 is link-local; fc00::/7 is a unique local address.
  return (head >= 0xfe80 && head <= 0xfebf) || (head >= 0xfc00 && head <= 0xfdff);
}

function ipv4Parts(host: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : undefined;
}

function isPrivateIPv4(parts: readonly number[]): boolean {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

function assertDownloadable(target: URL, redirected: boolean): void {
  if (target.protocol !== "https:" || target.username !== "" || target.password !== "") {
    throw new McpDownloadError(redirected
      ? "The link redirected away from https, so Roqer did not download it."
      : "Roqer only downloads https links.");
  }
  if (isBlockedHost(target.hostname)) {
    throw new McpDownloadError(redirected
      ? "The link redirected to a private or local address, so Roqer did not download it."
      : "Roqer does not download from a private or local address.");
  }
}

function landedUrl(responseUrl: string, fallback: URL): URL {
  try {
    return new URL(responseUrl !== "" ? responseUrl : fallback.href);
  } catch {
    throw new McpDownloadError("The link redirected to an address Roqer could not read, so it was not downloaded.");
  }
}

/** A short, safe name for the file, from the server's own name for it when it gave one. */
export function downloadName(url: URL, contentType: string, disposition: string | null): string {
  const declared = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  let base = declared ?? decodeFileName(url.pathname.split("/").filter(Boolean).pop() ?? "");
  base = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  if (base === "") base = "download";
  const extension = EXTENSIONS[contentType] ?? "";
  if (!KNOWN_EXTENSION.test(base) && extension !== "") base = `${base.replace(/\.[A-Za-z0-9]{1,5}$/, "")}${extension}`;
  return base;
}

/** Save `url` into `directory`. Throws `McpDownloadError` with a message fit for the model. */
export async function downloadMcpFile(
  url: string,
  directory: string,
  options: Readonly<{ fetch?: typeof fetch; signal?: AbortSignal; maxBytes?: number }> = {},
): Promise<DownloadedFile> {
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpDownloadError("That is not a link.");
  }
  assertDownloadable(parsed, false);
  let response: Response;
  try {
    // Storage links often redirect to a signed address; where it lands is checked below.
    response = await (options.fetch ?? fetch)(parsed.href, { redirect: "follow", ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new McpDownloadError(`The file could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
  }
  let landed: URL;
  try {
    landed = landedUrl(response.url, parsed);
    assertDownloadable(landed, response.url !== "" && response.url !== parsed.href);
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new McpDownloadError(response.status === 403 || response.status === 404 || response.status === 410
      ? `The link answered HTTP ${response.status}; it may have expired. Generate the file again and download the new link at once.`
      : `The link answered HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new McpDownloadError(`The file is larger than ${Math.round(maxBytes / 1_048_576)} MB.`);
  }
  const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  let name: string;
  try {
    name = downloadName(landed, contentType, response.headers.get("content-disposition"));
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  await fs.mkdir(directory, { recursive: true });
  // A prefix keeps two downloads of the same name apart.
  const file = path.join(directory, `${randomBytes(3).toString("hex")}-${name}`);
  const handle = await fs.open(file, "wx", 0o600);
  let bytes = 0;
  try {
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw new McpDownloadError(`The file is larger than ${Math.round(maxBytes / 1_048_576)} MB.`);
        }
        await handle.write(value);
      }
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  if (bytes === 0) {
    await fs.rm(file, { force: true }).catch(() => undefined);
    throw new McpDownloadError("The link returned an empty file.");
  }
  return { path: file, bytes, contentType };
}

/** Remove downloads older than the retention, run by run. Never throws. */
export async function pruneMcpDownloads(root: string, now = Date.now()): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const folder = path.join(root, entry.name);
    const details = await fs.stat(folder).catch(() => undefined);
    if (details !== undefined && now - details.mtimeMs > DOWNLOAD_RETENTION_MS) {
      await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }));
}

/** Every https link in a result, so a download can be held to the links a server gave. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(/https:\/\/[^\s"'<>`)\]}]+/g)].map((match) => match[0].replace(/[.,;:]+$/, ""));
}
