const test = require("node:test");
const assert = require("node:assert/strict");

const { computeSmartPairAction } = require("../vscode-extension/smart-edit.js");

test("smart typing pairs delimiters in empty space", () => {
  assert.deepEqual(
    computeSmartPairAction("*", " ", " ", false),
    { type: "pair", open: "*", close: "*" }
  );
});

test("smart typing does not auto-pair inside text", () => {
  assert.deepEqual(
    computeSmartPairAction("*", "a", "", false),
    { type: "insert", text: "*" }
  );
});

test("smart typing wraps selections", () => {
  assert.deepEqual(
    computeSmartPairAction("_", "", "", true),
    { type: "wrap", open: "_", close: "_" }
  );
});

test("smart typing skips over an existing closer", () => {
  assert.deepEqual(
    computeSmartPairAction("=", "", "=", false),
    { type: "skip" }
  );
});
