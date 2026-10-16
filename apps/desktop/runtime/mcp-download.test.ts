import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DOWNLOAD_RETENTION_MS, downloadMcpFile, linksIn, McpDownloadError, pruneMcpDownloads } from "./mcp-download";

function replied(
  body: ConstructorParameters<typeof Response>[0],
  init: { status?: number; headers?: Record<string, string>; url?: string } = {},
): Response {
  const response = new Response(body, { status: init.status ?? 200, headers: init.headers });
  if (init.url !== undefined) Object.defineProperty(response, "url", { value: init.url });
  return response;
}

const AUDIO = { "content-type": "audio/mpeg" };

async function emptyDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "roqer-mcp-download-"));
}

async function assertNoFile(directory: string): Promise<void> {
  assert.deepEqual(await readdir(directory), []);
}

test("a download throws and writes nothing for a link it must not follow", async () => {
  const directory = await emptyDirectory();
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return replied(new Uint8Array([1, 2, 3, 4]), { headers: AUDIO });
  }) as typeof globalThis.fetch;
  const refused = async (url: string): Promise<number> => {
    calls.length = 0;
    await assert.rejects(() => downloadMcpFile(url, directory, { fetch, maxBytes: 8 }), McpDownloadError);
    await assertNoFile(directory);
    return calls.length;
  };
  try {
    assert.equal(await refused("http://cdn.example.com/a.mp3"), 0);
    assert.equal(await refused("https://user:secret@cdn.example.com/a.mp3"), 0);
    assert.equal(await refused("https://127.0.0.1/a.mp3"), 0, "loopback");
    assert.equal(await refused("https://[::1]/a.mp3"), 0, "ipv6 loopback");
    assert.equal(await refused("https://169.254.169.254/a.mp3"), 0, "link-local");
    assert.equal(await refused("https://[fe80::1]/a.mp3"), 0, "ipv6 link-local");
    assert.equal(await refused("https://10.1.2.3/a.mp3"), 0, "private");
    assert.equal(await refused("https://192.168.0.8/a.mp3"), 0, "private");
    assert.equal(await refused("https://172.16.0.4/a.mp3"), 0, "private");
    assert.equal(await refused("https://cdn.example.com/file%ZZ.mp3"), 1, "a bad percent-encoding is refused after the fetch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a redirect off https, onto a local address, or to an unreadable address writes nothing", async () => {
  const directory = await emptyDirectory();
  const landed = [
    "http://cdn.example.com/a.mp3",
    "https://127.0.0.1/a.mp3",
    "https://[::1]/a.mp3",
    "https://169.254.1.1/a.mp3",
    "https://[fe80::1]/a.mp3",
    "https://10.0.0.5/a.mp3",
    "https://192.168.1.5/a.mp3",
    "https://172.31.0.2/a.mp3",
    "::::",
  ];
  try {
    for (const url of landed) {
      const fetch = (async () => replied(new Uint8Array([1, 2, 3]), { headers: AUDIO, url })) as typeof globalThis.fetch;
      await assert.rejects(
        () => downloadMcpFile("https://cdn.example.com/a.mp3", directory, { fetch, maxBytes: 8 }),
        (error: unknown) => error instanceof McpDownloadError,
      );
      await assertNoFile(directory);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a declared or streamed body over the cap, and an empty body, write no file", async () => {
  const directory = await emptyDirectory();
  try {
    const declared = (async () => replied(new Uint8Array([1, 2, 3, 4]), {
      headers: { ...AUDIO, "content-length": "1000" },
    })) as typeof globalThis.fetch;
    await assert.rejects(() => downloadMcpFile("https://cdn.example.com/a.mp3", directory, { fetch: declared, maxBytes: 8 }), McpDownloadError);
    await assertNoFile(directory);

    const streamed = (async () => replied(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        controller.close();
      },
    }), { headers: AUDIO })) as typeof globalThis.fetch;
    await assert.rejects(() => downloadMcpFile("https://cdn.example.com/a.mp3", directory, { fetch: streamed, maxBytes: 6 }), McpDownloadError);
    await assertNoFile(directory);

    const empty = (async () => replied(new Uint8Array(), { headers: AUDIO })) as typeof globalThis.fetch;
    await assert.rejects(() => downloadMcpFile("https://cdn.example.com/a.mp3", directory, { fetch: empty }), McpDownloadError);
    await assertNoFile(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a normal https file is saved under a sanitized name with no path separators", async () => {
  const directory = await emptyDirectory();
  try {
    const fetch = (async () => replied(new Uint8Array([1, 2, 3, 4]), {
      headers: { ...AUDIO, "content-disposition": 'attachment; filename="..\\\\..\\\\nested/sfx coin.mp3"' },
    })) as typeof globalThis.fetch;
    const saved = await downloadMcpFile("https://cdn.example.com/out/sfx%20coin.mp3", directory, { fetch });
    const base = path.basename(saved.path);
    assert.equal(base.includes("/") || base.includes("\\"), false);
    assert.match(base, /^[0-9a-f]{6}-nested-sfx-coin\.mp3$/);
    assert.equal(saved.bytes, 4);
    assert.deepEqual([...await readFile(saved.path)], [1, 2, 3, 4]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prune removes download directories older than 7 days and leaves a newer one", async () => {
  const root = await emptyDirectory();
  try {
    const old = path.join(root, "old-run");
    const recent = path.join(root, "recent-run");
    await mkdir(old);
    await mkdir(recent);
    await writeFile(path.join(old, "a.mp3"), "old");
    await writeFile(path.join(recent, "b.mp3"), "new");
    const stale = new Date(Date.now() - DOWNLOAD_RETENTION_MS - 60_000);
    await utimes(old, stale, stale);
    await pruneMcpDownloads(root);
    await assert.rejects(() => stat(old));
    assert.equal((await stat(recent)).isDirectory(), true);
    assert.equal(await readFile(path.join(recent, "b.mp3"), "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linksIn drops trailing punctuation", () => {
  assert.deepEqual(linksIn(
    "Hear https://cdn.example.com/a.mp3, then https://cdn.example.com/b.mp3. Also https://cdn.example.com/c.wav; and https://cdn.example.com/d.mp3:",
  ), [
    "https://cdn.example.com/a.mp3",
    "https://cdn.example.com/b.mp3",
    "https://cdn.example.com/c.wav",
    "https://cdn.example.com/d.mp3",
  ]);
});
