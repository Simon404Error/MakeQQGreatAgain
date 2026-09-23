/**
 * MQGA 设置界面注入（QQ NT 9.9.3x）
 *
 * 目标：把「宿主管理面板」与「各插件自己的设置页」直接做进 QQ 设置界面 ——
 *       左栏出现 "MGQA Ctrl" 与每个提供设置页的插件各一项，右侧切换显示对应内容。
 *
 * QQ 设置界面结构（9.9.35 实测）：
 *   div.setting-layout
 *     div.setting-tab  > div.nav-bar > div.nav-item > i.icon + div.name     ← 左栏列表
 *     div.setting-main > div.setting-title + div.wrapper > div.setting-main__content > div.q-scroll-view
 *
 * 做法（与 LiteLoaderQQNT 同思路，但只依赖 class 名与 DOM 事件）：
 *   1. 在 .setting-tab 里追加第二个 .nav-bar.mqga，第一项是我们自己的 "MGQA Ctrl"，之后每个插件一项；
 *   2. 在 .setting-main__content 里追加 .mqga-view 作为我们所有页面的容器；
 *   3. 点击我们的项 → 隐藏 QQ 自己的 .q-scroll-view、显示 .mqga-view 并渲染对应页面；
 *      点击 QQ 的项 → 恢复 QQ 的页面；
 *   4. 插件的设置页容器由宿主创建，并回调插件的 onSettingWindowCreated(container)（LLQQNT 语义）。
 */
