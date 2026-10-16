import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_TURN_IMAGE_BASE64, TURN_IMAGE_MEDIA_TYPES, type TurnImageMediaType } from "./model-api/turn-contract";
import type { McpToolImage } from "./mcp-types";
import { isMcpToolName, MAX_MCP_LISTED_TOOLS } from "../shared/mcp-servers";

/**
 * A small MCP client for the servers the user adds: JSON-RPC over a child
 * process's stdio, or over streamable HTTP.
 *
 * It speaks only what Roqer needs: initialize, list tools, call a tool, cancel
 * a call, and answer a server's ping. It declares no client capabilities, so a
 * server has no business asking it for sampling, roots or elicitation; any
 * request of that kind is refused as an unknown method.
 *
 * Everything a server sends is untrusted. Every message, list and result is
 * bounded here, before the rest of Roqer sees it.
 */

/** Newest first. A server that answers with any other version is refused. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const REQUESTED_PROTOCOL_VERSION = "2025-06-18";

/** One JSON-RPC message; larger is not a tool result, it is a flood. */
const MAX_MESSAGE_BYTES = 16 * 1_024 * 1_024;
const MAX_STDERR_CHARACTERS = 4_000;
const MAX_TOOL_DESCRIPTION_CHARACTERS = 2_000;
const MAX_INPUT_SCHEMA_CHARACTERS = 16_000;
const MAX_LIST_PAGES = 10;
/** The most text one external-MCP tool result keeps. Longer text is cut, and the cut is named. */
export const MAX_RESULT_TEXT_CHARACTERS = 200_000;
const MAX_RESULT_IMAGES = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 2_000;

/**
 * Where an OAuth server's bearer token comes from. Asked before every request,
 * so a token renewed elsewhere is picked up, and asked to renew once when the
 * server answers 401.
 */
export interface McpAuthorization {
  /** A current access token. Throws when there is no sign-in to use. */
  accessToken(): Promise<string>;
  /**
   * A renewed token after the server refused `rejected` with a 401, or
   * undefined when the sign-in cannot be renewed. Passing the refused token
   * lets a renewal another request already made be used rather than repeated.
   */
  renew(rejected: string): Promise<string | undefined>;
}

export type ExternalMcpTarget =
  | Readonly<{ transport: "stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>
  | Readonly<{ transport: "http"; url: string; headers: Readonly<Record<string, string>>; authorization?: McpAuthorization }>;

export type ExternalMcpTool = Readonly<{
  name: string;
  description: string;
  /** The tool's JSON schema, or undefined when the server sent none Roqer could keep. */
  inputSchema: Record<string, unknown> | undefined;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}>;

export type ExternalMcpCallResult = Readonly<{
  isError: boolean;
  text: string;
  images: readonly McpToolImage[];
  structured?: unknown;
  /** What the result held that Roqer did not pass on, in words. */
  omitted: readonly string[];
}>;

export type ExternalMcpErrorCode = "connect_failed" | "protocol_error" | "timeout" | "cancelled" | "server_error" | "closed" | "unauthorized";

export class ExternalMcpError extends Error {
  constructor(readonly code: ExternalMcpErrorCode, message: string) {
    super(message);
    this.name = "ExternalMcpError";
  }
}

export type ExternalMcpRequestOptions = Readonly<{ signal?: AbortSignal; timeoutMs?: number }>;

export interface ExternalMcpConnection {
  listTools(options?: ExternalMcpRequestOptions): Promise<ExternalMcpTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: ExternalMcpRequestOptions): Promise<ExternalMcpCallResult>;
  /** Whether the transport has ended; a closed connection answers nothing. */
  readonly closed: boolean;
  /** Counts the server's notices that its tools changed, so a kept list can be read again. */
  readonly toolsVersion: number;
  close(): Promise<void>;
}

export type SpawnServer = (command: string, args: readonly string[], options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  windowsVerbatimArguments: boolean;
}) => ChildProcess;

