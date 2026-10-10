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

test("fenced code keeps WMD directives literal and does not create tabs", () => {
  const source = `@var example = replaced
@tab Home
# Real content

\`\`\`wmd
@tab Fake
@title Fake title
@hidden
@var example = changed
@include Missing
@style Large
[[Home]]
{{example}}
!warning Still code
!end
\`\`\`

After the code.

@tab Real
# Second real tab
`;

  const result = compile(source);

  assert.match(result.html, /<code class="language-wmd">[\s\S]*@tab Fake[\s\S]*@title Fake title[\s\S]*@include Missing[\s\S]*\[\[Home\]\][\s\S]*\{\{example\}\}[\s\S]*!warning Still code/);
  assert.doesNotMatch(result.html, /<section id="fake"/);
  assert.doesNotMatch(result.html, /data-tab-name="Fake"/);
  assert.doesNotMatch(result.html, /Broken include in Home: tab does not exist: Missing/);
  assert.match(result.html, /<section id="real"/);
});

test("fenced code info strings become language classes", () => {
  const result = compile(`@tab Home

\`\`\`language-name
<thing>{{not-a-variable}}</thing>
\`\`\`
`);

  assert.match(result.html, /<code class="language-language-name">/);
  assert.match(result.html, /&lt;thing&gt;\{\{not-a-variable\}\}&lt;\/thing&gt;/);
  assert.doesNotMatch(result.warnings.join("\n"), /Unknown variable/);
});

test("fragment rendering leaves WMD directives inside fenced code untouched", () => {
  const result = renderFragment(`\`\`\`wmd
@tab Fake
@title Fake
@hidden
@config
font: serif
@endconfig
\`\`\`
`);

  assert.match(result.html, /<code class="language-wmd">[\s\S]*@tab Fake[\s\S]*@title Fake[\s\S]*@config[\s\S]*font: serif/);
  assert.equal(result.warnings.length, 0);
});

test("tilde fenced code is also opaque to WMD preprocessing", () => {
  const result = compile(`@var name = Alice
@tab Home

~~~wmd
@include Missing
{{name}}
@style Large
~~~
`);

  assert.match(result.html, /<code class="language-wmd">[\s\S]*@include Missing[\s\S]*\{\{name\}\}[\s\S]*@style Large/);
  assert.doesNotMatch(result.warnings.join("\n"), /Broken include|Unknown variable/);
});

test("prose blocks interrupt a preceding paragraph without a blank line", () => {
  const result = compile(`@tab Home
Text immediately before the prose block.
[[[
This is prose.
]]]`);

  assert.ok(result.html.includes("<p>Text immediately before the prose block.</p>"));
  assert.ok(result.html.includes('<div class="wmd-prose-block">'));
  assert.ok(result.html.includes("<p>This is prose.</p>"));
  assert.ok(!result.html.includes("[[["));
});

test("callouts interrupt a preceding paragraph without a blank line", () => {
  const result = compile(`@tab Home
Text immediately before the callout.
!note Important
This is something worth pointing out.
!end`);

  assert.ok(result.html.includes("<p>Text immediately before the callout.</p>"));
  assert.ok(result.html.includes('<div class="callout callout-note">'));
  assert.ok(result.html.includes('<div class="callout-title">Important</div>'));
});

test("collapsible sections interrupt a preceding paragraph without a blank line", () => {
  const result = compile(`@tab Home
Text immediately before the collapse.
@collapse More
Hidden content.
@endcollapse`);

  assert.ok(result.html.includes("<p>Text immediately before the collapse.</p>"));
  assert.ok(result.html.includes('<details class="collapse">'));
  assert.ok(result.html.includes("<summary>More</summary>"));
});

