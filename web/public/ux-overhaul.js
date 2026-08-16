(() => {
  "use strict";

  const connection = document.querySelector("#connectionStatus");
  const saveStatus = document.querySelector("#saveStatus");
  const presence = document.querySelector("#presence");
  const workspaceMeta = document.querySelector(".workspace-meta");
  const toolbar = document.querySelector(".document-toolbar");
  if (!connection || !saveStatus || !presence || !workspaceMeta) return;

  connection.setAttribute("role", "status");
  connection.setAttribute("aria-live", "polite");
  saveStatus.setAttribute("role", "status");
  saveStatus.setAttribute("aria-live", "polite");

  const summary = document.createElement("div");
  summary.className = "collaboration-summary";
  summary.dataset.state = "connecting";
  summary.setAttribute("role", "status");
  summary.setAttribute("aria-live", "polite");
  summary.innerHTML = '<span class="collaboration-summary-dot" aria-hidden="true"></span><span class="collaboration-summary-text">Connecting…</span>';
  workspaceMeta.prepend(summary);

  const hint = document.createElement("div");
  hint.className = "ux-shortcut-hint";
  hint.setAttribute("aria-hidden", "true");
  document.body.append(hint);
  let hintTimer = null;

  function showHint(message) {
    hint.textContent = message;
    hint.dataset.visible = "true";
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.dataset.visible = "false"; }, 1700);
  }

  function classifyConnection() {
    const text = `${connection.textContent || ""} ${connection.className || ""}`.toLowerCase();
    if (/problem|error|failed|offline|disconnected/.test(text)) return "problem";
    if (/connect|retry|delay/.test(text)) return "connecting";
    return "synced";
  }

  function updateSummary() {
    const avatars = [...presence.querySelectorAll(".avatar")];
    const selfCount = avatars.filter((avatar) => /\(you\)/i.test(avatar.title || "")).length;
    const collaboratorCount = Math.max(0, avatars.length - selfCount);
    const saveText = String(saveStatus.textContent || "").toLowerCase();
    const connectionState = classifyConnection();
    const saving = /saving|restoring|waiting/.test(saveText);
    const state = connectionState === "synced" && saving ? "saving" : connectionState;

    let label;
    if (state === "problem") label = "Sync problem — local copy kept";
    else if (state === "connecting") label = collaboratorCount ? `${collaboratorCount} collaborator${collaboratorCount === 1 ? "" : "s"} · reconnecting` : "Connecting to collaboration";
    else if (state === "saving") label = collaboratorCount ? `${collaboratorCount} collaborator${collaboratorCount === 1 ? "" : "s"} · saving` : "Saving changes";
    else if (collaboratorCount) label = `${collaboratorCount} collaborator${collaboratorCount === 1 ? "" : "s"} editing now`;
    else label = "Live collaboration ready";

    summary.dataset.state = state;
    summary.querySelector(".collaboration-summary-text").textContent = label;
    summary.title = `${connection.textContent || ""}. ${saveStatus.textContent || ""}`;
  }

  new MutationObserver(updateSummary).observe(connection, { childList: true, characterData: true, subtree: true, attributes: true });
  new MutationObserver(updateSummary).observe(saveStatus, { childList: true, characterData: true, subtree: true });
  new MutationObserver(updateSummary).observe(presence, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "disabled"] });
  updateSummary();

  // A horizontal mouse wheel over the dense toolbar should move the toolbar,
  // not unexpectedly scroll the document vertically.
  toolbar?.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || toolbar.scrollWidth <= toolbar.clientWidth) return;
    toolbar.scrollLeft += event.deltaY;
    event.preventDefault();
  }, { passive: false });

  document.addEventListener("keydown", (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier) return;

    if (event.key.toLowerCase() === "s") {
      // WikiMD autosaves. Prevent the browser's Save Page dialog, which otherwise
      // makes an autosaving editor feel broken.
      event.preventDefault();
      showHint(/all changes saved/i.test(saveStatus.textContent || "") ? "Already saved" : "WikiMD saves automatically");
      return;
    }

    if (event.shiftKey && event.key.toLowerCase() === "p") {
      const button = document.querySelector("#panelsButton");
      if (button) {
        event.preventDefault();
        button.click();
        showHint("Panels toggled");
      }
    }
  });

  // Keep useful controls discoverable for keyboard users without changing the
  // app's command handling.
  const shortcutTitles = new Map([
    ["#documentsButton", "Documents"],
    ["#shareButton", "Share this live document"],
    ["#panelsButton", "Panels (Ctrl+Shift+P)"],
    ["#downloadButton", "Download a .wmd snapshot"],
  ]);
  for (const [selector, title] of shortcutTitles) {
    const element = document.querySelector(selector);
    if (element) element.title = title;
  }
})();
