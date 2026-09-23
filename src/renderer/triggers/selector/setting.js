import { Runtime } from "../../runtime.js"
import { initView, appropriateIcon } from "../../settings/renderer.js";

const liteloader_nav_bar = document.createElement("div");
const liteloader_setting_view = document.createElement("div");

function init() {
    const setting_view = document.querySelector(".setting-main .q-scroll-view");
    const setting_title = document.querySelector(".setting-main .setting-title");
    liteloader_nav_bar.classList.add("nav-bar", "liteloader");
    liteloader_setting_view.classList.add("q-scroll-view", "scroll-view--show-scrollbar", "liteloader");
    liteloader_setting_view.style.display = "none";
    document.querySelector(".setting-tab").append(liteloader_nav_bar);
    document.querySelector(".setting-main .setting-main__content").append(liteloader_setting_view);
    document.querySelector(".setting-tab").addEventListener("click", event => {
        const nav_item = event.target.closest(".nav-item");
        if (nav_item) {
            // 内容显示
            if (nav_item.parentElement.classList.contains("liteloader")) {
                setting_view.style.display = "none";
                liteloader_setting_view.style.display = "block";
            }
            else {
                setting_view.style.display = "block";
                liteloader_setting_view.style.display = "none";
            }
            // 重新设定激活状态
            document.querySelectorAll(".setting-tab .nav-item").forEach(element => {
                element.classList.remove("nav-item-active");
            });
            nav_item.classList.add("nav-item-active");
            syncTitle();
        }
    });

    // MGQA: 标题同步。
    // QQ 的路由在进入设置时会把当前页名（例如「通用」）写进 .setting-title 的文本节点，
    // 于是标题会变成 "MGQA Ctrl通用"。只要激活的是我们自己的导航项，就持续把标题同步成它的名字，
    // 这样"通用"两个字不会再出现（路由改一次我们就改回来）。
    function syncTitle() {
        try {
            const active = document.querySelector(".nav-bar.liteloader .nav-item.nav-item-active");
            if (!active) return;
            const nameEl = active.querySelector(".name");
            const title = document.querySelector(".setting-main .setting-title");
            const name = nameEl && nameEl.textContent;
            if (!name || !title) return;
            if (title.textContent.trim() === name) return;
            let wrote = false;
            [...title.childNodes].forEach((node) => {
                if (node.nodeType === 3) {
                    node.textContent = wrote ? "" : name;
                    wrote = true;
                }
            });
            if (!wrote) title.append(document.createTextNode(name));
        } catch (e) { /* 忽略 */ }
    }
    syncTitle();
    setInterval(syncTitle, 400);
}

function add(plugin) {
    const default_thumb = `local://root/src/common/static/default.svg`;
    const plugin_thumb = `local:///${plugin.path.plugin}/${plugin.manifest?.thumb}`;
    const thumb = plugin.manifest.thumb ? plugin_thumb : default_thumb;
    const nav_item = document.querySelector(".setting-tab .nav-item").cloneNode(true);
    const view = document.createElement("div");
    nav_item.classList.remove("nav-item-active");
    nav_item.setAttribute("data-slug", plugin.manifest.slug);
    appropriateIcon(thumb).then(async text => nav_item.querySelector(".q-icon").innerHTML = text);
    nav_item.querySelector(".name").textContent = plugin.manifest.name;
    nav_item.addEventListener("click", event => {
        if (!event.currentTarget.classList.contains("nav-item-active")) {
            liteloader_setting_view.textContent = null;
            liteloader_setting_view.append(view);
        }
    });
    liteloader_nav_bar.append(nav_item);
    view.classList.add("tab-view", plugin.manifest.slug);
    return view;
}

export default {
    hash: "#/setting",
    selector: ".setting-tab .nav-bar",
    action() {
        init();
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = "local://root/src/renderer/settings/style.css";
        document.head.append(link);
        const view = add({
            manifest: {
                slug: "config_view",
                // MGQA: 只有这一处改了名字（upstream 写的是 "LiteLoaderQQNT"），其余逻辑原样
                name: "MGQA Ctrl"
            },
            path: {
                plugin: LiteLoader.path.root
            }
        });
        fetch("local://root/src/renderer/settings/view.html")
            .then(res => res.text())
            .then(html => initView(view, html));
        Runtime.triggerHooks("onSettingWindowCreated", (plugin) => [add(plugin)]);
    }
}

// MGQA: 把 add() 暴露出去。插件 renderer 段现在是原生动态 import 异步加载的，
// 有可能在面板已经建好之后才注册进 Runtime —— 那时需要能立刻补一个左栏条目。
export function addPluginTab(plugin) {
    try {
        return add(plugin);
    } catch (e) {
        console.warn("[MQGA] addPluginTab failed:", e);
        return null;
    }
}