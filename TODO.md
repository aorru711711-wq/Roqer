# Small improvements

Prioritized, smallest useful change first. Do one item per change. Do not start the next until its "done when" check passes.

Baseline on this Windows checkout, at upstream `4e29b9b`: desktop tests, typecheck, lint, `npm run build`, `npm run build:desktop`, and `npm run build:plugins` passed. Core Jest failed 2 tests in `model-loader-contract.test.ts` (1130 passed, 1 skipped), which stopped `npm test` before the later scripts. Those later scripts passed when run on their own. Live Studio suites were not run.

## 1. Make the model-loader contract test pass on Windows

`packages/core/src/__tests__/model-loader-contract.test.ts` looks for a line feed immediately after the loader's pace line and after `MOVING_SPEED` / `STANDING_SPEED`. The index stores those files as LF. A Windows checkout with `core.autocrlf=true` has CRLF in the working tree, so the character after the number is `\r` and both assertions fail. That is the documented platform, and the failure aborts the rest of `npm test`.

Done when: the test normalizes newlines before those checks, `npx jest src/__tests__/model-loader-contract.test.ts --config packages/core/jest.config.js` passes in this CRLF tree, and changing either constant in only one of the two files still fails the test.

**Status:** done

## 2. Give the model a structured-only MCP result

`ExternalMcpSession.call` in `apps/desktop/runtime/external-mcp.ts` leaves the text body empty when a server returns `structuredContent` and no text, and parks that object on `data`. Every planner sends `result.text` only (`agent-loop.ts`, `chatgpt-planner.ts`), so the model sees a header and nothing else. A download link that exists only in the structured payload is then invisible, while the download note still says a file can be saved.

Done when: a result with empty text and `structuredContent: { rows: 3 }` includes a JSON rendering of that object in `text`; a result that already has text does not repeat `structuredContent`; the rendering is cut by the same character cap as other external-MCP text; `external-mcp.test.ts` covers both cases.

**Status:** done

## 3. Do not let a stale usage read overwrite a fresher push

`LimitsCache.refresh` in `apps/desktop/runtime/limits-cache.ts` writes whatever the fetch returns. `CodexLimitsTracker` also calls `replace` when Codex pushes `account/rateLimits/updated`. A read that started first can finish second and paint the older snapshot over the push. Nothing tests this class.

Done when: `limits-cache.test.ts` shows that `replace` during an in-flight fetch is still the value after that fetch resolves, a thrown fetch keeps the previous report, and a second `read` inside the interval does not call fetch.

**Status:** done

## 4. Keep unfinished work in a compacted chat

`linesFor` in `apps/desktop/shared/chat-compaction.ts` keeps a clipped message, the outcome word, and the first five changes. It drops `stoppedBecause`, `unfinished`, and `failedCalls`. A note (`message.note === true`) is labeled "User asked". After Compact chat, the next model is not told what failed.

Done when: `chat-compaction.test.ts` shows a note labeled as a note, and a failed run's stop reason, one unfinished task, and one failed call survive as clipped lines. The summary stays within `MAX_COMPACT_SUMMARY_CHARS`, including when older lines are dropped.

**Status:** done

## 5. Cap external MCP text the way Studio results are capped

`parseCallResult` in `apps/desktop/runtime/external-mcp-client.ts` keeps 200,000 characters. A Studio result is cut at 24,000 (`MAX_MODEL_RESULT_CHARS` in `studio-tools.ts`). One oversized third-party result is charged to the user's subscription on every later turn of that chat.

Done when: model-facing external-MCP text is at most 24,000 characters, the omission names how many characters were left out, and the existing bound test in `external-mcp-client.test.ts` asserts 24,000.

**Status:** done

## 6. Test and tighten MCP file downloads

`apps/desktop/runtime/mcp-download.ts` has no tests. `downloadName` calls `decodeURIComponent`, which throws `URIError` on a bad percent-encoding instead of `McpDownloadError`. Any https host is saved, including loopback, link-local, and private addresses a third-party server can offer. A bad `response.url` throws `TypeError` from `new URL` rather than `McpDownloadError`.

Done when: `mcp-download.test.ts` uses a fake `fetch` and shows all of the following. The call throws `McpDownloadError` and writes no file for a non-https URL, a URL with userinfo, a redirect off https, a loopback or link-local or private host (before fetch and after redirect), a malformed percent-encoding, a declared or streamed body over the byte cap, and an empty body. A normal https file is saved under a sanitized name with no path separators. `pruneMcpDownloads` removes run directories older than 7 days and leaves a newer one. `linksIn` drops trailing punctuation.

**Status:** done

## 7. Retry a temporary DNS failure

`PERMANENT_CONNECTION_CODES` in `apps/desktop/runtime/model-api/http.ts` includes `EAI_AGAIN`. That code means the resolver asked the caller to try again. `fetchWithin` then throws a plain `Error`, so the turn stops instead of using `TransientTurnError`. `model-api.test.ts` locks this behavior for `ECONNREFUSED` only.

Done when: that test shows `EAI_AGAIN`, including inside an `AggregateError`, rejects with `TransientTurnError`, and `ECONNREFUSED`, `ENOTFOUND`, and `ERR_INVALID_URL` stay non-transient.

## 8. Stop sending the UI-design recipe on every turn

`apps/desktop/agent/developer.md` spells out the selected-theme path (`references/selected/<theme>/<layout>.md`) in the instructions for every run. `routedCurrentPrompt` in `conversation-prompt.ts` already adds that route when the current message looks like UI work.

Done when: the always-on developer text no longer contains `references/selected/`, and it still says to load `roblox-ui-design` before the first Studio mutation on a screen. `buildFollowUpPrompt` for a prompt such as "make a shop UI" still contains `references/selected/`. A test asserts both.

## 9. Correct the catalog budget in the token-efficiency doc

`docs/token-efficiency.md` says the full catalog ceiling is 50,900 characters. `packages/core/src/__tests__/mcp-runtime.test.ts` allows 51,000.

Done when: the doc states 51,000 and still matches the test's other figures: 52 tools, 25 inspector tools, descriptions at most 120 characters, inspector catalog at most 20,000 characters.

## 10. Test Windows global-package lookup

`windowsNpmPackageRoots` in `apps/desktop/runtime/windows-npm.ts` is how Codex and Claude Code are found under a global npm prefix. It has no test.

Done when: a test with a fake env shows a quoted PATH entry is unquoted, duplicate prefixes collapse, `%APPDATA%\npm` is included when it is absent from PATH, and `@anthropic-ai/claude-code` is joined as nested `node_modules` folders.

## 11. Guard the external MCP tool description length

Claude Code keeps only the first 2,048 characters of a tool description. `studio-tools.test.ts` checks every tool Roqer grants except `external_mcp`.

Done when: that test includes `externalMcpToolDefinition()`, and its description length is at most `MAX_TOOL_DESCRIPTION_CHARS`.

## 12. Tell a from-source build to use the lockfile

CI and `CONTRIBUTING.md` install with `npm ci`. The README getting-started block and `docs/building-from-source.md` say `npm install`, which can resolve a different tree than the committed lockfile.

Done when: both of those command blocks say `npm ci`.
