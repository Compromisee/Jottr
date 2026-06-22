/* ===========================================================
   Jottr - app.js v3

   Features:
   - Tab manager with per-tab editors and dirty state.
   - Atomic auto-save that NEVER resets the caret mid-typing.
   - Markdown source highlighting via overlay layer.
   - Todo-list mode: typing **todolist** in a blank note turns it
     into a structured checklist UI; multi-line paste inserts
     one item per non-empty line.
   - PIN gate (app-wide) on launch + on focus regain after hide.
   - Settings modal, context menu, recent + pinned files, stats widgets.
   - Eye-toggle preview mode (Ctrl+Shift+V) with rendered markdown
     and read-only todo checklist.
   - Find / Replace (Ctrl+F).
   - Drag-and-drop .md / .txt files into the editor.
   - Theme cycle button.
   =========================================================== */

(function () {
  "use strict";

  // ----------------------------------------------------------- Helpers
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) =>
    Array.from((root || document).querySelectorAll(sel));

  function getApi() { return window.pywebview && window.pywebview.api; }
  function hasApi() { return !!getApi(); }
  async function pycall(methodName, ...args) {
    const api = getApi();
    if (!api || typeof api[methodName] !== "function") {
      throw new Error("pywebview api not ready (missing: " + methodName + ")");
    }
    return await api[methodName](...args);
  }

  // ----------------------------------------------------------- State
  const state = {
    config: null,
    tabs: [],
    activeTab: null,
    pendingSave: null,
    locked: false,
    homeVisible: false,
    shouldRelockOnFocus: false,
    booted: false,
    preview: false,
    find: { open: false, last: "", idx: 0, matches: [] },
  };

  const SAVE_DEBOUNCE_MS = 600;
  const TODO_TRIGGER = "**todolist**";

  // ----------------------------------------------------------- Boot
  function startWhenReady() {
    if (window.pywebview && window.pywebview.api) { boot(); return; }
    window.addEventListener("pywebviewready", boot, { once: true });
    setTimeout(() => {
      if (!state.booted) {
        console.warn("pywebviewready never fired - using fallback mode.");
        boot();
      }
    }, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startWhenReady, { once: true });
  } else {
    startWhenReady();
  }

  async function boot() {
    if (state.booted) return;
    state.booted = true;
    bindStaticHandlers();
    state.config = defaultConfig();
    if (hasApi()) {
      try { state.config = await pycall("get_config"); }
      catch (e) { console.warn("get_config failed:", e); }
    }
    applyTheme(state.config.theme);
    updateHideEmptyEditor();

    if (hasApi()) {
      try {
        const need = await pycall("has_app_pin");
        if (need && need.required) { showPin(); return; }
      } catch (e) { console.warn("has_app_pin failed:", e); }
    }
    enterApp();
  }

  function defaultConfig() {
    return {
      version: 1,
      theme: "midnight",
      app_pin_hash: "",
      pin_scope: "app",
      startup: false,
      global_hotkey: "ctrl+alt+j",
      minimize_to_tray: true,
      show_home: true,
      recent: [],
      pinned: [],
      stats: { streak: 0, last_open_date: "",
               minutes_today: 0, minutes_today_date: "",
               total_words: 0 },
      explorer_context_menu: false,
      font_size: 14,
      show_line_numbers: true,
      word_wrap: false,
      preview_default: false,
    };
  }

  function applyTheme(theme) {
    document.body.dataset.theme = theme || "midnight";
  }

  // ----------------------------------------------------------- PIN gate
  function showPin() {
    state.locked = true;
    const ov = $("#pin-overlay");
    ov.classList.remove("hidden");
    ov.setAttribute("aria-hidden", "false");
    setTimeout(() => $("#pin-input").focus(), 30);
  }
  function hidePin() {
    state.locked = false;
    const ov = $("#pin-overlay");
    ov.classList.add("hidden");
    ov.setAttribute("aria-hidden", "true");
    $("#pin-input").value = "";
    $("#pin-error").textContent = "";
  }

  function bindStaticHandlers() {
    $("#pin-unlock").addEventListener("click", tryUnlock);
    $("#pin-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") tryUnlock();
    });

    // Titlebar buttons
    $("#btn-home").addEventListener("click", () => toggleHome());
    $("#btn-settings").addEventListener("click", () => openSettings());
    $("#btn-tray").addEventListener("click", hideToTray);
    $("#btn-quit").addEventListener("click", quitApp);
    $("#btn-preview").addEventListener("click", () => togglePreview());
    $("#btn-find").addEventListener("click", () => openFind());

    // Sidebar quick actions
    $("#quick-new-note").addEventListener("click", (e) => { e.preventDefault(); newNote(); });
    $("#quick-new-todo").addEventListener("click", (e) => { e.preventDefault(); newTodo(); });
    $("#quick-open").addEventListener("click", (e) => { e.preventDefault(); openExternal(); });

    // Empty editor
    $("#empty-new-note").addEventListener("click", (e) => { e.preventDefault(); newNote(); });
    $("#empty-new-todo").addEventListener("click", (e) => { e.preventDefault(); newTodo(); });

    // Settings modal
    $("#settings-close").addEventListener("click", closeSettings);
    $("#settings-cancel").addEventListener("click", closeSettings);
    $("#settings-save").addEventListener("click", saveSettings);
    $("#settings-modal").addEventListener("click", (e) => {
      if (e.target.id === "settings-modal") closeSettings();
    });

    // Find modal
    $("#find-close").addEventListener("click", closeFind);
    $("#find-modal").addEventListener("click", (e) => {
      if (e.target.id === "find-modal") closeFind();
    });
    $("#find-input").addEventListener("input", runFind);
    $("#find-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); runFind(null, e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
    });
    $("#find-prev").addEventListener("click", () => runFind(null, -1));
    $("#find-next").addEventListener("click", () => runFind(null, 1));
    $("#find-replace-one").addEventListener("click", replaceOne);
    $("#find-replace-all").addEventListener("click", replaceAll);

    // Global keyboard
    window.addEventListener("keydown", onGlobalKey);

    // Home screen quick actions (delegated)
    document.addEventListener("click", (e) => {
      const qa = e.target.closest(".qa");
      if (!qa) return;
      const a = qa.dataset.action;
      if (a === "new-note") newNote();
      else if (a === "new-todo") newTodo();
      else if (a === "open") openExternal();
      else if (a === "lock") {
        if (state.config && state.config.app_pin_hash) showPin();
        else toast("No PIN set - open Settings to add one", "info");
      }
      else if (a === "theme") cycleTheme();
    });

    // Recent + pinned list clicks (delegated)
    document.addEventListener("click", (e) => {
      const li = e.target.closest("[data-open-file]");
      if (!li) return;
      openTab(li.dataset.openFile);
    });

    // Tab bar (delegated)
    $("#tabbar").addEventListener("click", onTabClick);

    // Context menu
    $("#ctx-menu").addEventListener("click", onContextMenuClick);
    window.addEventListener("click", (e) => {
      if (!e.target.closest("#ctx-menu")) hideContextMenu();
    });
    window.addEventListener("contextmenu", (e) => {
      const li = e.target.closest("[data-open-file]");
      if (li) {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, li.dataset.openFile);
      }
    });

    // Drag and drop
    const surface = $("#editor-surface");
    surface.addEventListener("dragover", (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        const ed = e.target.closest(".editor");
        if (ed) ed.classList.add("dragover");
      }
    });
    surface.addEventListener("dragleave", (e) => {
      const ed = e.target.closest(".editor");
      if (ed) ed.classList.remove("dragover");
    });
    surface.addEventListener("drop", onDrop);

    // Lock-on-focus when window regained focus after being hidden.
    window.addEventListener("focus", onWindowFocus);
  }

  async function tryUnlock() {
    const pin = $("#pin-input").value;
    if (!hasApi()) { $("#pin-error").textContent = "Backend not ready"; return; }
    try {
      const out = await pycall("verify_app_pin", pin);
      if (out.ok) { hidePin(); enterApp(); }
      else { $("#pin-error").textContent = "Wrong PIN"; $("#pin-input").select(); }
    } catch (e) { $("#pin-error").textContent = "Unlock failed"; }
  }

  function onWindowFocus() {
    if (state.locked) return;
    if (state.shouldRelockOnFocus &&
        state.config && state.config.app_pin_hash) {
      state.shouldRelockOnFocus = false;
      showPin();
    }
  }

  function hideToTray() {
    state.shouldRelockOnFocus = !!(
      state.config && state.config.app_pin_hash);
    if (hasApi()) pycall("hide_to_tray").catch(() => {});
  }
  function quitApp() {
    if (hasApi()) pycall("quit_app").catch(() => {});
  }

  function enterApp() {
    $("#app").classList.remove("hidden");
    $("#pin-overlay").classList.add("hidden");
    refreshRecent();
    refreshPinned();
    refreshStats();
    if (state.config && state.config.show_home && state.tabs.length === 0) {
      toggleHome(true);
    } else {
      updateHideEmptyEditor();
    }
    window.__jottr = {
      newNote: () => newNote(),
      focusQuickNew: () => newNote(),
      lock: () => showPin(),
    };
    window.jottr = window.__jottr;
  }

  // ----------------------------------------------------------- Tabs
  function onTabClick(e) {
    const add = e.target.closest(".tab-add");
    if (add) { e.preventDefault(); newNote(); return; }
    const tabEl = e.target.closest(".tab");
    if (!tabEl) return;
    const name = tabEl.dataset.name;
    if (e.target.closest(".tab-close")) {
      e.preventDefault();
      closeTab(name);
    } else {
      activateTab(name);
    }
  }

  async function newNote(name) {
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    try {
      const out = await pycall("new_note", name || null, "note");
      if (!out.ok) { toast("Could not create note", "error"); return; }
      await openTab(out.name);
    } catch (e) { toast("Create failed: " + e.message, "error"); }
  }
  async function newTodo() {
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    try {
      const out = await pycall("new_note", null, "todo");
      if (!out.ok) { toast("Could not create todo", "error"); return; }
      await openTab(out.name);
    } catch (e) { toast("Create failed: " + e.message, "error"); }
  }
  async function openExternal() {
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    try {
      const out = await pycall("open_external");
      if (out.cancelled) return;
      if (!out.ok) { toast("Open failed: " + (out.error || ""), "error"); return; }
      await openTab(out.name);
    } catch (e) { toast("Open failed: " + e.message, "error"); }
  }

  async function openTab(name) {
    if (!hasApi()) return;
    if (state.tabs.find((t) => t.name === name)) {
      activateTab(name);
      return;
    }
    try {
      const r = await pycall("read_note", name);
      const tab = {
        name,
        content: r.content || "",
        mtime: r.mtime || 0,
        dirty: false,
        el: null, textarea: null, highlight: null, gutter: null,
        todoEl: null, previewEl: null,
        todoMode: isTodoTrigger(r.content || ""),
      };
      state.tabs.push(tab);
      renderTabBar();
      renderEditor(tab);
      activateTab(name);
      refreshRecent();
      refreshPinned();
    } catch (e) {
      toast("Read failed: " + e.message, "error");
    }
  }

  function closeTab(name) {
    const idx = state.tabs.findIndex((t) => t.name === name);
    if (idx < 0) return;
    const tab = state.tabs[idx];
    if (tab.dirty) flushSave(tab);
    if (tab.el) tab.el.remove();
    if (tab.todoEl) tab.todoEl.remove();
    if (tab.previewEl) tab.previewEl.remove();
    state.tabs.splice(idx, 1);
    renderTabBar();
    if (state.activeTab === name) {
      state.activeTab = null;
      if (state.tabs.length) {
        activateTab(state.tabs[Math.max(0, idx - 1)].name);
      } else {
        updateHideEmptyEditor();
      }
    }
  }

  function activateTab(name) {
    state.homeVisible = false;
    $("#home-screen").classList.add("hidden");

    // Decide the visible surface for each tab. Only ONE of the three
    // surfaces (.editor with textarea, .todo-surface, .preview-pane)
    // is ever shown at a time per tab.
    state.tabs.forEach((t) => {
      const active = t.name === name;
      const wantPreview = active && state.preview;
      const wantTodo   = active && t.todoMode && !state.preview;
      const wantEdit   = active && !t.todoMode && !state.preview;

      if (!active) {
        if (t.el) t.el.classList.add("hidden");
        if (t.todoEl) t.todoEl.classList.add("hidden");
        if (t.previewEl) t.previewEl.classList.add("hidden");
        return;
      }

      // Editor (raw textarea + gutter + highlight) - ONLY when not
      // in todo mode and not in preview mode.
      if (t.el) t.el.classList.toggle("hidden", !wantEdit);
      if (t.gutter) t.gutter.style.display =
        (wantEdit && state.config && state.config.show_line_numbers !== false) ? "" : "none";
      if (t.textarea) t.textarea.style.display = wantEdit ? "" : "none";
      if (t.highlight) t.highlight.style.display = wantEdit ? "" : "none";

      // Todo checklist UI - ONLY when in todo mode AND not preview.
      if (t.todoEl) t.todoEl.classList.toggle("hidden", !wantTodo);
      if (wantTodo) renderTodoList(t);

      // Preview pane - ONLY when preview mode is on.
      if (t.previewEl) {
        if (wantPreview) {
          renderPreview(t);
          t.previewEl.classList.remove("hidden");
        } else {
          t.previewEl.classList.add("hidden");
        }
      }
    });

    state.activeTab = name;
    $("#empty-editor").classList.add("hidden");
    renderTabBar();
    const t = state.tabs.find((x) => x.name === name);
    if (t) {
      updateStatus(t);
      // Focus the right surface.
      if (state.preview) {
        // Nothing focusable inside the preview pane.
      } else if (t.todoMode) {
        // Focus the last item so Enter keeps adding.
        setTimeout(() => {
          const lis = t.todoEl.querySelectorAll(".todo-item");
          const last = lis[lis.length - 1];
          if (last) {
            const nt = last.querySelector(".todo-text");
            if (nt) {
              nt.focus();
              const r = document.createRange();
              r.selectNodeContents(nt);
              r.collapse(false);
              const s = window.getSelection();
              s.removeAllRanges(); s.addRange(r);
            }
          }
        }, 0);
      } else if (t.textarea) {
        setTimeout(() => t.textarea.focus(), 0);
      }
    }
    $$(".recent-list li, .home-recent li, #pinned-list li").forEach((li) => {
      li.classList.toggle("is-active", li.dataset.openFile === name);
    });
    updatePreviewButton();
  }

  function renderTabBar() {
    const bar = $("#tabbar");
    bar.innerHTML = "";
    state.tabs.forEach((t) => {
      const el = document.createElement("div");
      el.className = "tab" + (t.name === state.activeTab ? " active" : "")
        + (t.dirty ? " dirty" : "");
      el.dataset.name = t.name;
      el.title = t.name;
      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined";
      icon.textContent = t.todoMode ? "checklist" : "description";
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = t.name;
      const close = document.createElement("span");
      close.className = "tab-close";
      close.innerHTML = '<span class="material-symbols-outlined">close</span>';
      el.append(icon, label, close);
      bar.appendChild(el);
    });
    const add = document.createElement("div");
    add.className = "tab-add";
    add.title = "New note (Ctrl+N)";
    add.innerHTML = '<span class="material-symbols-outlined">add</span>';
    bar.appendChild(add);
  }

  function updateHideEmptyEditor() {
    const empty = $("#empty-editor");
    if (!empty) return;
    if (state.tabs.length > 0 || state.homeVisible) empty.classList.add("hidden");
    else if (!state.activeTab && !state.homeVisible) empty.classList.remove("hidden");
  }

  // ----------------------------------------------------------- Editor
  function renderEditor(tab) {
    const surface = $("#editor-surface");

    const wrap = document.createElement("div");
    wrap.className = "editor hidden";
    wrap.dataset.wrap = state.config.word_wrap ? "true" : "false";
    wrap.style.setProperty("--font-size", (state.config.font_size || 14) + "px");
    wrap.dataset.name = tab.name;

    const gutter = document.createElement("div");
    gutter.className = "gutter";

    const body = document.createElement("div");
    body.className = "editor-body";

    const highlight = document.createElement("pre");
    highlight.className = "editor-highlight";
    highlight.setAttribute("aria-hidden", "true");

    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.value = tab.content;
    ta.wrap = state.config.word_wrap ? "soft" : "off";

    body.append(highlight, ta);
    wrap.append(gutter, body);
    surface.appendChild(wrap);

    tab.el = wrap;
    tab.textarea = ta;
    tab.highlight = highlight;
    tab.gutter = gutter;

    if (state.config.show_line_numbers === false) gutter.style.display = "none";

    const todoEl = document.createElement("div");
    todoEl.className = "todo-surface hidden";
    surface.appendChild(todoEl);
    tab.todoEl = todoEl;

    const previewEl = document.createElement("div");
    previewEl.className = "preview-pane hidden";
    surface.appendChild(previewEl);
    tab.previewEl = previewEl;

    syncHighlight(tab);
    renderGutter(tab);
    updateStatus(tab);

    ta.addEventListener("input", () => onEditorInput(tab));
    ta.addEventListener("scroll", () => {
      highlight.scrollTop = ta.scrollTop;
      highlight.scrollLeft = ta.scrollLeft;
    });
    ta.addEventListener("keyup", () => updateCaret(tab));
    ta.addEventListener("click", () => updateCaret(tab));
    ta.addEventListener("keydown", (e) => onEditorKey(tab, e));
  }

  function onEditorInput(tab) {
    tab.dirty = true;
    tab.content = tab.textarea.value;
    renderTabBar();
    syncHighlight(tab);
    renderGutter(tab);
    updateStatus(tab);

    const wantTodo = isTodoTrigger(tab.content);
    if (wantTodo !== tab.todoMode) {
      tab.todoMode = wantTodo;
      // Re-evaluate which surface should be visible for this tab.
      if (tab.name === state.activeTab) {
        activateTab(tab.name);
      } else {
        // Tab not active - just update the cached flag; activateTab
        // will pick the right surface when the user switches back.
        if (tab.todoEl) tab.todoEl.classList.toggle("hidden", !tab.todoMode);
      }
    }

    scheduleSave(tab);
  }

  function onEditorKey(tab, e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault(); flushSave(tab); return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = tab.textarea;
      const s = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 4;
      onEditorInput(tab);
    }
  }

  function isTodoTrigger(text) {
    if (!text) return false;
    const t = text.trim();
    return t === TODO_TRIGGER || t.startsWith(TODO_TRIGGER);
  }

  function syncHighlight(tab) {
    tab.highlight.innerHTML = highlightMarkdown(tab.textarea.value);
    tab.highlight.scrollTop = tab.textarea.scrollTop;
    tab.highlight.scrollLeft = tab.textarea.scrollLeft;
  }

  function renderGutter(tab) {
    const lines = tab.textarea.value.split("\n").length;
    const g = tab.gutter;
    const arr = [];
    for (let i = 1; i <= lines; i++) arr.push('<span class="ln">' + i + "</span>");
    g.innerHTML = arr.join("");
    updateCaret(tab);
  }

  function updateCaret(tab) {
    if (!tab || !tab.textarea) return;
    const ta = tab.textarea;
    const upto = ta.value.slice(0, ta.selectionStart);
    const line = (upto.match(/\n/g) || []).length + 1;
    const col = upto.length - upto.lastIndexOf("\n");
    $$(".ln", tab.gutter).forEach((el, i) => {
      el.classList.toggle("active", i + 1 === line);
    });
    $("#status-pos").textContent = "Ln " + line + ", Col " + col;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  // Highlight used in the editor overlay (line-by-line, no inline HTML).
  function highlightMarkdown(src) {
    const lines = escapeHtml(src).split("\n");
    const out = [];
    let inFence = false;
    for (const ln of lines) {
      if (/^```/.test(ln)) {
        inFence = !inFence;
        out.push('<span class="h-com">' + ln + "</span>");
        continue;
      }
      if (inFence) { out.push('<span class="h-com">' + ln + "</span>"); continue; }
      let r = ln;
      r = r.replace(/^(#{1,6})\s+(.*)$/, (m, h, t) =>
        '<span class="h-h">' + h + " " + '</span><span class="h-bold">' + t + "</span>");
      r = r.replace(/\*\*([^*]+)\*\*/g, '<span class="h-bold">**$1**</span>');
      r = r.replace(/\*([^*]+)\*/g, '<span class="h-emph">*$1*</span>');
      r = r.replace(/`([^`]+)`/g, '<span class="h-str">`$1`</span>');
      r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
        '<span class="h-tag">[$1]</span><span class="h-com">($2)</span>');
      r = r.replace(/\b(\d+)\b/g, '<span class="h-num">$1</span>');
      out.push(r);
    }
    return out.join("\n");
  }

  // ----------------------------------------------------------- Todo list mode
  function renderTodoList(tab) {
    const el = tab.todoEl;
    el.innerHTML = "";

    const lines = tab.textarea.value.split("\n");
    let startIdx = 0;
    while (startIdx < lines.length && lines[startIdx].trim() === "") startIdx++;
    if (lines[startIdx] && lines[startIdx].trim() === TODO_TRIGGER) startIdx++;
    if (lines[startIdx] && lines[startIdx].trim() === "") startIdx++;

    const items = [];
    for (let i = startIdx; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s\[( |x|X)\]\s?(.*)$/);
      if (m) items.push({ done: m[1].toLowerCase() === "x", text: m[2] });
      else if (lines[i].trim() !== "") {
        if (items.length) items[items.length - 1].text += "\n" + lines[i];
        else items.push({ done: false, text: lines[i] });
      }
    }
    if (items.length === 0) items.push({ done: false, text: "" });

    const ul = document.createElement("ul");
    ul.className = "todo-list";

    items.forEach((it, idx) => {
      const li = document.createElement("li");
      li.className = "todo-item" + (it.done ? " done" : "");
      const box = document.createElement("span");
      box.className = "todo-box";
      box.addEventListener("click", () => toggleTodo(tab, idx));
      const text = document.createElement("div");
      text.className = "todo-text";
      text.contentEditable = "true";
      text.spellcheck = true;
      text.textContent = it.text;
      text.dataset.placeholder = "List item...";
      text.addEventListener("input", () => {
        items[idx].text = text.innerText;
        writeTodosToTab(tab, items);
        tab.dirty = true;
        renderTabBar();
        scheduleSave(tab);
      });
      // Paste handler - one item per non-empty line.
      text.addEventListener("paste", (e) => onTodoPaste(e, tab, items, idx));
      text.addEventListener("keydown", (e) => onTodoKey(e, tab, items, idx));
      li.append(box, text);
      ul.appendChild(li);
    });

    el.appendChild(ul);
  }

  function onTodoPaste(e, tab, items, idx) {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const text = cd.getData("text/plain");
    if (!text) return;
    // Only intercept if the paste contains newlines - otherwise let
    // the browser handle a normal single-line paste.
    if (!/\r?\n/.test(text)) return;
    e.preventDefault();
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    // Replace current item with the first line; insert rest after.
    items[idx].text = lines[0];
    for (let i = 1; i < lines.length; i++) {
      items.splice(idx + i, 0, { done: false, text: lines[i] });
    }
    writeTodosToTab(tab, items);
    renderTodoList(tab);
    tab.dirty = true;
    renderTabBar();
    scheduleSave(tab);
    // Focus the last inserted item.
    setTimeout(() => {
      const surface = tab.todoEl;
      const lis = surface.querySelectorAll(".todo-item");
      const targetIdx = Math.min(idx + lines.length - 1, lis.length - 1);
      const target = lis[targetIdx];
      if (target) {
        const nt = target.querySelector(".todo-text");
        nt && nt.focus();
        const r = document.createRange();
        r.selectNodeContents(nt);
        r.collapse(false);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(r);
      }
    }, 0);
    toast(lines.length + " items pasted", "content_paste");
  }

  function onTodoKey(e, tab, items, idx) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      items.splice(idx + 1, 0, { done: false, text: "" });
      writeTodosToTab(tab, items);
      renderTodoList(tab);
      tab.dirty = true;
      renderTabBar();
      scheduleSave(tab);
      setTimeout(() => {
        const lis = tab.todoEl.querySelectorAll(".todo-item");
        const ni = lis[idx + 1];
        if (ni) {
          const nt = ni.querySelector(".todo-text");
          nt && nt.focus();
        }
      }, 0);
    } else if (e.key === "Backspace" && e.target.innerText === "") {
      e.preventDefault();
      if (items.length > 1) {
        items.splice(idx, 1);
        writeTodosToTab(tab, items);
        renderTodoList(tab);
        tab.dirty = true;
        renderTabBar();
        scheduleSave(tab);
        setTimeout(() => {
          const lis = tab.todoEl.querySelectorAll(".todo-item");
          const prev = lis[Math.max(0, idx - 1)];
          if (prev) {
            const pt = prev.querySelector(".todo-text");
            pt && pt.focus();
            const r = document.createRange();
            r.selectNodeContents(pt);
            r.collapse(false);
            const s = window.getSelection();
            s.removeAllRanges(); s.addRange(r);
          }
        }, 0);
      }
    }
  }

  function toggleTodo(tab, idx) {
    const lines = tab.textarea.value.split("\n");
    let startIdx = 0;
    while (startIdx < lines.length && lines[startIdx].trim() === "") startIdx++;
    if (lines[startIdx] && lines[startIdx].trim() === TODO_TRIGGER) startIdx++;
    if (lines[startIdx] && lines[startIdx].trim() === "") startIdx++;

    let seen = -1;
    for (let i = startIdx; i < lines.length; i++) {
      if (/^\s*-\s\[( |x|X)\]\s?/.test(lines[i])) {
        seen++;
        if (seen === idx) {
          lines[i] = lines[i].replace(/\[( |x|X)\]/, (m, c) =>
            c === " " ? "[x]" : "[ ]");
          break;
        }
      }
    }
    tab.textarea.value = lines.join("\n");
    onEditorInput(tab);
  }

  function writeTodosToTab(tab, items) {
    const head = TODO_TRIGGER + "\n\n";
    const body = items.map((it) =>
      "- [" + (it.done ? "x" : " ") + "] " + it.text).join("\n");
    tab.textarea.value = head + body + "\n";
    syncHighlight(tab);
    renderGutter(tab);
    updateStatus(tab);
  }

  // ----------------------------------------------------------- Preview pane
  function renderPreview(tab) {
    if (!tab.previewEl) return;
    const content = tab.content || "";
    if (tab.todoMode) {
      tab.previewEl.innerHTML = renderPreviewTodoList(content);
    } else {
      tab.previewEl.innerHTML = renderPreviewMarkdown(content);
    }
  }

  function renderPreviewTodoList(text) {
    const lines = text.split("\n");
    let startIdx = 0;
    while (startIdx < lines.length && lines[startIdx].trim() === "") startIdx++;
    if (lines[startIdx] && lines[startIdx].trim() === TODO_TRIGGER) startIdx++;
    if (lines[startIdx] && lines[startIdx].trim() === "") startIdx++;
    const items = [];
    for (let i = startIdx; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s\[( |x|X)\]\s?(.*)$/);
      if (m) items.push({ done: m[1].toLowerCase() === "x", text: escapeHtml(m[2]) });
      else if (lines[i].trim() !== "") {
        if (items.length) items[items.length - 1].text += "<br>" + escapeHtml(lines[i]);
        else items.push({ done: false, text: escapeHtml(lines[i]) });
      }
    }
    if (!items.length) return '<p class="hint">No items.</p>';
    return '<ul class="preview-todo-list">' + items.map((it) =>
      '<li class="' + (it.done ? "done" : "") + '">' +
      '<span class="todo-box"></span>' +
      '<span class="todo-text">' + (it.text || "") + '</span></li>'
    ).join("") + '</ul>';
  }

  // Tiny Markdown -> HTML renderer for the preview pane.
  function renderPreviewMarkdown(src) {
    if (!src) return '<p class="hint">Empty note.</p>';
    // Handle fenced code blocks first so inline rules don't fight them.
    const tokens = [];
    src = src.replace(/```([\s\S]*?)```/g, (m, body) => {
      const i = tokens.length;
      tokens.push("<pre><code>" + escapeHtml(body) + "</code></pre>");
      return "\u0001FENCE" + i + "\u0001";
    });
    const lines = src.split("\n");
    const out = [];
    let inList = null;       // "ul" | "ol" | null
    let paraBuf = [];
    function flushPara() {
      if (paraBuf.length) {
        const joined = paraBuf.join(" ");
        out.push("<p>" + inline(joined) + "</p>");
        paraBuf = [];
      }
    }
    function closeList() {
      if (inList) { out.push("</" + inList + ">"); inList = null; }
    }
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // Fenced code replacement
      if (/^\u0001FENSE?\d+\u0001$/.test(ln) || /^\u0001FENCE\d+\u0001$/.test(ln)) {
        flushPara(); closeList();
        const m = ln.match(/\u0001FENCE(\d+)\u0001/);
        if (m) out.push(tokens[+m[1]]);
        continue;
      }
      // Headings
      let m = ln.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flushPara(); closeList();
        const lvl = m[1].length;
        out.push("<h" + lvl + ">" + inline(m[2]) + "</h" + lvl + ">");
        continue;
      }
      // Horizontal rule
      if (/^---+\s*$/.test(ln)) {
        flushPara(); closeList();
        out.push("<hr>");
        continue;
      }
      // Blockquote
      m = ln.match(/^>\s?(.*)$/);
      if (m) {
        flushPara(); closeList();
        out.push("<blockquote>" + inline(m[1]) + "</blockquote>");
        continue;
      }
      // Unordered list
      m = ln.match(/^\s*[-*]\s+(.*)$/);
      if (m) {
        flushPara();
        if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; }
        out.push("<li>" + inline(m[1]) + "</li>");
        continue;
      }
      // Ordered list
      m = ln.match(/^\s*\d+\.\s+(.*)$/);
      if (m) {
        flushPara();
        if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; }
        out.push("<li>" + inline(m[1]) + "</li>");
        continue;
      }
      // Blank line
      if (ln.trim() === "") { flushPara(); closeList(); continue; }
      // Paragraph
      paraBuf.push(ln);
    }
    flushPara(); closeList();
    return out.join("\n");
  }
  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  function togglePreview(force) {
    const next = force === true ? true : force === false ? false : !state.preview;
    state.preview = next;
    if (state.config) {
      state.config.preview_default = next;
    }
    const mode = $("#status-mode");
    if (mode) {
      mode.textContent = next ? "Preview" : "Edit";
      mode.classList.toggle("preview", next);
    }
    updatePreviewButton();
    if (state.activeTab) activateTab(state.activeTab);
    else updateHideEmptyEditor();
  }
  function updatePreviewButton() {
    const btn = $("#btn-preview");
    if (!btn) return;
    btn.classList.toggle("active", state.preview);
    const ic = btn.querySelector(".material-symbols-outlined");
    if (ic) ic.textContent = state.preview ? "visibility_off" : "visibility";
  }

  // ----------------------------------------------------------- Find / Replace
  function openFind() {
    const m = $("#find-modal");
    m.classList.remove("hidden");
    state.find.open = true;
    const t = currentTab();
    if (t && t.textarea) {
      const sel = t.textarea.value.substring(t.textarea.selectionStart, t.textarea.selectionEnd);
      if (sel) $("#find-input").value = sel;
    }
    setTimeout(() => $("#find-input").focus(), 30);
    runFind();
  }
  function closeFind() {
    $("#find-modal").classList.add("hidden");
    state.find.open = false;
    const t = currentTab();
    if (t && t.textarea) t.textarea.focus();
  }
  function runFind(_e, dir) {
    const term = $("#find-input").value || "";
    state.find.last = term;
    const t = currentTab();
    if (!t || !t.textarea) return;
    const text = t.textarea.value;
    if (!term) { setFindCount(0); return; }
    const flags = $("#find-case").checked ? "g" : "gi";
    const pattern = $("#find-word").checked
      ? "\\b" + escapeRegex(term) + "\\b"
      : escapeRegex(term);
    let regex;
    try { regex = new RegExp(pattern, flags); }
    catch (e) { setFindCount(-1); return; }
    const matches = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length });
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
    state.find.matches = matches;
    state.find.idx = matches.length ? 0 : -1;
    setFindCount(matches.length);
    if (dir && matches.length) {
      state.find.idx = ((state.find.idx + dir) + matches.length) % matches.length;
    }
    jumpToMatch(t);
  }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function setFindCount(n) {
    const c = $("#find-count");
    if (!c) return;
    if (n < 0) c.textContent = "Invalid pattern";
    else if (n === 0) c.textContent = state.find.last ? "No matches" : "";
    else c.textContent = (state.find.idx + 1) + " of " + n;
  }
  function jumpToMatch(tab) {
    const i = state.find.idx;
    if (i < 0 || !state.find.matches.length) return;
    const m = state.find.matches[i];
    tab.textarea.focus();
    tab.textarea.setSelectionRange(m.start, m.end);
    // Scroll into view roughly.
    const before = tab.textarea.value.substring(0, m.start);
    const lines = (before.match(/\n/g) || []).length;
    const lh = parseFloat(getComputedStyle(tab.textarea).lineHeight) || 22;
    tab.textarea.scrollTop = Math.max(0, lines * lh - tab.textarea.clientHeight / 2);
  }
  function replaceOne() {
    const t = currentTab();
    if (!t) return;
    const term = $("#find-input").value || "";
    const repl = $("#replace-input").value || "";
    if (!term || !state.find.matches.length) return;
    const m = state.find.matches[state.find.idx];
    const text = t.textarea.value;
    t.textarea.value = text.substring(0, m.start) + repl + text.substring(m.end);
    t.textarea.setSelectionRange(m.start, m.start + repl.length);
    onEditorInput(t);
    runFind();
    toast("Replaced 1", "check");
  }
  function replaceAll() {
    const t = currentTab();
    if (!t) return;
    const term = $("#find-input").value || "";
    const repl = $("#replace-input").value || "";
    if (!term) return;
    const flags = $("#find-case").checked ? "g" : "gi";
    const pattern = $("#find-word").checked
      ? "\\b" + escapeRegex(term) + "\\b"
      : escapeRegex(term);
    let regex;
    try { regex = new RegExp(pattern, flags); }
    catch (e) { return; }
    const count = (t.textarea.value.match(regex) || []).length;
    t.textarea.value = t.textarea.value.replace(regex, repl);
    onEditorInput(t);
    runFind();
    toast("Replaced " + count, "done_all");
  }

  // ----------------------------------------------------------- Auto-save
  function scheduleSave(tab) {
    if (state.pendingSave) clearTimeout(state.pendingSave);
    state.pendingSave = setTimeout(() => flushSave(tab), SAVE_DEBOUNCE_MS);
    setStatusSaving();
  }

  async function flushSave(tab) {
    if (!hasApi()) return;
    if (state.pendingSave) { clearTimeout(state.pendingSave); state.pendingSave = null; }
    try {
      const out = await pycall("save_note", tab.name, tab.content);
      if (out && out.ok) {
        tab.dirty = false;
        tab.mtime = out.mtime;
        renderTabBar();
        setStatusSaved(new Date());
        refreshRecent();
        refreshStats();
      } else { setStatusError(); }
    } catch (e) { setStatusError(); }
  }

  function setStatusSaving() {
    const el = $("#status-saved");
    if (!el) return;
    el.classList.add("saving");
    const ic = el.querySelector(".material-symbols-outlined");
    if (ic) ic.textContent = "cloud_sync";
    const t = $("#status-saved-text");
    if (t) t.textContent = "Saving";
  }
  function setStatusSaved(when) {
    const el = $("#status-saved");
    if (!el) return;
    el.classList.remove("saving");
    const ic = el.querySelector(".material-symbols-outlined");
    if (ic) ic.textContent = "cloud_done";
    const t = $("#status-saved-text");
    if (!t) return;
    const sec = Math.max(0, Math.round((Date.now() - when.getTime()) / 1000));
    t.textContent = sec === 0 ? "All changes saved" : ("Saved " + sec + "s ago");
    clearTimeout(el._t);
    el._t = setTimeout(() => setStatusSaved(when), 5000);
  }
  function setStatusError() {
    const el = $("#status-saved");
    if (!el) return;
    el.classList.remove("saving");
    const ic = el.querySelector(".material-symbols-outlined");
    if (ic) ic.textContent = "cloud_off";
    const t = $("#status-saved-text");
    if (t) t.textContent = "Save failed";
  }

  function updateStatus(tab) {
    if (!tab || !tab.textarea) return;
    const v = tab.textarea.value;
    const words = (v.match(/\S+/g) || []).length;
    const c = $("#status-count");
    if (c) c.textContent = words + " words / " + v.length + " chars";
  }

  // ----------------------------------------------------------- Recent / Pinned / Stats
  async function refreshRecent() {
    if (!hasApi()) { renderRecentList([], "recent-list"); return; }
    try {
      const r = await pycall("list_notes");
      const cfgRec = (state.config && state.config.recent) || [];
      const recent = cfgRec.length ? cfgRec : (r.files || []).map((f) => f.name);
      renderRecentList(recent, "recent-list");
    } catch (e) { renderRecentList([], "recent-list"); }
  }
  function refreshPinned() {
    const pinned = (state.config && state.config.pinned) || [];
    renderRecentList(pinned, "pinned-list", "push_pin");
    if (pinned.length === 0) {
      const ul = $("#pinned-list");
      if (ul) {
        ul.innerHTML = '<li class="side-empty">No pinned notes yet</li>';
      }
    }
  }
  function renderRecentList(names, ulId, pinIcon) {
    const sb = $("#" + ulId);
    if (!sb) return;
    sb.innerHTML = "";
    names.forEach((name) => {
      const li = document.createElement("li");
      li.dataset.openFile = name;
      const main = document.createElement("span");
      main.className = "material-symbols-outlined";
      main.textContent = pinIcon ? "description" : "description";
      const lbl = document.createElement("span");
      lbl.textContent = name;
      li.append(main, lbl);
      if (pinIcon) {
        const pi = document.createElement("span");
        pi.className = "material-symbols-outlined pin-ico";
        pi.textContent = pinIcon;
        li.append(pi);
      }
      sb.appendChild(li);
    });
  }

  async function refreshStats() {
    const stats = (state.config && state.config.stats) || {};
    setStat("stat-streak", stats.streak || 0);
    setStat("stat-minutes", stats.minutes_today || 0);
    setStat("stat-words", (stats.total_words || 0).toLocaleString());
    if (!hasApi()) {
      renderStreakBars(buildFallbackSeries());
      setStreakFoot((stats.streak || 0) + " day streak - keep it going!");
      return;
    }
    try {
      const r = await pycall("get_stats");
      const s = (r && r.stats) || stats;
      setStat("stat-streak", s.streak || 0);
      setStat("stat-minutes", s.minutes_today || 0);
      setStat("stat-words", (s.total_words || 0).toLocaleString());
      renderStreakBars((r && r.series) || buildFallbackSeries());
      setStreakFoot((s.streak || 0) + " day streak - keep it going!");
    } catch (e) {
      renderStreakBars(buildFallbackSeries());
      setStreakFoot("Stats unavailable");
    }
  }
  function setStat(id, value) { const el = $("#" + id); if (el) el.textContent = value; }
  function setStreakFoot(text) { const el = $("#streak-foot"); if (el) el.textContent = text; }
  function buildFallbackSeries() {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      out.push({ date: d.toISOString().slice(0, 10), label: days[d.getDay()], count: 0 });
    }
    return out;
  }
  function renderStreakBars(series) {
    const bars = $("#streak-bars");
    if (!bars) return;
    bars.innerHTML = "";
    const next = bars.nextElementSibling;
    if (next && next.classList && next.classList.contains("streak-bars-labels")) next.remove();
    const labels = [];
    series.forEach((s) => {
      const b = document.createElement("div");
      b.className = "bar" + (s.count ? " has" : "") +
        (s.date === todayISO() ? " today" : "");
      const h = Math.max(6, Math.min(80, 6 + s.count * 18));
      b.style.height = h + "px";
      b.title = s.date + " - " + s.count + " edit" + (s.count === 1 ? "" : "s");
      bars.appendChild(b);
      labels.push(s.label);
    });
    const lab = document.createElement("div");
    lab.className = "streak-bars-labels";
    lab.innerHTML = labels.map((l) => "<span>" + l + "</span>").join("");
    if (bars.parentNode) {
      bars.parentNode.insertBefore(lab, bars.nextSibling);
    }
  }
  function todayISO() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + dd;
  }

  // ----------------------------------------------------------- Home
  function toggleHome(force) {
    const show = force === true ? true : force === false ? false : !state.homeVisible;
    state.homeVisible = show;
    $("#home-screen").classList.toggle("hidden", !show);
    if (show) {
      $$(".editor").forEach((e) => e.classList.add("hidden"));
      state.tabs.forEach((t) => {
        if (t.todoEl) t.todoEl.classList.add("hidden");
        if (t.previewEl) t.previewEl.classList.add("hidden");
      });
      $("#empty-editor").classList.add("hidden");
      refreshStats();
      refreshRecent();
      refreshPinned();
      state.activeTab = null;
      renderTabBar();
    } else if (state.activeTab) {
      activateTab(state.activeTab);
    } else {
      updateHideEmptyEditor();
    }
  }

  // ----------------------------------------------------------- Settings
  function openSettings() {
    const m = $("#settings-modal");
    m.classList.remove("hidden");
    $("#set-theme").value = state.config.theme || "midnight";
    $("#set-fontsize").value = state.config.font_size || 14;
    $("#set-lineno").checked = state.config.show_line_numbers !== false;
    $("#set-wrap").checked = !!state.config.word_wrap;
    $("#set-startup").checked = !!state.config.startup;
    $("#set-tray").checked = state.config.minimize_to_tray !== false;
    $("#set-hotkey").value = state.config.global_hotkey || "";
    $("#set-pin-scope").value = state.config.pin_scope || "app";
    $("#set-context").checked = !!state.config.explorer_context_menu;
    $("#set-preview-default").checked = !!state.config.preview_default;
    $("#set-pin").value = "";
  }
  function closeSettings() { $("#settings-modal").classList.add("hidden"); }
  async function saveSettings() {
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    const patch = {
      theme: $("#set-theme").value,
      font_size: parseInt($("#set-fontsize").value, 10) || 14,
      show_line_numbers: $("#set-lineno").checked,
      word_wrap: $("#set-wrap").checked,
      startup: $("#set-startup").checked,
      minimize_to_tray: $("#set-tray").checked,
      global_hotkey: $("#set-hotkey").value.trim() || "ctrl+alt+j",
      pin_scope: $("#set-pin-scope").value,
      explorer_context_menu: $("#set-context").checked,
      preview_default: $("#set-preview-default").checked,
    };
    const pin = $("#set-pin").value;
    if (pin && pin.length >= 3) {
      try {
        const r = await pycall("set_app_pin", pin);
        if (!r.ok) { toast(r.error || "PIN not set", "error"); return; }
      } catch (e) { toast("PIN failed: " + e.message, "error"); return; }
    }
    try {
      await pycall("update_settings", patch);
      state.config = Object.assign({}, state.config, patch);
      applyTheme(state.config.theme);
      state.tabs.forEach((t) => {
        if (!t.el) return;
        t.el.style.setProperty("--font-size", state.config.font_size + "px");
        t.el.dataset.wrap = state.config.word_wrap ? "true" : "false";
        t.textarea.wrap = state.config.word_wrap ? "soft" : "off";
        if (t.gutter) t.gutter.style.display = state.config.show_line_numbers ? "" : "none";
        syncHighlight(t);
      });
      closeSettings();
      toast("Settings saved", "check_circle");
    } catch (e) { toast("Save failed: " + e.message, "error"); }
  }

  // ----------------------------------------------------------- Pin / unpin
  async function togglePin(name) {
    if (!state.config) state.config = {};
    const arr = state.config.pinned = state.config.pinned || [];
    const idx = arr.indexOf(name);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(name);
    if (hasApi()) {
      try { await pycall("update_settings", { pinned: arr }); }
      catch (e) { toast("Could not save pin: " + e.message, "error"); }
    }
    refreshPinned();
    toast(idx >= 0 ? "Unpinned " + name : "Pinned " + name, "push_pin");
  }
  function isPinned(name) {
    return state.config && state.config.pinned && state.config.pinned.includes(name);
  }

  // ----------------------------------------------------------- Theme cycle
  const THEMES = ["midnight", "graphite", "dusk", "paper", "solar"];
  function cycleTheme() {
    const cur = state.config && state.config.theme;
    const idx = THEMES.indexOf(cur);
    const next = THEMES[(idx + 1) % THEMES.length];
    state.config = state.config || {};
    state.config.theme = next;
    applyTheme(next);
    if (hasApi()) {
      pycall("update_settings", { theme: next }).catch(() => {});
    }
    toast("Theme: " + next, "contrast");
  }

  // ----------------------------------------------------------- Context menu
  let ctxTarget = null;
  function showContextMenu(x, y, name) {
    ctxTarget = name;
    const m = $("#ctx-menu");
    m.style.left = Math.min(x, window.innerWidth - 220) + "px";
    m.style.top = Math.min(y, window.innerHeight - 240) + "px";
    m.classList.remove("hidden");
    const pinLbl = m.querySelector(".ctx-pin-label");
    if (pinLbl) pinLbl.textContent = isPinned(name) ? "Unpin from sidebar" : "Pin to sidebar";
  }
  function hideContextMenu() {
    $("#ctx-menu").classList.add("hidden");
    ctxTarget = null;
  }
  async function onContextMenuClick(e) {
    const btn = e.target.closest("button");
    if (!btn || !ctxTarget) return;
    const act = btn.dataset.act;
    const name = ctxTarget;
    hideContextMenu();
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    try {
      if (act === "open") openTab(name);
      else if (act === "pin") togglePin(name);
      else if (act === "reveal") await pycall("reveal_in_explorer", name);
      else if (act === "setpin") {
        const pin = prompt("Set a per-file PIN for " + name + " (leave empty to clear):");
        if (pin === null) return;
        const tab = state.tabs.find((t) => t.name === name);
        if (tab) {
          if (pin) {
            tab.textarea.value = "<!-- pin:" + btoa(pin) + " -->\n" +
              tab.textarea.value.replace(/^<!-- pin:[^>]*-->\n?/, "");
          } else {
            tab.textarea.value = tab.textarea.value.replace(/^<!-- pin:[^>]*-->\n?/, "");
          }
          onEditorInput(tab);
          flushSave(tab);
        }
        toast(pin ? "PIN set on " + name : "PIN cleared", "lock");
      }
      else if (act === "rename") {
        const nn = prompt("Rename to:", name);
        if (!nn || nn === name) return;
        const t = state.tabs.find((x) => x.name === name);
        if (t) {
          await pycall("save_note", nn, t.content);
          await pycall("delete_note", name);
          closeTab(name);
          await openTab(nn);
        }
      }
      else if (act === "delete") {
        if (!confirm("Delete " + name + "?")) return;
        await pycall("delete_note", name);
        closeTab(name);
        refreshRecent();
      }
    } catch (e) { toast("Action failed: " + e.message, "error"); }
  }

  // ----------------------------------------------------------- Drag and drop
  async function onDrop(e) {
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    e.preventDefault();
    const ed = e.target.closest(".editor");
    if (ed) ed.classList.remove("dragover");
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    for (const f of Array.from(dt.files)) {
      const text = await f.text().catch(() => null);
      if (text === null) continue;
      let name = f.name;
      if (!/\.(md|txt|jot)$/i.test(name)) name += ".md";
      try {
        const out = await pycall("save_note", name, text);
        if (out && out.ok) {
          await openTab(name);
          toast("Imported " + name, "file_download");
        }
      } catch (err) {
        toast("Import failed: " + err.message, "error");
      }
    }
  }

  // ----------------------------------------------------------- Global keys
  function onGlobalKey(e) {
    if (state.locked) return;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key === "Tab") {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }

    if (ctrl && e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === "v") { e.preventDefault(); togglePreview(); return; }
      if (k === "p") { e.preventDefault(); cycleTheme(); return; }
      if (k === "l") {
        e.preventDefault();
        if (state.config && state.config.app_pin_hash) showPin();
        else toast("No PIN set", "info");
        return;
      }
      if (k === "f") { e.preventDefault(); openFind(); return; }
    }

    if (ctrl && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "n") { e.preventDefault(); newNote(); return; }
      if (k === "t") { e.preventDefault(); newTodo(); return; }
      if (k === "o") { e.preventDefault(); openExternal(); return; }
      if (k === "s") {
        e.preventDefault();
        const tab = currentTab();
        if (tab) flushSave(tab);
        return;
      }
      if (k === "w") {
        e.preventDefault();
        if (state.activeTab) closeTab(state.activeTab);
        return;
      }
      if (k === "p") {
        e.preventDefault();
        openSettings();
        return;
      }
      if (k === "f") {
        e.preventDefault();
        openFind();
        return;
      }
    }

    if (e.key === "Escape") {
      if (state.find.open) closeFind();
    }
  }

  function currentTab() {
    return state.tabs.find((t) => t.name === state.activeTab);
  }
  function cycleTab(dir) {
    if (!state.tabs.length) return;
    let i = state.tabs.findIndex((t) => t.name === state.activeTab);
    if (i < 0) i = 0;
    else i = (i + dir + state.tabs.length) % state.tabs.length;
    activateTab(state.tabs[i].name);
  }

  // ----------------------------------------------------------- Toast
  function toast(msg, icon) {
    const el = $("#toast");
    if (!el) return;
    el.innerHTML = '<span class="material-symbols-outlined">' +
      (icon || "info") + '</span><span>' + escapeHtml(msg) + "</span>";
    el.classList.remove("hidden");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add("hidden"), 2200);
  }
})();
