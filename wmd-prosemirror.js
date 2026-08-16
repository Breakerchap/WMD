"use strict";

const { Fragment, Schema } = require("prosemirror-model");
const { parseWmd, textWithoutLineEnding } = require("./wmd-ast");

const nodeSpecs = {
  doc: { content: "wmd_tab+" },
  text: { group: "inline" },
  image: {
    inline: true, group: "inline", atom: true,
    attrs: { src: {}, alt: { default: "" }, title: { default: "" } },
    toDOM: (node) => ["img", { class: "rich-image", src: node.attrs.src, alt: node.attrs.alt || "", title: node.attrs.title || "" }],
    parseDOM: [{ tag: "img[src]", getAttrs: (dom) => ({ src: dom.getAttribute("src") || "", alt: dom.getAttribute("alt") || "", title: dom.getAttribute("title") || "" }) }],
  },
  hard_break: { inline: true, group: "inline", selectable: false, toDOM: () => ["br"], parseDOM: [{ tag: "br" }] },
  paragraph: {
    group: "block", content: "inline*", attrs: { id: { default: null }, leading: { default: "" }, raw: { default: "" }, sourceText: { default: "" } },
    toDOM: (node) => ["p", { "data-wmd-id": node.attrs.id || "" }, 0], parseDOM: [{ tag: "p" }],
  },
  heading: {
    group: "block", content: "inline*", defining: true,
    attrs: { id: { default: null }, leading: { default: "" }, raw: { default: "" }, sourceText: { default: "" }, level: { default: 1 }, style: { default: "" }, formatting: { default: "" } },
    toDOM: (node) => [`h${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}`, { "data-wmd-id": node.attrs.id || "", "data-wmd-style": node.attrs.style || "" }, 0],
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, getAttrs: () => ({ level }) })),
  },
  wmd_title: {
    group: "block", content: "inline*", defining: true,
    attrs: { id: { default: null }, leading: { default: "" }, raw: { default: "" }, sourceText: { default: "" } },
    toDOM: (node) => ["h1", { class: "wmd-title", "data-wmd-id": node.attrs.id || "" }, 0], parseDOM: [{ tag: "h1.wmd-title" }],
  },
  wmd_tab: {
    group: "block", content: "block+", isolating: true,
    attrs: { id: { default: null }, name: { default: "Untitled" }, hidden: { default: false }, header: { default: "" }, trailing: { default: "" } },
    toDOM: (node) => ["section", { class: "wmd-tab", "data-wmd-id": node.attrs.id || "", "data-wmd-tab": node.attrs.name, "data-hidden": String(Boolean(node.attrs.hidden)) }, 0],
    parseDOM: [{ tag: "section.wmd-tab" }],
  },
  wmd_raw: rawNodeSpec("rich-raw-block"),
  wmd_callout: rawNodeSpec("rich-callout"),
  wmd_collapse: rawNodeSpec("rich-collapse"),
  wmd_table: rawNodeSpec("rich-table"),
  wmd_checklist: rawNodeSpec("rich-checklist"),
  wmd_list: rawNodeSpec("rich-list"),
};

function rawNodeSpec(className) {
  return {
    group: "block", atom: true, selectable: true,
    attrs: { id: { default: null }, leading: { default: "" }, raw: { default: "" }, kind: { default: "raw" }, title: { default: "" }, calloutType: { default: "note" } },
    toDOM: (node) => richBlockDom(className, node),
    parseDOM: [{ tag: `div.${className}` }],
  };
}

