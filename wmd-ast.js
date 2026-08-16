"use strict";

/*
 * The WikiMD AST deliberately keeps the original spelling of blocks.  This is
 * important while somebody is half way through a directive: a valid document
 * is useful, but silently "fixing" the other half of an unfinished document is
 * not.  Rich-editor nodes only normalise the small, safe subset they edit.
 */

let nextId = 1;

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lineRecords(source) {
  const text = String(source || "");
  const records = [];
  const expression = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  let match;
  while ((match = expression.exec(text))) {
    if (!match[0] && match.index === text.length) break;
    const raw = match[0];
    records.push({ raw, text: raw.replace(/\r?\n$|\r$/, ""), start: match.index, end: match.index + raw.length });
    if (!raw) break;
  }
  return records;
}

function lineEnding(raw, fallback = "\n") {
  const match = String(raw || "").match(/(\r\n|\n|\r)$/);
  return match ? match[1] : fallback;
}

function textWithoutLineEnding(raw) {
  return String(raw || "").replace(/(\r\n|\n|\r)$/, "");
}

function makeId(type, hint = "") {
  const normal = String(hint || type).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);
  return `wmd-${type}-${normal || "node"}-${nextId++}`;
}

function createBlock(type, raw, attrs = {}, diagnostics = []) {
  const hint = attrs.name || attrs.text || textWithoutLineEnding(raw).slice(0, 32);
  return {
    type,
    id: makeId(type, hint),
    raw: String(raw || ""),
    lineEnding: lineEnding(raw),
    attrs: { ...attrs },
    diagnostics: [...diagnostics],
  };
}

function tabAttributes(line) {
  let name = String(line || "").replace(/^@tab\s+/, "").trim();
  let hidden = false;
  if (/\s+\{hidden\}\s*$/i.test(name)) {
    hidden = true;
    name = name.replace(/\s+\{hidden\}\s*$/i, "").trim();
  }
  if (/\s+\[hidden\]\s*$/i.test(name)) {
    hidden = true;
    name = name.replace(/\s+\[hidden\]\s*$/i, "").trim();
  }
  return { name: name || "Untitled", hidden };
}

function configMetadata(raw) {
  const styles = {};
  const values = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*;?\s*$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (value.startsWith("{") && value.endsWith("}")) styles[key] = value;
    else values[key] = value;
  }
  return { raw: String(raw || ""), values, styles };
}

