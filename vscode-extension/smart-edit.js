function isWordLike(char) {
  return Boolean(char) && /[A-Za-z0-9]/.test(char);
}

function shouldAutoPairDelimiter(before, after) {
  return !isWordLike(before) && !isWordLike(after);
}

function computeSmartPairAction(text, before, after, hasSelection) {
  if (!["*", "_", "=", "`"].includes(text)) {
    return { type: "none" };
  }

  if (hasSelection) {
    return { type: "wrap", open: text, close: text };
  }

  if (after === text) {
    return { type: "skip" };
  }

  if (!shouldAutoPairDelimiter(before, after)) {
    return { type: "insert", text };
  }

  return {
    type: "pair",
    open: text,
    close: text,
  };
}

module.exports = {
  computeSmartPairAction,
  shouldAutoPairDelimiter,
};