export type ExternalMcpConnectOptions = Readonly<{
  clientVersion: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable for tests. */
  spawn?: SpawnServer;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  /** The environment a stdio server starts from, before its own variables. */
  baseEnv?: NodeJS.ProcessEnv;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const truncate = (value: string, limit: number): string => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

// -- JSON-RPC ---------------------------------------------------------------

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** The transport underneath a session: one way to send a message and learn of the end. */
interface MessageChannel {
  /**
   * Whether `send` resolves only once the answer to a request has been read,
   * as an HTTP response is. A request still unanswered then never will be.
   */
  readonly answersInline: boolean;
  send(message: Record<string, unknown>, options: { signal: AbortSignal }): Promise<void>;
  close(): Promise<void>;
}

/**
 * Request and response bookkeeping shared by both transports. A transport
 * hands every message it receives to `receive`, and calls `end` once.
 */
class RpcSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private endedWith: ExternalMcpError | undefined;
  channel: MessageChannel | undefined;
  /** Bumped when the server says its tools changed, so a cached list is dropped. */
  toolsChanged = 0;

  get ended(): boolean {
    return this.endedWith !== undefined;
  }

  receive(message: unknown): void {
    if (!isRecord(message) || message.jsonrpc !== "2.0") return;
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    if (hasId && typeof message.method === "string") {
      this.answerServerRequest(message.id as number | string, message.method);
      return;
    }
    if (hasId) {
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (pending === undefined) return;
      this.pending.delete(message.id as number);
      if (isRecord(message.error)) {
        const text = typeof message.error.message === "string" ? message.error.message : "The server reported an error.";
        pending.reject(new ExternalMcpError("server_error", truncate(text, 500)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "notifications/tools/list_changed") this.toolsChanged += 1;
  }

  /** Ping is answered; anything else a server asks of the client is not something Roqer offers. */
  private answerServerRequest(id: number | string, method: string): void {
    const reply = method === "ping"
      ? { jsonrpc: "2.0", id, result: {} }
      : { jsonrpc: "2.0", id, error: { code: -32601, message: "Roqer does not offer this method." } };
    void this.channel?.send(reply, { signal: new AbortController().signal }).catch(() => undefined);
  }

  end(error: ExternalMcpError): void {
    if (this.endedWith !== undefined) return;
    this.endedWith = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request(method: string, params: Record<string, unknown>, options: ExternalMcpRequestOptions = {}): Promise<unknown> {
    if (this.endedWith !== undefined) throw this.endedWith;
    if (options.signal?.aborted) throw new ExternalMcpError("cancelled", "The call was cancelled.");
    const id = this.nextId++;
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      const finish = () => {
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const abandon = (error: ExternalMcpError) => {
        if (done) return;
        finish();
        controller.abort();
        // A request the server already started is told it is no longer wanted.
        void this.notify("notifications/cancelled", { requestId: id, reason: error.message }).catch(() => undefined);
        reject(error);
      };
      const onAbort = () => abandon(new ExternalMcpError("cancelled", "The call was cancelled."));
      const timer = setTimeout(() => abandon(new ExternalMcpError("timeout", `The server did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          if (done) return;
          finish();
          resolve(value);
        },
        reject: (error) => {
          if (done) return;
          finish();
          reject(error);
        },
      });
      const channel = this.channel!;
      channel.send({ jsonrpc: "2.0", id, method, params }, { signal: controller.signal }).then(() => {
        if (done || !channel.answersInline) return;
        finish();
        reject(new ExternalMcpError("protocol_error", `The server ended its answer to ${method} without a result.`));
      }, (error: unknown) => {
        if (done) return;
        finish();
        reject(error instanceof ExternalMcpError ? error : new ExternalMcpError("connect_failed", describeError(error)));
      });
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.endedWith !== undefined || this.channel === undefined) return;
    await this.channel.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, { signal: new AbortController().signal });
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error && cause.message ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}

// -- stdio ------------------------------------------------------------------

function isExistingFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a bare command name lives on Windows, with its extension. Node will
 * not start a `.cmd` or `.bat` file without a shell, and most MCP servers are
 * started through one (`npx.cmd`), so the caller needs to know which it is.
 * `isFile` is injectable so the lookup can be tested off Windows.
 */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, isFile: (file: string) => boolean = isExistingFile): string | undefined {
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase());
  const hasExtension = path.win32.extname(command) !== "";
  const candidates = (base: string) => hasExtension ? [base] : extensions.map((ext) => `${base}${ext}`);
  if (path.win32.isAbsolute(command)) return candidates(command).find(isFile);
  const directories = (env.Path ?? env.PATH ?? "").split(";").filter(Boolean);
  for (const directory of directories) {
    const found = candidates(path.win32.join(directory, command)).find(isFile);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * One argument quoted for `cmd.exe /s /c` and the program behind it.
 *
 * Inside double quotes cmd takes `& | < > ( ) ^` literally, but still expands
 * `%NAME%`, and a `"` would end the quoting. So those two are refused rather
 * than escaped: there is no escape for them that holds across every batch
 * file. Trailing backslashes are doubled so they do not escape the closing
 * quote when the program reads its command line.
 */
export function quoteForCmd(argument: string): string {
  if (argument.includes("\"") || argument.includes("%")) {
    throw new ExternalMcpError("connect_failed", "On Windows, a command started through a .cmd or .bat file cannot have \" or % in its arguments.");
  }
  return `"${argument.replace(/(\\+)$/, "$1$1")}"`;
}

/** How to start a stdio server on this platform: the program, its arguments, and whether they are already quoted. */
export function launchPlan(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isFile: (file: string) => boolean = isExistingFile,
): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== "win32") return { file: command, args: [...args], verbatim: false };
  const resolved = resolveWindowsCommand(command, env, isFile);
  if (resolved === undefined) {
    throw new ExternalMcpError("connect_failed", `Roqer could not find ${command}${path.win32.isAbsolute(command) ? "" : " on PATH"}.`);
  }
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args: [...args], verbatim: false };
  const line = [resolved, ...args].map(quoteForCmd).join(" ");
  return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

const defaultSpawn: SpawnServer = (command, args, options) => nodeSpawn(command, [...args], {
  cwd: options.cwd,
  env: options.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  windowsVerbatimArguments: options.windowsVerbatimArguments,
  // Its own process group, so closing it takes whatever it started.
  detached: process.platform !== "win32",
});

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function startStdio(
  target: Extract<ExternalMcpTarget, { transport: "stdio" }>,
  session: RpcSession,
  options: ExternalMcpConnectOptions,
): { channel: MessageChannel; describeExit: () => string } {
  const platform = options.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env), ...target.env };
  const plan = launchPlan(target.command, target.args, platform, env);
  const spawn = options.spawn ?? defaultSpawn;
  let child: ChildProcess;
  try {
    child = spawn(plan.file, plan.args, { env, cwd: os.homedir(), windowsVerbatimArguments: plan.verbatim });
  } catch (error) {
    throw new ExternalMcpError("connect_failed", `The server could not start: ${describeError(error)}`);
  }
  let stderr = "";
  let buffered = "";
  let exited = false;
  const describeExit = () => {
    const tail = stderr.trim();
    return tail === "" ? "" : ` It said: ${truncate(tail.split(/\r?\n/).slice(-6).join(" "), 600)}`;
  };
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARACTERS);
  });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buffered += chunk.toString();
    if (buffered.length > MAX_MESSAGE_BYTES) {
      session.end(new ExternalMcpError("protocol_error", "The server sent a message larger than Roqer accepts."));
      killTree(child);
      return;
    }
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line !== "") {
        try {
          session.receive(JSON.parse(line));
        } catch {
          // A line that is not JSON is a server logging to stdout; the
          // protocol has nothing in it to answer.
        }
      }
      newline = buffered.indexOf("\n");
    }
  });
  child.once("error", (error) => {
    exited = true;
    session.end(new ExternalMcpError("connect_failed", `The server could not start: ${describeError(error)}`));
  });
  child.once("exit", (code, signal) => {
    exited = true;
    const how = signal !== null ? `was stopped (${signal})` : `exited with code ${code ?? "unknown"}`;
    session.end(new ExternalMcpError("closed", `The server ${how}.${describeExit()}`));
  });
  child.stdin?.on("error", () => undefined);

  const channel: MessageChannel = {
    answersInline: false,
    send: (message) => new Promise<void>((resolve, reject) => {
      if (exited || child.stdin === null || child.stdin.destroyed) {
        reject(new ExternalMcpError("closed", `The server is not running.${describeExit()}`));
        return;
      }
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(new ExternalMcpError("closed", describeError(error))) : resolve());
    }),
    close: async () => {
      session.end(new ExternalMcpError("closed", "The connection was closed."));
      if (exited) return;
      // Closing stdin is how the protocol asks a stdio server to stop; one
      // that does not is stopped, with everything it started.
      child.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          killTree(child);
          resolve();
        }, CLOSE_GRACE_MS);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
  return { channel, describeExit };
}

