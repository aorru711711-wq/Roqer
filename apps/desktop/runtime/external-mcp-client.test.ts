import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  connectExternalMcp, ExternalMcpError, launchPlan, parseCallResult, quoteForCmd, type ExternalMcpConnection,
} from "./external-mcp-client";

/**
 * A real MCP server over stdio, small enough to read: it answers the
 * handshake, lists two pages of tools, and has tools that echo, fail, return
 * an image, wait forever, ping the client, and report what it was sent.
 */
const STDIO_SERVER = String.raw`
let cancellations = 0;
let buffered = "";
const pending = new Map();
let nextId = 1000;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
process.stdout.write("this line is a server logging to stdout\n");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method === undefined) {
      pending.get(message.id)?.(message);
      continue;
    }
    if (message.method === "notifications/cancelled") { cancellations += 1; continue; }
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    } else if (message.method === "tools/list") {
      if (message.params.cursor === undefined) {
        reply(message.id, { tools: [
          { name: "echo", description: "Echo the arguments.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "bad name with spaces", description: "Not offered." },
        ], nextCursor: "page-2" });
      } else {
        reply(message.id, { tools: [{ name: "fail", description: "Always fails." }] });
      }
    } else if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      if (name === "echo") reply(message.id, { content: [{ type: "text", text: JSON.stringify(args) }] });
      else if (name === "fail") reply(message.id, { isError: true, content: [{ type: "text", text: "it broke" }] });
      else if (name === "image") reply(message.id, { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }, { type: "audio", mimeType: "audio/wav", data: "AAAA" }] });
      else if (name === "cancellations") reply(message.id, { content: [{ type: "text", text: String(cancellations) }] });
      else if (name === "env") reply(message.id, { content: [{ type: "text", text: JSON.stringify({ secret: process.env.MY_SECRET ?? null }) }] });
      else if (name === "ping_me") {
        const id = nextId++;
        pending.set(id, (answer) => reply(message.id, { content: [{ type: "text", text: answer.result !== undefined ? "pong" : "no pong" }] }));
        send({ jsonrpc: "2.0", id, method: "ping" });
      } else if (name === "exit") process.exit(3);
      // "slow" never answers.
    }
  }
});
`;

async function withStdioServer(run: (connection: ExternalMcpConnection) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-fake-mcp-"));
  const script = path.join(directory, "server.cjs");
  await fs.writeFile(script, STDIO_SERVER);
  const connection = await connectExternalMcp(
    { transport: "stdio", command: process.execPath, args: [script], env },
    { clientVersion: "test", timeoutMs: 10_000, baseEnv: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot } },
  );
  try {
    await run(connection);
  } finally {
    await connection.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("a stdio server is started, listed across pages, and called", async () => {
  await withStdioServer(async (connection) => {
    const tools = await connection.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["echo", "fail"], "a tool with an invalid name is not offered");
    assert.equal(tools[0].readOnlyHint, true);

    const echoed = await connection.callTool("echo", { a: 1 });
    assert.deepEqual(echoed, { isError: false, text: "{\"a\":1}", images: [], omitted: [] });

    const failed = await connection.callTool("fail", {});
    assert.equal(failed.isError, true);
    assert.equal(failed.text, "it broke");

    const pictured = await connection.callTool("image", {});
    assert.deepEqual(pictured.images, [{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
    assert.deepEqual(pictured.omitted, ["audio"]);
  });
});

test("on Windows a server behind a .cmd shim really starts, with arguments that need quoting", { skip: process.platform !== "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer fake mcp (shim) & co-"));
  try {
    const script = path.join(directory, "server.cjs");
    await fs.writeFile(script, STDIO_SERVER);
    const shim = path.join(directory, "server.cmd");
    // As npm writes one: the program and every argument passed through.
    await fs.writeFile(shim, `@"${process.execPath}" %*\r\n`);
    const connection = await connectExternalMcp(
      { transport: "stdio", command: shim, args: [script], env: {} },
      { clientVersion: "test", timeoutMs: 10_000, baseEnv: { ...process.env } },
    );
    try {
      assert.equal((await connection.callTool("echo", { ok: true })).text, "{\"ok\":true}");
    } finally {
      await connection.close();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a stdio server gets the variables it was given", async () => {
  await withStdioServer(async (connection) => {
    const result = await connection.callTool("env", {});
    assert.deepEqual(JSON.parse(result.text), { secret: "s3cret" });
  }, { MY_SECRET: "s3cret" });
});

test("a cancelled call is abandoned at once, and the server is told", async () => {
  await withStdioServer(async (connection) => {
    const controller = new AbortController();
    const call = connection.callTool("slow", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(call, (error: unknown) => error instanceof ExternalMcpError && error.code === "cancelled");
    const count = await connection.callTool("cancellations", {});
    assert.equal(count.text, "1");
  });
});

test("a call that outlives its budget times out, and the server is told", async () => {
  await withStdioServer(async (connection) => {
    await assert.rejects(connection.callTool("slow", {}, { timeoutMs: 100 }), (error: unknown) =>
      error instanceof ExternalMcpError && error.code === "timeout");
    assert.equal((await connection.callTool("cancellations", {})).text, "1");
  });
});

test("the server's ping is answered", async () => {
  await withStdioServer(async (connection) => {
    assert.equal((await connection.callTool("ping_me", {})).text, "pong");
  });
});

test("a server that exits fails its pending call and reports closed", async () => {
  await withStdioServer(async (connection) => {
    await assert.rejects(connection.callTool("exit", {}), (error: unknown) =>
      error instanceof ExternalMcpError && error.code === "closed" && /code 3/.test(error.message));
    assert.equal(connection.closed, true);
  });
});

test("a program that cannot start is reported, not thrown past the caller", async () => {
  await assert.rejects(
    connectExternalMcp(
      { transport: "stdio", command: path.join(os.tmpdir(), "roqer-no-such-program", "missing.exe"), args: [], env: {} },
      { clientVersion: "test", timeoutMs: 5_000, platform: "linux" },
    ),
    (error: unknown) => error instanceof ExternalMcpError && (error.code === "connect_failed" || error.code === "closed"),
  );
});

/** A streamable HTTP server: JSON for most answers, an event stream for tool calls. */
async function withHttpServer(
  run: (url: string, seen: { headers: http.IncomingHttpHeaders[]; deleted: number }) => Promise<void>,
  options: { redirect?: boolean } = {},
): Promise<void> {
  const seen = { headers: [] as http.IncomingHttpHeaders[], deleted: 0 };
  const server = http.createServer((request, response) => {
    seen.headers.push(request.headers);
    if (options.redirect) {
      response.writeHead(307, { location: "http://127.0.0.1:1/elsewhere" }).end();
      return;
    }
    if (request.method === "DELETE") {
      seen.deleted += 1;
      response.writeHead(200).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }));
      } else if (message.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search", description: "Search." }] } }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`);
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `found ${JSON.stringify(message.params?.arguments)}` }] } })}\n\n`);
        // The stream stays open: the client stops reading once it has its answer.
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}/mcp`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a streamable HTTP server is reached with the session, version and the user's headers", async () => {
  await withHttpServer(async (url, seen) => {
    const connection = await connectExternalMcp(
      { transport: "http", url, headers: { authorization: "Bearer key-1" } },
      { clientVersion: "test", timeoutMs: 5_000 },
    );
    assert.deepEqual((await connection.listTools()).map((tool) => tool.name), ["search"]);
    const result = await connection.callTool("search", { q: "parts" });
    assert.equal(result.text, "found {\"q\":\"parts\"}");
    await connection.close();

    const [initialize, ...later] = seen.headers;
    assert.equal(initialize.authorization, "Bearer key-1");
    assert.equal(initialize["mcp-session-id"], undefined);
    assert.ok(later.length >= 3);
    for (const headers of later) {
      assert.equal(headers["mcp-session-id"], "session-1");
      assert.equal(headers["mcp-protocol-version"], "2025-06-18");
      assert.equal(headers.authorization, "Bearer key-1");
    }
    assert.equal(seen.deleted, 1, "closing ends the session on the server");
  });
});