(function () {
    if (window.__MQGA_SETTINGS_UI__) return;
    const state = {
        mounted: false, active: false, pages: {}, current: "host",
        titleBackup: null, hostNode: null, naturalWidths: {},
    };
    window.__MQGA_SETTINGS_UI__ = state;

    const LABEL = "MGQA Ctrl";
    const NAV_ID = "mqga-nav-bar";
    const VIEW_ID = "mqga-view";
    const BODY_ID = "mqga-view-body";
    const HOST_ITEM_ID = "mqga-host-item";
    const PLUGIN_ITEM_PREFIX = "mqga-plugin-item-";
    const REF_WIDTH = 880;   // 插件设置页按此宽度设计，更窄时整体等比缩小
    const MIN_ZOOM = 0.5;

    function log(msg) {
        try {
            if (window.MQGA && window.MQGA.api && window.MQGA.api.log) window.MQGA.api.log("settings-ui: " + msg);
            else console.log("[MQGA settings-ui]", msg);
        } catch (e) { /* 忽略 */ }
    }

    function pluginInfo() {
        const mqga = window.MQGA || {};
        return (mqga.pluginsInfo ? mqga.pluginsInfo() : null) || mqga.plugins || {};
    }

    function findSettings() {
        const layout = document.querySelector(".setting-layout");
        if (!layout) return null;
        const tab = layout.querySelector(".setting-tab");
        const navBar = layout.querySelector(".setting-tab .nav-bar");
        const content = layout.querySelector(".setting-main__content");
        const qqView = layout.querySelector(".setting-main__content .q-scroll-view");
        if (!tab || !navBar || !content) return null;
        return { layout, tab, navBar, content, qqView, title: layout.querySelector(".setting-title") };
    }

    /* ------------------------------- 左侧导航 -------------------------------- */

    function cloneItem(template, name, id) {
        let item;
        if (template) {
            item = template.cloneNode(true);
            const nameNode = item.querySelector(".name") || item;
            nameNode.textContent = name;
            item.querySelectorAll("[tabindex]").forEach((el) => el.setAttribute("tabindex", "0"));
        } else {
            item = document.createElement("div");
            item.className = "nav-item";
            item.innerHTML = '<div class="name">' + name + "</div>";
        }
        item.classList.remove("nav-item-active");
        item.id = id || "";
        return item;
    }

    function setItemIcon(item, url) {
        if (!url) return;
        try {
            const icon = item.querySelector(".q-icon") || item.querySelector("i");
            if (!icon) return;
            icon.innerHTML = '<img src="' + url + '" style="width:20px;height:20px;border-radius:4px;object-fit:cover" />';
        } catch (e) { /* 忽略 */ }
    }

    function ensureNavBar(found) {
        let nav = found.tab.querySelector("#" + NAV_ID);
        if (nav) return nav;
        nav = document.createElement("div");
        nav.id = NAV_ID;
        nav.className = "nav-bar mqga";
        // 第一项：宿主自己
        const template = found.navBar.querySelector(".nav-item");
        const hostItem = cloneItem(template, LABEL, HOST_ITEM_ID);
        nav.appendChild(hostItem);
        found.tab.appendChild(nav);
        return nav;
    }

    /* --------------------------- 插件设置页（LLQQNT 兼容） --------------------------- */

    function pluginIconUrl(slug, info) {
        const m = (info[slug] && info[slug].manifest) || {};
        const p = (info[slug] && info[slug].path) || {};
        if (!m.icon || !p.plugin) return "";
        const file = String(m.icon).replace(/^\.\//, "").replace(/\//g, "\\");
        return "local:///" + (p.plugin + "\\" + file);
    }

    function initPluginPages(found) {
        const map = window.__MQGA_RENDERER_EXPORTS__ || {};
        const info = pluginInfo();
        const nav = found.tab.querySelector("#" + NAV_ID);
        if (!nav) return;
        for (const slug of Object.keys(map)) {
            const exps = map[slug];
            if (!exps || typeof exps.onSettingWindowCreated !== "function") continue;
            if (state.pages[slug]) continue;
            const showName = (info[slug] && info[slug].manifest && (info[slug].manifest.name || slug)) || slug;
            const page = document.createElement("div");
            page.id = VIEW_ID + "-page-" + slug;
            page.style.cssText = "display:none;padding:4px 2px 30px;box-sizing:border-box;";
            const item = cloneItem(found.navBar.querySelector(".nav-item"), showName, PLUGIN_ITEM_PREFIX + slug);
            setItemIcon(item, pluginIconUrl(slug, info));
            nav.appendChild(item);
            state.pages[slug] = { slug, name: showName, page, item };
            try {
                Promise.resolve(exps.onSettingWindowCreated(page))
                    .then(() => {
                        const text = (page.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140);
                        log("已调用插件设置钩子: " + slug + " 子节点=" + page.children.length + " 文本=\"" + text + "\"");
                        updateNavLabels();
                    })
                    .catch((e) => log("插件设置钩子 " + slug + " 失败: " + ((e && e.message) || e)));
            } catch (e) {
                log("插件设置钩子 " + slug + " 抛错: " + ((e && e.message) || e));
            }
        }
    }

    function updateNavLabels() {
        const info = pluginInfo();
        for (const slug of Object.keys(state.pages)) {
            const entry = state.pages[slug];
            if (entry.item) {
                const nameNode = entry.item.querySelector(".name");
                if (nameNode) nameNode.textContent = entry.name;
            }
            void info;
        }
    }

    /* ------------------------------- 内容区 ---------------------------------- */

    function buildView() {
        const view = document.createElement("div");
        view.id = VIEW_ID;
        view.className = "q-scroll-view scroll-view--show-scrollbar mqga";
        view.style.cssText = [
            "display:none", "position:absolute", "left:0", "top:0", "right:0", "bottom:0",
            "box-sizing:border-box", "overflow:auto", "z-index:20",
            "background:var(--bg_bottom_standard,#fff)", "color:var(--text_primary,#111)",
            "font-family:system-ui,'Microsoft YaHei',sans-serif", "max-width:100%", "max-height:100%",
        ].join(";");
        const body = document.createElement("div");
        body.id = BODY_ID;
        body.style.cssText = "padding:18px 24px 40px;box-sizing:border-box;max-width:100%;";
        view.appendChild(body);
        return view;
    }

    function renderHostBody(body) {
        const mqga = window.MQGA || {};
        const info = pluginInfo();
        const versions = mqga.versions || {};
        const loader = mqga.loader || {};
        const paths = mqga.paths || {};
        const slugs = Object.keys(info);
        const rows = slugs.length ? slugs.map((slug) => {
            const p = info[slug] || {};
            const m = p.manifest || {};
            const stateText = p.disabled ? "已禁用" : (p.incompatible ? "平台不兼容" : "已启用");
            const color = p.disabled ? "#c66" : (p.incompatible ? "#a80" : "#3a3");
            const hasPage = !!state.pages[slug];
            return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:1px solid #8883;border-radius:10px;margin-bottom:8px;max-width:100%;box-sizing:border-box">
                <div style="flex:1 1 180px;min-width:0">
                    <div style="font-weight:600;overflow-wrap:anywhere">${m.name || slug}
                        <span style="opacity:.5;font-weight:400;font-size:12px">v${m.version || "?"} · ${slug}</span></div>
                    <div style="opacity:.6;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.description || ""}</div>
                </div>
                ${hasPage ? `<button data-open="${slug}" style="padding:5px 12px;border-radius:6px;border:1px solid #8884;background:#8882;cursor:pointer">设置页</button>` : ""}
                <div style="font-size:12px;color:${color};flex:0 0 auto">${stateText}</div>
                <button data-slug="${slug}" data-enable="${p.disabled ? "1" : "0"}"
                    style="padding:5px 12px;border-radius:6px;border:1px solid #8884;background:#8882;cursor:pointer">
                    ${p.disabled ? "启用" : "禁用"}</button>
                <button data-slug="${slug}" data-reveal="1"
                    style="padding:5px 12px;border-radius:6px;border:1px solid #8884;background:#8882;cursor:pointer">目录</button>
            </div>`;
        }).join("") : '<div style="opacity:.6">plugins 目录中还没有插件。</div>';

        body.innerHTML = `
            <h2 style="margin:0 0 4px;font-size:19px;font-weight:600">${LABEL}</h2>
            <div style="opacity:.65;font-size:12px;margin-bottom:16px">
                MakeQQGreatAgain · 宿主 v${loader.version || "?"} · QQ ${versions.qqnt || "?"} · Electron ${versions.electron || "?"} · Node ${versions.node || "?"}
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
                <button id="${BODY_ID}-plugins" style="padding:6px 14px;border-radius:6px;border:1px solid #8884;background:#8882;cursor:pointer">打开插件目录</button>
                <button id="${BODY_ID}-logs" style="padding:6px 14px;border-radius:6px;border:1px solid #8884;background:#8882;cursor:pointer">打开日志目录</button>
                <button id="${BODY_ID}-refresh" style="padding:6px 14px;border-radius:6px;border:1px solid #8884;background:#8882;cursor:pointer">刷新</button>
            </div>
            ${rows}
            <div style="margin-top:14px;opacity:.55;font-size:12px">
                插件启停需要重启 QQ 才完全生效；带「设置页」按钮的插件已把设置界面接入到左侧列表。宿主日志见 logs\\loader.log。
            </div>`;

        body.querySelector("#" + BODY_ID + "-plugins").onclick = () => window.MQGA.openPath && window.MQGA.openPath(paths.plugins || paths.root);
        body.querySelector("#" + BODY_ID + "-logs").onclick = () => window.MQGA.openPath && window.MQGA.openPath(paths.logs || paths.root);
        body.querySelector("#" + BODY_ID + "-refresh").onclick = () => showHostPage();
        body.querySelectorAll("button[data-enable]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const slug = btn.getAttribute("data-slug");
                const pluginApi = (window.MQGA && window.MQGA.api && window.MQGA.api.plugin) || {};
                try {
                    if (btn.getAttribute("data-enable") === "1") await pluginApi.enable?.(slug);
                    else await pluginApi.disable?.(slug);
                    btn.textContent = "重启后生效";
                    btn.disabled = true;
                    log("切换插件 " + slug + " 的启用状态");
                } catch (e) { log("切换插件失败: " + e); }
            });
        });
        body.querySelectorAll("button[data-reveal]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const p = info[btn.getAttribute("data-slug")];
                if (p && p.path && p.path.plugin && window.MQGA.openPath) window.MQGA.openPath(p.path.plugin);
            });
        });
        body.querySelectorAll("button[data-open]").forEach((btn) => {
            btn.addEventListener("click", () => selectPage(btn.getAttribute("data-open")));
        });
    }

    function bodyOf() {
        const view = document.getElementById(VIEW_ID);
        return view ? view.querySelector("#" + BODY_ID) : null;
    }

    function showHostPage() {
        const body = bodyOf();
        if (!body) return;
        if (!state.hostNode) {
            const host = document.createElement("div");
            host.id = BODY_ID + "-host";
            renderHostBody(host);
            state.hostNode = host;
        }
        body.innerHTML = "";
        body.appendChild(state.hostNode);
        state.current = "host";
        markActive(HOST_ITEM_ID);
        log("显示宿主面板");
    }

    function showPluginPage(slug) {
        const entry = state.pages[slug];
        const body = bodyOf();
        if (!entry || !body) return;
        body.innerHTML = "";
        body.appendChild(entry.page);
        entry.page.style.display = "block";
        state.current = slug;
        markActive(PLUGIN_ITEM_PREFIX + slug);
        setTimeout(() => { try { applyResponsiveLayout(true); } catch (e) { } }, 60);
        log("切到插件设置页: " + slug);
    }

    function selectPage(key) {
        const found = findSettings();
        if (found) showView(found);
        if (key === "host") showHostPage();
        else showPluginPage(key);
    }

    function markActive(id) {
        const nav = document.getElementById(NAV_ID);
        if (!nav) return;
        nav.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("nav-item-active"));
        const item = document.getElementById(id);
        if (item) item.classList.add("nav-item-active");
    }

    /* --------------------------- 窗口自适应（缩放/回流） --------------------------- */

    function applyResponsiveLayout(force) {
        const view = document.getElementById(VIEW_ID);
        const body = bodyOf();
        if (!view || !body) return null;
        const rect = view.getBoundingClientRect();
        const width = Math.floor(rect.width || view.clientWidth || 0);
        if (width <= 0) return null;
        body.style.padding = width >= 560 ? "18px 24px 40px" : "12px 12px 28px";
        const scaleMode = String((window.MQGA && window.MQGA.preferences && window.MQGA.preferences.ui_scale) || "auto").toLowerCase();
        const results = {};
        for (const slug of Object.keys(state.pages)) {
            const entry = state.pages[slug];
            const page = entry.page;
            if (!page) continue;
            const visible = page.parentElement && page.style.display !== "none";
            if (visible && !state.naturalWidths[slug]) {
                const prev = page.style.zoom;
                page.style.zoom = "1";
                const natural = Math.max(page.scrollWidth || 0, page.offsetWidth || 0);
                page.style.zoom = prev || "";
                if (natural > 240) state.naturalWidths[slug] = natural;
            }
            const natural = state.naturalWidths[slug] || REF_WIDTH;
            let zoom = 1;
            if (scaleMode !== "off" && natural > width && width > 0) {
                zoom = Math.max(MIN_ZOOM, Math.round((width / natural) * 100) / 100);
            }
            if (force || page.dataset.mqgaZoom !== String(zoom)) {
                page.style.zoom = zoom === 1 ? "" : String(zoom);
                page.dataset.mqgaZoom = String(zoom);
                if (zoom !== 1) results[slug] = zoom;
            }
            page.style.maxWidth = "100%";
        }
        if (Object.keys(results).length) log("自适应缩放: 可用宽=" + width + " 插件页=" + JSON.stringify(results));
        return { width, zoom: results };
    }

    /* ------------------------------ 显示 / 隐藏 ----------------------------- */

    function showView(found) {
        const view = document.getElementById(VIEW_ID);
        if (!view) return;
        if (found.qqView) found.qqView.style.display = "none";
        view.style.display = "block";
        state.active = true;
        applyResponsiveLayout(true);
        setTimeout(() => { try { applyResponsiveLayout(false); } catch (e) { } }, 400);
    }

    function hideView(found) {
        const view = document.getElementById(VIEW_ID);
        if (view) view.style.display = "none";
        if (found.qqView) found.qqView.style.display = "block";
        state.active = false;
        const nav = document.getElementById(NAV_ID);
        if (nav) nav.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("nav-item-active"));
    }

    function setTitle(found, text) {
        if (!found.title) return;
        const nodes = Array.from(found.title.childNodes);
        const textNode = nodes.reverse().find((n) => n.nodeType === 3 && n.nodeValue && n.nodeValue.trim());
        if (textNode) {
            if (state.titleBackup === null) state.titleBackup = textNode.nodeValue;
            textNode.nodeValue = " " + text;
        }
    }

    /* -------------------------------- 挂载 --------------------------------- */

    function mount() {
        if (state.mounted) return true;
        const found = findSettings();
        if (!found) return false;
        if (!found.tab.querySelector("#" + NAV_ID)) {
            ensureNavBar(found);
            const view = buildView();
            if (getComputedStyle(found.content).position === "static") found.content.style.position = "relative";
            found.content.appendChild(view);
            // 点击左栏：我们的项切换视图，QQ 的项交还控制权
            found.tab.addEventListener("click", (ev) => {
                const item = ev.target && ev.target.closest ? ev.target.closest(".nav-item") : null;
                if (!item) return;
                const fresh = findSettings() || found;
                if (item.closest("#" + NAV_ID)) {
                    const key = item.id === HOST_ITEM_ID ? "host"
                        : (item.id.startsWith(PLUGIN_ITEM_PREFIX) ? item.id.slice(PLUGIN_ITEM_PREFIX.length) : "host");
                    setTitle(fresh, item.querySelector(".name") ? item.querySelector(".name").textContent : LABEL);
                    selectPage(key);
                } else if (state.active) {
                    hideView(fresh);
                    if (fresh.title && state.titleBackup !== null) {
                        const nodes = Array.from(fresh.title.childNodes);
                        const textNode = nodes.reverse().find((n) => n.nodeType === 3 && n.nodeValue && n.nodeValue.trim());
                        if (textNode) textNode.nodeValue = state.titleBackup;
                    }
                }
            }, true);
        }
        initPluginPages(found);
        state.mounted = true;
        log("已在 QQ 设置左栏加入 " + LABEL + " 与插件设置项（原生项 " + found.navBar.querySelectorAll(".nav-item").length + " 个）");
        return true;
    }

    // 窗口尺寸变化（最大化/还原、拖拽边缘）时重算自适应缩放
    let resizeTimer = null;
    try {
        window.addEventListener("resize", () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { try { applyResponsiveLayout(false); } catch (e) { } }, 150);
        });
    } catch (e) { /* 忽略 */ }

    const observer = new MutationObserver(() => { try { mount(); } catch (e) { log("mount 异常: " + e); } });
    function boot() {
        try { mount(); } catch (e) { log("首次 mount 异常: " + e); }
        try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { }
        setInterval(() => { try { mount(); } catch (e) { } }, 2000);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
})();
