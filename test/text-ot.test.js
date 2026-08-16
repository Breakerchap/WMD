const assert = require("node:assert/strict");
const test = require("node:test");
const textOT = require("../web/public/text-ot");
const editorSync = require("../web/public/editor-sync");
const { transformOperations: serverTransform } = require("../web/server");

function rng(seed) {
  let value = seed >>> 0;
  return (limit) => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return limit ? value % limit : value;
  };
}

function randomEdit(source, random, label) {
  const start = random(source.length + 1);
  const removed = Math.min(random(4), source.length - start);
  const inserted = random(3) === 0 ? "" : `[${label}:${random(1000)}]`;
  const next = `${source.slice(0, start)}${inserted}${source.slice(start + removed)}`;
  return editorSync.operationFromTextDiff(source, next);
}

test("text OT validates incompatible concurrent source lengths", () => {
  assert.throws(
    () => textOT.transform({ ops: [3] }, { ops: [4] }),
    /different source lengths/,
  );
});

test("text OT normalises adjacent operation parts", () => {
  assert.deepEqual(
    textOT.normalize({ ops: [1, 2, "a", "b", -1, -2] }),
    { ops: [3, "ab", -3] },
  );
});

test("text OT transform satisfies convergence across random concurrent edits", () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = rng(seed);
    const source = "@tab Home\n\nThe quick brown fox jumps over the lazy dog.";
    const left = randomEdit(source, random, "L");
    const right = randomEdit(source, random, "R");
    if (!left || !right) continue;

    const [leftPrime, rightPrime] = textOT.transform(left, right);
    const leftThenRight = textOT.apply(textOT.apply(source, left), rightPrime);
    const rightThenLeft = textOT.apply(textOT.apply(source, right), leftPrime);
    assert.equal(leftThenRight, rightThenLeft, `seed ${seed} did not converge`);
  }
});

test("browser shared OT core and server transform remain behaviourally identical", () => {
  for (let seed = 1; seed <= 250; seed += 1) {
    const random = rng(seed * 13);
    const source = "0123456789abcdefghijklmnopqrstuvwxyz";
    const left = randomEdit(source, random, "client-a");
    const right = randomEdit(source, random, "client-b");
    if (!left || !right) continue;

    const shared = textOT.transform(left, right);
    const server = serverTransform(left, right);
    assert.deepEqual(server, shared, `seed ${seed}: client/server OT drifted`);
  }
});

test("editor sync delegates generic apply/transform behaviour to the shared OT core", () => {
  const source = "abcdef";
  const left = { ops: [2, "LEFT", 4] };
  const right = { ops: [4, -1, "R", 1] };

  assert.equal(editorSync.applyOperation(source, left), textOT.apply(source, left));
  assert.deepEqual(editorSync.transformOperations(left, right), textOT.transform(left, right));
});