test("prose blocks render inside collapsible sections without a blank line", () => {
  const result = compile(`@tab Home
@collapse Prose
Block prose is useful.
[[[
I met a traveller from an antique land
Who said two vast and trunkless legs of stone
Stand in the desert.
]]]
@endcollapse`);

  assert.ok(result.html.includes('<details class="collapse">'));
  assert.ok(result.html.includes('<div class="wmd-prose-block">'));
  assert.ok(result.html.includes("I met a traveller from an antique land"));
  assert.ok(!result.html.includes("[[["));
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


test("triple-angle inline prose renders without a pill background", () => {
  const result = compile(`@tab Home
Use <<<plain prose>>> here and <<pill prose>> here.`);

  assert.match(result.html, /<span class="wmd-inline-prose">plain prose<\/span>/);
  assert.match(result.html, /<span class="wmd-mention">pill prose<\/span>/);
  assert.match(result.html, /\.wmd-inline-prose\{font-family:/);
  assert.doesNotMatch(result.html, /\.wmd-inline-prose\{[^}]*background:/);
  assert.match(result.html, /\.wmd-mention\{[^}]*background:/);
});

test("triple-angle inline prose works in fragment rendering", () => {
  const result = renderFragment(`Use <<<plain prose>>> and <<pill prose>>.`);

  assert.match(result.html, /<span class="wmd-inline-prose">plain prose<\/span>/);
  assert.match(result.html, /<span class="wmd-mention">pill prose<\/span>/);
  assert.match(result.css, /\.wmd-inline-prose\{font-family:/);
});

test("standalone legacy arrow fences are no longer block prose", () => {
  const result = compile(`@tab Home
<<<
Old block syntax
>>>`);

  assert.doesNotMatch(result.html, /class="wmd-prose-block"/);
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

[[[
This is *finished prose*.

And this is a second paragraph with <<a mentioned phrase>>.
]]]

After`);

  assert.match(result.html, /<div class="wmd-prose-block">/);
  assert.match(result.html, /<strong>finished prose<\/strong>/);
  assert.match(result.html, /<span class="wmd-mention">a mentioned phrase<\/span>/);
  assert.match(result.html, /<p>And this is a second paragraph/);
  assert.match(result.html, /\.wmd-prose-block\{font-family:/);
});

test("bracket prose fences render without colliding with wiki links", () => {
  const result = compile(`@tab Home
[[[
The Quick Brown Fox Jumps

Over The
]]]

[[Home|Back home]]`);

  assert.match(result.html, /<div class="wmd-prose-block">/);
  assert.match(result.html, /<p>The Quick Brown Fox Jumps<\/p>/);
  assert.match(result.html, /<p>Over The<\/p>/);
  assert.match(result.html, /href="#home">Back home<\/a>/);
  assert.doesNotMatch(result.html, /<blockquote/);
});

test("fragment rendering returns mention and prose-block styles", () => {
  const result = renderFragment(`A <<term>>.

[[[
A prose paragraph.
]]]`);

  assert.match(result.html, /class="wmd-mention"/);
  assert.match(result.html, /class="wmd-prose-block"/);
  assert.match(result.css, /\.wmd-mention\{/);
  assert.match(result.css, /\.wmd-prose-block\{/);
});


test("multiline style presets work in compiled documents", () => {
  const result = compile(`@config
Large: {
  wmd-formatting: @style;
  size: 1.5em;
};
@endconfig

@tab Home
@style Large
Preface text.
@end`);

  assert.match(result.html, /data-wmd-preset="large"/);
  assert.match(result.html, /\[data-wmd-preset="large"\]\{[^}]*font-size:1\.5em/);
});

test("multiline style presets work in fragment rendering", () => {
  const result = renderFragment(`@config
Large: {
  wmd-formatting: @style;
  size: 1.5em;
};
@endconfig

@style Large
Preface text.
@end`);

  assert.match(result.html, /data-wmd-preset="large"/);
  assert.match(result.css, /\[data-wmd-preset="large"\]\{[^}]*font-size:1\.5em/);
});

test("unindented prose following a list starts a separate paragraph", () => {
  const variants = [
    "THEQUCIKBROWN\n- FOX\n- JUMPS\nOVER THE",
    "THEQUCIKBROWN\n\n- FOX\n- JUMPS\n\nOVER THE",
    "THEQUCIKBROWN\n- FOX\n- JUMPS\n\nOVER THE",
    "THEQUCIKBROWN\n\n- FOX\n- JUMPS\nOVER THE",
  ];

  for (const source of variants) {
    for (const { html } of [renderFragment(source), compile("@tab Home\n" + source)]) {
      const listEnd = html.indexOf("</ul>");
      assert.ok(listEnd !== -1, "Expected an unordered list");
      assert.match(html.slice(0, listEnd), /FOX[\s\S]*JUMPS/);
      assert.doesNotMatch(html.slice(0, listEnd), /OVER THE/);
      assert.match(html.slice(listEnd), /^<\/ul>\s*<p(?: class="wmd-list-after")?>OVER THE<\/p>/);
    }
  }
});

test("blank lines between list items add spacing without spacing tight items", () => {
  const tight = renderFragment("- FOX\n- JUMPS");
  const spaced = renderFragment("- FOX\n\n- JUMPS");
  const mixed = renderFragment("- ONE\n- TWO\n\n- THREE\n- FOUR");

  assert.match(tight.html, /<ul class="wmd-list">/);
  assert.doesNotMatch(tight.html, /wmd-list-item-spaced/);
  assert.match(spaced.html, /<li class="wmd-list-item-spaced">/);
  assert.equal((mixed.html.match(/class="wmd-list-item-spaced"/g) || []).length, 1);
  assert.match(mixed.html, /<li class="wmd-list-item-spaced">\s*<p>THREE<\/p>/);
  assert.match(spaced.css, /\.wmd-list > li\.wmd-list-item-spaced\{margin-top:\.65em\}/);
  assert.match(spaced.css, /\.wmd-list > li > p\{margin-top:0;margin-bottom:0\}/);
});

test("indented list continuations and code fences retain their content", () => {
  const continuation = renderFragment("- FOX\n  JUMPS OVER THE\nAFTER");
  const listEnd = continuation.html.indexOf("</ul>");
  assert.match(continuation.html.slice(0, listEnd), /JUMPS OVER THE/);
  assert.doesNotMatch(continuation.html.slice(0, listEnd), /AFTER/);
  assert.match(continuation.html.slice(listEnd), /^<\/ul>\s*<p class="wmd-list-after">AFTER<\/p>/);

  const fence = String.fromCharCode(96).repeat(3);
  const code = renderFragment([fence + "wmd", "- FOX", "OVER THE", fence].join("\n"));
  assert.match(code.html, /<code class="language-wmd">- FOX\nOVER THE\n<\/code>/);
});

test("single-newline transitions around lists have compact block margins", () => {
  const source = "Before list\n- Alpha\n- Beta\nAfter list";
  const rendered = renderFragment(source);
  const html = rendered.html;

  assert.match(html, /<p class="wmd-list-before">Before list<\/p>/);
  assert.match(html, /<ul class="wmd-list wmd-list-joined-before wmd-list-joined-after">/);
  assert.match(html, /<\/ul>\s*<p class="wmd-list-after">After list<\/p>/);
  assert.match(rendered.css, /ul\.wmd-list,ol\.wmd-list\{line-height:1\.35\}/);
  assert.match(rendered.css, /p\.wmd-list-before\{margin-bottom:0\}/);
  assert.match(rendered.css, /p\.wmd-list-after\{margin-top:0\}/);
  assert.match(rendered.css, /ul\.wmd-list\.wmd-list-joined-after,ol\.wmd-list\.wmd-list-joined-after\{margin-bottom:0\}/);
});

test("real blank lines retain paragraph-to-list and list-to-paragraph margins", () => {
  const before = renderFragment("Before list\n\n- Alpha\n- Beta\nAfter list").html;
  assert.doesNotMatch(before, /wmd-list-before|wmd-list-joined-before/);
  assert.match(before, /wmd-list-joined-after/);

  const after = renderFragment("Before list\n- Alpha\n- Beta\n\nAfter list").html;
  assert.match(after, /wmd-list-before|wmd-list-joined-before/);
  assert.doesNotMatch(after, /wmd-list-after|wmd-list-joined-after/);

  const both = renderFragment("Before list\n\n- Alpha\n- Beta\n\nAfter list").html;
  assert.doesNotMatch(both, /wmd-list-before|wmd-list-joined-before|wmd-list-after|wmd-list-joined-after/);
});

test("numbered lists use compact transitions and honour blank lines", () => {
  const tight = renderFragment("Before\n1. First\n2. Second\nAfter").html;
  assert.match(tight, /<ol class="wmd-list wmd-list-joined-before wmd-list-joined-after">/);
  assert.match(tight, /<p class="wmd-list-after">After<\/p>/);
  const spaced = renderFragment("1. First\n\n2. Second").html;
  assert.match(spaced, /<li class="wmd-list-item-spaced">/);
});

test("configurable tab stops align independently in documents and fragments", () => {
  const source = "@tabstops 12em, 29em\nAlgorithmica \\tab $P=NP$\nHeuristica \\tab $P\\ne NP$ \\tab _average-case_\n@endtabstops";
  for (const { html } of [renderFragment(source), compile("@tab Main\n" + source)]) {
    assert.match(html, /<div class="wmd-tab-stops">/);
    assert.match(html, /grid-template-columns:12em calc\(29em - 12em\) minmax\(max-content, 1fr\)/);
    assert.match(html, /<span class="wmd-tab-cell">Algorithmica<\/span>/);
    assert.match(html, /<span class="wmd-tab-cell">Heuristica<\/span>/);
    assert.match(html, /<em>average-case<\/em>/);
    assert.doesNotMatch(html, /@tabstops|@endtabstops/);
  }
});

test("tab stops preserve WMD formatting, code spans, links, and maths", () => {
  const tick = String.fromCharCode(96);
  const source = "@tabstops 10rem, 21rem\n*Name* \\tab $P\\ne NP$ \\tab [paper](https://example.com)\n" +
    tick + "\\tab" + tick + " \\tab <<prose>>\n@endtabstops";
  const result = renderFragment(source);
  assert.match(result.html, /<strong>Name<\/strong>/);
  assert.match(result.html, /\$P\\ne NP\$/);
  assert.match(result.html, /href="https:\/\/example.com"/);
  assert.match(result.html, /<code>\\tab<\/code>/);
  assert.match(result.html, /class="wmd-mention">prose<\/span>/);
  assert.equal((result.html.match(/class="wmd-tab-row"/g) || []).length, 2);
  assert.match(result.css, /\.wmd-tab-row\{display:grid/);
});

test("tab stops use defaults and extend past the last custom position", () => {
  const defaults = renderFragment("@tabstops\nA \\tab B \\tab C\n@endtabstops");
  assert.match(defaults.html, /grid-template-columns:8em calc\(16em - 8em\) calc\(24em - 16em\)/);
  const extended = renderFragment("@tabstops 11em\nA \\tab B \\tab C\n@endtabstops");
  assert.match(extended.html, /grid-template-columns:11em calc\(19em - 11em\)/);
});

test("tab-stop CSS values are validated", () => {
  for (const ruler of ["10em, 9em", "10em, calc(20em)", "10em; background:red", "12em, 20px", "0em"]) {
    const result = renderFragment("@tabstops " + ruler + "\nA \\tab B\n@endtabstops");
    assert.doesNotMatch(result.html, /class="wmd-tab-stops"/);
    assert.ok(result.warnings.some(warning => warning.includes("Invalid @tabstops ruler")));
  }
});

test("tab-stop markers in code and escaped markers do not split columns", () => {
  const tick = String.fromCharCode(96);
  const source = "@tabstops 9em\n" + tick + "\\tab" + tick + " \\tab B\n" +
    "Escaped \\\\tab \\tab C\n@endtabstops";
  const result = renderFragment(source);
  assert.match(result.html, /<code>\\tab<\/code>/);
  assert.match(result.html, /Escaped/);
  assert.equal((result.html.match(/class="wmd-tab-row"/g) || []).length, 2);
});

test("tab stops in fenced code remain literal", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const result = renderFragment([fence + "wmd", "@tabstops 10em", "A \\tab B", "@endtabstops", fence].join("\n"));
  assert.doesNotMatch(result.html, /class="wmd-tab-stops"/);
  assert.match(result.html, /@tabstops 10em/);
});

test("tab-stop blocks interrupt adjoining paragraphs without blank lines", () => {
  const source = "Before\n@tabstops 11em\nA \\tab B\n@endtabstops\nAfter";
  const result = renderFragment(source);
  assert.match(result.html, /<p>Before<\/p>/);
  assert.match(result.html, /<div class="wmd-tab-stops">/);
  assert.match(result.html, /<\/div>\s*<p>After<\/p>/);
});