function isBlockStart(record, markers = new Map()) {
  const line = record.text;
  return Boolean(customMarkerAtLine(line, markers))
    || /^@title\s+/.test(line)
    || /^@collapse(?:\s|$)/.test(line)
    || /^@style(?:\s|$)/.test(line)
    || /^@toc(?:\s|$)/.test(line)
    || /^!([A-Za-z][\w-]*)(?:\s|$)/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^```/.test(line)
    || /^\|/.test(line)
    || /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/.test(line)
    || /^@(?:hidden|var|include)\b/.test(line);
}

function readDelimited(records, start, endExpression) {
  let index = start + 1;
  while (index < records.length && !endExpression.test(records[index].text.trim())) index += 1;
  const closed = index < records.length;
  const end = closed ? index + 1 : records.length;
  return { end, raw: records.slice(start, end).map((record) => record.raw).join(""), closed };
}

function customMarkers(config) {
  const markers = new Map();
  for (const [name, value] of Object.entries(config && config.styles || {})) {
    const body = String(value || "").replace(/^\{|\}\s*;?\s*$/g, "");
    const match = body.match(/(?:^|;)\s*wmd-formatting\s*:\s*([^;]+?)\s*(?:;|$)/i);
    if (!match) continue;
    const marker = match[1].trim();
    if (!marker || marker.startsWith("!") || /^#{1,6}$/.test(marker) || /^@(?:title|style)$/i.test(marker)) continue;
    markers.set(marker.toLowerCase(), { marker, style: String(name || ""), level: /^heading\b/i.test(String(name || "")) ? 2 : 0 });
  }
  return markers;
}

function customMarkerAtLine(line, markers) {
  const source = String(line || "");
  return [...markers.values()]
    .sort((left, right) => right.marker.length - left.marker.length)
    .find((style) => source.startsWith(style.marker) && (source.length === style.marker.length || /\s/.test(source[style.marker.length]))) || null;
}

function parseTabContent(raw, markers = new Map()) {
  const records = lineRecords(raw);
  const blocks = [];
  let pending = "";
  let index = 0;
  const add = (block) => {
    block.leading = pending;
    pending = "";
    blocks.push(block);
  };

  while (index < records.length) {
    const record = records[index];
    const line = record.text;
    if (!line.trim()) {
      pending += record.raw;
      index += 1;
      continue;
    }

    if (/^@title\s+/.test(line)) {
      add(createBlock("title", record.raw, { text: line.slice("@title ".length).trim() }));
      index += 1;
      continue;
    }

    const customStyle = customMarkerAtLine(line, markers);
    if (customStyle) {
      add(createBlock(customStyle.level ? "heading" : "paragraph", record.raw, {
        text: line.slice(customStyle.marker.length).trim(), level: customStyle.level || undefined, formatting: customStyle.marker, style: customStyle.style,
      }));
      index += 1;
      continue;
    }

    const callout = line.match(/^!([A-Za-z][\w-]*)(?:\s+(.*))?$/);
    if (callout && callout[1].toLowerCase() !== "end") {
      const section = readDelimited(records, index, /^!end\s*$/i);
      const diagnostics = section.closed ? [] : ["Unclosed callout; preserved as a recoverable raw block."];
      add(createBlock(section.closed ? "callout" : "raw", section.raw, {
        calloutType: callout[1].toLowerCase(),
        title: (callout[2] || callout[1]).trim(),
        kind: "callout",
      }, diagnostics));
      index = section.end;
      continue;
    }

    if (/^@collapse(?:\s|$)/.test(line)) {
      const section = readDelimited(records, index, /^@endcollapse\s*$/i);
      const title = line.replace(/^@collapse\s*/, "").trim() || "Details";
      const diagnostics = section.closed ? [] : ["Unclosed collapse; preserved as a recoverable raw block."];
      add(createBlock(section.closed ? "collapse" : "raw", section.raw, { title, kind: "collapse" }, diagnostics));
      index = section.end;
      continue;
    }

    if (/^@style(?:\s|$)/.test(line)) {
      const section = readDelimited(records, index, /^@end(?:style)?\s*$/i);
      add(createBlock("raw", section.raw, { kind: "style" }, section.closed ? [] : ["Unclosed style block; preserved verbatim."]));
      index = section.end;
      continue;
    }

    if (/^```/.test(line)) {
      const marker = line.match(/^(`{3,}|~{3,})/)?.[1] || "```";
      const section = readDelimited(records, index, new RegExp(`^${marker[0]}{${marker.length},}\\s*$`));
      add(createBlock("raw", section.raw, { kind: "code" }, section.closed ? [] : ["Unclosed fenced code block; preserved verbatim."]));
      index = section.end;
      continue;
    }

    if (/^@toc(?:\s|$)/.test(line)) {
      add(createBlock("raw", record.raw, { kind: "toc" }));
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      add(createBlock("heading", record.raw, { level: heading[1].length, text: heading[2] }));
      index += 1;
      continue;
    }

    if (/^\|/.test(line)) {
      let end = index + 1;
      while (end < records.length && records[end].text.trim() && /^\|/.test(records[end].text)) end += 1;
      add(createBlock("table", records.slice(index, end).map((entry) => entry.raw).join(""), { kind: "table" }));
      index = end;
      continue;
    }

    if (/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/.test(line)) {
      const checklist = /^(?:[-*+]\s+\[[ xX]\]\s+)/.test(line);
      let end = index + 1;
      while (end < records.length && /^(?:\s+|[-*+]\s+|\d+[.)]\s+)/.test(records[end].text) && records[end].text.trim()) end += 1;
      add(createBlock(checklist ? "checklist" : "list", records.slice(index, end).map((entry) => entry.raw).join(""), { kind: checklist ? "checklist" : "list" }));
      index = end;
      continue;
    }

    if (/^@(?:hidden|var|include)\b/.test(line)) {
      add(createBlock("raw", record.raw, { kind: "directive" }));
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < records.length && records[index].text.trim() && !isBlockStart(records[index], markers)) index += 1;
    const paragraphRaw = records.slice(start, index).map((entry) => entry.raw).join("");
    add(createBlock("paragraph", paragraphRaw, { text: textWithoutLineEnding(paragraphRaw) }));
  }

  return { blocks, trailing: pending };
}