const markSpecs = {
  strong: { toDOM: () => ["strong", 0], parseDOM: [{ tag: "strong" }, { tag: "b" }] },
  em: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }, { tag: "i" }] },
  code: { toDOM: () => ["code", 0], parseDOM: [{ tag: "code" }] },
  underline: { toDOM: () => ["u", 0], parseDOM: [{ tag: "u" }] },
  strike: { toDOM: () => ["s", 0], parseDOM: [{ tag: "s" }, { tag: "del" }] },
  highlight: { attrs: { level: { default: 1 } }, toDOM: (mark) => ["mark", { "data-highlight-level": String(mark.attrs.level || 1) }, 0], parseDOM: [{ tag: "mark", getAttrs: (dom) => ({ level: Number(dom.getAttribute("data-highlight-level") || 1) || 1 }) }] },
  link: { attrs: { href: {}, wiki: { default: false } }, inclusive: false, toDOM: (mark) => ["a", { href: mark.attrs.href }, 0], parseDOM: [{ tag: "a[href]", getAttrs: (dom) => ({ href: dom.getAttribute("href") || "", wiki: String(dom.getAttribute("href") || "").startsWith("wiki:") }) }] },
};

function splitTableRow(line) {
  return String(line || "").trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function tableDom(raw, attrs) {
  const rows = String(raw || "").split(/\r?\n/).filter((line) => /^\|/.test(line)).map(splitTableRow);
  const header = rows[0] || ["Column"];
  const separator = rows[1] && rows[1].every((cell) => /^:?-{3,}:?$/.test(cell));
  const body = rows.slice(separator ? 2 : 1);
  const alignment = (index) => {
    const marker = separator && rows[1][index] || "";
    return /^:.*:$/.test(marker) ? "center" : /:$/.test(marker) ? "right" : /^:/.test(marker) ? "left" : "";
  };
  const cell = (tag, value, row, column) => [tag, {
    contenteditable: "true", "data-wmd-table-cell": String(row) + ":" + String(column),
    style: alignment(column) ? "text-align:" + alignment(column) : "",
  }, value];
  return ["div", { class: "rich-table-wrap", "data-wmd-id": attrs.id || "", "data-wmd-kind": attrs.kind || "table" },
    ["table", { class: "rich-table" },
      ["thead", ["tr", ...header.map((value, index) => cell("th", value, 0, index))]],
      ["tbody", ...body.map((row, rowIndex) => ["tr", ...header.map((_, index) => cell("td", row[index] || "", rowIndex + 1, index))])],
    ],
  ];
}

function listDom(raw, attrs, checklist = false) {
  const lines = String(raw || "").split(/\r?\n/).filter(Boolean);
  const ordered = !checklist && lines.some((line) => /^\s*\d+[.)]\s+/.test(line));
  const items = lines.map((line, index) => {
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    const text = task ? task[2] : line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    return checklist
      ? ["li", { class: "rich-checklist-item" }, ["input", { type: "checkbox", "data-wmd-task": "true", checked: task && /x/i.test(task[1]) ? "checked" : null }], ["span", { contenteditable: "true", "data-wmd-list-item": String(index) }, text]]
      : ["li", ["span", { contenteditable: "true", "data-wmd-list-item": String(index) }, text]];
  });
  return [checklist ? "ul" : ordered ? "ol" : "ul", { class: checklist ? "rich-checklist" : "rich-list", "data-wmd-id": attrs.id || "", "data-wmd-kind": attrs.kind || "list" }, ...items];
}

function calloutDom(raw, attrs) {
  const lines = String(raw || "").split(/\r?\n/);
  const start = lines[0] && lines[0].match(/^!([\w-]+)(?:\s+(.*))?$/);
  const type = (start && start[1] || attrs.calloutType || "note").toLowerCase();
  const title = start && start[2] || attrs.title || type;
  const content = lines.slice(1, lines.findIndex((line) => /^!end\s*$/i.test(line)) > -1 ? lines.findIndex((line) => /^!end\s*$/i.test(line)) : undefined).filter(Boolean);
  return ["aside", { class: `rich-callout ${type}`, "data-wmd-id": attrs.id || "", "data-wmd-kind": attrs.kind || "callout" }, ["strong", { class: "rich-callout-title" }, title], ...content.map((line) => ["p", line])];
}

