# WikiMD

WikiMD is a small Markdown-derived document format that compiles `.wmd` files into self-contained interactive HTML.

This repository intentionally contains only two user-facing pieces:

- the **WikiMD compiler** (`wmd-compiler.js`)
- the **VS Code extension** (`vscode-extension/`)

Tests, package metadata, and the licence remain only to support those two pieces.

## Requirements

- Node.js 18 or newer
- npm

Install the compiler dependency once:

```bash
npm ci
```

## Compiler

Compile a file:

```bash
node wmd-compiler.js notes.wmd
```

If the output path is omitted, WikiMD writes a sibling HTML file with the same base name, so `notes.wmd` becomes `notes.html`.

Choose the output path explicitly when needed:

```bash
node wmd-compiler.js notes.wmd site/notes.html
```

Watch for changes:

```bash
node wmd-compiler.js --watch notes.wmd
```

Start the local live-preview server:

```bash
node wmd-compiler.js --serve notes.wmd
node wmd-compiler.js --serve notes.wmd --port 4400
```

Run `node wmd-compiler.js --help` for the full CLI reference.

The npm scripts are thin aliases, so arguments go after `--`:

```bash
npm run build -- notes.wmd
npm run watch -- notes.wmd
npm run serve -- notes.wmd
```

### Supported WMD features

The compiler supports tabs, hidden tabs, titles, variables, includes/embeds, per-tab tables of contents, wiki links, callouts, collapsible sections, style presets, custom heading/callout markers, task lists, tables, highlighting, underline, and standard Markdown links/code.

A minimal document:

```wmd
@tab Home
@title My notes

# Start here

See [[Reference#Details|the details]].

!note Remember
This is a callout.
!end

@tab Reference
## Details
More text.
```

## VS Code extension

The extension lives in `vscode-extension/`. It provides:

- a dedicated `.wmd` language mode
- syntax highlighting
- snippets and completions
- smart delimiter typing
- a basic formatter
- WMD Dark and WMD Light themes
- an editor-title **Open Live Preview** command

For local installation, copy the `vscode-extension` folder into your VS Code extensions directory and reload VS Code.

The live preview searches workspace roots for `wmd-compiler.js`. If the compiler lives elsewhere, set **WikiMD: Compiler Path** (`wmd.compilerPath`). You can also configure the Node executable and preview port with `wmd.nodePath` and `wmd.previewPort`.

## Development

Run the retained tests:

```bash
npm test
```

Run syntax checks plus tests:

```bash
npm run check
```

## Repository layout

```text
WikiMD/
├─ wmd-compiler.js
├─ vscode-extension/
├─ test/
├─ package.json
├─ package-lock.json
├─ README.md
└─ LICENSE
```

## Licence

WikiMD is licensed under the GNU GPL v3.0 or later. See [LICENSE](LICENSE).
