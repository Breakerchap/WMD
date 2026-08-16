(function initEditorSync(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WmdEditorSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (root) => {
  "use strict";

  const textOT = root && root.WmdTextOT
    ? root.WmdTextOT
    : typeof require === "function"
      ? require("./text-ot")
      : null;

  if (!textOT) throw new Error("WmdTextOT must be loaded before editor-sync.js.");

  const appendPart = textOT.append;
  const applyOperation = textOT.apply;
  const mapOffsetThroughOperation = textOT.mapOffset;
  const transformOperations = textOT.transform;

  // Converts a local optimistic position back to the current server text. Any
  // position inside locally inserted text maps to that insertion's source point.
  function mapOffsetBackwardThroughOperation(offset, operation) {
    const targetOffset = Math.max(0, Number(offset) || 0);
    let consumed = 0;
    let produced = 0;
    for (const part of textOT.normalize(operation).ops) {
      if (typeof part === "string") {
        if (targetOffset <= produced + part.length) return consumed;
        produced += part.length;
        continue;
      }
      if (part > 0) {
        if (targetOffset <= produced + part) return consumed + Math.max(0, targetOffset - produced);
        consumed += part;
        produced += part;
        continue;
      }
      consumed += -part;
    }
    return consumed + Math.max(0, targetOffset - produced);
  }

  function mapSelectionThroughOperations(selection, operations, affinity = "before") {
    let start = Math.max(0, Number(selection && selection.start) || 0);
    let end = Math.max(0, Number(selection && selection.end) || 0);
    for (const operation of operations || []) {
      const collapsed = start === end;
      start = mapOffsetThroughOperation(start, operation, collapsed ? affinity : "before");
      end = mapOffsetThroughOperation(end, operation, collapsed ? affinity : "after");
    }
    return { start, end };
  }

  function mapSelectionBackwardThroughOperations(selection, operations) {
    let start = Math.max(0, Number(selection && selection.start) || 0);
    let end = Math.max(0, Number(selection && selection.end) || 0);
    for (const operation of [...(operations || [])].reverse()) {
      start = mapOffsetBackwardThroughOperation(start, operation);
      end = mapOffsetBackwardThroughOperation(end, operation);
    }
    return { start, end };
  }

  function simpleOperationFromDiff(before, after) {
    if (before === after) return null;
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix
      && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
    const ops = [];
    appendPart(ops, prefix);
    appendPart(ops, -(before.length - prefix - suffix));
    appendPart(ops, after.slice(prefix, after.length - suffix));
    appendPart(ops, suffix);
    return { ops };
  }

  function backtrackDiff(trace, before, after) {
    let x = before.length;
    let y = after.length;
    const edits = [];
    for (let depth = trace.length - 1; depth >= 0; depth -= 1) {
      const diagonal = x - y;
      const previous = trace[depth];
      const left = previous.has(diagonal - 1) ? previous.get(diagonal - 1) : -Infinity;
      const right = previous.has(diagonal + 1) ? previous.get(diagonal + 1) : -Infinity;
      const previousDiagonal = diagonal === -depth || (diagonal !== depth && left < right) ? diagonal + 1 : diagonal - 1;
      const previousX = previous.has(previousDiagonal) ? previous.get(previousDiagonal) : 0;
      const previousY = previousX - previousDiagonal;
      while (x > previousX && y > previousY) {
        edits.push({ type: "equal", value: before[x - 1] });
        x -= 1;
        y -= 1;
      }
      if (depth === 0) break;
      if (x === previousX) edits.push({ type: "insert", value: after[previousY] });
      else edits.push({ type: "delete", value: before[previousX] });
      x = previousX;
      y = previousY;
    }
    return edits.reverse();
  }

  // Myers keeps unchanged characters as anchors between canonical canvas WMD and
  // the user's original spelling, rather than treating a whole block as replaced.
  function operationFromTextDiff(before, after) {
    before = String(before || "");
    after = String(after || "");
    if (before === after) return null;
    const maximum = before.length + after.length;
    if (maximum > 24000) return simpleOperationFromDiff(before, after);
    let diagonals = new Map([[1, 0]]);
    const trace = [];
    for (let depth = 0; depth <= maximum; depth += 1) {
      trace.push(new Map(diagonals));
      const next = new Map();
      for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
        const left = diagonals.has(diagonal - 1) ? diagonals.get(diagonal - 1) : -Infinity;
        const right = diagonals.has(diagonal + 1) ? diagonals.get(diagonal + 1) : -Infinity;
        let x = diagonal === -depth || (diagonal !== depth && left < right) ? right : left + 1;
        if (!Number.isFinite(x)) x = 0;
        let y = x - diagonal;
        while (x < before.length && y < after.length && before[x] === after[y]) {
          x += 1;
          y += 1;
        }
        next.set(diagonal, x);
        if (x >= before.length && y >= after.length) {
          const ops = [];
          for (const edit of backtrackDiff(trace, before, after)) {
            if (edit.type === "equal") appendPart(ops, 1);
            else if (edit.type === "delete") appendPart(ops, -1);
            else appendPart(ops, edit.value);
          }
          return { ops };
        }
      }
      diagonals = next;
    }
    return simpleOperationFromDiff(before, after);
  }

  function rebaseOperationThroughExternal(operation, externalOperations) {
    let rebased = operation;
    const transformedExternalOperations = [];
    for (const external of externalOperations || []) {
      const [localPrime, externalPrime] = transformOperations(rebased, external);
      rebased = localPrime;
      transformedExternalOperations.push(externalPrime);
    }
    return { operation: rebased, externalOperations: transformedExternalOperations };
  }

  function operationForSerializedRange(source, range, beforeSerialized, afterSerialized) {
    const start = Math.max(0, Math.min(source.length, Number(range && range.start) || 0));
    const end = Math.max(start, Math.min(source.length, Number(range && range.end) || 0));
    const local = operationFromTextDiff(beforeSerialized, afterSerialized);
    if (!local) return null;
    const sourceSlice = source.slice(start, end);
    const bridge = operationFromTextDiff(beforeSerialized, sourceSlice);
    const translated = bridge ? transformOperations(local, bridge)[0] : local;
    const ops = [];
    appendPart(ops, start);
    for (const part of translated.ops) appendPart(ops, part);
    appendPart(ops, source.length - end);
    return { ops };
  }

  function transformSnapshotStack(stack, currentSource, incoming) {
    const transformed = stack.slice();
    let base = currentSource;
    let remote = incoming;
    for (let index = transformed.length - 1; index >= 0; index -= 1) {
      const target = transformed[index];
      const step = operationFromTextDiff(base, target);
      if (!step) continue;
      const remoteAtTarget = transformOperations(step, remote)[1];
      transformed[index] = applyOperation(target, remoteAtTarget);
      base = target;
      remote = remoteAtTarget;
    }
    return transformed;
  }

  return {
    applyOperation,
    mapOffsetThroughOperation,
    mapOffsetBackwardThroughOperation,
    mapSelectionThroughOperations,
    mapSelectionBackwardThroughOperations,
    operationFromTextDiff,
    operationForSerializedRange,
    rebaseOperationThroughExternal,
    transformOperations,
    transformSnapshotStack,
  };
});
