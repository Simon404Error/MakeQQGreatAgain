/**
 * MakeQQGreatAgain 预加载脚本（渲染进程侧）。
 * 运行在 Electron 隔离世界：可能处于 sandbox 环境（没有 fs/path），因此所有文件读取都走 IPC。
 * 职责：
 *   1. 从主进程取回宿主/插件信息，向页面主世界暴露 MQGA 与 LiteLoader（兼容层）
 *   2. 在隔离世界执行插件的 preload 段（自带迷你模块系统，兼容 require("./x.js")）
 *   3. 在页面主世界执行插件的 renderer 段
 */
const { ipcRenderer, contextBridge, webFrame } = require("electron");

// 预加载命中标记（最先执行，用于诊断注入是否生效）
try {
    ipcRenderer.sendSync("mqga.preloadHit", { url: location.href, pid: process.pid, type: process.type });
} catch (e) { /* 忽略 */ }

const sync = (path, args = []) => ipcRenderer.sendSync("mqga.sync", path, args);
const readText = (file) => ipcRenderer.sendSync("mqga.readText", file);
const exists = (file) => ipcRenderer.sendSync("mqga.exists", file);
const writeText = (file, content) => ipcRenderer.sendSync("mqga.writeText", file, content);

/* ------------------------------- 迷你路径工具 ------------------------------ */

const PathU = {
    isAbsolute(p) { return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\"); },
    normalize(p) {
        const win = /^[a-zA-Z]:/.test(p);
        const prefix = win ? p.slice(0, 2) : p.startsWith("/") ? "" : "";
        const rest = win ? p.slice(2) : p;
        const stack = [];
        for (const part of rest.split(/[\\/]+/)) {
            if (!part || part === ".") continue;
            if (part === "..") stack.pop();
            else stack.push(part);
        }
        return (win ? prefix + "\\" : p.startsWith("/") ? "/" : "") + stack.join("\\");
    },
    dirname(p) {
        const norm = PathU.normalize(p);
        const idx = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
        return idx <= 0 ? norm : norm.slice(0, idx);
    },
    join(base, rel) {
        if (PathU.isAbsolute(rel)) return PathU.normalize(rel);
        return PathU.normalize(base + "\\" + rel);
    },
};

/* ---------------------------- 插件信息的同步获取 ---------------------------- */

let info = { plugins: {}, paths: {}, versions: {} };
try {
    info = Object.assign(info, sync(["info"], []));
} catch (e) {
    console.error("[MQGA] 获取宿主信息失败", e);
}

const apiMethods = {
    config: {
        get: async (...args) => sync(["config", "get"], args),
        set: async (...args) => sync(["config", "set"], args),
    },
    plugin: {
        install: async (...args) => sync(["plugin", "install"], args),
        delete: async (...args) => sync(["plugin", "delete"], args),
        disable: async (...args) => sync(["plugin", "disable"], args),
        enable: async (...args) => sync(["plugin", "enable"], args),
    },
    openExternal: async (...args) => sync(["openExternal"], args),
    openPath: async (...args) => sync(["openPath"], args),
    log: async (...args) => sync(["log"], args),
};

const mqgaObject = {
    api: apiMethods,
    loader: info.loader || {},
    path: info.paths || {},
    paths: info.paths || {},
    versions: info.versions || {},
    plugins: info.plugins || {},
    preferences: info.preferences || {},
    pluginList: () => info.plugins || {},
    readText: (file) => readText(file),
    debugLog: (msg) => { try { sync(["log"], ["renderer: " + String(msg)]); } catch (e) { } },
    exists: (file) => exists(file),
    writeText: (file, content) => writeText(file, content),
};

/* --------------------------------- 主世界暴露 ------------------------------- */

function expose(key, value) {
    try {
        if (typeof contextBridge?.executeInMainWorld === "function") {
            const already = contextBridge.executeInMainWorld({ func: (k) => k in globalThis, args: [key] });
            if (already) return;
        }
        contextBridge.exposeInMainWorld(key, value);
    } catch (e) {
        console.error("[MQGA] 暴露 " + key + " 失败", e);
    }
}

expose("MQGA", mqgaObject);
expose("LiteLoader", {
    ...mqgaObject,
    api: apiMethods,
});

function reportError(stage, target, error) {
    const text = `[${new Date().toISOString()}] ${stage} ${target}\n${String((error && error.stack) || error)}\n`;
    try { console.error("[MQGA] " + text); } catch (e) { /* 忽略 */ }
    try {
        const root = info?.paths?.root;
        if (root) writeText(root + "\\logs\\renderer-error.log", text);
    } catch (e) { /* 忽略 */ }
}

/**
 * 把打包器输出的 ESM 语法改写成可被普通脚本执行的 CommonJS 形式。
 * 覆盖 esbuild / rollup 常见的三种写法：export{a as b,...}、export default、export const/function
 */
function esmToCjs(source) {
    let out = source;
    out = out.replace(/\bexport\s*\{([^}]*)\}\s*;?/g, (all, list) => {
        const assigns = list.split(",").map((part) => {
            const item = part.trim();
            if (!item) return "";
            const renamed = item.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
            const local = renamed ? renamed[1] : item;
            const exported = renamed ? renamed[2] : item;
            return `try{module.exports[${JSON.stringify(exported)}]=${local};}catch(e){}`;
        }).join("");
        return assigns;
    });
    out = out.replace(/\bexport\s+default\s+/g, "module.exports.default=");
    out = out.replace(/\bexport\s+(const|let|var|function|class)\s+/g, "$1 ");
    return out;
}

