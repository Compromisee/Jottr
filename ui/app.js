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
      accent_color: "#7c5cff",
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
    // The data-theme attribute goes on the <html> element. CSS rules
    // like [data-theme="paper"] then match html, so every descendant
    // picks up that theme's CSS custom properties via inheritance.
    // CRITICAL: we removed data-theme from <body> in the HTML so the
    // body cannot "win" with its own stale theme.
    document.documentElement.dataset.theme = theme || "midnight";

    // Accent colors come in two flavors:
    //   1. THEME DEFAULT  - the [data-theme="..."] CSS rule defines
    //      --accent. We clear any inline override so the theme wins.
    //   2. CUSTOM ACCENT   - the user picked a color in Settings and
    //      we set it inline on <html> so it cascades to every child.
    // The "use_custom_accent" flag in config decides which path we
    // take. Default is FALSE so a fresh install uses the theme accent.
    const cfg = state.config || {};
    const themeDefaults = {
      midnight: "#7c5cff",
      graphite: "#5cc8ff",
      dusk:     "#ff8a5c",
      paper:    "#5a4ad1",
      solar:    "#cb4b16",
    };
    const themeDefault = (themeDefaults[theme || "midnight"]
                          || "#7c5cff").toLowerCase();
    const customAccent = (cfg.accent_color || "").trim().toLowerCase();
    const useCustom = cfg.accent_color_use === true
                      && !!customAccent
                      && customAccent !== themeDefault;
    // Always clear inline accent first so the CSS rule can re-assert
    // itself, then re-apply the custom one if needed.
    const root = document.documentElement;
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-2");
    root.style.removeProperty("--accent-soft");
    if (useCustom) {
      applyAccentColor(cfg.accent_color);
    }
  }

  // Convert "#rrggbb" -> "rgba(r,g,b,a)" and lighten helper.
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function withAlpha(hex, a) {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")";
  }
  function lighten(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const mix = rgb.map((c) => Math.min(255, Math.round(c + (255 - c) * amount)));
    return "#" + mix.map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  function applyAccentColor(hex) {
    if (!hex || !hexToRgb(hex)) return;
    document.documentElement.style.setProperty("--accent", hex);
    document.documentElement.style.setProperty("--accent-2", lighten(hex, 0.25));
    const soft = withAlpha(hex, 0.18);
    if (soft) document.documentElement.style.setProperty("--accent-soft", soft);
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
    $("#btn-sidebar").addEventListener("click", toggleSidebar);

    // Sidebar quick actions
    $("#quick-new-note").addEventListener("click", (e) => { e.preventDefault(); newNote(); });
    $("#quick-new-todo").addEventListener("click", (e) => { e.preventDefault(); newTodo(); });
    $("#quick-open").addEventListener("click", (e) => { e.preventDefault(); openExternal(); });

    // Empty editor
    $("#empty-new-note").addEventListener("click", (e) => { e.preventDefault(); newNote(); });
    $("#empty-new-todo").addEventListener("click", (e) => { e.preventDefault(); newTodo(); });

    // Folder tree controls
    const folderAdd = $("#folder-add");
    if (folderAdd) {
      folderAdd.addEventListener("click", (e) => {
        e.preventDefault();
        const name = prompt("Folder name (you can use 'a/b/c' for nested):", "New folder");
        if (!name) return;
        createFolderInteractive(name);
      });
    }

    // Move-to-folder modal
    const moveClose = $("#move-close");
    if (moveClose) moveClose.addEventListener("click", closeMoveModal);
    const moveModal = $("#move-modal");
    if (moveModal) moveModal.addEventListener("click", (e) => {
      if (e.target.id === "move-modal") closeMoveModal();
    });

    // Folder context menu
    const ctxFolder = $("#ctx-folder");
    if (ctxFolder) {
      ctxFolder.addEventListener("click", onFolderContextMenuClick);
    }

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
      else if (a === "accent") {
        // cycle through accent presets
        const cur = state.config && state.config.accent_color;
        const idx = ACCENT_PRESETS.indexOf((cur || "").toLowerCase());
        const next = ACCENT_PRESETS[(idx + 1 + ACCENT_PRESETS.length) % ACCENT_PRESETS.length];
        state.config.accent_color = next;
        applyAccentColor(next);
        if (hasApi()) pycall("update_settings", { accent_color: next }).catch(() => {});
        toast("Accent: " + next, "palette");
      }
    });

    // Home search bar
    const homeSearch = $("#home-search");
    if (homeSearch) {
      homeSearch.addEventListener("input", (e) => runHomeSearch(e.target.value));
      homeSearch.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); homeSearch.value = ""; runHomeSearch(""); }
      });
    }
    const homeSearchClear = $("#home-search-clear");
    if (homeSearchClear) {
      homeSearchClear.addEventListener("click", () => {
        if (homeSearch) homeSearch.value = "";
        runHomeSearch("");
        if (homeSearch) homeSearch.focus();
      });
    }

    // Accent color picker live preview
    const accentPicker = $("#set-accent");
    if (accentPicker) {
      accentPicker.addEventListener("input", (e) => {
        // Picking a color in the picker implies the user wants to
        // override the theme accent. Auto-check the override toggle
        // so what they see in the live preview is what gets saved.
        const cb = $("#set-accent-custom");
        if (cb) cb.checked = true;
        applyAccentColor(e.target.value);
      });
    }
    const accentPreset = $("#set-accent-preset");
    if (accentPreset) {
      accentPreset.addEventListener("change", (e) => {
        if (!e.target.value) return;
        $("#set-accent").value = e.target.value;
        applyAccentColor(e.target.value);
      });
    }

    // Hotkey dropdown - show custom input when "Custom..." is chosen
    const hotkeySel = $("#set-hotkey");
    if (hotkeySel) {
      hotkeySel.addEventListener("change", () => {
        const ci = $("#set-hotkey-custom");
        if (ci) ci.style.display = (hotkeySel.value === "__custom__") ? "" : "none";
      });
    }

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
      if (!e.target.closest("#ctx-folder")) hideFolderContextMenu();
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

  // Play the wrong/correct PIN feedback animation on the pin-card.
  function pinShake() {
    const card = $(".pin-card");
    if (!card) return;
    card.classList.remove("shake", "flash-good");
    // Force reflow so the animation restarts on rapid retries.
    void card.offsetWidth;
    card.classList.add("shake");
    setTimeout(() => card.classList.remove("shake"), 420);
  }
  function pinPulseGood() {
    const card = $(".pin-card");
    if (!card) return;
    card.classList.remove("shake", "flash-good");
    void card.offsetWidth;
    card.classList.add("flash-good");
    setTimeout(() => card.classList.remove("flash-good"), 640);
  }

  async function tryUnlock() {
    const pin = $("#pin-input").value;
    if (!hasApi()) { $("#pin-error").textContent = "Backend not ready"; return; }
    try {
      const out = await pycall("verify_app_pin", pin);
      if (out.ok) {
        pinPulseGood();
        setTimeout(() => { hidePin(); enterApp(); }, 220);
      } else {
        pinShake();
        $("#pin-error").textContent = "Wrong PIN";
        $("#pin-input").select();
      }
    } catch (e) {
      pinShake();
      $("#pin-error").textContent = "Unlock failed";
    }
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
    refreshFolderTree();
    refreshStats();
    // Restore sidebar visibility from config (animates on boot).
    if (state.config && state.config.sidebar_hidden) {
      document.body.classList.add("sidebar-hidden");
    }
    if (state.config && state.config.show_home && state.tabs.length === 0) {
      toggleHome(true);
    } else {
      updateHideEmptyEditor();
    }
    initCollapsibles();
    refreshPluginsList();
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
    if (add) {
      e.preventDefault();
      // Clicking the + icon opens the dashboard so the user can
      // see their options, then creates a fresh note inside it.
      toggleHome(true);
      newNote();
      return;
    }
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

  // ----------------------------------------------------------- Folders
  const state_folders = { tree: [], collapsed: {}, current: "" };

  async function refreshFolderTree() {
    if (!hasApi()) {
      $("#folder-tree").innerHTML = '<div class="side-empty">Backend not ready</div>';
      return;
    }
    try {
      const r = await pycall("list_tree");
      if (!r.ok) return;
      state_folders.tree = r.tree || [];
      renderFolderTree();
    } catch (e) {
      $("#folder-tree").innerHTML = '<div class="side-empty">Failed to load</div>';
    }
  }

  function renderFolderTree() {
    const root = $("#folder-tree");
    if (!root) return;
    root.innerHTML = "";
    if (!state_folders.tree.length) {
      root.innerHTML = '<div class="side-empty">No notes yet</div>';
      return;
    }
    const ul = document.createElement("ul");
    state_folders.tree.forEach((node) => {
      ul.appendChild(renderTreeNode(node, 0));
    });
    root.appendChild(ul);
    attachDragHandlers();
  }

  function renderTreeNode(node, depth) {
    const li = document.createElement("li");
    if (node.kind === "folder") {
      const row = document.createElement("div");
      row.className = "folder-row";
      row.dataset.folder = node.name || "";
      const collapsed = !!state_folders.collapsed[node.name];
      if (collapsed) row.classList.add("collapsed");
      if (state_folders.current === node.name) row.classList.add("selected");
      const chev = document.createElement("span");
      chev.className = "chev material-symbols-outlined";
      chev.textContent = "expand_more";
      const ico = document.createElement("span");
      ico.className = "material-symbols-outlined folder-ico";
      ico.textContent = collapsed ? "folder" : "folder_open";
      ico.style.color = tagColorFor(node.name, "folder");
      const lbl = document.createElement("span");
      lbl.className = "label";
      lbl.textContent = basename(node.name) || "(root)";
      row.append(chev, ico, lbl);
      row.addEventListener("click", (e) => {
        if (e.altKey) {
          state_folders.current = node.name;
          renderFolderTree();
          toast("New notes will go to: " + (node.name || "root"), "folder");
          return;
        }
        if (collapsed) delete state_folders.collapsed[node.name];
        else state_folders.collapsed[node.name] = true;
        renderFolderTree();
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showFolderContextMenu(e.clientX, e.clientY, node.name);
      });
      li.appendChild(row);

      const children = document.createElement("div");
      children.className = "tree-children";
      if (!collapsed && node.children && node.children.length) {
        const cul = document.createElement("ul");
        node.children.forEach((c) => cul.appendChild(renderTreeNode(c, depth + 1)));
        children.appendChild(cul);
      } else if (!node.children || !node.children.length) {
        const empty = document.createElement("div");
        empty.className = "side-empty";
        empty.style.padding = "2px 10px";
        empty.textContent = "Empty";
        children.appendChild(empty);
      }
      li.appendChild(children);
    } else {
      const row = document.createElement("div");
      row.className = "tree-file";
      row.dataset.openFile = node.name;
      row.draggable = true;
      if (state.activeTab === node.name) row.classList.add("is-active");
      // No visible drag handle - the whole row is draggable, and the
      // drag_indicator chev only shows while a drag is in flight.
      const chev = document.createElement("span");
      chev.className = "chev material-symbols-outlined drag-handle";
      chev.textContent = "drag_indicator";
      const ico = document.createElement("span");
      ico.className = "material-symbols-outlined file-ico";
      ico.textContent = "description";
      ico.style.color = tagColorFor(node.name, "note");
      const lbl = document.createElement("span");
      lbl.className = "label";
      lbl.textContent = basename(node.name);
      row.append(chev, ico, lbl);
      row.addEventListener("click", () => openTab(node.name));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, node.name);
      });
      li.appendChild(row);
    }
    return li;
  }

  function basename(fullName) {
    if (!fullName) return "";
    const s = String(fullName).replace(/\\/g, "/");
    const i = s.lastIndexOf("/");
    return i < 0 ? s : s.substring(i + 1);
  }

  async function newNote(name, folder) {
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    try {
      const target = folder != null ? folder : state_folders.current;
      const out = await pycall("new_note", name || null, "note", target || "");
      if (!out.ok) { toast("Could not create note: " + (out.error || ""), "error"); return; }
      if (out.extension_added) {
        toast("Saved as " + basename(out.name) + " (added .md)", "info");
      }
      await openTab(out.name);
      refreshFolderTree();
      refreshRecent();
    } catch (e) { toast("Create failed: " + e.message, "error"); }
  }
  async function newTodo(name, folder) {
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    try {
      const target = folder != null ? folder : state_folders.current;
      const out = await pycall("new_note", name || null, "todo", target || "");
      if (!out.ok) { toast("Could not create todo: " + (out.error || ""), "error"); return; }
      if (out.extension_added) {
        toast("Saved as " + basename(out.name) + " (added .md)", "info");
      }
      await openTab(out.name);
      refreshFolderTree();
      refreshRecent();
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

  // Track which PINs we've already verified in this session
  // so we don't re-prompt every time the user re-opens a tab.
  const unlocked = new Set();
  // Track in-flight openTab calls so double-clicks don't spawn two
  // of the same tab.
  const pendingOpens = new Set();
  // Normalize a note name so "Work/Ideas.md" and "work/ideas.md"
  // are treated as the same tab.
  function normalizeName(n) {
    return String(n || "").replace(/\\/g, "/").replace(/\/+$/, "");
  }

  async function openTab(name) {
    if (!hasApi()) return;
    const key = normalizeName(name);
    // Already open? Just activate and bail.
    if (state.tabs.find((t) => normalizeName(t.name) === key)) {
      activateTab(state.tabs.find((t) => normalizeName(t.name) === key).name);
      return;
    }
    // Already in-flight? Wait for it instead of opening a duplicate.
    if (pendingOpens.has(key)) return;
    pendingOpens.add(key);
    try {
      // PIN gate: if this file (or any parent folder) has a PIN,
      // ask for it before reading the file. PINs live in config.json.
      if (!unlocked.has(key) && !unlocked.has("__app__")) {
        try {
          const c = await pycall("check_pin", key, "");
          if (c && c.required) {
            const ok = await promptForPin(c.scope === "folder"
                ? "This folder is locked. Enter its PIN:"
                : "This file is locked. Enter its PIN:");
            if (!ok) { toast("Cancelled - file not opened", "info"); return; }
            const v = await pycall("check_pin", key, ok);
            if (!v.ok) { toast("Wrong PIN", "error"); return; }
            unlocked.add(key);
            toast("Unlocked " + (c.scope === "folder" ? "folder" : "file"), "lock_open");
          }
        } catch (e) { /* ignore */ }
      }
      // Filter folders out of "open as a tab". If the user clicks a
      // folder anywhere (recent list etc.) we just no-op.
      try {
        const tree = await pycall("list_tree");
        if (tree && tree.ok) {
          const isFolder = (tree.tree || []).some((n) =>
            n.kind === "folder" && n.name === key);
          if (isFolder) {
            toast("Folders can't be opened - click to expand", "folder");
            return;
          }
        }
      } catch (e) { /* ignore */ }

      const r = await pycall("read_note", key);
      const tab = {
        name: key,
        content: r.content || "",
        mtime: r.mtime || 0,
        dirty: false,
        el: null, textarea: null, highlight: null, gutter: null,
        todoEl: null, previewEl: null,
        todoMode: isTodoTrigger(r.content || ""),
      };
      state.tabs.push(tab);
      lastOpened = key;
      renderTabBar();
      renderEditor(tab);
      activateTab(key);
      refreshRecent();
      refreshPinned();
      refreshFolderTree();
    } catch (e) {
      toast("Read failed: " + e.message, "error");
    } finally {
      pendingOpens.delete(key);
    }
  }

  // Promise-based PIN prompt. Resolves to the entered PIN (string)
  // or null if the user cancelled.
  function promptForPin(message) {
    return new Promise((resolve) => {
      const ov = $("#pin-overlay");
      const input = $("#pin-input");
      const err = $("#pin-error");
      const unlock = $("#pin-unlock");
      $("#pin-overlay .pin-card h2").textContent = "Locked";
      $("#pin-overlay .pin-card p").textContent = message;
      ov.classList.remove("hidden");
      input.value = "";
      err.textContent = "";
      setTimeout(() => input.focus(), 30);
      const cleanup = () => {
        $("#pin-overlay .pin-card h2").textContent = "Jottr is locked";
        $("#pin-overlay .pin-card p").textContent = "Enter your PIN to continue";
        unlock.removeEventListener("click", onOk);
        input.removeEventListener("keydown", onKey);
      };
      const onOk = () => {
        const v = input.value;
        cleanup();
        ov.classList.add("hidden");
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === "Enter") { e.preventDefault(); onOk(); }
        else if (e.key === "Escape") { e.preventDefault(); cleanup(); ov.classList.add("hidden"); resolve(null); }
      };
      unlock.addEventListener("click", onOk);
      input.addEventListener("keydown", onKey);
    });
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

  // Track the most-recently-opened tab so renderTabBar can give it
  // an "entering" class for one render cycle (drives the slide-in).
  let lastOpened = null;

  function renderTabBar() {
    const bar = $("#tabbar");
    bar.innerHTML = "";
    state.tabs.forEach((t) => {
      const el = document.createElement("div");
      const activeCls = t.name === state.activeTab ? " active" : "";
      const dirtyCls = t.dirty ? " dirty" : "";
      const enterCls = (t.name === lastOpened) ? " entering" : "";
      el.className = "tab" + activeCls + dirtyCls + enterCls;
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
      if (t.name === lastOpened) {
        // Remove the entering class after the animation so the tab
        // settles into the normal layout.
        setTimeout(() => el.classList.remove("entering"), 360);
        lastOpened = null;
      }
    });
    const add = document.createElement("div");
    add.className = "tab-add";
    add.title = "New note / open dashboard (Ctrl+N)";
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

  // ----------------------------------------------------------- Animated counters
  // Renders an integer into `el` and tweens from the previously
  // shown value to `target` using an easeOutQuart curve so the
  // animation slows down at the end (each digit appears to roll
  // into place).
  function tweenNumber(el, target, duration) {
    if (!el) return;
    const targetN = Number(target) || 0;
    const prev = parseInt(el.dataset.rolling || "0", 10) || 0;
    if (prev === targetN) {
      el.textContent = targetN.toLocaleString();
      return;
    }
    if (el._rollingRaf) cancelAnimationFrame(el._rollingRaf);
    const dur = duration || Math.max(420, Math.min(1100, Math.abs(targetN - prev) * 18));
    // Subtle bounce when the value lands.
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / dur);
      // Ease out quart - strong slow-down at the end.
      const eased = 1 - Math.pow(1 - t, 4);
      const v = Math.round(prev + (targetN - prev) * eased);
      el.textContent = v.toLocaleString();
      if (t < 1) {
        el._rollingRaf = requestAnimationFrame(step);
      } else {
        el.textContent = targetN.toLocaleString();
        el.dataset.rolling = String(targetN);
        el._rollingRaf = null;
      }
    }
    el.dataset.rolling = String(prev);  // mark "in flight" from prev
    el._rollingRaf = requestAnimationFrame(step);
  }

  // Detect whether a string looks like a URL.
  function looksLikeUrl(s) {
    return /^(https?:\/\/|www\.)/i.test(String(s || "").trim());
  }

  // Extract a short display name from a URL: last path segment,
  // stripped of trailing slashes / .html / common file extensions.
  function urlDisplayName(url) {
    let s = String(url || "").trim();
    try {
      const u = new URL(s);
      let path = u.pathname.replace(/\/+$/, "");
      const parts = path.split("/").filter(Boolean);
      let last = parts[parts.length - 1] || u.hostname || s;
      last = last.replace(/\.(html?|php|aspx?|jsp)$/i, "");
      return decodeURIComponent(last) || u.hostname;
    } catch (e) {
      s = s.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      const parts = s.split("/").filter(Boolean);
      return parts[parts.length - 1] || s;
    }
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
      r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
        // Smart links: if the link text is itself a URL, only show
        // the "name" part in the editor. Keep full URL as a tooltip
        // so the user can hover to see the target.
        if (looksLikeUrl(text)) {
          const disp = escapeHtml(urlDisplayName(text));
          return '<span class="h-tag" title="' + escapeHtml(text) +
                 '">[' + disp + ']</span>' +
                 '<span class="h-com">(' + escapeHtml(url) + ')</span>';
        }
        return '<span class="h-tag">[' + text + ']</span>' +
               '<span class="h-com">(' + escapeHtml(url) + ')</span>';
      });
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
    tab.previewEl.innerHTML = "";
    if (tab.todoMode) {
      renderPreviewTodoListDOM(tab, content, tab.previewEl);
    } else {
      tab.previewEl.innerHTML = renderPreviewMarkdown(content);
    }
  }

  // Render the todo checklist as interactive DOM elements (not HTML
  // strings) so the user can click the checkbox straight from preview
  // mode. State changes write back to tab.content and re-render.
  function renderPreviewTodoListDOM(tab, text, container) {
    const lines = text.split("\n");
    let startIdx = 0;
    while (startIdx < lines.length && lines[startIdx].trim() === "") startIdx++;
    if (lines[startIdx] && lines[startIdx].trim() === TODO_TRIGGER) startIdx++;
    if (lines[startIdx] && lines[startIdx].trim() === "") startIdx++;

    const items = [];
    for (let i = startIdx; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s\[( |x|X)\]\s?(.*)$/);
      if (m) items.push({ done: m[1].toLowerCase() === "x", text: m[2] });
    }

    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No items yet.";
      container.appendChild(empty);
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "preview-todo-list";
    items.forEach((it, idx) => {
      const li = document.createElement("li");
      li.className = it.done ? "done" : "";

      const box = document.createElement("span");
      box.className = "todo-box";
      box.setAttribute("role", "checkbox");
      box.setAttribute("aria-checked", it.done ? "true" : "false");
      box.tabIndex = 0;
      const onToggle = (e) => {
        e.preventDefault();
        // Animate the box ticking on/off so the action has weight.
        li.classList.remove("flash-tick");
        void li.offsetWidth;
        li.classList.add("flash-tick");
        toggleTodo(tab, idx);
        flushSave(tab).catch(() => {});
        renderPreview(tab);
      };
      box.addEventListener("click", onToggle);
      box.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") onToggle(e);
      });

      const txt = document.createElement("span");
      txt.className = "todo-text";
      txt.textContent = it.text || "";

      li.append(box, txt);
      ul.appendChild(li);
    });
    container.appendChild(ul);
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
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
      const safeUrl = escapeHtml(url);
      // Smart links: if the link text is itself a URL, display only
      // the "name" part (last URL path segment) with the full URL as
      // a tooltip. The link itself still navigates to `url` (the
      // destination in parentheses). A small glyph hints that there
      // is a URL.
      if (looksLikeUrl(text)) {
        const disp = escapeHtml(urlDisplayName(text));
        const tooltip = escapeHtml(text);
        return '<a class="smart-link" href="' + safeUrl +
               '" data-url="' + safeUrl + '" target="_blank" rel="noopener" ' +
               'title="' + tooltip + '">' + disp +
               '<span class="link-glyph material-symbols-outlined">link</span></a>';
      }
      return '<a class="smart-link" href="' + safeUrl + '" target="_blank" ' +
             'rel="noopener" title="' + safeUrl + '">' + text +
             '<span class="link-glyph material-symbols-outlined">link</span></a>';
    });
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
        // Backend may have appended .md if our stored name lacked it.
        if (out.name && out.name !== tab.name) {
          tab.name = out.name;
          tab.dirty = false;
          tab.mtime = out.mtime;
          renderTabBar();
          if (out.extension_added) {
            toast("Saved as " + basename(out.name) + " (added .md)", "info");
          }
        } else {
          tab.dirty = false;
          tab.mtime = out.mtime;
          renderTabBar();
        }
        setStatusSaved(new Date());
        refreshRecent();
        refreshFolderTree();
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
    if (!c) return;
    // Compose the status text. Animate the WORDS portion only when
    // it actually changes - char count jumps are usually 1 at a time.
    const curWords = parseInt(c.dataset.words || "0", 10) || 0;
    const curChars = parseInt(c.dataset.chars || "0", 10) || 0;
    if (curWords === words && curChars === v.length) return;
    c.dataset.words = String(words);
    c.dataset.chars = String(v.length);
    // Roll up the words number only; leave chars alone (they tick 1-by-1).
    const oldHTML = c.innerHTML;
    c.innerHTML = "";
    const wordsSpan = document.createElement("span");
    wordsSpan.id = "status-words";
    wordsSpan.textContent = words.toLocaleString();
    c.appendChild(wordsSpan);
    c.appendChild(document.createTextNode(" words / "));
    const charsSpan = document.createElement("span");
    charsSpan.id = "status-chars";
    charsSpan.textContent = v.length.toLocaleString();
    c.appendChild(charsSpan);
    c.appendChild(document.createTextNode(" chars"));
    // Roll up just the words number.
    if (curWords !== words) {
      tweenNumber(wordsSpan, words, 480);
    } else {
      wordsSpan.textContent = words.toLocaleString();
    }
    charsSpan.textContent = v.length.toLocaleString();
  }

  // ----------------------------------------------------------- Recent / Pinned / Stats
  async function refreshRecent() {
    if (!hasApi()) { renderRecentList([], "recent-list"); return; }
    try {
      const r = await pycall("list_notes");
      const cfgRec = (state.config && state.config.recent) || [];
      // Filter to actual files (no folders) - Jottr shouldn't try to
      // open folders as tabs.
      const fileSet = new Set((r.files || []).map((f) => f.name));
      let recent = cfgRec.filter((n) => fileSet.has(n));
      if (!recent.length) recent = (r.files || []).map((f) => f.name).slice(0, 8);
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
      main.textContent = "description";
      main.style.color = tagColorFor(name, "note");
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
  function setStat(id, value) {
    const el = $("#" + id);
    if (!el) return;
    // Roll-up animation for stats. textContent of `value` could already
    // include thousands separators; we coerce to number for the tween.
    const n = Number(String(value).replace(/,/g, "")) || 0;
    tweenNumber(el, n);
  }
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

  // ----------------------------------------------------------- Sidebar toggle
  function toggleSidebar() {
    const hidden = document.body.classList.toggle("sidebar-hidden");
    // Persist preference
    if (state.config) {
      state.config.sidebar_hidden = hidden;
      if (hasApi()) {
        pycall("update_settings", { sidebar_hidden: hidden }).catch(() => {});
      }
    }
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
    $("#set-accent").value = state.config.accent_color || "#7c5cff";
    $("#set-accent-preset").value = "";
    // The override toggle is ON when the user explicitly opted into a
    // custom accent (config.accent_color_use === true).
    const ac = $("#set-accent-custom");
    if (ac) ac.checked = state.config.accent_color_use === true;
    $("#set-fontsize").value = state.config.font_size || 14;
    $("#set-lineno").checked = state.config.show_line_numbers !== false;
    $("#set-wrap").checked = !!state.config.word_wrap;
    $("#set-startup").checked = !!state.config.startup;
    $("#set-tray").checked = state.config.minimize_to_tray !== false;
    populateHotkeyDropdown(state.config.global_hotkey || "ctrl+alt+j");
    $("#set-pin-scope").value = state.config.pin_scope || "app";
    $("#set-context").checked = !!state.config.explorer_context_menu;
    $("#set-preview-default").checked = !!state.config.preview_default;
    $("#set-pin").value = "";
    refreshPluginsList();
  }
  function closeSettings() { $("#settings-modal").classList.add("hidden"); }

  // ----- Hotkey dropdown helpers -----
  // Common presets the user can pick from. The dropdown value is the
  // raw hotkey string accepted by the `keyboard` Python library.
  const HOTKEY_PRESETS = [
    { value: "ctrl+alt+j",     label: "Ctrl + Alt + J" },
    { value: "ctrl+alt+n",     label: "Ctrl + Alt + N" },
    { value: "ctrl+alt+t",     label: "Ctrl + Alt + T" },
    { value: "ctrl+shift+j",   label: "Ctrl + Shift + J" },
    { value: "ctrl+shift+space", label: "Ctrl + Shift + Space" },
    { value: "ctrl+shift+y",   label: "Ctrl + Shift + Y" },
    { value: "alt+space",      label: "Alt + Space" },
    { value: "alt+z",          label: "Alt + Z" },
    { value: "win+j",          label: "Win + J" },
    { value: "f8",             label: "F8" },
  ];
  function populateHotkeyDropdown(current) {
    const sel = $("#set-hotkey");
    if (!sel) return;
    const known = HOTKEY_PRESETS.find((p) => p.value === current);
    sel.innerHTML = "";
    HOTKEY_PRESETS.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.value;
      o.textContent = p.label;
      sel.appendChild(o);
    });
    // Custom option
    const custom = document.createElement("option");
    custom.value = "__custom__";
    custom.textContent = "Custom...";
    sel.appendChild(custom);
    if (known) sel.value = current;
    else { sel.value = "__custom__"; }
    // Reveal / hide custom input.
    const customInput = $("#set-hotkey-custom");
    if (customInput) {
      customInput.style.display = (sel.value === "__custom__") ? "" : "none";
      customInput.value = known ? "" : current;
    }
  }
  function readHotkeyValue() {
    const sel = $("#set-hotkey");
    if (!sel) return "ctrl+alt+j";
    if (sel.value === "__custom__") {
      const v = ($("#set-hotkey-custom").value || "").trim();
      return v || "ctrl+alt+j";
    }
    return sel.value || "ctrl+alt+j";
  }
  async function saveSettings() {
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    const accent = $("#set-accent").value.trim();
    const useCustom = !!$("#set-accent-custom") && $("#set-accent-custom").checked;
    const themeDefaults = {
      midnight: "#7c5cff", graphite: "#5cc8ff", dusk: "#ff8a5c",
      paper:    "#5a4ad1", solar:   "#cb4b16",
    };
    const themeNow = $("#set-theme").value || "midnight";
    const themeDefault = (themeDefaults[themeNow] || "#7c5cff").toLowerCase();
    const accentClean = /^#?[0-9a-f]{6}$/i.test(accent) ?
      (accent.startsWith("#") ? accent : "#" + accent) : "";
    const customDiffers = !!accentClean && accentClean.toLowerCase() !== themeDefault;
    // Only mark as "use custom" when the toggle is on AND the color
    // differs from the selected theme's default.
    const willUseCustom = useCustom && customDiffers;
    const patch = {
      theme: $("#set-theme").value,
      accent_color: accentClean || "",
      accent_color_use: willUseCustom,
      font_size: parseInt($("#set-fontsize").value, 10) || 14,
      show_line_numbers: $("#set-lineno").checked,
      word_wrap: $("#set-wrap").checked,
      startup: $("#set-startup").checked,
      minimize_to_tray: $("#set-tray").checked,
      global_hotkey: readHotkeyValue(),
      pin_scope: $("#set-pin-scope").value,
      explorer_context_menu: $("#set-context").checked,
      preview_default: $("#set-preview-default").checked,
    };
    // Drop undefined keys so backend doesn't overwrite with bad values.
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
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
      // applyTheme reads state.config to decide whether the custom
      // accent should override the theme accent.
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
  const ACCENT_PRESETS = [
    "#7c5cff", "#5cc8ff", "#58e1a8", "#ff8ad1", "#ffb86b",
    "#ff6363", "#cb4b16", "#e8a16c",
  ];
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

  // ----------------------------------------------------------- Search (home)
  const state_search = { term: "", results: [] };
  async function runHomeSearch(term) {
    state_search.term = term || "";
    const list = $("#home-search-results");
    if (!list) return;
    list.innerHTML = "";
    if (!state_search.term.trim()) {
      $("#home-search-wrap")?.classList.add("hidden");
      return;
    }
    $("#home-search-wrap")?.classList.remove("hidden");
    if (!hasApi()) {
      list.innerHTML = '<li class="hint" style="padding:10px 12px">Search needs the backend.</li>';
      return;
    }
    try {
      const r = await pycall("search_notes", state_search.term.trim(), 30);
      state_search.results = r.results || [];
      if (!state_search.results.length) {
        list.innerHTML = '<li class="hint" style="padding:10px 12px">No matches for &ldquo;' +
          escapeHtml(state_search.term) + '&rdquo;.</li>';
        return;
      }
      state_search.results.forEach((hit) => {
        const li = document.createElement("li");
        li.dataset.openFile = hit.name;
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined";
        icon.textContent = hit.kind === "todo" ? "checklist" : "description";
        const lbl = document.createElement("span");
        lbl.className = "search-line";
        lbl.innerHTML =
          '<strong>' + escapeHtml(hit.name) + '</strong>' +
          '<span class="search-snippet">' +
            escapeHtml(hit.snippet || "") +
          '</span>';
        li.append(icon, lbl);
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = '<li class="hint" style="padding:10px 12px">Search failed.</li>';
    }
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

  // ----------------------------------------------------------- Folder context menu
  let ctxFolderTarget = null;
  function showFolderContextMenu(x, y, folder) {
    ctxFolderTarget = folder || "";
    const m = $("#ctx-folder");
    if (!m) return;
    m.style.left = Math.min(x, window.innerWidth - 240) + "px";
    m.style.top = Math.min(y, window.innerHeight - 240) + "px";
    m.classList.remove("hidden");
  }
  function hideFolderContextMenu() {
    $("#ctx-folder")?.classList.add("hidden");
    ctxFolderTarget = null;
  }
  async function onFolderContextMenuClick(e) {
    const btn = e.target.closest("button");
    if (!btn || ctxFolderTarget == null) return;
    const act = btn.dataset.fact;
    const folder = ctxFolderTarget;
    hideFolderContextMenu();
    if (!hasApi()) { toast("Backend not ready", "error"); return; }
    try {
      if (act === "note") await newNote(null, folder);
      else if (act === "todo") await newTodo(null, folder);
      else if (act === "subfolder") {
        const name = prompt("Subfolder name (you can use 'a/b/c' for nested):", "New folder");
        if (!name) return;
        await createFolderInteractive(name, folder);
      } else if (act === "rename") {
        const base = basename(folder);
        const nn = prompt("Rename folder to:", base);
        if (!nn || nn === base) return;
        await renameFolderInteractive(folder, nn);
      } else if (act === "delete") {
        if (!confirm("Delete folder '" + folder + "' (must be empty)?")) return;
        await deleteFolderInteractive(folder);
      } else if (act === "reveal") {
        await pycall("reveal_in_explorer", folder);
      }
    } catch (e) { toast("Action failed: " + e.message, "error"); }
  }

  async function createFolderInteractive(name, parent) {
    if (!hasApi()) return;
    try {
      const r = await pycall("create_folder", name, parent || "");
      if (!r.ok) { toast("Could not create folder: " + (r.error || ""), "error"); return; }
      toast("Created folder " + r.name, "create_new_folder");
      refreshFolderTree();
    } catch (e) { toast("Folder failed: " + e.message, "error"); }
  }
  async function renameFolderInteractive(folder, newName) {
    if (!hasApi()) return;
    const parent = folder.includes("/") ? folder.substring(0, folder.lastIndexOf("/")) : "";
    try {
      const r = await pycall("rename_folder", basename(folder), newName, parent);
      if (!r.ok) { toast("Rename failed: " + (r.error || ""), "error"); return; }
      toast("Renamed to " + r.name, "drive_file_rename_outline");
      refreshFolderTree();
      refreshRecent();
    } catch (e) { toast("Rename failed: " + e.message, "error"); }
  }
  async function deleteFolderInteractive(folder) {
    if (!hasApi()) return;
    try {
      const parent = folder.includes("/") ? folder.substring(0, folder.lastIndexOf("/")) : "";
      const r = await pycall("delete_folder", basename(folder), parent);
      if (!r.ok) { toast("Delete failed: " + (r.error || ""), "error"); return; }
      toast("Deleted folder " + r.name, "delete");
      refreshFolderTree();
    } catch (e) { toast("Delete failed: " + e.message, "error"); }
  }

  // ----------------------------------------------------------- Move-to-folder modal
  let moveTarget = null;
  async function openMoveModal(name) {
    moveTarget = name;
    if (!hasApi()) return;
    $("#move-source").textContent = "Move " + name + " to:";
    const list = $("#move-folders");
    if (list) list.innerHTML = "";
    try {
      const r = await pycall("list_tree");
      if (r && r.ok) {
        addMoveOption("", "(root - no folder)");
        (r.tree || []).forEach((node) => addAllFolders(node, ""));
      }
    } catch (e) {}
    $("#move-modal").classList.remove("hidden");
  }
  function addMoveOption(folder, label) {
    const list = $("#move-folders");
    if (!list) return;
    const li = document.createElement("li");
    li.dataset.folder = folder;
    const ico = document.createElement("span");
    ico.className = "material-symbols-outlined";
    ico.textContent = folder ? "folder" : "inbox";
    const lbl = document.createElement("span");
    lbl.textContent = label || "(root)";
    li.append(ico, lbl);
    if (moveTarget && folder && (moveTarget === folder ||
        moveTarget.startsWith(folder + "/"))) {
      li.classList.add("current");
      li.title = "Cannot move into self or descendants";
    }
    li.addEventListener("click", () => {
      if (li.classList.contains("current")) return;
      performMove(folder);
    });
    list.appendChild(li);
  }
  function addAllFolders(node, prefix) {
    const fullName = prefix ? prefix + "/" + basename(node.name) : node.name;
    if (node.kind === "folder") {
      addMoveOption(fullName, fullName || "(root)");
      (node.children || []).forEach((c) => addAllFolders(c, fullName));
    }
  }
  function closeMoveModal() {
    $("#move-modal").classList.add("hidden");
    moveTarget = null;
  }
  async function performMove(newFolder) {
    if (!moveTarget) return;
    const oldName = moveTarget;
    closeMoveModal();
    if (!hasApi()) return;
    try {
      const r = await pycall("move_note", oldName, newFolder || "");
      if (!r.ok) { toast("Move failed: " + (r.error || ""), "error"); return; }
      toast("Moved to " + (newFolder || "root"), "drive_file_move");
      const tab = state.tabs.find((t) => t.name === oldName);
      if (tab) tab.name = r.name;
      refreshFolderTree();
      refreshRecent();
      renderTabBar();
    } catch (e) { toast("Move failed: " + e.message, "error"); }
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
      else if (act === "tag") openTagPicker(name, "note");
      else if (act === "move") openMoveModal(name);
      else if (act === "reveal") await pycall("reveal_in_explorer", name);
      else if (act === "setpin") {
        await setPinInteractive(name, "note");
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
        refreshFolderTree();
      }
      else if (act === "encrypt") {
        await encryptFileInteractive(name);
      }
      else if (act === "decrypt") {
        await decryptFileInteractive(name);
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
      if (k === "h") {
        e.preventDefault();
        toggleHome(true);
        setTimeout(() => $("#home-search")?.focus(), 30);
        return;
      }
    }

    if (ctrl && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); toggleSidebar(); return; }
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

  // ============================================================
  //                    COLOR TAGS
  // ============================================================
  const TAG_COLORS = [
    { name: "None",   hex: "" },
    { name: "Purple", hex: "#7c5cff" },
    { name: "Cyan",   hex: "#5cc8ff" },
    { name: "Mint",   hex: "#58e1a8" },
    { name: "Pink",   hex: "#ff8ad1" },
    { name: "Amber",  hex: "#ffb86b" },
    { name: "Coral",  hex: "#ff6363" },
    { name: "Rust",   hex: "#cb4b16" },
    { name: "Sand",   hex: "#e8a16c" },
    { name: "Slate",  hex: "#6f7e8c" },
    { name: "Sky",    hex: "#7ab8ff" },
    { name: "Lime",   hex: "#9bd14a" },
    { name: "Plum",   hex: "#a06bbf" },
    { name: "Graphite", hex: "#9aa0a6" },
    { name: "Rose",   hex: "#f48fb1" },
    { name: "Sage",   hex: "#90c695" },
  ];
  // Default colors: purple for folders, grey for files.
  const DEFAULT_FOLDER_COLOR = "#7c5cff";
  const DEFAULT_FILE_COLOR = "#9aa0a6";

  function tagColorFor(name, kind) {
    const tags = (state.config && state.config.tags) || { notes: {}, folders: {} };
    const bucket = kind === "folder" ? tags.folders : tags.notes;
    const raw = bucket && bucket[name];
    if (raw) return raw;
    return kind === "folder" ? DEFAULT_FOLDER_COLOR : DEFAULT_FILE_COLOR;
  }

  function tagDot(color) {
    const span = document.createElement("span");
    span.className = "tag-dot";
    if (color) span.style.background = color;
    return span;
  }

  async function openTagPicker(name, kind) {
    if (!hasApi()) return;
    // Build modal ad-hoc
    let modal = $("#tag-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "tag-modal";
      modal.className = "overlay hidden";
      modal.innerHTML = `
        <div class="modal-card tag-card">
          <header class="modal-head">
            <h2>Tag color</h2>
            <button class="iconbtn" id="tag-close"><span class="material-symbols-outlined">close</span></button>
          </header>
          <div class="modal-body">
            <p class="hint" id="tag-target"></p>
            <div class="tag-picker-grid" id="tag-grid"></div>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener("click", (e) => {
        if (e.target.id === "tag-modal") closeTagPicker();
      });
      $("#tag-close").addEventListener("click", closeTagPicker);
    }
    const grid = $("#tag-grid");
    grid.innerHTML = "";
    const current = tagColorFor(name, kind);
    TAG_COLORS.forEach((c) => {
      const sw = document.createElement("div");
      sw.className = "tag-swatch" + (c.hex === "" ? " none" : "");
      sw.style.background = c.hex || "transparent";
      sw.title = c.name;
      if ((c.hex || "") === (current || "")) sw.classList.add("selected");
      sw.addEventListener("click", () => pickTag(name, kind, c.hex));
      grid.appendChild(sw);
    });
    $("#tag-target").textContent = `Pick a color for ${kind === "folder" ? "folder" : "note"}: ${name}`;
    modal._name = name;
    modal._kind = kind;
    modal.classList.remove("hidden");
  }
  function closeTagPicker() {
    $("#tag-modal")?.classList.add("hidden");
  }
  async function pickTag(name, kind, color) {
    try {
      const r = await pycall("set_tag", name, color || "", kind);
      if (r && r.ok) {
        toast(color ? "Tag set on " + basename(name) : "Tag cleared", "palette");
        refreshFolderTree();
        refreshRecent();
        openTagPicker(name, kind);  // refresh selection
      } else {
        toast("Could not set tag: " + (r && r.error), "error");
      }
    } catch (e) { toast("Tag failed: " + e.message, "error"); }
  }

  // ============================================================
  //                    PER-FILE / PER-FOLDER PIN
  // ============================================================
  async function setPinInteractive(name, kind) {
    if (!hasApi()) return;
    const newPin = prompt("Set PIN for " + name + " (leave empty to clear):", "");
    if (newPin === null) return;
    try {
      const r = await pycall("set_pin", name, newPin, kind);
      if (r && r.ok) {
        unlocked.delete(name);  // require re-entry
        toast(newPin ? "PIN set on " + basename(name) : "PIN cleared on " + basename(name),
             newPin ? "lock" : "lock_open");
        refreshFolderTree();
      } else {
        toast("Could not set PIN: " + (r && r.error), "error");
      }
    } catch (e) { toast("PIN failed: " + e.message, "error"); }
  }

  // ============================================================
  //                    DRAG-AND-DROP INTO FOLDERS
  // ============================================================
  function attachDragHandlers() {
    const tree = $("#folder-tree");
    if (!tree) return;
    tree.addEventListener("dragstart", (e) => {
      const file = e.target.closest(".tree-file");
      if (!file) return;
      e.dataTransfer.setData("text/jottr-file", file.dataset.openFile);
      e.dataTransfer.effectAllowed = "move";
      file.classList.add("dragging");
      // Reveal the drag-handle column on every file row.
      tree.classList.add("is-dragging");
    });
    tree.addEventListener("dragend", (e) => {
      const file = e.target.closest(".tree-file");
      if (file) file.classList.remove("dragging");
      $$(".folder-row.dragover").forEach((f) => f.classList.remove("dragover"));
      tree.classList.remove("is-dragging");
    });
    tree.addEventListener("dragover", (e) => {
      const folder = e.target.closest(".folder-row");
      if (!folder) return;
      const dt = e.dataTransfer;
      if (!dt || !dt.types.includes("text/jottr-file")) return;
      e.preventDefault();
      dt.dropEffect = "move";
      folder.classList.add("dragover");
    });
    tree.addEventListener("dragleave", (e) => {
      const folder = e.target.closest(".folder-row");
      if (folder && (!e.relatedTarget || !folder.contains(e.relatedTarget))) {
        folder.classList.remove("dragover");
      }
    });
    tree.addEventListener("drop", async (e) => {
      const folder = e.target.closest(".folder-row");
      if (!folder) return;
      const srcName = e.dataTransfer.getData("text/jottr-file");
      if (!srcName) return;
      e.preventDefault();
      folder.classList.remove("dragover");
      const folderName = folder.dataset.folder || "";
      // Don't move into itself
      if (srcName === folderName || srcName.startsWith(folderName + "/")) return;
      try {
        const r = await pycall("move_note", srcName, folderName);
        if (r && r.ok) {
          toast("Moved " + basename(srcName) + " to " + (folderName || "root"), "drive_file_move");
          // If the moved note is open, rename its tab too
          const tab = state.tabs.find((t) => t.name === srcName);
          if (tab) tab.name = r.name;
          unlocked.delete(srcName);
          refreshFolderTree();
          refreshRecent();
          renderTabBar();
        } else {
          toast("Move failed: " + (r && r.error), "error");
        }
      } catch (e) { toast("Move failed: " + e.message, "error"); }
    });
  }

  // ============================================================
  //                    WIDGET & SIDEBAR COLLAPSE
  // ============================================================
  const sidebarCollapsed = {
    quick: false,
    pinned: false,
    notes: false,
    recent: false,
    stats: false,
  };

  function applySidebarCollapse() {
    Object.keys(sidebarCollapsed).forEach((id) => {
      const sec = document.querySelector('.side-section[data-section="' + id + '"]');
      if (!sec) return;
      sec.classList.toggle("collapsed", !!sidebarCollapsed[id]);
    });
  }
  function initCollapsibles() {
    // Sidebar section headers
    $$('.side-section[data-section] h3').forEach((h) => {
      h.addEventListener("click", () => {
        const id = h.parentElement.dataset.section;
        sidebarCollapsed[id] = !sidebarCollapsed[id];
        if (state.config) {
          state.config.sidebar_collapsed = state.config.sidebar_collapsed || {};
          state.config.sidebar_collapsed[id] = !!sidebarCollapsed[id];
          if (hasApi()) {
            pycall("update_settings", { sidebar_collapsed: state.config.sidebar_collapsed })
              .catch(() => {});
          }
        }
        applySidebarCollapse();
      });
    });
    // Widget headers
    $$(".widget-head").forEach((h) => {
      h.addEventListener("click", () => {
        const w = h.closest(".widget");
        if (w) w.classList.toggle("collapsed");
      });
    });
    // Restore from config
    if (state.config && state.config.sidebar_collapsed) {
      Object.assign(sidebarCollapsed, state.config.sidebar_collapsed);
    }
    applySidebarCollapse();
  }

  // ============================================================
  //                    PLUGIN MANAGER UI
  // ============================================================
  async function refreshPluginsList() {
    if (!hasApi()) return;
    const wrap = $("#plugins-list");
    if (!wrap) return;
    wrap.innerHTML = "";
    try {
      const r = await pycall("list_plugins");
      const plugins = (r && r.plugins) || [];
      if (!plugins.length) {
        wrap.innerHTML = '<p class="hint">No .plugg files found. See <code>syntax.plugg</code> in the Jottr directory for the manifest format.</p>';
        return;
      }
      plugins.forEach((p) => {
        const card = document.createElement("div");
        card.className = "plugin-card";
        const head = document.createElement("div");
        head.className = "plugin-head";
        const ico = document.createElement("span");
        ico.className = "material-symbols-outlined";
        ico.textContent = p.icon || "extension";
        ico.style.color = "var(--accent)";
        const nm = document.createElement("span");
        nm.className = "plugin-name";
        nm.textContent = p.name;
        const ver = document.createElement("span");
        ver.className = "plugin-version";
        ver.textContent = p.version || "";
        head.append(ico, nm, ver);
        card.appendChild(head);
        if (p.description) {
          const d = document.createElement("div");
          d.className = "plugin-desc";
          d.textContent = p.description;
          card.appendChild(d);
        }
        if (p.features && p.features.length) {
          const ul = document.createElement("ul");
          ul.style.margin = "6px 0 0 0";
          ul.style.paddingLeft = "18px";
          p.features.forEach((f) => {
            const li = document.createElement("li");
            li.textContent = f;
            li.style.fontSize = "12.5px";
            li.style.color = "var(--fg-mute)";
            ul.appendChild(li);
          });
          card.appendChild(ul);
        }
        const actions = document.createElement("div");
        actions.className = "plugin-actions";
        const btn = document.createElement("button");
        btn.className = "btn " + (p.enabled ? "" : "primary");
        btn.textContent = p.enabled ? "Disable" : "Enable";
        btn.addEventListener("click", () => togglePlugin(p.id, !p.enabled));
        actions.appendChild(btn);
        card.appendChild(actions);
        wrap.appendChild(card);
      });
    } catch (e) {
      wrap.innerHTML = '<p class="hint">Plugin load failed: ' + escapeHtml(e.message) + "</p>";
    }
  }
  async function togglePlugin(id, enabled) {
    try {
      const r = await pycall("set_plugin_enabled", id, enabled);
      if (r && r.ok) {
        toast((enabled ? "Enabled " : "Disabled ") + id, "extension");
        refreshPluginsList();
      }
    } catch (e) { toast("Plugin toggle failed: " + e.message, "error"); }
  }

  // ============================================================
  //                    ENCRYPT / DECRYPT (uses bundled plugin)
  // ============================================================
  async function encryptFileInteractive(name) {
    if (!hasApi()) return;
    const pw = prompt("Encrypt " + basename(name) + "\nEnter a password (you'll need it to decrypt):");
    if (!pw) return;
    try {
      const r = await pycall("encrypt_file", name, pw);
      if (r && r.ok) {
        toast("Encrypted " + basename(name), "lock");
        refreshFolderTree();
        refreshRecent();
      } else {
        toast("Encrypt failed: " + (r && r.error), "error");
      }
    } catch (e) { toast("Encrypt failed: " + e.message, "error"); }
  }
  async function decryptFileInteractive(name) {
    if (!hasApi()) return;
    const pw = prompt("Decrypt " + basename(name) + "\nEnter the password:");
    if (!pw) return;
    try {
      const r = await pycall("decrypt_file", name, pw);
      if (r && r.ok) {
        toast("Decrypted " + basename(name), "lock_open");
        // If the note is open in a tab, reload its content.
        const tab = state.tabs.find((t) => t.name === name);
        if (tab) {
          const r2 = await pycall("read_note", name);
          if (r2 && r2.ok) {
            tab.content = r2.content || "";
            tab.textarea.value = tab.content;
            syncHighlight(tab);
            renderGutter(tab);
            updateStatus(tab);
          }
        }
        refreshFolderTree();
        refreshRecent();
      } else {
        toast("Decrypt failed: " + (r && r.error), "error");
      }
    } catch (e) { toast("Decrypt failed: " + e.message, "error"); }
  }
})();