function collapseDom(raw, attrs) {
  const lines = String(raw || "").split(/\r?\n/);
  const title = (lines[0] || "").replace(/^@collapse\s*/i, "").trim() || attrs.title || "Details";
  const end = lines.findIndex((line) => /^@endcollapse\s*$/i.test(line));
  const content = lines.slice(1, end < 0 ? undefined : end).filter(Boolean);
  return ["details", { class: "rich-collapse", "data-wmd-id": attrs.id || "", "data-wmd-kind": attrs.kind || "collapse" }, ["summary", title], ...content.map((line) => ["p", line])];
}

function richBlockDom(className, node) {
  const attrs = node.attrs || {};
  if (attrs.kind === "table") return tableDom(attrs.raw, attrs);
  if (attrs.kind === "checklist") return listDom(attrs.raw, attrs, true);
  if (attrs.kind === "list") return listDom(attrs.raw, attrs, false);
  if (attrs.kind === "callout") return calloutDom(attrs.raw, attrs);
  if (attrs.kind === "collapse") return collapseDom(attrs.raw, attrs);
  return ["div", { class: className, "data-wmd-id": attrs.id || "", "data-wmd-kind": attrs.kind || "raw" },
    attrs.title ? ["strong", { class: "rich-raw-title" }, attrs.title] : ["span", { class: "rich-raw-label" }, attrs.kind || "raw"],
    ["pre", attrs.raw || ""]];
}

function getWmdSchema() {
  return new Schema({ nodes: nodeSpecs, marks: markSpecs });
}

