# WMD – Wiki Markup Dialect VS Code extension

Language support for `.wmd` files.

## Features

- WMD syntax highlighting
- snippets and completions
- smart pairing for `*`, `_`, `=`, and backticks
- bracket, quote, backtick, and wiki-link auto-closing
- document formatting
- folding for config, callout, collapse, and style blocks
- WMD Dark and WMD Light colour themes
- live preview in VS Code's Simple Browser

## Install locally

Copy this folder to your VS Code extensions directory, for example on Windows:

```text
%USERPROFILE%\.vscode\extensions\wmd
```

Then reload VS Code.

## Live preview

Open a `.wmd` file and click **WMD: Open Live Preview** in the editor title area.

The extension looks for `wmd-compiler.js` in the open workspace. When developing the extension from this repository, it also finds the compiler in the repository root.

If the compiler is somewhere else, set:

- `wmd.compilerPath` – path to `wmd-compiler.js`
- `wmd.nodePath` – Node.js executable, default `node`
- `wmd.previewPort` – preview server port, default `4312`

The preview writes the compiled `.html` beside the source `.wmd` file and refreshes when the source changes.