// -- streamable HTTP --------------------------------------------------------

/** Read a body, refusing one past the limit rather than buffering it. */
async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MESSAGE_BYTES) {
    throw new ExternalMcpError("protocol_error", "The server sent a response larger than Roqer accepts.");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MESSAGE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ExternalMcpError("protocol_error", "The server sent a response larger than Roqer accepts.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Hand every message in a server-sent event stream to the session, until the
 * stream ends or the response to `waitingFor` has arrived.
 */
async function readEventStream(
  response: Response,
  signal: AbortSignal,
  session: RpcSession,
  waitingFor: number | undefined,
): Promise<void> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let data: string[] = [];
  let answered = false;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  const dispatch = () => {
    if (data.length === 0) return;
    const payload = data.join("\n");
    data = [];
    try {
      const message = JSON.parse(payload) as unknown;
      if (isRecord(message) && waitingFor !== undefined && message.id === waitingFor && message.method === undefined) answered = true;
      session.receive(message);
    } catch {
      // Not a message; nothing in it to answer.
    }
  };
  try {
    while (!answered) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > MAX_MESSAGE_BYTES) throw new ExternalMcpError("protocol_error", "The server sent an event larger than Roqer accepts.");
      let newline = buffered.search(/\r?\n/);
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(buffered[newline] === "\r" ? newline + 2 : newline + 1);
        if (line === "") dispatch();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        if (answered) break;
        newline = buffered.search(/\r?\n/);
      }
    }
    if (!answered) dispatch();
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