// 启动时立即注入 Vue 组件钩子（LiteLoaderQQNT 插件的 onVueComponentMount/Unmount 依赖它）
// 渲染进程 console / 未捕获异常 -> 宿主日志（受 debug_console 控制，便于排查插件报错）
function loadConsoleBridge() {
    if (!info?.preferences?.debug_console) return;
    const src = `(function(){
        if (window.__MQGA_CONSOLE_BRIDGE__) return;
        window.__MQGA_CONSOLE_BRIDGE__ = true;
        function send(level, args) {
            try {
                var M = window.MQGA;
                if (!M || !M.debugLog) return;
                var text = Array.prototype.slice.call(args).map(function (a) {
                    try { return typeof a === "string" ? a : JSON.stringify(a); } catch (e) { return String(a); }
                }).join(" ");
                M.debugLog("[" + level + "] " + text);
            } catch (e) { }
        }
        ["log", "warn", "error", "info"].forEach(function (level) {
            var orig = console[level];
            if (typeof orig !== "function") return;
            console[level] = function () {
                send(level, arguments);
                return orig.apply(console, arguments);
            };
        });
        window.addEventListener("error", function (e) { send("error", [String(e.message) + " @" + (e.filename || "?") + ":" + (e.lineno || 0)]); });
        window.addEventListener("unhandledrejection", function (e) { send("error", ["unhandledrejection: " + ((e.reason && e.reason.stack) || e.reason)]); });
    })();`;
    runInMainWorld(src, "mqga-console-bridge.js", "mqga-console-bridge");
}
function loadVueHook() {
    try {
        const root = info?.paths?.root;
        if (!root) return;
        const source = readText(root + "\\src\\renderer-hooks.js");
        if (source) runInMainWorld(source, root + "\\src\\renderer-hooks.js", "mqga-renderer-hooks");
    } catch (e) {
        console.error("[MQGA] 注入 Vue 钩子失败", e);
    }
}
function runInMainWorld(source, filename, slug) {
    // 优先使用 webFrame.executeJavaScript：由 Electron 原生注入，不受页面 CSP 限制
    // 统一包装成 CommonJS 模块：ESM 语法先改写，异常作为返回值带回，便于定位真实错误
    const safeName = filename.replace(/\\/g, "\\\\");
    const exportKey = String(slug || filename).replace(/[^A-Za-z0-9_$-]/g, "_");
    const wrapped =
        ";(async function(){try{\n" +
        "var module={exports:{}};var exports=module.exports;\n" +
        esmToCjs(source) +
        "\ntry{window.__MQGA_RENDERER_EXPORTS__=window.__MQGA_RENDERER_EXPORTS__||{};" +
        "window.__MQGA_RENDERER_EXPORTS__[" + JSON.stringify(exportKey) + "]=module.exports;}catch(e){}\n" +
        "return {ok:true,keys:Object.keys(module.exports||{})};\n" +
        "}catch(e){return {ok:false,error:'[MQGA-RENDERER-ERR] " + safeName + " :: '+((e&&e.stack)||e)};}})();\n" +
        "//# sourceURL=" + filename;
    const useExecuteFirst = String(info?.preferences?.renderer_inject || "webframe").toLowerCase() === "execute";
    const handleResult = (result) => {
        if (result && typeof result === "object" && result.ok === false) {
            reportError("renderer段异常", filename, result.error);
        } else if (result && typeof result === "object" && result.ok) {
            try { sync(["log"], ["renderer段已执行: " + (slug || filename) + " exports=" + JSON.stringify(result.keys || [])]); } catch (e) { }
        } else if (typeof result === "string" && result.startsWith("[MQGA-RENDERER-ERR]")) {
            reportError("renderer段异常（捕获）", filename, result);
        }
    };
    try {
        if (!useExecuteFirst && webFrame && typeof webFrame.executeJavaScript === "function") {
            const promise = webFrame.executeJavaScript(wrapped, true);
            if (promise && typeof promise.then === "function") {
                promise.then(handleResult).catch((e) => reportError("renderer段异常", filename, e));
            }
            return true;
        }
    } catch (e) {
        reportError("renderer段注入失败", filename, e);
    }
    // 退回 contextBridge.executeInMainWorld
    const runner = (src, name) => {
        try {
            const module = { exports: {} };
            const factory = new Function("module", "exports", "require", "__filename", "__dirname", "MQGA", "LiteLoader", src);
            factory(module, module.exports, () => { throw new Error("renderer 段暂不支持 require"); }, name, name.replace(/[\\/][^\\/]*$/, ""), globalThis.MQGA, globalThis.LiteLoader || globalThis.MQGA);
            return { ok: true, keys: Object.keys(module.exports || {}) };
        } catch (e) {
            return { ok: false, error: String((e && e.stack) || e) };
        }
    };
    try {
        if (typeof contextBridge?.executeInMainWorld === "function") {
            const result = contextBridge.executeInMainWorld({ func: runner, args: [esmToCjs(source), filename] });
            handleResult(result);
            return !!(result && result.ok);
        }
    } catch (e) {
        reportError("renderer段注入失败", filename, e);
    }
    return false;
}

