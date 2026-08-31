import assert from "node:assert/strict";
import test from "node:test";

const { normalizeAppBasePath } = await import("../lib/app-path.ts");

test("normalizes root and nested deployment paths", () => {
  assert.equal(normalizeAppBasePath(undefined), "");
  assert.equal(normalizeAppBasePath(""), "");
  assert.equal(normalizeAppBasePath("/"), "");
  assert.equal(normalizeAppBasePath("/projects/lumos/"), "/projects/lumos");
});

test("rejects a deployment path without a leading slash", () => {
  assert.throws(
    () => normalizeAppBasePath("projects/lumos"),
    /must start with '\/'/,
  );
});
