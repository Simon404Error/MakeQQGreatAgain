/**
 * MGQA 的设置界面引导：把 LiteLoaderQQNT 的渲染层原样跑起来。
 *
 * 直接 import LQ 的源码（除下面注明的两处外未做改动）：
 *   · renderer/components/renderer.js  —— 定义 setting-section / -panel / -list / -item / -switch /
 *                                        -button / -text / -link / -select / -option / -divider / -modal
 *   · renderer/hook.js                 —— Vue 组件钩子
 *   · renderer/runtime.js              —— Runtime 注册表
 *   · renderer/triggers/renderer.js    —— 触发器注册表（watchHash + watchElement -> action）
 *   · renderer/settings/renderer.js    —— initView / initPluginList / initPath
 *   · triggers/selector/setting.js     —— 建侧栏 + 内容容器（MGQA 版改了面板名，并导出了 addPluginTab）
 */
import "./renderer/components/renderer.js";
import "./renderer/triggers/renderer.js";
import { installHook } from "./renderer/hook.js";
import { Runtime } from "./renderer/runtime.js";
import { initView, appropriateIcon } from "./renderer/settings/renderer.js";
import { addPluginTab } from "./renderer/triggers/selector/setting.js";

installHook();

// 主世界里读插件信息要用 window.MQGA.plugins（pluginsInfo 是主进程侧 API）
const pluginsOf = () => (globalThis.MQGA && (globalThis.MQGA.plugins || (typeof globalThis.MQGA.pluginList === "function" ? globalThis.MQGA.pluginList() : {}))) || {};

/** 把一个插件的 renderer 段注册进 LQ 的 Runtime；面板已经建好时顺便补一个左栏条目 */
function registerPlugin(slug, exports) {
    if (!exports || typeof exports.onSettingWindowCreated !== "function") return false;
    const plugin = pluginsOf()[slug] || { manifest: { slug, name: slug, type: "extension" }, path: { plugin: "" } };
    Runtime.registerPlugin(plugin, exports);
    // 面板已经存在（说明 trigger 早就跑完了）→ 立刻补条目，否则等 trigger 自己加
    if (document.querySelector(".nav-bar.liteloader")) {
        try { addPluginTab(plugin); } catch (e) { console.warn("[MQGA] 追加插件面板项失败:", e); }
    }
    return true;
}

// 1) 注入时已经注册过的插件（宿主预加载已经执行完 renderer 段的那批）
for (const [slug, exports] of Object.entries(globalThis.__MQGA_RENDERER_EXPORTS__ || {})) {
    registerPlugin(slug, exports);
}

// 2) 之后才加载完的插件 renderer 段（原生 import 是异步的）—— 宿主会回调这里
globalThis.__MQGA_LQ_REGISTER__ = (slug, exports) => registerPlugin(slug, exports);

// 3) 自愈：面板建好之后，只要某个插件的 renderer 段已经注册进 __MQGA_RENDERER_EXPORTS__，
//    左栏就必须有它的条目。插件是异步加载的、窗口还会 reload（安装后自动刷新），
//    任何时序错位都可能漏掉条目 —— 这里每秒对账一次，缺了就补。
function reconcile() {
    try {
        const bar = document.querySelector(".nav-bar.liteloader");
        if (!bar) return;   // 面板还没建起来，等 trigger 自己建
        const registry = globalThis.__MQGA_RENDERER_EXPORTS__ || {};
        for (const slug of Object.keys(registry)) {
            if (bar.querySelector('[data-slug="' + slug + '"]')) continue;
            registerPlugin(slug, registry[slug]);
        }
    } catch (e) { /* 忽略 */ }
}
setInterval(reconcile, 1000);

globalThis.__MQGA_LQ__ = { Runtime, initView, appropriateIcon, registerPlugin, reconcile };

// 自检：3 秒后报告面板状态（写进 logs\loader.log，不必开 UI 就能定位）
function probe() {
    try {
        const bar = document.querySelector(".nav-bar.liteloader");
        const names = bar ? [...bar.querySelectorAll(".nav-item .name")].map((n) => n.textContent).join(" | ") : "";
        const view = document.querySelector(".q-scroll-view.liteloader");
        const sections = view ? view.querySelectorAll("setting-section").length : 0;
        const msg = "[MQGA-LQ] hash=" + location.hash
            + " nav-bar=" + (bar ? bar.querySelectorAll(".nav-item").length + "项[" + names + "]" : "无")
            + " view=" + (view ? "有" : "无")
            + " sections=" + sections;
        if (globalThis.MQGA && typeof globalThis.MQGA.debugLog === "function") globalThis.MQGA.debugLog(msg);
        else console.log(msg);
    } catch (e) { /* 忽略 */ }
}
setTimeout(probe, 3000);