/* ----------------------------- 插件 preload 段执行 --------------------------- */

const moduleCache = new Map();

function makeRequire(baseDir) {
    return function mqgaRequire(id) {
        if (id === "electron") return require("electron");
        if (id.startsWith("mqga") || id === "path" || id === "fs") {
            try { return require(id); } catch (e) { /* sandbox 下不可用，继续尝试相对解析 */ }
        }
        let tried = false;
        if (!PathU.isAbsolute(id) && !id.startsWith(".")) {
            try { return require(id); } catch (e) { tried = true; }
            if (tried) throw new Error("无法加载外部模块: " + id);
        }
        const base = PathU.join(baseDir, id);
        for (const ext of ["", ".js", ".json", ".node"]) {
            const file = base + ext;
            if (!exists(file)) continue;
            if (ext === ".json") return JSON.parse(readText(file));
            if (moduleCache.has(file)) return moduleCache.get(file).exports;
            const source = readText(file);
            if (source === null) throw new Error("读取失败: " + file);
            const module = { exports: {} };
            moduleCache.set(file, module);
            const factory = new Function(
                "module", "exports", "require", "__filename", "__dirname", "MQGA", "LiteLoader",
                source + "\n//# sourceURL=" + file
            );
            try {
                factory(module, module.exports, makeRequire(PathU.dirname(file)), file, PathU.dirname(file), mqgaObject, mqgaObject);
            } catch (e) {
                moduleCache.delete(file);
                throw e;
            }
            return module.exports;
        }
        throw new Error("模块不存在: " + id + " (from " + baseDir + ")");
    };
}