test("a redirect is refused, so the user's headers never follow it", async () => {
  await withHttpServer(async (url, seen) => {
    await assert.rejects(
      connectExternalMcp({ transport: "http", url, headers: { authorization: "Bearer key-1" } }, { clientVersion: "test", timeoutMs: 5_000 }),
      (error: unknown) => error instanceof ExternalMcpError && error.code === "connect_failed",
    );
    assert.equal(seen.headers.length, 1, "only the first server was asked");
  }, { redirect: true });
});

test("on Windows a .cmd shim is started through cmd with every argument quoted", () => {
  // A Windows file system of two files, so the lookup reads the same on any machine.
  const files = new Set(["C:\\Program Files\\nodejs\\npx.cmd", "C:\\Tools\\server.exe"]);
  const isFile = (file: string) => files.has(file);
  const env = { PATH: "C:\\Windows;C:\\Program Files\\nodejs;C:\\Tools", PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  const plan = launchPlan("npx", ["-y", "@scope/server", "C:\\dir with space\\"], "win32", env, isFile);
  assert.equal(plan.file, env.ComSpec);
  assert.equal(plan.verbatim, true);
  assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(plan.args[3], "\"\"C:\\Program Files\\nodejs\\npx.cmd\" \"-y\" \"@scope/server\" \"C:\\dir with space\\\\\"\"");
  // An .exe needs no shell, and its arguments are left for Node to quote.
  assert.deepEqual(launchPlan("server", ["--port", "1"], "win32", env, isFile), { file: "C:\\Tools\\server.exe", args: ["--port", "1"], verbatim: false });
  assert.throws(() => launchPlan("npx", ["%PATH%"], "win32", env, isFile), /cannot have/);
  assert.throws(() => launchPlan("missing", [], "win32", env, isFile), /could not find missing on PATH/);
  assert.deepEqual(launchPlan("npx", ["-y"], "linux", env, isFile), { file: "npx", args: ["-y"], verbatim: false }, "elsewhere the command runs as given");
});

test("quoting refuses what cmd would still expand", () => {
  assert.equal(quoteForCmd("a & b"), "\"a & b\"");
  assert.throws(() => quoteForCmd("say \"hi\""), ExternalMcpError);
  assert.throws(() => quoteForCmd("%USERPROFILE%"), ExternalMcpError);
});

test("a result is bounded, and what is not passed on is named", () => {
  const result = parseCallResult({
    content: [
      { type: "text", text: "x".repeat(250_000) },
      { type: "image", mimeType: "image/tiff", data: "AAAA" },
      { type: "resource_link", uri: "file:///notes.md", name: "notes" },
    ],
    structuredContent: { rows: 3 },
  });
  const passed = `${"x".repeat(250_000)}\n\n[resource: file:///notes.md (notes)]`;
  const leftOut = passed.length - (24_000 - 1);
  assert.equal(result.text.length, 24_000);
  assert.deepEqual(result.omitted, ["an image", `${leftOut} characters left out`]);
  assert.deepEqual(result.structured, { rows: 3 });
  assert.throws(() => parseCallResult("nope"), ExternalMcpError);
});