function parseWmd(source) {
  const text = String(source || "");
  const records = lineRecords(text);
  const tabIndexes = records.map((record, index) => /^@tab\s+/.test(record.text) ? index : -1).filter((index) => index >= 0);
  const tabs = [];
  const firstTabStart = tabIndexes.length ? records[tabIndexes[0]].start : text.length;
  const preamble = text.slice(0, firstTabStart);
  const configMatch = preamble.match(/(^|[\r\n])@config\s*(?:\r?\n|\r)([\s\S]*?)(?:^|[\r\n])@endconfig\s*(?=\r?\n|\r|$)/m);
  const configRaw = configMatch ? configMatch[0].replace(/^\r?\n|\r/, "") : "";
  const config = configMetadata(configRaw);
  const markers = customMarkers(config);

  for (let tabIndex = 0; tabIndex < tabIndexes.length; tabIndex += 1) {
    const start = tabIndexes[tabIndex];
    const end = tabIndex + 1 < tabIndexes.length ? tabIndexes[tabIndex + 1] : records.length;
    const header = records[start];
    const attrs = tabAttributes(header.text);
    const contentRaw = records.slice(start + 1, end).map((record) => record.raw).join("");
    const content = parseTabContent(contentRaw, markers);
    tabs.push({
      type: "tab",
      id: makeId("tab", attrs.name),
      header: header.raw,
      attrs,
      blocks: content.blocks,
      trailing: content.trailing,
    });
  }

  if (!tabs.length && text.trim()) {
    const content = parseTabContent(text, markers);
    tabs.push({
      type: "tab",
      id: makeId("tab", "Main"),
      header: "",
      attrs: { name: "Main", hidden: false, implicit: true },
      blocks: content.blocks,
      trailing: content.trailing,
    });
  }

  return {
    type: "document",
    version: 1,
    source: text,
    preamble,
    config,
    tabs,
    diagnostics: tabs.flatMap((tab) => tab.blocks.flatMap((block) => block.diagnostics || [])),
  };
}

function renderBlock(block) {
  if (block.type === "heading" && block.attrs.formatting) return block.attrs.formatting + " " + (block.attrs.text || "") + (block.lineEnding || "\n");
  if (block.type === "title") return `@title ${block.attrs.text || ""}${block.lineEnding || "\n"}`;
  if (block.type === "heading") return `${"#".repeat(Number(block.attrs.level) || 1)} ${block.attrs.text || ""}${block.lineEnding || "\n"}`;
  if (block.type === "paragraph") return `${block.attrs.text == null ? textWithoutLineEnding(block.raw) : block.attrs.text}${block.lineEnding || "\n"}`;
  return block.raw || "";
}

function stringifyWmd(ast) {
  if (!ast || ast.type !== "document") return "";
  if (ast.tabs.length === 1 && ast.tabs[0].attrs.implicit) {
    const tab = ast.tabs[0];
    return tab.blocks.map((block) => `${block.leading || ""}${renderBlock(block)}`).join("") + (tab.trailing || "");
  }
  return `${ast.preamble || ""}${(ast.tabs || []).map((tab) => {
    const header = tab.header || `@tab ${tab.attrs.name || "Untitled"}${tab.attrs.hidden ? " {hidden}" : ""}\n`;
    return `${header}${(tab.blocks || []).map((block) => `${block.leading || ""}${renderBlock(block)}`).join("")}${tab.trailing || ""}`;
  }).join("")}`;
}

function blockSignature(block) {
  const attrs = block.attrs || {};
  return `${block.type}|${attrs.name || attrs.level || attrs.kind || ""}|${attrs.text || textWithoutLineEnding(block.raw).slice(0, 96)}`;
}

function reconcileAst(previous, next) {
  if (!previous || !next) return next;
  const tabsByName = new Map();
  for (const tab of previous.tabs || []) {
    const key = `${tab.attrs.name}|${tab.attrs.hidden ? "hidden" : "visible"}`;
    const entries = tabsByName.get(key) || [];
    entries.push(tab);
    tabsByName.set(key, entries);
  }
  for (const tab of next.tabs || []) {
    const key = `${tab.attrs.name}|${tab.attrs.hidden ? "hidden" : "visible"}`;
    const matchingTab = (tabsByName.get(key) || []).shift();
    if (!matchingTab) continue;
    tab.id = matchingTab.id;
    const oldBySignature = new Map();
    for (const block of matchingTab.blocks || []) {
      const signature = blockSignature(block);
      const entries = oldBySignature.get(signature) || [];
      entries.push(block);
      oldBySignature.set(signature, entries);
    }
    for (const block of tab.blocks || []) {
      const entries = oldBySignature.get(blockSignature(block));
      if (entries && entries.length) block.id = entries.shift().id;
    }
  }
  return next;
}

function renderWmdAst(ast) {
  return (ast.tabs || []).map((tab) => `<section class="wmd-ast-tab" data-wmd-id="${escapeHtml(tab.id)}"><h2>${escapeHtml(tab.attrs.name)}</h2>${tab.blocks.map((block) => {
    const label = block.type === "heading" || block.type === "title" ? escapeHtml(block.attrs.text) : escapeHtml(textWithoutLineEnding(renderBlock(block)));
    return `<div class="wmd-ast-${escapeHtml(block.type)}" data-wmd-id="${escapeHtml(block.id)}">${label}</div>`;
  }).join("")}</section>`).join("");
}

module.exports = {
  configMetadata,
  customMarkers,
  parseWmd,
  reconcileAst,
  renderWmdAst,
  stringifyWmd,
  textWithoutLineEnding,
};
