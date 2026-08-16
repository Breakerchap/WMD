/*
 * WikiMD text operational-transformation primitives.
 *
 * The retain/insert/delete representation and transform state machine follow the
 * well-established TextOperation model used by ot.js (MIT). This implementation
 * is intentionally small and dependency-free so the same code can run in a
 * browser and in Node tests. See THIRD_PARTY_NOTICES.md.
 */
(function initTextOt(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WmdTextOT = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  function append(target, part) {
    if (part === 0 || part === "") return;
    if (typeof part !== "number" && typeof part !== "string") {
      throw new TypeError("Text operations may only contain retain/delete counts and inserted strings.");
    }
    if (typeof part === "number" && (!Number.isSafeInteger(part) || part === 0)) {
      throw new TypeError("Text operation counts must be non-zero safe integers.");
    }
    const previous = target[target.length - 1];
    if (typeof part === "number" && typeof previous === "number" && Math.sign(part) === Math.sign(previous)) {
      target[target.length - 1] += part;
    } else if (typeof part === "string" && typeof previous === "string") {
      target[target.length - 1] += part;
    } else {
      target.push(part);
    }
  }

  function normalize(operation) {
    const ops = [];
    for (const part of operation && Array.isArray(operation.ops) ? operation.ops : []) append(ops, part);
    return { ops };
  }

  function lengths(operation) {
    let baseLength = 0;
    let targetLength = 0;
    for (const part of normalize(operation).ops) {
      if (typeof part === "string") targetLength += part.length;
      else if (part > 0) {
        baseLength += part;
        targetLength += part;
      } else {
        baseLength += -part;
      }
    }
    return { baseLength, targetLength };
  }

  function apply(source, operation) {
    source = String(source ?? "");
    const normalized = normalize(operation);
    let sourceIndex = 0;
    let output = "";
    for (const part of normalized.ops) {
      if (typeof part === "string") {
        output += part;
      } else if (part > 0) {
        if (sourceIndex + part > source.length) throw new Error("Text operation retains beyond the document end.");
        output += source.slice(sourceIndex, sourceIndex + part);
        sourceIndex += part;
      } else {
        const count = -part;
        if (sourceIndex + count > source.length) throw new Error("Text operation deletes beyond the document end.");
        sourceIndex += count;
      }
    }
    if (sourceIndex !== source.length) throw new Error("Text operation does not cover its complete source.");
    return output;
  }

  function consume(part, length) {
    if (typeof part === "string") return part.slice(length);
    return part > 0 ? part - length : part + length;
  }

  function transform(left, right) {
    const leftNormalized = normalize(left);
    const rightNormalized = normalize(right);
    const leftLengths = lengths(leftNormalized);
    const rightLengths = lengths(rightNormalized);
    if (leftLengths.baseLength !== rightLengths.baseLength) {
      throw new Error(`Cannot transform operations with different source lengths (${leftLengths.baseLength} and ${rightLengths.baseLength}).`);
    }

    const leftParts = leftNormalized.ops.slice();
    const rightParts = rightNormalized.ops.slice();
    let leftPart = leftParts.shift();
    let rightPart = rightParts.shift();
    const leftPrime = [];
    const rightPrime = [];

    while (leftPart !== undefined || rightPart !== undefined) {
      // Same-position inserts are deliberately left-biased. The WikiMD server is
      // the single sequencer, so every replica sees the same canonical ordering.
      if (typeof leftPart === "string") {
        append(leftPrime, leftPart);
        append(rightPrime, leftPart.length);
        leftPart = leftParts.shift();
        continue;
      }
      if (typeof rightPart === "string") {
        append(leftPrime, rightPart.length);
        append(rightPrime, rightPart);
        rightPart = rightParts.shift();
        continue;
      }
      if (leftPart === undefined || rightPart === undefined) {
        throw new Error("Concurrent text operations are structurally incompatible.");
      }

      const length = Math.min(Math.abs(leftPart), Math.abs(rightPart));
      if (leftPart > 0 && rightPart > 0) {
        append(leftPrime, length);
        append(rightPrime, length);
      } else if (leftPart < 0 && rightPart > 0) {
        append(leftPrime, -length);
      } else if (leftPart > 0 && rightPart < 0) {
        append(rightPrime, -length);
      }
      // If both delete the same source text, neither transformed operation needs
      // to delete it again.

      leftPart = consume(leftPart, length);
      rightPart = consume(rightPart, length);
      if (leftPart === 0) leftPart = leftParts.shift();
      if (rightPart === 0) rightPart = rightParts.shift();
    }

    const result = [{ ops: leftPrime }, { ops: rightPrime }];
    const leftPrimeLengths = lengths(result[0]);
    const rightPrimeLengths = lengths(result[1]);
    if (leftPrimeLengths.baseLength !== rightLengths.targetLength || rightPrimeLengths.baseLength !== leftLengths.targetLength) {
      throw new Error("Transformed operation lengths are inconsistent.");
    }
    if (leftPrimeLengths.targetLength !== rightPrimeLengths.targetLength) {
      throw new Error("Transformed operations do not converge on the same target length.");
    }
    return result;
  }

  function mapOffset(offset, operation, affinity = "before") {
    const sourceOffset = Math.max(0, Number(offset) || 0);
    let consumed = 0;
    let produced = 0;
    for (const part of normalize(operation).ops) {
      if (typeof part === "string") {
        if (sourceOffset === consumed && affinity !== "after") return produced;
        produced += part.length;
      } else if (part > 0) {
        if (sourceOffset < consumed + part) return produced + Math.max(0, sourceOffset - consumed);
        consumed += part;
        produced += part;
        if (sourceOffset === consumed && affinity !== "after") return produced;
      } else {
        const removed = -part;
        if (sourceOffset < consumed + removed) return produced;
        consumed += removed;
        if (sourceOffset === consumed && affinity !== "after") return produced;
      }
    }
    return produced + Math.max(0, sourceOffset - consumed);
  }

  return { append, normalize, lengths, apply, transform, mapOffset };
});
