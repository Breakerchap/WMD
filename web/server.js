#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const WebSocket = require("ws");
const Y = require("yjs");
const awarenessProtocol = require("y-protocols/awareness");
const syncProtocol = require("y-protocols/sync");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");
const { prosemirrorToYDoc, yXmlFragmentToProseMirrorRootNode } = require("y-prosemirror");
const { compile } = require("../wmd-compiler");
const { parseWmd, stringifyWmd } = require("../wmd-ast");
const { getWmdSchema, proseMirrorToWmdAst, wmdAstToProseMirror } = require("../wmd-prosemirror");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4313;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const WEB_ROOT = __dirname;
const PUBLIC_ROOT = path.join(WEB_ROOT, "public");
const DATA_ROOT = path.join(WEB_ROOT, "data");
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const YJS_MESSAGE_SYNC = 0;
const YJS_MESSAGE_AWARENESS = 1;
const SCHEMA = getWmdSchema();
const collabDocuments = new Map();

const DEFAULT_DOCUMENT_SOURCE = [
  "@config",
  "Normal Text: {wmd-formatting: ; keybind: ctrl+shift+0; size: 16px; font: arial; default: true};",
  "Title: {wmd-formatting: @title; keybind: ctrl+shift+`; size: 45px; font: arial};",
  "Heading 1: {wmd-formatting: #; keybind: ctrl+shift+1; size: 38px; font: arial; bold: true};",
  "Heading 2: {wmd-formatting: ##; keybind: ctrl+shift+2; size: 28px; font: arial; bold: true};",
  "Heading 3: {wmd-formatting: ###; keybind: ctrl+shift+3; size: 22px; font: arial; bold: true};",
  "Heading 4: {wmd-formatting: ####; keybind: ctrl+shift+4; size: 18px; font: arial; bold: false; italic: true};",
  "@endconfig",
  "",
  "@tab Test",
  "@title Home",
  "",
  "# Home",
  "",
].join("\n");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function normalizeDocumentId(value) {
  const raw = String(value || "").toLowerCase().trim();
  const normalized = raw.replace(/\.[^./\\]+$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return DOCUMENT_ID_PATTERN.test(normalized) ? normalized : "untitled";
}

function createStarterDocument() {
  return DEFAULT_DOCUMENT_SOURCE;
}

function documentFilePath(id) {
  return path.join(DATA_ROOT, `${normalizeDocumentId(id)}.wmd`);
}

function yStateFilePath(id) {
  return path.join(DATA_ROOT, `${normalizeDocumentId(id)}.yjs`);
}

function metadataFilePath(id) {
  return path.join(DATA_ROOT, normalizeDocumentId(id) + ".meta.json");
}

function atomicWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, filePath);
}

function readSnapshot(id) {
  const filePath = documentFilePath(id);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : createStarterDocument();
}

function readDocumentMetadata(id) {
  const filePath = metadataFilePath(id);
  if (!fs.existsSync(filePath)) return {};
  try {
    const metadata = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return metadata && typeof metadata === "object" ? metadata : {};
  } catch (_) {
    return {};
  }
}

function writeDocumentMetadata(id, metadata) {
  atomicWrite(metadataFilePath(id), JSON.stringify(metadata));
}

function metadataFromRecord(record) {
  return {
    preamble: String(record.meta.get("preamble") || ""),
    config: record.meta.get("config") || { raw: "", values: {}, styles: {} },
  };
}

function sourceFromRecord(record) {
  const fragment = record.ydoc.getXmlFragment("prosemirror");
  if (!fragment.length) return readSnapshot(record.id);
  const document = yXmlFragmentToProseMirrorRootNode(fragment, SCHEMA);
  return stringifyWmd(proseMirrorToWmdAst(document, metadataFromRecord(record)));
}