function loadPluginPreloads() {
    for (const plugin of Object.values(info.plugins || {})) {
        if (plugin.disabled || plugin.incompatible) continue;
        const file = plugin.path?.injects?.preload;
        if (!file) continue;
        try {
            const source = readText(file);
            if (source === null) {
                console.error("[MQGA] 无法读取插件 preload: " + file);
                continue;
            }
            const module = { exports: {} };
            const factory = new Function(
                "module", "exports", "require", "__filename", "__dirname", "MQGA", "LiteLoader",
                source + "\n//# sourceURL=" + file
            );
            factory(module, module.exports, makeRequire(PathU.dirname(file)), file, PathU.dirname(file), mqgaObject, mqgaObject);
            try { sync(["log"], ["preload段已执行: " + plugin.manifest.slug]); } catch (e) { }
        } catch (e) {
            console.error("[MQGA] preload 段异常 [" + plugin.manifest?.slug + "]", e);
        }
    }
}

/* ---------------------------- 插件 renderer 段执行 --------------------------- */

function loadRendererScripts() {
    let list = [];
    try {
        list = ipcRenderer.sendSync("mqga.sync", ["rendererScripts"], []) || [];
    } catch (e) {
        console.error("[MQGA] 获取 renderer 段列表失败", e);
    }
    for (const item of list) {
        if (!item?.source) continue;
        const result = runInMainWorld(item.source, item.file, item.slug);
        console.log("[MQGA] renderer 段已注入: " + item.slug);
        void result;
    }
}

// 宿主自带脚本：设置界面注入（+ 可选 DOM 转储，便于适配新版 QQ）
function loadHostScripts() {
    const root = info?.paths?.root;
    if (!root) return;
    try {
        const settingsUi = readText(root + "\\src\\settings-ui.js");
        if (settingsUi) runInMainWorld(settingsUi, root + "\\src\\settings-ui.js");
    } catch (e) {
        console.error("[MQGA] 注入设置界面脚本失败", e);
    }
    if (info?.preferences?.dom_dump) {
        const openSettings = !!info?.preferences?.open_settings;
        const dumper = `(function(){
            var openSettings = ${openSettings ? "true" : "false"};
            function write(name, text) {
                try {
                    var M = window.MQGA;
                    if (M && M.writeText && M.paths && M.paths.root) M.writeText(M.paths.root + "\\\\logs\\\\dom\\\\" + name, text);
                } catch (e) { }
            }
            function snap(tag) {
                try {
                    var base = location.href.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
                    write(base + "_" + tag + ".html", document.documentElement.outerHTML);
                } catch (e) { }
            }
            function navReport() {
                try {
                    var out = [];
                    var all = document.querySelectorAll("div,ul,nav");
                    for (var i = 0; i < all.length; i++) {
                        var el = all[i];
                        var kids = el.children;
                        if (kids.length < 3) continue;
                        var rects = [];
                        var n = Math.min(kids.length, 8);
                        for (var k = 0; k < n; k++) rects.push(kids[k].getBoundingClientRect());
                        var ok = true;
                        for (var k2 = 0; k2 < rects.length; k2++) if (rects[k2].height < 18 || rects[k2].width < 60) ok = false;
                        if (!ok) continue;
                        var h0 = Math.round(rects[0].height);
                        for (var k3 = 0; k3 < rects.length; k3++) if (Math.abs(Math.round(rects[k3].height) - h0) > 6) ok = false;
                        if (!ok) continue;
                        var er = el.getBoundingClientRect();
                        out.push({
                            cls: String(el.className).slice(0, 120),
                            tag: el.tagName,
                            w: Math.round(er.width), h: Math.round(er.height), x: Math.round(er.x), y: Math.round(er.y),
                            items: Array.prototype.slice.call(kids, 0, 8).map(function (c) { return String(c.textContent || "").trim().slice(0, 24); })
                        });
                    }
                    var base = location.href.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
                    write(base + "_nav.json", JSON.stringify({ url: location.href, candidates: out }, null, 1));
                } catch (e) { }
            }
            snap("t0");
            setTimeout(function () { snap("t4"); navReport(); }, 4000);
            setTimeout(function () { snap("t9"); navReport(); }, 9000);
            var last = location.href, count = 0;
            setInterval(function () {
                try {
                    if (location.href !== last && count < 8) {
                        last = location.href; count++;
                        setTimeout(function () { snap("r" + count); navReport(); }, 1500);
                    }
                } catch (e) { }
            }, 1500);
            if (openSettings && location.href.indexOf("#/main/message") >= 0) {
                setTimeout(function () {
                    try { location.hash = "#/setting/settings/common"; write("open-settings.txt", new Date().toISOString()); } catch (e) { }
                }, 6000);
            }
        })();`;
        runInMainWorld(dumper, "mqga-dom-dump.js");
    }
}