function startHttp(
  target: Extract<ExternalMcpTarget, { transport: "http" }>,
  session: RpcSession,
  options: ExternalMcpConnectOptions,
): { channel: MessageChannel; setProtocolVersion: (version: string) => void } {
  const fetchImpl = options.fetch ?? fetch;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  const headers = (): Record<string, string> => ({
    ...target.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === undefined ? {} : { "mcp-protocol-version": protocolVersion }),
  });

  const signedOut = () => new ExternalMcpError(
    "unauthorized",
    "Roqer's sign-in to this server has expired or was revoked. Sign in again in Settings → MCP servers.",
  );
  /** The bearer token for one request, or nothing for a server without OAuth. */
  const bearer = async (): Promise<Record<string, string>> => {
    if (target.authorization === undefined) return {};
    try {
      return { authorization: `Bearer ${await target.authorization.accessToken()}` };
    } catch (error) {
      throw new ExternalMcpError("unauthorized", describeError(error));
    }
  };
  const post = async (message: Record<string, unknown>, signal: AbortSignal, auth: Record<string, string>): Promise<Response> => {
    try {
      return await fetchImpl(target.url, {
        method: "POST",
        headers: { ...headers(), ...auth },
        body: JSON.stringify(message),
        signal,
        // A redirect would carry the headers, and the keys and tokens in
        // them, to wherever it points.
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw new ExternalMcpError("cancelled", "The call was cancelled.");
      throw new ExternalMcpError("connect_failed", `The server could not be reached: ${describeError(error)}`);
    }
  };

  const channel: MessageChannel = {
    answersInline: true,
    send: async (message, { signal }) => {
      if (session.ended) throw new ExternalMcpError("closed", "The connection was closed.");
      const auth = await bearer();
      let response = await post(message, signal, auth);
      // An expired token is renewed once, and the request sent again with it.
      if (response.status === 401 && target.authorization !== undefined) {
        void response.body?.cancel().catch(() => undefined);
        const rejected = (auth.authorization ?? "").replace(/^Bearer /, "");
        const renewed = await target.authorization.renew(rejected).catch(() => undefined);
        if (renewed === undefined) throw signedOut();
        response = await post(message, signal, { authorization: `Bearer ${renewed}` });
        if (response.status === 401) {
          void response.body?.cancel().catch(() => undefined);
          throw signedOut();
        }
      }
      const given = response.headers.get("mcp-session-id");
      if (given !== null && /^[\x21-\x7e]{1,256}$/.test(given)) sessionId = given;
      const waitingFor = typeof message.id === "number" && typeof message.method === "string" ? message.id : undefined;
      if (response.status === 202 || waitingFor === undefined) {
        void response.body?.cancel().catch(() => undefined);
        if (!response.ok && response.status !== 202) {
          throw new ExternalMcpError("server_error", `The server answered HTTP ${response.status}.`);
        }
        return;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 404 && sessionId !== undefined) {
          session.end(new ExternalMcpError("closed", "The server ended the session."));
          throw new ExternalMcpError("closed", "The server ended the session.");
        }
        const why = response.status === 401 || response.status === 403
          ? target.authorization === undefined
            ? " Check the server's key in Settings, or sign in to it with OAuth."
            : " The signed-in account may not be allowed this."
          : "";
        throw new ExternalMcpError("server_error", `The server answered HTTP ${response.status}.${why}`);
      }
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("text/event-stream")) {
        await readEventStream(response, signal, session, waitingFor);
        return;
      }
      const text = await readBounded(response, signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ExternalMcpError("protocol_error", "The server's answer was not JSON.");
      }
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) session.receive(entry);
    },
    close: async () => {
      const id = sessionId;
      session.end(new ExternalMcpError("closed", "The connection was closed."));
      if (id === undefined) return;
      // Telling the server the session is over is a courtesy; one that does
      // not answer in time is left to expire it.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLOSE_GRACE_MS);
      try {
        const auth = await bearer().catch(() => ({}));
        const response = await fetchImpl(target.url, {
          method: "DELETE",
          headers: { ...target.headers, ...auth, "mcp-session-id": id, ...(protocolVersion === undefined ? {} : { "mcp-protocol-version": protocolVersion }) },
          signal: controller.signal,
          redirect: "error",
        });
        void response.body?.cancel().catch(() => undefined);
      } catch {
        // Nothing to do about it.
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return { channel, setProtocolVersion: (version) => { protocolVersion = version; } };
}

// -- Results ----------------------------------------------------------------

function isTurnImageMediaType(value: unknown): value is TurnImageMediaType {
  return typeof value === "string" && (TURN_IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/** A tool definition as Roqer keeps it, or undefined for one it will not offer. */
function parseTool(value: unknown): ExternalMcpTool | undefined {
  if (!isRecord(value) || !isMcpToolName(value.name)) return undefined;
  const annotations = isRecord(value.annotations) ? value.annotations : {};
  let inputSchema: Record<string, unknown> | undefined;
  if (isRecord(value.inputSchema)) {
    const size = JSON.stringify(value.inputSchema)?.length ?? 0;
    inputSchema = size <= MAX_INPUT_SCHEMA_CHARACTERS ? value.inputSchema : undefined;
  }
  return {
    name: value.name,
    description: typeof value.description === "string" ? truncate(value.description, MAX_TOOL_DESCRIPTION_CHARACTERS) : "",
    inputSchema,
    ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
    ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
  };
}

/** A `tools/call` result as Roqer passes it on: text, images it can show a model, and a note of the rest. */
export function parseCallResult(value: unknown): ExternalMcpCallResult {
  if (!isRecord(value)) throw new ExternalMcpError("protocol_error", "The server's tool result was not an object.");
  const texts: string[] = [];
  const images: McpToolImage[] = [];
  const omitted: string[] = [];
  const content = Array.isArray(value.content) ? value.content : [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "image") {
      if (isTurnImageMediaType(block.mimeType) && typeof block.data === "string" && block.data.length <= MAX_TURN_IMAGE_BASE64 &&
        images.length < MAX_RESULT_IMAGES && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) {
        images.push({ mediaType: block.mimeType, data: block.data });
      } else {
        omitted.push("an image");
      }
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      texts.push(`[resource: ${truncate(block.uri, 300)}${typeof block.name === "string" ? ` (${truncate(block.name, 100)})` : ""}]`);
    } else if (block.type === "resource" && isRecord(block.resource)) {
      const resource = block.resource;
      if (typeof resource.text === "string") {
        texts.push(`[resource ${typeof resource.uri === "string" ? truncate(resource.uri, 300) : ""}]\n${resource.text}`);
      } else {
        omitted.push("a binary resource");
      }
    } else if (block.type === "audio") {
      omitted.push("audio");
    } else {
      omitted.push("content of an unknown kind");
    }
  }
  let text = texts.join("\n\n");
  if (text.length > MAX_RESULT_TEXT_CHARACTERS) {
    text = truncate(text, MAX_RESULT_TEXT_CHARACTERS);
    omitted.push("the end of a long text");
  }
  const structured = value.structuredContent;
  return {
    isError: value.isError === true,
    text,
    images,
    ...(structured === undefined ? {} : { structured }),
    omitted,
  };
}

// -- Connecting -------------------------------------------------------------

/**
 * Start or reach the server and complete the MCP handshake. Rejects with an
 * `ExternalMcpError` whose message is fit to show the user and the model.
 */
export async function connectExternalMcp(target: ExternalMcpTarget, options: ExternalMcpConnectOptions): Promise<ExternalMcpConnection> {
  const session = new RpcSession();
  let setProtocolVersion: (version: string) => void = () => undefined;
  if (target.transport === "stdio") {
    session.channel = startStdio(target, session, options).channel;
  } else {
    const http = startHttp(target, session, options);
    session.channel = http.channel;
    setProtocolVersion = http.setProtocolVersion;
  }
  const channel = session.channel;

  let initialized: unknown;
  try {
    initialized = await session.request("initialize", {
      protocolVersion: REQUESTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Roqer", version: options.clientVersion },
    }, { signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS });
  } catch (error) {
    await channel.close().catch(() => undefined);
    if (error instanceof ExternalMcpError && error.code === "timeout") {
      throw new ExternalMcpError("timeout", "The server did not finish starting in time.");
    }
    throw error;
  }
  const version = isRecord(initialized) ? initialized.protocolVersion : undefined;
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(version)) {
    await channel.close().catch(() => undefined);
    throw new ExternalMcpError("protocol_error", `The server speaks an MCP version Roqer does not (${typeof version === "string" ? truncate(version, 40) : "none given"}).`);
  }
  if (!isRecord(initialized) || !isRecord(initialized.capabilities) || initialized.capabilities.tools === undefined) {
    await channel.close().catch(() => undefined);
    throw new ExternalMcpError("protocol_error", "The server offers no tools.");
  }
  setProtocolVersion(version as string);
  await session.notify("notifications/initialized").catch(() => undefined);

  return {
    get closed() {
      return session.ended;
    },
    get toolsVersion() {
      return session.toolsChanged;
    },
    async listTools(requestOptions = {}) {
      const tools: ExternalMcpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await session.request("tools/list", cursor === undefined ? {} : { cursor }, requestOptions);
        if (!isRecord(result) || !Array.isArray(result.tools)) throw new ExternalMcpError("protocol_error", "The server's tool list was not valid.");
        for (const entry of result.tools) {
          const tool = parseTool(entry);
          if (tool !== undefined && !tools.some((known) => known.name === tool.name)) tools.push(tool);
          if (tools.length >= MAX_MCP_LISTED_TOOLS) return tools;
        }
        if (typeof result.nextCursor !== "string" || result.nextCursor === "") break;
        cursor = result.nextCursor;
      }
      return tools;
    },
    async callTool(name, args, requestOptions = {}) {
      return parseCallResult(await session.request("tools/call", { name, arguments: args }, requestOptions));
    },
    close: () => channel.close(),
  };
}