function textNodes(schema, text, marks = []) {
  const result = [];
  const emit = (value, activeMarks) => {
    if (value) result.push(schema.text(value, activeMarks));
  };
  const parse = (value, activeMarks) => {
    let index = 0;
    while (index < value.length) {
      const rest = value.slice(index);
      const image = rest.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/);
      if (image) {
        result.push(schema.nodes.image.create({ src: image[2], alt: image[1] || "", title: image[3] || "" }));
        index += image[0].length;
        continue;
      }
      const wiki = rest.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      if (wiki) {
        parse(wiki[2] || wiki[1], activeMarks.concat(schema.marks.link.create({ href: `wiki:${wiki[1]}`, wiki: true })));
        index += wiki[0].length;
        continue;
      }
      const link = rest.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (link) {
        parse(link[1], activeMarks.concat(schema.marks.link.create({ href: link[2], wiki: false })));
        index += link[0].length;
        continue;
      }
      const pair = [
        ["===", "highlight", { level: 3 }], ["==", "highlight", { level: 2 }], ["++", "underline", {}], ["~~", "strike", {}], ["**", "strong", {}], ["*", "strong", {}], ["_", "em", {}], ["`", "code", {}], ["=", "highlight", { level: 1 }],
      ].find(([marker]) => rest.startsWith(marker) && rest.indexOf(marker, marker.length) > marker.length);
      if (pair) {
        const [marker, markName, attrs] = pair;
        const end = rest.indexOf(marker, marker.length);
        parse(rest.slice(marker.length, end), activeMarks.concat(schema.marks[markName].create(attrs)));
        index += end + marker.length;
        continue;
      }
      if (rest[0] === "\\" && rest.length > 1) {
        emit(rest[1], activeMarks);
        index += 2;
        continue;
      }
      if (rest[0] === "\n") {
        result.push(schema.nodes.hard_break.create());
        index += 1;
        continue;
      }
      const next = rest.search(/!\[|\[|\*|_|\+|~|=|`|\\|\n/);
      if (next > 0) {
        emit(rest.slice(0, next), activeMarks);
        index += next;
      } else {
        emit(rest[0], activeMarks);
        index += 1;
      }
    }
  };
  parse(String(text || ""), marks);
  return result;
}

function plainTextFromInline(node) {
  return node.textContent;
}

function wrapMarks(text, marks) {
  return [...marks].sort((left, right) => left.type.name.localeCompare(right.type.name)).reduce((value, mark) => {
    if (mark.type.name === "strong") return `*${value}*`;
    if (mark.type.name === "em") return `_${value}_`;
    if (mark.type.name === "code") return `\`${value}\``;
    if (mark.type.name === "underline") return `++${value}++`;
    if (mark.type.name === "strike") return `~~${value}~~`;
    if (mark.type.name === "highlight") return `${"=".repeat(mark.attrs.level || 1)}${value}${"=".repeat(mark.attrs.level || 1)}`;
    if (mark.type.name === "link") return mark.attrs.wiki ? `[[${String(mark.attrs.href || "").replace(/^wiki:/, "")}|${value}]]` : `[${value}](${mark.attrs.href})`;
    return value;
  }, text);
}

function serializeInline(node) {
  let output = "";
  node.forEach((child) => {
    if (child.type.name === "hard_break") output += "\n";
    else if (child.type.name === "image") output += `![${child.attrs.alt || ""}](${child.attrs.src || ""}${child.attrs.title ? ` \"${child.attrs.title}\"` : ""})`;
    else if (child.isText) output += wrapMarks(child.text || "", child.marks || []);
    else output += child.textContent;
  });
  return output;
}

function rawNodeTypeFor(block) {
  return ({ callout: "wmd_callout", collapse: "wmd_collapse", table: "wmd_table", checklist: "wmd_checklist", list: "wmd_list" }[block.type] || "wmd_raw");
}

function blockToNode(block, schema) {
  const common = { id: block.id, leading: block.leading || "", raw: block.raw || "" };
  if (block.type === "paragraph") return schema.nodes.paragraph.create({ ...common, sourceText: block.attrs.text || "" }, textNodes(schema, block.attrs.text || ""));
  if (block.type === "heading") return schema.nodes.heading.create({ ...common, sourceText: block.attrs.text || "", level: block.attrs.level || 1, style: block.attrs.style || "", formatting: block.attrs.formatting || "" }, textNodes(schema, block.attrs.text || ""));
  if (block.type === "title") return schema.nodes.wmd_title.create({ ...common, sourceText: block.attrs.text || "" }, textNodes(schema, block.attrs.text || ""));
  const type = schema.nodes[rawNodeTypeFor(block)];
  return type.create({ ...common, kind: block.attrs.kind || block.type, title: block.attrs.title || "", calloutType: block.attrs.calloutType || "note" });
}

function wmdAstToProseMirror(ast, schema = getWmdSchema()) {
  const documentAst = ast && ast.type === "document" ? ast : parseWmd("");
  const tabs = (documentAst.tabs || []).map((tab) => {
    const blocks = (tab.blocks || []).map((block) => blockToNode(block, schema));
    const fallback = schema.nodes.paragraph.create({ id: `${tab.id}-empty`, leading: "\n", raw: "", sourceText: "" });
    return schema.nodes.wmd_tab.create({ id: tab.id, name: tab.attrs.name, hidden: Boolean(tab.attrs.hidden), header: tab.header || "", trailing: tab.trailing || "" }, blocks.length ? blocks : [fallback]);
  });
  const fallbackTab = schema.nodes.wmd_tab.create({ id: "wmd-tab-main", name: "Main", hidden: false, header: "@tab Main\n", trailing: "" }, [schema.nodes.paragraph.create({ id: "wmd-paragraph-empty", leading: "\n", raw: "", sourceText: "" })]);
  return schema.nodes.doc.create(null, tabs.length ? tabs : [fallbackTab]);
}

function nodeToBlock(node) {
  const attrs = node.attrs || {};
  const base = { id: attrs.id, leading: attrs.leading || "", raw: attrs.raw || "", lineEnding: /\r\n$/.test(attrs.raw || "") ? "\r\n" : "\n", attrs: {}, diagnostics: [] };
  if (node.type.name === "paragraph" || node.type.name === "heading" || node.type.name === "wmd_title") {
    const currentText = serializeInline(node);
    const unmodified = currentText === String(attrs.sourceText || "");
    const type = node.type.name === "wmd_title" ? "title" : node.type.name;
    base.type = type;
    base.attrs.text = currentText;
    if (node.type.name === "heading") {
      base.attrs.level = attrs.level || 1;
      base.attrs.style = attrs.style || "";
      base.attrs.formatting = attrs.formatting || "";
    }
    if (!unmodified) {
      const prefix = type === "title" ? "@title " : type === "heading" ? `${base.attrs.formatting || "#".repeat(base.attrs.level)} ` : "";
      base.raw = `${prefix}${currentText}${base.lineEnding}`;
    }
    return base;
  }
  base.type = ({ wmd_callout: "callout", wmd_collapse: "collapse", wmd_table: "table", wmd_checklist: "checklist", wmd_list: "list" }[node.type.name] || "raw");
  base.attrs = { kind: attrs.kind || base.type, title: attrs.title || "", calloutType: attrs.calloutType || "note" };
  return base;
}

function proseMirrorToWmdAst(doc, metadata = {}) {
  const tabs = [];
  doc.forEach((tab) => {
    if (tab.type.name !== "wmd_tab") return;
    const blocks = [];
    tab.forEach((node) => blocks.push(nodeToBlock(node)));
    tabs.push({
      type: "tab", id: tab.attrs.id, header: tab.attrs.header || `@tab ${tab.attrs.name || "Untitled"}${tab.attrs.hidden ? " {hidden}" : ""}\n`,
      attrs: { name: tab.attrs.name || "Untitled", hidden: Boolean(tab.attrs.hidden) }, blocks, trailing: tab.attrs.trailing || "",
    });
  });
  return { type: "document", version: 1, preamble: metadata.preamble || "", config: metadata.config || { raw: "", values: {}, styles: {} }, tabs, diagnostics: [] };
}

function mapDocumentNodes(doc) {
  const tabs = new Map();
  const blocks = new Map();
  doc.descendants((node, pos) => {
    if (node.type.name === "wmd_tab" && node.attrs.id) tabs.set(node.attrs.id, { node, pos });
    else if (node.attrs && node.attrs.id) blocks.set(node.attrs.id, { node, pos });
  });
  return { tabs, blocks };
}

function applyAstToProseMirror(view, ast, schema = getWmdSchema()) {
  const nextDoc = wmdAstToProseMirror(ast, schema);
  const current = mapDocumentNodes(view.state.doc);
  const next = mapDocumentNodes(nextDoc);
  if (current.tabs.size !== next.tabs.size || [...next.tabs.keys()].some((id) => !current.tabs.has(id))) {
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, nextDoc.content));
    return { kind: "document" };
  }
  let transaction = view.state.tr;
  let changed = false;
  for (const [id, nextTab] of next.tabs) {
    const oldTab = current.tabs.get(id);
    const oldBlockIds = [];
    oldTab.node.forEach((node) => oldBlockIds.push(node.attrs.id));
    const nextBlockIds = [];
    nextTab.node.forEach((node) => nextBlockIds.push(node.attrs.id));
    if (oldBlockIds.length !== nextBlockIds.length || oldBlockIds.some((blockId, index) => blockId !== nextBlockIds[index])) {
      const mapped = transaction.mapping.map(oldTab.pos, 1);
      transaction = transaction.replaceWith(mapped, mapped + oldTab.node.nodeSize, nextTab.node);
      changed = true;
    }
  }
  if (!changed) {
    for (const [id, nextBlock] of next.blocks) {
      const oldBlock = current.blocks.get(id);
      if (!oldBlock || oldBlock.node.eq(nextBlock.node)) continue;
      const mapped = transaction.mapping.map(oldBlock.pos, 1);
      transaction = transaction.replaceWith(mapped, mapped + oldBlock.node.nodeSize, nextBlock.node);
      changed = true;
    }
  }
  if (changed) view.dispatch(transaction);
  return { kind: changed ? "targeted" : "none" };
}

module.exports = {
  applyAstToProseMirror,
  getWmdSchema,
  markSpecs,
  nodeSpecs,
  proseMirrorToWmdAst,
  serializeInline,
  wmdAstToProseMirror,
};