function initialiseFromWmd(record, source) {
  const ast = parseWmd(source);
  const document = wmdAstToProseMirror(ast, SCHEMA);
  const template = prosemirrorToYDoc(document);
  Y.applyUpdate(record.ydoc, Y.encodeStateAsUpdate(template), "wikimd-migration");
  template.destroy();
  record.meta.set("preamble", ast.preamble || "");
  record.meta.set("config", ast.config || { raw: "", values: {}, styles: {} });
  record.meta.set("styles", ast.config && ast.config.styles || {});
  record.meta.set("schemaVersion", 1);
}

function schedulePersistence(record) {
  clearTimeout(record.stateTimer);
  record.stateTimer = setTimeout(() => {
    record.stateTimer = null;
    atomicWrite(yStateFilePath(record.id), Buffer.from(Y.encodeStateAsUpdate(record.ydoc)));
  }, 100);

  clearTimeout(record.snapshotTimer);
  record.snapshotTimer = setTimeout(() => {
    record.snapshotTimer = null;
    atomicWrite(documentFilePath(record.id), sourceFromRecord(record));
  }, 350);
}

function flushPersistence(record) {
  clearTimeout(record.stateTimer);
  clearTimeout(record.snapshotTimer);
  record.stateTimer = null;
  record.snapshotTimer = null;
  atomicWrite(yStateFilePath(record.id), Buffer.from(Y.encodeStateAsUpdate(record.ydoc)));
  atomicWrite(documentFilePath(record.id), sourceFromRecord(record));
}

function getCollabDocument(id) {
  const normalizedId = normalizeDocumentId(id);
  const existing = collabDocuments.get(normalizedId);
  if (existing) return existing;

  const ydoc = new Y.Doc();
  const record = {
    id: normalizedId,
    ydoc,
    meta: ydoc.getMap("wikimd"),
    awareness: new awarenessProtocol.Awareness(ydoc),
    clients: new Map(),
    stateTimer: null,
    snapshotTimer: null,
  };
  const yStatePath = yStateFilePath(normalizedId);
  if (fs.existsSync(yStatePath)) {
    Y.applyUpdate(ydoc, fs.readFileSync(yStatePath), "disk");
  } else {
    // Existing .wmd documents are migrated exactly once: only a missing Yjs
    // state file may seed the authoritative structured document.
    initialiseFromWmd(record, readSnapshot(normalizedId));
    atomicWrite(yStatePath, Buffer.from(Y.encodeStateAsUpdate(ydoc)));
  }
  if (!record.meta.get("title")) {
    const metadata = readDocumentMetadata(normalizedId);
    record.meta.set("title", String(metadata.title || titleFromSource(readSnapshot(normalizedId), normalizedId)).slice(0, 120));
  }

  ydoc.on("update", (update, origin) => {
    schedulePersistence(record);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, YJS_MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(record, encoding.toUint8Array(encoder), origin);
  });
  record.awareness.on("update", ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed);
    if (origin && record.clients.has(origin)) {
      const controlled = record.clients.get(origin);
      added.forEach((clientId) => controlled.add(clientId));
      removed.forEach((clientId) => controlled.delete(clientId));
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, YJS_MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(record.awareness, changed));
    broadcast(record, encoding.toUint8Array(encoder));
  });
  collabDocuments.set(normalizedId, record);
  return record;
}

function send(client, payload) {
  if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
    client.send(payload, { binary: true }, () => {});
  }
}

function broadcast(record, payload, except) {
  for (const client of record.clients.keys()) {
    if (client !== except) send(client, payload);
  }
}

function sendInitialState(record, client) {
  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, YJS_MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(syncEncoder, record.ydoc);
  send(client, encoding.toUint8Array(syncEncoder));
  const clientIds = [...record.awareness.getStates().keys()];
  if (clientIds.length) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, YJS_MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(record.awareness, clientIds));
    send(client, encoding.toUint8Array(awarenessEncoder));
  }
}

