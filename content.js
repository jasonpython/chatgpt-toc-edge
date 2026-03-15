(() => {
  const ROOT_ID = "cgpt-toc-root";
  const STORAGE_KEY = "chatgpt_toc_settings_v3";
  const DEFAULT_SETTINGS = {
    collapsed: false,
    width: 340,
    mode: "all",
    left: null,
    top: 72,
    search: "",
    pinnedSide: "right",
  };

  let settings = { ...DEFAULT_SETTINGS };
  let booted = false;
  let observer = null;
  let intersectionObserver = null;
  let renderTimer = null;
  let lastItems = [];
  let moveState = null;
  let resizeState = null;
  let handledHash = "";

  function extStorageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (result) => resolve(result[key]));
      } catch {
        resolve(undefined);
      }
    });
  }

  function extStorageSet(obj) {
    try {
      chrome.storage.local.set(obj);
    } catch {}
  }

  function persistSettings() {
    extStorageSet({ [STORAGE_KEY]: settings });
  }

  function debounce(fn, wait = 180) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(fn, wait);
  }

  function isDarkMode() {
    return (
      document.documentElement.classList.contains("dark") ||
      document.body.classList.contains("dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/Copy code/gi, "")
      .replace(/Edit message/gi, "")
      .replace(/You said/gi, "")
      .replace(/ChatGPT said/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function firstMeaningfulLine(text) {
    const parts = String(text || "")
      .split(/\n+/)
      .map((s) => cleanText(s))
      .filter(Boolean)
      .filter((s) => !/^chatgpt$/i.test(s))
      .filter((s) => !/^you$/i.test(s))
      .filter((s) => !/^you said[:：]?$/i.test(s))
      .filter((s) => !/^chatgpt said[:：]?$/i.test(s));
    return parts[0] || "";
  }

  function getTextLinesFromNodes(nodes) {
    const lines = [];
    nodes.forEach((node) => {
      const value = cleanText(node.innerText || node.textContent || "");
      if (!value) return;
      lines.push(
        ...value
          .split(/\n+/)
          .map((s) => cleanText(s))
          .filter(Boolean),
      );
    });
    return Array.from(new Set(lines));
  }

  function filterMessageLines(lines) {
    return lines
      .map((line) => cleanText(line))
      .filter(Boolean)
      .filter(
        (line) =>
          !/^(copy code|edit message|good response|bad response|read aloud|regenerate|copy|share|retry|more)$/i.test(
            line,
          ),
      )
      .filter((line) => !/^you said[:：]?$/i.test(line))
      .filter((line) => !/^chatgpt said[:：]?$/i.test(line))
      .filter((line) => !/^you$/i.test(line))
      .filter((line) => !/^chatgpt$/i.test(line));
  }

  function extractMessageText(article, roleHint = null) {
    const role = roleHint || detectRoleStrong(article) || null;
    const selectorGroups =
      role === "user"
        ? [
            [
              '[data-message-author-role="user"] [dir="auto"]',
              '[data-message-author-role="user"] [class*="whitespace-pre-wrap"]',
              '[data-message-author-role="user"] [class*="break-words"]',
              '[data-message-author-role="user"] [class*="select-text"]',
              '[data-message-author-role="user"] p',
              '[data-message-author-role="user"] span',
            ],
            [
              '[dir="auto"]',
              '[class*="whitespace-pre-wrap"]',
              '[class*="break-words"]',
              '[class*="select-text"]',
              "p",
              "span",
            ],
          ]
        : [
            [
              "[data-message-author-role] .markdown",
              '[data-message-author-role] [class*="markdown"]',
              '[data-message-author-role] [class*="prose"]',
              ".markdown",
              '[class*="markdown"]',
              '[class*="prose"]',
              "p",
              "li",
              "pre code",
              "blockquote",
              "h1, h2, h3, h4",
            ],
          ];

    let lines = [];
    for (const selectors of selectorGroups) {
      for (const selector of selectors) {
        const nodes = Array.from(article.querySelectorAll(selector));
        if (!nodes.length) continue;
        lines = filterMessageLines(getTextLinesFromNodes(nodes));
        if (lines.length) break;
      }
      if (lines.length) break;
    }

    if (!lines.length) {
      lines = filterMessageLines(String(article.innerText || "").split(/\n+/));
    }

    return lines.join("\n").trim();
  }

  function getRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }
    return root;
  }

  function createUI() {
    const root = getRoot();
    if (root.dataset.ready === "1") return;

    root.innerHTML = `
      <div id="cgpt-toc-panel" aria-label="ChatGPT 对话目录">
        <div id="cgpt-toc-resizer" title="拖动调整宽度"></div>
        <div id="cgpt-toc-header">
          <div id="cgpt-toc-header-top">
            <div id="cgpt-toc-brand">
              <div id="cgpt-toc-brand-dot"></div>
              <div>
                <div id="cgpt-toc-title">对话目录</div>
                <div id="cgpt-toc-subtitle">搜索、锚点、导出、拖动定位</div>
              </div>
            </div>
            <div id="cgpt-toc-actions">
              <button class="cgpt-toc-btn" id="cgpt-toc-mode-btn" title="切换目录模式">全部</button>
              <button class="cgpt-toc-btn cgpt-toc-icon-btn" id="cgpt-toc-export-md" title="导出 Markdown">MD</button>
              <button class="cgpt-toc-btn cgpt-toc-icon-btn" id="cgpt-toc-export-json" title="导出 JSON">JSON</button>
              <button class="cgpt-toc-btn" id="cgpt-toc-collapse-btn" title="收起目录">收起</button>
            </div>
          </div>
          <div id="cgpt-toc-toolbar">
            <div id="cgpt-toc-search-wrap">
              <input id="cgpt-toc-search" type="text" placeholder="搜索目录关键词" />
              <button class="cgpt-toc-clear" id="cgpt-toc-search-clear" title="清空搜索">×</button>
            </div>
          </div>
          <div id="cgpt-toc-status">
            <span id="cgpt-toc-count">0 条</span>
            <span id="cgpt-toc-toast"></span>
          </div>
        </div>
        <div id="cgpt-toc-body">
          <div id="cgpt-toc-list"></div>
        </div>
      </div>
      <button id="cgpt-toc-mini" title="展开目录">目录</button>
    `;

    root.dataset.ready = "1";

    document
      .getElementById("cgpt-toc-collapse-btn")
      .addEventListener("click", () => {
        settings.collapsed = true;
        persistSettings();
        applySettings();
      });

    document.getElementById("cgpt-toc-mini").addEventListener("click", (e) => {
      if (e.currentTarget.dataset.dragMoved === "1") return;
      settings.collapsed = false;
      persistSettings();
      applySettings();
    });

    document
      .getElementById("cgpt-toc-mode-btn")
      .addEventListener("click", () => {
        settings.mode = settings.mode === "all" ? "user-only" : "all";
        persistSettings();
        updateModeButton();
        renderTOC();
      });

    document
      .getElementById("cgpt-toc-export-md")
      .addEventListener("click", () => exportData("md"));
    document
      .getElementById("cgpt-toc-export-json")
      .addEventListener("click", () => exportData("json"));

    const searchInput = document.getElementById("cgpt-toc-search");
    searchInput.addEventListener("input", (e) => {
      settings.search = e.target.value || "";
      persistSettings();
      renderTOC();
    });
    document
      .getElementById("cgpt-toc-search-clear")
      .addEventListener("click", () => {
        settings.search = "";
        searchInput.value = "";
        persistSettings();
        renderTOC();
      });

    bindMove();
    bindResize();
    bindHashChange();
    applySettings();
  }

  function updateModeButton() {
    const btn = document.getElementById("cgpt-toc-mode-btn");
    if (!btn) return;
    btn.textContent = settings.mode === "all" ? "全部" : "仅问题";
  }

  function showToast(text) {
    const toast = document.getElementById("cgpt-toc-toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.classList.remove("show");
      toast.textContent = "";
    }, 1600);
  }

  function applyTheme() {
    const dark = isDarkMode();
    const panel = document.getElementById("cgpt-toc-panel");
    const mini = document.getElementById("cgpt-toc-mini");
    if (panel) panel.classList.toggle("dark", dark);
    if (mini) mini.classList.toggle("dark", dark);
  }

  function clampPanelPosition() {
    const panel = document.getElementById("cgpt-toc-panel");
    if (!panel) return;
    const width = Math.max(300, Math.min(560, settings.width || 340));
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - 120);
    if (settings.left == null) {
      settings.left = window.innerWidth - width - 16;
    }
    settings.left = Math.max(8, Math.min(maxLeft, settings.left));
    settings.top = Math.max(8, Math.min(maxTop, settings.top || 72));
  }

  function applySettings() {
    const panel = document.getElementById("cgpt-toc-panel");
    const mini = document.getElementById("cgpt-toc-mini");
    const searchInput = document.getElementById("cgpt-toc-search");
    if (!panel || !mini) return;

    settings.width = Math.max(300, Math.min(560, settings.width || 340));
    clampPanelPosition();
    updateModeButton();
    applyTheme();

    if (searchInput && searchInput.value !== settings.search) {
      searchInput.value = settings.search || "";
    }

    panel.style.width = `${settings.width}px`;
    panel.style.left = `${settings.left}px`;
    panel.style.top = `${settings.top}px`;
    panel.style.right = "auto";

    mini.style.left = `${settings.left}px`;
    mini.style.top = `${settings.top}px`;
    mini.style.right = "auto";

    if (settings.collapsed) {
      panel.style.display = "none";
      mini.style.display = "inline-flex";
    } else {
      panel.style.display = "flex";
      mini.style.display = "none";
    }
  }

  function bindMove() {
    const header = () => document.getElementById("cgpt-toc-header-top");
    const mini = () => document.getElementById("cgpt-toc-mini");

    const startMove = (e, rect) => {
      moveState = {
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        source:
          e.currentTarget && e.currentTarget.id === "cgpt-toc-mini"
            ? "mini"
            : "panel",
      };
      document.body.style.userSelect = "none";
      e.preventDefault();
    };

    window.addEventListener("mousemove", (e) => {
      if (!moveState) return;
      const dx = e.clientX - moveState.startX;
      const dy = e.clientY - moveState.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moveState.moved = true;
      settings.left = e.clientX - moveState.offsetX;
      settings.top = e.clientY - moveState.offsetY;
      clampPanelPosition();
      applySettings();
    });
    window.addEventListener("mouseup", () => {
      if (!moveState) return;
      const moved = moveState.moved;
      const source = moveState.source;
      moveState = null;
      document.body.style.userSelect = "";
      persistSettings();
      const miniBtn = mini();
      if (miniBtn) {
        miniBtn.dataset.dragMoved = moved ? "1" : "0";
        miniBtn.dataset.dragSource = source || "";
        setTimeout(() => {
          if (miniBtn.dataset.dragSource === source) {
            miniBtn.dataset.dragMoved = "0";
            miniBtn.dataset.dragSource = "";
          }
        }, 0);
      }
    });
    setTimeout(() => {
      const h = header();
      if (h) {
        h.addEventListener("mousedown", (e) => {
          if (e.target.closest("button") || e.target.closest("input")) return;
          const panel = document.getElementById("cgpt-toc-panel");
          if (!panel) return;
          startMove(e, panel.getBoundingClientRect());
        });
      }

      const m = mini();
      if (m) {
        m.addEventListener("mousedown", (e) => {
          startMove(e, m.getBoundingClientRect());
        });

        m.addEventListener(
          "click",
          (e) => {
            if (m.dataset.dragMoved === "1") {
              e.preventDefault();
              e.stopPropagation();
              m.dataset.dragMoved = "0";
            }
          },
          true,
        );
      }
    }, 0);
  }

  function bindResize() {
    const resizer = document.getElementById("cgpt-toc-resizer");
    if (!resizer) return;
    resizer.addEventListener("mousedown", (e) => {
      resizeState = { startX: e.clientX, startWidth: settings.width };
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!resizeState) return;
      const delta = e.clientX - resizeState.startX;
      settings.width = Math.max(
        300,
        Math.min(560, resizeState.startWidth - delta),
      );
      clampPanelPosition();
      applySettings();
    });

    window.addEventListener("mouseup", () => {
      if (!resizeState) return;
      resizeState = null;
      document.body.style.userSelect = "";
      persistSettings();
    });
  }

  function getArticles() {
    return Array.from(document.querySelectorAll("main article")).filter(
      (el) => {
        const text = cleanText(el.innerText || "");
        if (!text) return false;
        return window.getComputedStyle(el).display !== "none";
      },
    );
  }

  function getArticleMetaText(article) {
    const attr = article.outerHTML.match(/data-message-author-role="([^"]+)"/i);
    return [
      article.getAttribute("aria-label") || "",
      article.getAttribute("data-testid") || "",
      article.getAttribute("class") || "",
      attr ? attr[0] : "",
      article.innerText || "",
    ]
      .join(" ")
      .toLowerCase();
  }

  function getActionButtonText(article) {
    return Array.from(article.querySelectorAll("button"))
      .map((b) => cleanText(b.innerText || b.getAttribute("aria-label") || ""))
      .join(" ")
      .toLowerCase();
  }

  function detectRoleStrong(article) {
    const meta = getArticleMetaText(article);
    const actions = getActionButtonText(article);

    if (/data-message-author-role="user"/.test(meta)) return "user";
    if (/data-message-author-role="assistant"/.test(meta)) return "assistant";
    if (meta.includes("you said") || meta.includes("edit message"))
      return "user";
    if (
      actions.includes("good response") ||
      actions.includes("bad response") ||
      actions.includes("regenerate") ||
      actions.includes("read aloud")
    )
      return "assistant";
    if (actions.includes("edit")) return "user";
    return null;
  }

  function assignRoles(articles) {
    const roles = articles.map((article) => detectRoleStrong(article));
    let next = "user";
    for (let i = 0; i < roles.length; i++) {
      if (roles[i]) {
        next = roles[i] === "user" ? "assistant" : "user";
        continue;
      }
      roles[i] = next;
      next = next === "user" ? "assistant" : "user";
    }
    return roles;
  }

  function makeTitle(article, role, index) {
    const messageText = extractMessageText(article, role);
    const raw = cleanText(messageText || article.innerText || "");
    if (!raw) return `${role === "user" ? "问题" : "回复"} ${index + 1}`;
    const base =
      firstMeaningfulLine(messageText || article.innerText || "") || raw;
    let title = base
      .replace(/^(你|我|用户|user|you said)[:：]?\s*/i, "")
      .replace(/^(chatgpt|assistant|chatgpt said)[:：]?\s*/i, "")
      .trim();
    if (!title) title = base || raw;
    if (!title) title = `${role === "user" ? "问题" : "回复"} ${index + 1}`;
    if (title.length > 96) title = `${title.slice(0, 96)}…`;
    return title;
  }

  function ensureAnchor(article, idx) {
    if (!article.dataset.cgptTocId) {
      article.dataset.cgptTocId = `cgpt-msg-${idx}-${Math.random().toString(36).slice(2, 8)}`;
    }
    article.id = article.dataset.cgptTocId;
    return article.dataset.cgptTocId;
  }

  function collectItems() {
    const articles = getArticles();
    const roles = assignRoles(articles);
    const baseItems = articles.map((article, idx) => {
      const role = roles[idx] || "assistant";
      const id = ensureAnchor(article, idx);
      const messageText = extractMessageText(article, role);
      return {
        id,
        domIndex: idx,
        role,
        title: makeTitle(article, role, idx),
        node: article,
        text: cleanText(messageText || article.innerText || ""),
      };
    });

    let items = baseItems.filter((item) =>
      settings.mode === "all" ? true : item.role === "user",
    );
    const keyword = cleanText(settings.search || "").toLowerCase();
    if (keyword) {
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(keyword) ||
          item.text.toLowerCase().includes(keyword),
      );
    }

    return items.map((item, idx) => ({ ...item, index: idx + 1 }));
  }

  function highlightTocItem(id) {
    document.querySelectorAll(".cgpt-toc-item").forEach((node) => {
      node.classList.toggle("active", node.dataset.targetId === id);
    });
  }

  function scrollToItem(id, updateHash = true) {
    handledHash = id || "";
    const target =
      document.getElementById(id) ||
      document.querySelector(`[data-cgpt-toc-id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("cgpt-toc-target-flash");
    setTimeout(() => target.classList.remove("cgpt-toc-target-flash"), 1300);
    if (updateHash) {
      history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}#${id}`,
      );
    }
    highlightTocItem(id);
  }

  async function copyAnchorLink(item) {
    const url = `${location.origin}${location.pathname}${location.search}#${item.id}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast("锚点链接已复制");
    } catch {
      const area = document.createElement("textarea");
      area.value = url;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      showToast("锚点链接已复制");
    }
  }

  function exportData(kind) {
    const items = lastItems.length ? lastItems : collectItems();
    if (!items.length) {
      showToast("没有可导出的目录");
      return;
    }

    let content = "";
    let filename = "";
    if (kind === "md") {
      content = [
        "# ChatGPT 对话目录",
        "",
        `- 页面: ${location.href.split("#")[0]}`,
        `- 导出时间: ${new Date().toLocaleString()}`,
        `- 模式: ${settings.mode === "all" ? "全部消息" : "仅问题"}`,
        "",
        ...items.map(
          (item) =>
            `- [${item.index}. ${item.title}](${location.href.split("#")[0]}#${item.id})`,
        ),
      ].join("\n");
      filename = "chatgpt-toc.md";
    } else {
      content = JSON.stringify(
        {
          page: location.href.split("#")[0],
          exportedAt: new Date().toISOString(),
          mode: settings.mode,
          search: settings.search,
          items: items.map((item) => ({
            index: item.index,
            id: item.id,
            role: item.role,
            title: item.title,
            url: `${location.href.split("#")[0]}#${item.id}`,
          })),
        },
        null,
        2,
      );
      filename = "chatgpt-toc.json";
    }

    const blob = new Blob([content], {
      type:
        kind === "md"
          ? "text/markdown;charset=utf-8"
          : "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(kind === "md" ? "已导出 Markdown" : "已导出 JSON");
  }

  function setupIntersectionTracking(items) {
    if (intersectionObserver) intersectionObserver.disconnect();
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (!visible.length) return;
        highlightTocItem(
          visible[0].target.dataset.cgptTocId || visible[0].target.id,
        );
      },
      { root: null, threshold: [0.15, 0.35, 0.6, 0.85] },
    );

    items.forEach((item) => {
      if (item.node && item.node.isConnected)
        intersectionObserver.observe(item.node);
    });
  }

  function refreshActiveItem() {
    if (!lastItems.length) return;
    let best = null;
    let score = Infinity;
    for (const item of lastItems) {
      const rect = item.node.getBoundingClientRect();
      const s = Math.abs(rect.top - 130);
      if (s < score) {
        score = s;
        best = item;
      }
    }
    if (best) highlightTocItem(best.id);
  }

  function renderTOC() {
    createUI();
    applyTheme();

    const list = document.getElementById("cgpt-toc-list");
    const count = document.getElementById("cgpt-toc-count");
    if (!list) return;

    const items = collectItems();
    // 避免在 items 列表未发生变化时重复重建 DOM（会导致悬停/激活时闪烁）
    const newIds = items.map((it) => it.id);
    const oldIds = lastItems.map((it) => it.id);
    if (
      oldIds.length === newIds.length &&
      oldIds.every((v, i) => v === newIds[i])
    ) {
      lastItems = items;
      if (count) count.textContent = `${items.length} 条`;
      refreshActiveItem();
      setupIntersectionTracking(items);
      return;
    }

    lastItems = items;
    list.innerHTML = "";
    if (count) count.textContent = `${items.length} 条`;

    if (!items.length) {
      const empty = document.createElement("div");
      empty.id = "cgpt-toc-empty";
      empty.textContent = settings.search
        ? "没有匹配到搜索结果，换个关键词试试。"
        : "还没有识别到可导航的对话内容。打开一个对话后会自动生成目录。";
      list.appendChild(empty);
      return;
    }

    items.forEach((item) => {
      const el = document.createElement("div");
      el.className = "cgpt-toc-item";
      el.dataset.targetId = item.id;
      el.innerHTML = `
        <div class="cgpt-toc-row-top">
          <div class="cgpt-toc-meta-left">
            <span class="cgpt-toc-index">#${item.index}</span>
            <span class="cgpt-toc-role ${item.role === "user" ? "user" : "assistant"}">${item.role === "user" ? "问题" : "回复"}</span>
          </div>
          <div class="cgpt-toc-row-actions">
            <button class="cgpt-toc-link-btn" title="复制锚点链接">#</button>
          </div>
        </div>
        <div class="cgpt-toc-text"></div>
      `;
      el.querySelector(".cgpt-toc-text").textContent = item.title;
      el.addEventListener("click", (e) => {
        if (e.target.closest(".cgpt-toc-link-btn")) return;
        scrollToItem(item.id, true);
      });
      el.querySelector(".cgpt-toc-link-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        copyAnchorLink(item);
      });
      list.appendChild(el);
    });

    refreshActiveItem();
    setupIntersectionTracking(items);
  }

  function jumpToHashIfNeeded(force = false) {
    const hash = decodeURIComponent(location.hash || "").replace(/^#/, "");
    if (!hash) return;
    if (!force && handledHash === hash) return;
    const target = document.getElementById(hash);
    if (!target) return;
    handledHash = hash;
    clearTimeout(jumpToHashIfNeeded._timer);
    jumpToHashIfNeeded._timer = setTimeout(() => scrollToItem(hash, false), 60);
  }

  function bindHashChange() {
    window.addEventListener("hashchange", () => jumpToHashIfNeeded(false));
  }

  function startObserve() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => debounce(renderTOC, 220));
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.addEventListener("scroll", () => debounce(refreshActiveItem, 60), {
      passive: true,
    });
    window.addEventListener(
      "resize",
      () =>
        debounce(() => {
          clampPanelPosition();
          applySettings();
          refreshActiveItem();
        }, 80),
      { passive: true },
    );
  }

  async function init() {
    if (booted) return;
    booted = true;
    const saved = await extStorageGet(STORAGE_KEY);
    settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    createUI();
    applySettings();
    renderTOC();
    startObserve();
    setTimeout(() => {
      renderTOC();
      jumpToHashIfNeeded(true);
    }, 900);
    setTimeout(renderTOC, 2200);
    setTimeout(() => jumpToHashIfNeeded(true), 400);
    setInterval(applyTheme, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
