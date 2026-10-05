const test = require("node:test");
const assert = require("node:assert/strict");

const path = require("node:path");

const { compile, parseArgs, renderFragment } = require("../wmd-compiler.js");

test("parseArgs supports positional files and serve mode", () => {
  const options = parseArgs(["--serve", "notes.wmd", "notes.html", "--port", "4500"]);

  assert.equal(options.serve, true);
  assert.equal(options.watch, true);
  assert.equal(options.inputPath, "notes.wmd");
  assert.equal(options.outputPath, "notes.html");
  assert.equal(options.port, 4500);
});

test("parseArgs derives the output path from the input file", () => {
  const options = parseArgs([path.join("docs", "notes.wmd")]);

  assert.equal(options.outputPath, path.join("docs", "notes.html"));
});

test("parseArgs requires an input file outside help mode", () => {
  assert.throws(() => parseArgs([]), /Missing input \.wmd file/);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("duplicate headings get unique ids and stable link targets", () => {
  const source = `@tab Main
# Main

## Repeat
First section

## Repeat
Second section

[[Main#Repeat]]
`;

  const result = compile(source);

  assert.match(result.html, /id="main-repeat"/);
  assert.match(result.html, /id="main-repeat-2"/);
  assert.match(result.html, /href="#main-repeat">Main#Repeat<\/a>/);
});

test("fenced code headings are not added to navigation", () => {
  const source = `@tab Main
# Real Heading
@toc

\`\`\`md
## Fake Heading
\`\`\`
`;

  const result = compile(source);

  assert.match(result.html, /href="#main-real-heading">Real Heading<\/a>/);
  assert.doesNotMatch(result.html, /href="#main-fake-heading">/);
  assert.doesNotMatch(result.html, /data-heading-id="main-fake-heading"/);
});

test("duplicate tab names are warned about and get unique section ids", () => {
  const source = `@tab Combat
# One

@tab Combat
# Two
`;

  const result = compile(source);

  assert.match(result.html, /<section id="combat"/);
  assert.match(result.html, /<section id="combat-2"/);
  assert.match(result.html, /data-tab-name="Combat"/);
  assert.ok(result.warnings.some((warning) => warning.includes('Duplicate tab name "Combat"')));
});

test("compiled documents leave theme selection to the host application", () => {
  const result = compile("@tab Home\n# Theme test");

  assert.doesNotMatch(result.html, /id="darkToggle"/);
  assert.doesNotMatch(result.html, /localStorage\.getItem\("darkMode"\)/);
});

test("double plus markers compile to persistent underline", () => {
  const result = compile("@tab Home\n++Important++");

  assert.match(result.html, /<u>Important<\/u>/);
});

test("style markers decorate blocks without rendering the directive", () => {
  const result = compile(`@config
Project Heading: {bold: true; heading: 2};
Tagline: {italic: true};
@endconfig

@tab Home
@style Project Heading
## Project plan
@end

@style Tagline
A styled paragraph
@end`);

  assert.match(result.html, /<h2[^>]*class="wmd-preset-project-heading"[^>]*data-wmd-preset="project-heading"[^>]*>Project plan<\/h2>/);
  assert.match(result.html, /<p[^>]*class="wmd-preset-tagline"[^>]*data-wmd-preset="tagline"[^>]*>A styled paragraph<\/p>/);
  assert.doesNotMatch(result.html, />@style /);
});

test("callout types retain their compiled style classes", () => {
  const result = compile("@tab Home\n!warning Check this\nImportant detail\n!end");

  assert.match(result.html, /class="callout callout-warning"/);
  assert.match(result.html, /<div class="callout-title">Check this<\/div>/);
});

test("task list syntax compiles to checkboxes", () => {
  const result = compile("@tab Home\n- [ ] Pending\n- [x] Complete");

  assert.match(result.html, /class="task-checkbox" type="checkbox" disabled/);
  assert.match(result.html, /class="task-checkbox" type="checkbox" checked disabled/);
});

test("single WMD newlines render as document line breaks", () => {
  const result = compile("@tab Home\nFirst line\nSecond line");

  assert.match(result.html, /First line<br>\s*Second line/);
});

test("WMD tables compile to semantic table markup", () => {
  const result = compile(`@tab Home
| Name | Score |
| --- | --- |
| Ada | 10 |`);

  assert.match(result.html, /<table>/);
  assert.match(result.html, /<th>Name<\/th>/);
  assert.match(result.html, /<td>Ada<\/td>/);
});

test("config-defined custom heading markers compile and style headings", () => {
  const result = compile(`@config
Heading A: {wmd-formatting: $; keybind: ctrl+shift+a; size: 80px; font: arial; bold: true; italic: true};
Heading B: {wmd-formatting: \\\\; keybind: ctrl+shift+b; size: 60px; font: garamond; bold: true};
@endconfig

@tab Test
$ Alpha
\\\\ Beta`);

  assert.match(result.html, /<h2[^>]*id="test-alpha"[^>]*class="wmd-preset-heading-a"[^>]*data-wmd-preset="heading-a"[^>]*>Alpha<\/h2>/);
  assert.match(result.html, /<h2[^>]*id="test-beta"[^>]*class="wmd-preset-heading-b"[^>]*data-wmd-preset="heading-b"[^>]*>Beta<\/h2>/);
  assert.match(result.html, /\[data-wmd-preset="heading-a"\]\{[^}]*font-size:80px/);
  assert.match(result.html, /\[data-wmd-preset="heading-b"\]\{[^}]*font-family:garamond/);
});

test("custom callout config colours compile without leaking heading marker styles into body", () => {
  const result = compile(`@config
Heading A: {wmd-formatting: $; keybind: ctrl+shift+a; size: 80px; font: arial; bold: true; italic: true};
Boss Box: {wmd-formatting: !boss; keybind: ctrl+alt+b; callout-title: Boss; callout-bg: #111827; callout-border: #ef4444; callout-text: #f9fafb; callout-title-color: #fecaca; callout-icon: ⚔; callout-radius: 14px};
@endconfig

@tab Test
$ Alpha
!boss
Watch out
!end`);

  assert.match(result.html, /<div class="callout callout-boss">/);
  assert.match(result.html, /<div class="callout-title">Boss<\/div>/);
  assert.match(result.html, /background:#111827/);
  assert.match(result.html, /border-left-color:#ef4444/);
  assert.match(result.html, /color:#f9fafb/);
  assert.match(result.html, /border-radius:14px/);
  assert.match(result.html, /content:"⚔"/);
  assert.match(result.html, /<p>Watch out<\/p>/);
  assert.doesNotMatch(result.html, /wmd-preset-heading-a[^>]*>Watch out/);
});


test("blockquotes do not add outer paragraph spacing", () => {
  const result = compile(`@tab Home
> Quoted text`);

  assert.match(result.html, /<blockquote class="wmd-blockquote">\s*<p>Quoted text<\/p>\s*<\/blockquote>/);
  assert.match(result.html, /\.wmd-blockquote > p:first-child\{margin-top:0\}/);
  assert.match(result.html, /\.wmd-blockquote > p:last-child\{margin-bottom:0\}/);
});

test("multi-paragraph blockquotes keep separate paragraphs", () => {
  const result = compile(`@tab Home
> First paragraph
>
> Second paragraph`);

  assert.match(
    result.html,
    /<blockquote class="wmd-blockquote">\s*<p>First paragraph<\/p>\s*<p>Second paragraph<\/p>\s*<\/blockquote>/
  );
});


test("inline mentions render with prose typography without affecting wiki links", () => {
  const result = compile(`@tab Home
Use an <<en-dash>> here.

[[Home|Back home]]`);

  assert.match(result.html, /<span class="wmd-mention">en-dash<\/span>/);
  assert.match(result.html, /href="#home">Back home<\/a>/);
  assert.match(result.html, /\.wmd-mention\{font-family:/);
});

test("prose blocks render normal WMD inside a prose container", () => {
  const result = compile(`@tab Home
Before

<<<
This is *finished prose*.

And this is a second paragraph with <<a mentioned phrase>>.
>>>

After`);

  assert.match(result.html, /<div class="wmd-prose-block">/);
  assert.match(result.html, /<strong>finished prose<\/strong>/);
  assert.match(result.html, /<span class="wmd-mention">a mentioned phrase<\/span>/);
  assert.match(result.html, /<p>And this is a second paragraph/);
  assert.match(result.html, /\.wmd-prose-block\{font-family:/);
});

test("fragment rendering returns mention and prose-block styles", () => {
  const result = renderFragment(`A <<term>>.

<<<
A prose paragraph.
>>>`);

  assert.match(result.html, /class="wmd-mention"/);
  assert.match(result.html, /class="wmd-prose-block"/);
  assert.match(result.css, /\.wmd-mention\{/);
  assert.match(result.css, /\.wmd-prose-block\{/);
});