function handleYjsMessage(record, client, message) {
  const decoder = decoding.createDecoder(new Uint8Array(message));
  const messageType = decoding.readVarUint(decoder);
  if (messageType === YJS_MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, YJS_MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, record.ydoc, client);
    if (encoding.length(encoder) > 1) send(client, encoding.toUint8Array(encoder));
    return;
  }
  if (messageType === YJS_MESSAGE_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(record.awareness, decoding.readVarUint8Array(decoder), client);
  }
}

function attachYjsClient(record, client) {
  record.clients.set(client, new Set());
  client.binaryType = "arraybuffer";
  client.on("message", (message) => {
    try {
      handleYjsMessage(record, client, message);
    } catch (error) {
      console.error(`Yjs message failed for ${record.id}: ${error.message}`);
      client.close(1003, "Invalid Yjs message");
    }
  });
  client.on("close", () => {
    const controlled = record.clients.get(client);
    record.clients.delete(client);
    if (controlled && controlled.size) awarenessProtocol.removeAwarenessStates(record.awareness, [...controlled], null);
  });
  sendInitialState(record, client);
}

function titleFromSource(source, fallback) {
  const match = String(source || "").match(/^@title\s+(.+)$/m);
  return (match && match[1].trim()) || fallback.replace(/[-_]+/g, " ");
}

function documentSummary(id, source, updatedAt) {
  const record = collabDocuments.get(id);
  const metadata = readDocumentMetadata(id);
  const title = String(record && record.meta.get("title") || metadata.title || titleFromSource(source, id)).trim() || id.replace(/[-_]+/g, " ");
  return { id, title, updatedAt: updatedAt || new Date().toISOString() };
}

function listDocuments() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const fromDisk = fs.readdirSync(DATA_ROOT).filter((file) => file.endsWith(".wmd")).map((file) => {
    const id = file.slice(0, -4);
    const stats = fs.statSync(path.join(DATA_ROOT, file));
    const record = collabDocuments.get(id);
    return documentSummary(id, record ? sourceFromRecord(record) : fs.readFileSync(path.join(DATA_ROOT, file), "utf8"), stats.mtime.toISOString());
  });
  const loadedOnly = [...collabDocuments.values()].filter((record) => !fromDisk.some((document) => document.id === record.id))
    .map((record) => documentSummary(record.id, sourceFromRecord(record)));
  return [...fromDisk, ...loadedOnly].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.title.localeCompare(right.title));
}

function createDocument(payload = {}) {
  const requested = normalizeDocumentId(payload.id || payload.title || "untitled");
  const id = requested === "untitled" && (payload.id || payload.title) ? normalizeDocumentId(`${payload.id || payload.title}-${Date.now().toString(36)}`) : requested;
  const filePath = documentFilePath(id);
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  if (fs.existsSync(filePath) || fs.existsSync(yStateFilePath(id)) || collabDocuments.has(id)) {
    const error = new Error(`A document called ${id} already exists.`);
    error.statusCode = 409;
    throw error;
  }
  const source = createStarterDocument();
  atomicWrite(filePath, source);
  const title = String(payload.title || id.replace(/[-_]+/g, " ")).trim().slice(0, 120) || id.replace(/[-_]+/g, " ");
  writeDocumentMetadata(id, { title });
  return documentSummary(id, source);
}

function renameDocumentTitle(id, title) {
  const normalized = normalizeDocumentId(id);
  const nextTitle = String(title || "").replace(/[\r\n]/g, " ").trim().slice(0, 120);
  if (!nextTitle) {
    const error = new Error("Document title cannot be empty.");
    error.statusCode = 400;
    throw error;
  }
  const record = collabDocuments.get(normalized);
  if (record) record.meta.set("title", nextTitle);
  writeDocumentMetadata(normalized, { ...readDocumentMetadata(normalized), title: nextTitle });
  return documentSummary(normalized, record ? sourceFromRecord(record) : readSnapshot(normalized));
}

