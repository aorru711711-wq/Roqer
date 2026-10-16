import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { windowsNpmPackageRoots } from "./windows-npm";

test("Windows npm roots unquote PATH, collapse duplicates, and add the default AppData prefix", () => {
  const quoted = path.join("C:", "Program Files", "nodejs");
  const other = path.join("D:", "tools", "npm");
  const appData = path.join("C:", "Users", "me", "AppData", "Roaming");
  const roots = windowsNpmPackageRoots(
    {
      PATH: [`"${quoted}"`, other, quoted, ""].join(path.delimiter),
      APPDATA: appData,
    },
    "@anthropic-ai/claude-code",
  );
  const packageRoot = (prefix: string) => path.join(prefix, "node_modules", "@anthropic-ai", "claude-code");

  assert.deepEqual(roots, [
    packageRoot(quoted),
    packageRoot(other),
    packageRoot(path.join(appData, "npm")),
  ]);
  assert.equal(roots.some((root) => root.includes('"')), false);
  assert.equal(roots.filter((root) => root.startsWith(quoted)).length, 1);
  assert.equal(roots.includes(packageRoot(path.join(appData, "npm"))), true);
  assert.ok(roots.every((root) => root.endsWith(path.join("node_modules", "@anthropic-ai", "claude-code"))));
  assert.ok(roots.every((root) => !root.includes("@anthropic-ai/claude-code")));
});