// 立即安装（不等待 DOMContentLoaded）
setTimeout(loadVueHook, 0);
setTimeout(loadConsoleBridge, 0);

let started = false;
function startRenderer() {
    if (started) return;
    started = true;
    loadPluginPreloads();
    loadRendererScripts();
    loadHostScripts();
    // 诊断：确认主世界里的插件 renderer 导出登记表已生效（contextBridge 暴露的对象是只读代理，
    // 因此登记表必须挂在普通全局变量上）
    setTimeout(() => {
        const probe = `(function(){try{
            var map = window.__MQGA_RENDERER_EXPORTS__ || {};
            var out = {};
            Object.keys(map).forEach(function (k) { out[k] = Object.keys(map[k] || {}); });
            return { registry: out, liteLoaderSeen: ("LiteLoader" in window), mqgaSeen: ("MQGA" in window) };
        }catch(e){return {error:String(e)};}})();`;
        try {
            const result = webFrame && webFrame.executeJavaScript ? webFrame.executeJavaScript(probe, true) : null;
            if (result && result.then) {
                result.then((r) => {
                    try { sync(["log"], ["主世界导出登记表: " + JSON.stringify(r)]); } catch (e) { }
                }).catch(() => { });
            }
        } catch (e) { /* 忽略 */ }
    }, 3000);
    // 诊断：验证渲染进程的 fetch("local://...") 是否可用（LiteLoaderQQNT 插件读自身资源靠它）
    if (info?.preferences?.net_probe) {
        setTimeout(() => {
            let probe2 = "";
            try {
                const sample = "local:///" + (info.paths.root + "\\package.json");
                probe2 = "(async function(){try{var url=" + JSON.stringify(sample) +
                    ";var r=await fetch(url);var t=await r.text();return {ok:r.ok,status:r.status,len:t.length};}" +
                    "catch(e){return {error:String(e)};}})();";
            } catch (e) { return; }
            try {
                const out = webFrame && webFrame.executeJavaScript ? webFrame.executeJavaScript(probe2, true) : null;
                if (out && out.then) {
                    out.then((r) => { try { sync(["log"], ["local:// fetch 探测: " + JSON.stringify(r)]); } catch (e) { } })
                        .catch((e) => { try { sync(["log"], ["local:// fetch 探测异常: " + e]); } catch (err) { } });
                }
            } catch (e) { /* 忽略 */ }
        }, 4000);
    }
}

if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", startRenderer, { once: true });
    // 兜底：部分页面 DOMContentLoaded 很晚，插件仍需尽早拿到 preload 能力
    setTimeout(startRenderer, 3000);
} else {
    startRenderer();
}