function deleteDocument(id) {
  const normalized = normalizeDocumentId(id);
  if (normalized === "untitled") {
    const error = new Error("The fallback untitled document cannot be deleted.");
    error.statusCode = 400;
    throw error;
  }
  const record = collabDocuments.get(normalized);
  if (record && record.clients.size) {
    const error = new Error("Close this document before deleting it.");
    error.statusCode = 409;
    throw error;
  }
  if (record) {
    flushPersistence(record);
    record.ydoc.destroy();
    collabDocuments.delete(normalized);
  }
  const paths = [documentFilePath(normalized), yStateFilePath(normalized), metadataFilePath(normalized)];
  if (!paths.some((filePath) => fs.existsSync(filePath))) {
    const error = new Error("Document not found.");
    error.statusCode = 404;
    throw error;
  }
  paths.filter((filePath) => fs.existsSync(filePath)).forEach((filePath) => fs.unlinkSync(filePath));
  return { id: normalized };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error("Request body is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function contentTypeFor(filePath) {
  return ({ ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function serveStatic(request, response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_ROOT, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`) || !fs.existsSync(filePath)) return sendJson(response, 404, { error: "Not found." });
  response.writeHead(200, { ...CORS_HEADERS, "Content-Type": contentTypeFor(filePath), "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(response);
}

function decodeXml(value) {
  return String(value || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function readZipEntry(buffer, filename) {
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset === -1) throw new Error("This is not a valid DOCX archive.");
  const count = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  for (let entry = 0; entry < count; entry += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === filename) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid DOCX file entry.");
      const contentStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const content = buffer.subarray(contentStart, contentStart + size);
      return compression === 0 ? content : compression === 8 ? zlib.inflateRawSync(content, { maxOutputLength: MAX_BODY_BYTES }) : (() => { throw new Error("This DOCX uses an unsupported compression method."); })();
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("This DOCX file does not contain document text.");
}

function docxToWmd(buffer, title = "Imported document") {
  const paragraphs = readZipEntry(buffer, "word/document.xml").toString("utf8").match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
  const lines = [];
  for (const paragraph of paragraphs) {
    const style = paragraph.match(/<w:pStyle\s+[^>]*w:val="([^"]+)"[^>]*\/?\s*>/);
    const list = /<w:numPr(?:\s[^>]*)?>/.test(paragraph);
    let content = "";
    for (const run of paragraph.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) || []) {
      const text = decodeXml((run.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || []).map((part) => part.replace(/^<w:t(?:\s[^>]*)?>|<\/w:t>$/g, "")).join("")).replace(/<w:tab\s*\/>/g, "\t").replace(/<w:br\s*\/>/g, "\n");
      if (!text) continue;
      content += /<w:b(?:\s[^>]*)?\/>/.test(run) && /<w:i(?:\s[^>]*)?\/>/.test(run) ? `*_${text}_*` : /<w:b(?:\s[^>]*)?\/>/.test(run) ? `*${text}*` : /<w:i(?:\s[^>]*)?\/>/.test(run) ? `_${text}_` : text;
    }
    if (!content.trim()) continue;
    const heading = style && style[1].match(/^Heading([1-6])$/i);
    lines.push(heading ? `${"#".repeat(Number(heading[1]))} ${content.trim()}` : list ? `- ${content.trim()}` : content.trim());
  }
  const safeTitle = String(title || "Imported document").replace(/\.[^.]+$/, "").trim() || "Imported document";
  return `@tab Home\n@title ${safeTitle}\n\n${lines.join("\n\n") || "# Imported document\n"}\n`;
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || HOST}`);
  try {
    if (request.method === "OPTIONS") { response.writeHead(204, CORS_HEADERS); response.end(); return; }
    if (request.method === "GET" && url.pathname === "/api/documents") return sendJson(response, 200, { documents: listDocuments() });
    if (request.method === "POST" && url.pathname === "/api/documents") return sendJson(response, 201, { document: createDocument(JSON.parse((await readRequestBody(request)).toString("utf8") || "{}")) });
    const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (documentMatch && request.method === "GET") {
      const id = normalizeDocumentId(decodeURIComponent(documentMatch[1]));
      const record = collabDocuments.get(id);
      const source = record ? sourceFromRecord(record) : readSnapshot(id);
      return sendJson(response, 200, { document: { ...documentSummary(id, source), source, hasYState: fs.existsSync(yStateFilePath(id)) } });
    }
    if (documentMatch && request.method === "PATCH") {
      const payload = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");
      return sendJson(response, 200, { document: renameDocumentTitle(decodeURIComponent(documentMatch[1]), payload.title) });
    }
    if (documentMatch && request.method === "DELETE") return sendJson(response, 200, { document: deleteDocument(decodeURIComponent(documentMatch[1])) });
    if (request.method === "POST" && url.pathname === "/api/compile") return sendJson(response, 200, compile(String(JSON.parse((await readRequestBody(request)).toString("utf8")).source || "")));
    if (request.method === "POST" && url.pathname === "/api/import") {
      const payload = JSON.parse((await readRequestBody(request)).toString("utf8"));
      if (path.extname(String(payload.filename || "")).toLowerCase() !== ".docx") throw new Error("Only DOCX imports are sent to the server.");
      return sendJson(response, 200, { source: docxToWmd(Buffer.from(String(payload.data || ""), "base64"), payload.filename), suggestedId: normalizeDocumentId(payload.filename) });
    }
    serveStatic(request, response, url.pathname);
  } catch (error) {
    sendJson(response, Number(error.statusCode) || 400, { error: error.message || "Something went wrong." });
  }
}

function localNetworkUrls(port) {
  const urls = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) for (const address of addresses || []) if (address.family === "IPv4" && !address.internal) urls.add(`http://${address.address}:${port}`);
  return [...urls];
}

function parseOptions(argv) {
  const portIndex = argv.indexOf("--port");
  const candidate = portIndex === -1 ? DEFAULT_PORT : Number(argv[portIndex + 1]);
  const hostIndex = argv.indexOf("--host");
  const publicIndex = argv.indexOf("--public-url");
  let publicUrl = "";
  try { if (publicIndex !== -1) publicUrl = new URL(String(argv[publicIndex + 1] || "")).origin; } catch (_) { /* optional display URL */ }
  return { host: hostIndex === -1 ? HOST : String(argv[hostIndex + 1] || HOST), port: Number.isInteger(candidate) && candidate > 0 && candidate < 65536 ? candidate : DEFAULT_PORT, publicUrl };
}

function startServer(port = DEFAULT_PORT, host = HOST, publicUrl = "") {
  const server = http.createServer(handleRequest);
  const websocketServer = new WebSocket.Server({ noServer: true, maxPayload: MAX_BODY_BYTES });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || HOST}`);
    if (!/^\/collaboration(?:\/|$)/.test(url.pathname)) return socket.destroy();
    const room = String(url.searchParams.get("room") || decodeURIComponent(url.pathname.replace(/^\/collaboration\/?/, "")) || "");
    const documentId = normalizeDocumentId(room.replace(/^wikimd:/, ""));
    websocketServer.handleUpgrade(request, socket, head, (client) => attachYjsClient(getCollabDocument(documentId), client));
  });
  server.listen(port, host, () => {
    console.log(`WMD Web Editor running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    if (host === "0.0.0.0") { const urls = localNetworkUrls(port); if (urls.length) console.log(`LAN address: ${urls.join(" or ")}`); }
    if (publicUrl) console.log(`Public editor URL: ${publicUrl}`);
    console.log("Share a document URL such as /?doc=team-notes to collaborate.");
  });
  return server;
}

if (require.main === module) {
  const options = parseOptions(process.argv.slice(2));
  const server = startServer(options.port, options.host, options.publicUrl);
  const shutdown = () => {
    for (const record of collabDocuments.values()) { try { flushPersistence(record); } catch (error) { console.error(`Could not save ${record.id}: ${error.message}`); } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = { DEFAULT_DOCUMENT_SOURCE, createStarterDocument, docxToWmd, getCollabDocument, normalizeDocumentId, parseOptions, sourceFromRecord, startServer };
