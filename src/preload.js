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

/**
 * 登录窗口保护。
 * QQ 的账密登录依赖「安全登录控件」（TSSafeEdit.dat + SSOShareInfoHelper），
 * 该控件对渲染进程环境很敏感；宿主在主世界包装 Proxy / 改写 console / 注入插件脚本
 * 会让它自检失败，弹出「QQ安全登录控件被破坏……建议重新安装QQ」。
 * 因此在 login.html / passport 页面上不注入任何宿主或插件脚本，只保留注入命中登记。
 * 如确需在登录页调试，可在 data\loader.json 里设 protect_login: false 关闭该保护。
 */
let MQGA_AUTH_PAGE = (() => {
    try {
        const href = String(location.href || "");
        if (/login\.html|passport\.qq\.com|ptlogin|\.ssologin|#\/login/i.test(href)) return true;
    } catch (e) { /* 忽略 */ }
    try {
        if (/login\.html|passport\.qq\.com/i.test((process.argv || []).join(" "))) return true;
    } catch (e) { /* 忽略 */ }
    try {
        if (globalThis.__MQGA_PROTECT_LOGIN__ === false) return false;
        if (globalThis.__MQGA_FORCE_INJECT__ === true) return false;
    } catch (e) { /* 忽略 */ }
    return false;
})();
if (MQGA_AUTH_PAGE) {
    try {
        ipcRenderer.sendSync("mqga.sync", ["log"], ["登录窗口：跳过 MGQA 注入（保护 QQ 安全登录控件） url=" + location.href]);
    } catch (e) { /* 忽略 */ }
}

// 宿主「刷新」：重新扫描插件后，让本帧重新注入插件 preload / renderer 段
try {
    ipcRenderer.on("mqga.rerun", () => {
        if (MQGA_AUTH_PAGE) return;
        try { moduleCache.clear(); } catch (e) { /* 忽略 */ }
        try { sync(["log"], ["收到重载请求：重新注入插件 preload / renderer 段"]); } catch (e) { }
        try { loadPluginPreloads(); } catch (e) { console.error("[MQGA] 重新执行 preload 段失败", e); }
        try { loadRendererScripts(); } catch (e) { console.error("[MQGA] 重新注入 renderer 段失败", e); }
        try {
            webFrame.executeJavaScript("(function(){try{if(window.__MQGA_RESET_PAGES__)window.__MQGA_RESET_PAGES__();}catch(e){}})();", true);
        } catch (e) { /* 忽略 */ }
    });
} catch (e) { /* 忽略 */ }
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

// 登录页保护可在 data\loader.json 里用 protect_login: false 关闭（默认开启）
if (MQGA_AUTH_PAGE && info?.preferences?.protect_login === false) {
    MQGA_AUTH_PAGE = false;
    try { sync(["log"], ["登录窗口保护已被配置关闭（protect_login: false）"]); } catch (e) { /* 忽略 */ }
}

const apiMethods = {
    config: {
        get: async (...args) => sync(["config", "get"], args),
        set: async (...args) => sync(["config", "set"], args),
    },
    plugin: {
        install: async (...args) => sync(["plugin", "install"], args),
        // LiteLoaderQQNT 的签名是 delete(slug, [self, data], now)；
        // 本宿主用 delete(slug, { mode }) —— 这里做一次转译，保证 LQ 的面板代码原样可用。
        delete: async (slug, options, now) => {
            if (Array.isArray(options)) {
                const [self, data] = options;
                const mode = self && data ? "all" : (self ? "plugin" : (data ? "data" : "data"));
                return sync(["plugin", "delete"], [slug, { mode, self: !!self, data: !!data, now: now !== false }]);
            }
            return sync(["plugin", "delete"], [slug, options || {}]);
        },
        uninstall: async (slug, options) => sync(["plugin", "delete"], [slug, options || {}]),
        pickAndInstall: async (mode) => sync(["pickAndInstallPlugin"], [mode]),
        // 面板里「安装文件夹」那一行用的（LQ 的 view.html 没有这行，是 MGQA 加的）
        pickAndInstallFolder: async () => sync(["pickAndInstallPlugin"], ["folder"]),
        installFromPath: async (source, options) => sync(["installPluginFromPath"], [source, options || {}]),
        // Electron 32+ 删除了 File.path：主世界的 File 要经预加载的 webUtils 换出真实路径
        getPathForFile: (file) => {
            try {
                const electron = require("electron");
                if (electron.webUtils && typeof electron.webUtils.getPathForFile === "function") {
                    return electron.webUtils.getPathForFile(file) || "";
                }
            } catch (e) { /* 忽略 */ }
            return "";
        },
        setLoaderConfig: async (patch) => sync(["setLoaderConfig"], [patch || {}]),
        disable: async (...args) => sync(["plugin", "disable"], args),
        enable: async (...args) => sync(["plugin", "enable"], args),
    },
    openExternal: async (...args) => sync(["openExternal"], args),
    openPath: async (...args) => sync(["openPath"], args),
    log: async (...args) => sync(["log"], args),
    reloadPlugins: async () => sync(["reloadPlugins"], []),
    setLoaderConfig: async (patch) => sync(["setLoaderConfig"], [patch || {}]),
    installPluginFromPath: async (source, options) => sync(["installPluginFromPath"], [source, options || {}]),
    pickAndInstallPlugin: async (mode) => sync(["pickAndInstallPlugin"], [mode]),
};

// LiteLoaderQQNT 兼容字段：LQ 的渲染层会读 LiteLoader.versions.* / LiteLoader.package.liteloader.repository
const hostVersion = (info.loader && info.loader.version) || (info.versions && info.versions.mqga) || "?";
const liteLoaderCompat = {
    os: (info && info.os) || { platform: "win32" },
    package: {
        liteloader: {
            version: hostVersion,
            repository: { type: "git", url: "https://github.com/Simon404Error/MakeQQGreatAgain.git" },
        },
        qqnt: { version: (info.versions && info.versions.qqnt) || "?" },
    },
};
// LQ 的面板要求 versions.liteloader / qqnt / electron / chrome / node
const compatVersions = Object.assign({}, info.versions || {}, {
    liteloader: hostVersion,
    mqga: hostVersion,
});

const mqgaObject = {
    api: apiMethods,
    loader: info.loader || {},
    path: info.paths || {},
    paths: info.paths || {},
    versions: compatVersions,
    plugins: info.plugins || {},
    preferences: info.preferences || {},
    os: liteLoaderCompat.os,
    package: liteLoaderCompat.package,
    pluginList: () => info.plugins || {},
    openPath: (target) => apiMethods.openPath(target),
    openExternal: (url) => apiMethods.openExternal(url),
    reloadPlugins: () => apiMethods.reloadPlugins(),
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

if (!MQGA_AUTH_PAGE) {
    expose("MQGA", mqgaObject);
    expose("LiteLoader", {
        ...mqgaObject,
        api: apiMethods,
    });
}

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
/* ---- ESM-TO-CJS-START ---- */
function esmToCjs(source) {
    let out = source;
    // export const/let/var/function/class NAME -> 去掉 export，并在模块末尾补上 module.exports 赋值
    const named = [];
    out = out.replace(/\bexport\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g, (all, kind, name) => {
        named.push(name);
        return `${kind} ${name}`;
    });
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
    if (named.length) {
        out += "\n;" + named.map((n) => `try{module.exports[${JSON.stringify(n)}]=${n};}catch(e){}`).join("");
    }
    return out;
}

/* ---- ESM-TO-CJS-END ---- */
// 启动时立即注入 Vue 组件钩子（LiteLoaderQQNT 插件的 onVueComponentMount/Unmount 依赖它）
// 渲染进程 console / 未捕获异常 -> 宿主日志（受 debug_console 控制，便于排查插件报错）
function loadConsoleBridge() {
    if (!info?.preferences?.debug_console) {
        try { sync(["log"], ["console 桥未启用（loader.json 的 debug_console=false）"]); } catch (e) { /* 忽略 */ }
        return;
    }
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
                M.debugLog("[pid:" + process.pid + "] [" + level + "] " + text);
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
    setTimeout(() => {
        try {
            const probe = webFrame && webFrame.executeJavaScript
                ? webFrame.executeJavaScript("(function(){return !!window.__MQGA_CONSOLE_BRIDGE__})()", true)
                : null;
            if (probe && probe.then) {
                probe.then((ok) => { try { sync(["log"], ["console 桥安装结果: " + ok + " (" + location.href.slice(0, 48) + ")"]); } catch (e) { /* 忽略 */ } })
                    .catch(() => { });
            }
        } catch (e) { /* 忽略 */ }
    }, 1500);
}
function loadVueHook() {
    // Vue 组件钩子由 LiteLoaderQQNT 的 renderer/hook.js 提供（见 loadHostScripts 里的 lq.bundle.js）。
    // 这里不再注入宿主自己那份 renderer-hooks.js，避免同一个 Proxy 被包装两次、插件的
    // onVueComponentMount / onVueComponentUnmount 被重复触发。
    try {
        const root = info?.paths?.root;
        if (!root) return;
    } catch (e) {
        console.error("[MQGA] Vue 钩子准备失败", e);
    }
}
/* ------------------- 插件 renderer 段的 ESM 支持（LiteLoaderQQNT 生态） -------------------
 * 很多插件（尤其主题）的 renderer 入口是 ESM：
 *     import { settingWindowCreated } from './index.js';
 *     export const onSettingWindowCreated = async (view) => { ... };
 * 主世界里没有 import 解析器，光把 export 改写成 CommonJS 是跑不起来的（以前 mspring-theme
 * 就是因此报 "Script failed to execute"、主题完全没效果）。
 * 这里在预加载（有 Node 能力）里自己走一遍模块图：读文件 -> 解析 import -> 相对路径解析
 * （自动补 .js / index.js）-> 把每个模块包成工厂函数 -> 生成一段带 __mqgaRequire 的 IIFE。
 */
/* ---- ESM-BUNDLER-START ---- */
function extractImportSpecs(src) {
    const specs = [];
    const re = /import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
    return specs;
}

function resolveModulePath(spec, fromFile) {
    try {
        if (/^(electron|node:|fs|path|os|crypto|url|util)$/.test(spec)) return null; // 内置/裸模块：这里解析不了
        const base = PathU.isAbsolute(spec) ? spec : PathU.join(PathU.dirname(fromFile), spec);
        const cands = [base, base + ".js", PathU.join(base, "index.js")];
        for (const c of cands) {
            if (exists(c)) return c;
        }
    } catch (e) { /* 忽略 */ }
    return null;
}

function transformModuleSource(src, file) {
    let out = src;
    // import a, { b as c } from './x.js'
    out = out.replace(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/g, (all, clause, spec) => {
        const target = resolveModulePath(spec, file);
        if (!target) return `/* 未能解析的 import: ${spec} */`;
        const req = `__mqgaRequire(${JSON.stringify(target)})`;
        const text = clause.trim();
        const braceIdx = text.indexOf("{");
        if (braceIdx >= 0) {
            // 支持 "import a, { b as c } from ..."（默认导入 + 命名导入混用）
            const before = text.slice(0, braceIdx).replace(/,\s*$/, "").trim();
            const inner = text.slice(braceIdx + 1, text.lastIndexOf("}")).split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
                const m = s.split(/\s+as\s+/);
                return m.length === 2 ? `${m[0].trim()}: ${m[1].trim()}` : s;
            }).join(", ");
            const parts = [];
            if (before) parts.push(`const ${before} = (${req} && ${req}.default !== undefined ? ${req}.default : ${req});`);
            parts.push(`const { ${inner} } = ${req};`);
            return parts.join(" ");
        }
        if (text.startsWith("*")) {
            const name = text.replace(/^\*\s*as\s*/, "").trim() || "__ns";
            return `const ${name} = ${req};`;
        }
        // 默认导入：兼容 esModuleInterop 的两种写法
        return `const ${text} = (${req} && ${req}.default !== undefined ? ${req}.default : ${req});`;
    });
    // 纯副作用 import './x.js'
    out = out.replace(/import\s+["']([^"']+)["']\s*;?/g, (all, spec) => {
        const target = resolveModulePath(spec, file);
        return target ? `__mqgaRequire(${JSON.stringify(target)});` : `/* 未能解析的 import: ${spec} */`;
    });
    return esmToCjs(out);
}

function buildModuleBundle(entryFile) {
    const order = [];
    const seen = new Set();
    const visit = (file) => {
        if (!file || seen.has(file)) return;
        seen.add(file);
        const src = readText(file);
        if (src === null) return;
        for (const spec of extractImportSpecs(src)) {
            const target = resolveModulePath(spec, file);
            if (target) visit(target);
            else if (!/^(electron|node:)/.test(spec)) { try { sync(["log"], ["renderer 段 import 未解析: " + spec + " (来自 " + file + ")"]); } catch (e) { } }
        }
        order.push({ file, code: transformModuleSource(src, file) });
    };
    visit(entryFile);
    const factories = order.map((m) => `  ${JSON.stringify(m.file)}: function(module, exports, __mqgaRequire, require){\n${m.code}\n  }`).join(",\n");
    return `(function(){
  var __mqgaModules = {\n${factories}\n  };
  var __mqgaCache = {};
  function __mqgaRequire(path){
    if (Object.prototype.hasOwnProperty.call(__mqgaCache, path)) return __mqgaCache[path].exports;
    var m = { exports: {} };
    __mqgaCache[path] = m;
    var f = __mqgaModules[path];
    if (!f) { throw new Error("找不到模块: " + path); }
    f(m, m.exports, __mqgaRequire, __mqgaRequire);
    return m.exports;
  }
  return __mqgaRequire(${JSON.stringify(entryFile)});
})()`;
}

/* ---- ESM-BUNDLER-END ---- */

/** 把一段代码送进页面主世界执行（优先 webFrame.executeJavaScript）
 *  返回 Promise<result>（可以等到这段代码真正跑完），不可用时返回 null。 */
function execInMainWorldAsync(wrapped, filename) {
    const useExecuteFirst = String(info?.preferences?.renderer_inject || "webframe").toLowerCase() === "execute";
    try {
        if (!useExecuteFirst && webFrame && typeof webFrame.executeJavaScript === "function") {
            return Promise.resolve(webFrame.executeJavaScript(wrapped, true));
        }
    } catch (e) {
        reportError("renderer段注入失败", filename, e);
    }
    return null;
}

/** 兼容旧调用：跑完再用 handleResult 回调 */
function execInMainWorld(wrapped, filename, handleResult) {
    const promise = execInMainWorldAsync(wrapped, filename);
    if (promise) {
        promise.then(handleResult).catch((e) => reportError("renderer段异常", filename, e));
        return true;
    }
    return false;
}

/**
 * 插件 renderer 段：优先用页面原生的动态 import（= LiteLoaderQQNT 的做法：
 * `await import("local:///<绝对路径>")`）。
 * 这样相对 import、import.meta、顶层 await（mspring-theme 就有 TLA）全部原生支持，
 * 比宿主自己改写 ESM 靠谱得多；失败时再回退到内联打包/改写。
 */
function runRendererSegment(item) {
    const file = item.file;
    const slug = item.slug || file;
    const exportKey = String(slug).replace(/[^A-Za-z0-9_$-]/g, "_");
    const url = "local:///" + String(file).replace(/\\/g, "/");
    const wrapped =
        ";(async function(){try{\n" +
        "const mod = await import(" + JSON.stringify(url) + ");\n" +
        "try{window.__MQGA_RENDERER_EXPORTS__=window.__MQGA_RENDERER_EXPORTS__||{};" +
        "const ns = (mod && mod.default && Object.keys(mod).length === 1) ? mod.default : mod;\n" +
        "window.__MQGA_RENDERER_EXPORTS__[" + JSON.stringify(exportKey) + "]=ns;}catch(e){}\n" +
        "return {ok:true,keys:Object.keys(mod||{})};\n" +
        "}catch(e){return {ok:false,error:'[MQGA-RENDERER-ERR] '+((e&&e.stack)||e)};}})();\n" +
        "//# sourceURL=" + file;
    const handle = (result) => {
        if (result && typeof result === "object" && result.ok) {
            try { sync(["log"], ["renderer段已执行(ESM import): " + slug + " exports=" + JSON.stringify(result.keys || [])]); } catch (e) { }
            // 面板可能已经建好了：让 LQ 的 Runtime 也登记上，并补一个左栏条目
            try {
                if (typeof globalThis.__MQGA_LQ_REGISTER__ === "function") {
                    globalThis.__MQGA_LQ_REGISTER__(exportKey, globalThis.__MQGA_RENDERER_EXPORTS__ && globalThis.__MQGA_RENDERER_EXPORTS__[exportKey]);
                }
            } catch (e) { /* 忽略 */ }
            return;
        }
        const reason = (result && result.error) || "未知";
        try { sync(["log"], ["renderer 段 ESM 导入失败，回退内联改写: " + slug + " :: " + String(reason).slice(0, 200)]); } catch (e) { }
        runInMainWorld(item.source, file, item.slug);
    };
    // 关键：返回 Promise，让调用方（loadRendererScripts -> startRenderer）能等到注册完成
    const promise = execInMainWorldAsync(wrapped, file);
    if (promise) {
        return promise.then(handle).catch((e) => {
            reportError("renderer段异常", file, e);
            runInMainWorld(item.source, file, item.slug);
        });
    }
    runInMainWorld(item.source, file, item.slug);
    return Promise.resolve();
}

function runInMainWorld(source, filename, slug) {
    // 优先使用 webFrame.executeJavaScript：由 Electron 原生注入，不受页面 CSP 限制
    // 统一包装成 CommonJS 模块：ESM 语法先改写，异常作为返回值带回，便于定位真实错误
    const safeName = filename.replace(/\\/g, "\\\\");
    const exportKey = String(slug || filename).replace(/[^A-Za-z0-9_$-]/g, "_");
    // 含 import 的源：走模块图打包；否则沿用原来的单文件改写
    let body = source;
    if (/^\s*import\s|[\r\n]\s*import\s/m.test(source)) {
        try {
            body = buildModuleBundle(filename);
        } catch (e) {
            reportError("renderer段打包失败", filename, e);
            body = esmToCjs(source);
        }
    }
    const wrapped =
        ";(async function(){try{\n" +
        "var module={exports:{}};var exports=module.exports;\n" +
        body +
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
    // 每段都返回一个 Promise（原生 import 是异步的）：调用方可以等它们注册完再注入面板，
    // 否则面板可能看不到插件（曾经就是因为这个把插件的左栏条目弄丢了）。
    const jobs = [];
    for (const item of list) {
        if (!item || !item.file) continue;
        try {
            jobs.push(Promise.resolve(runRendererSegment(item)));
        } catch (e) {
            console.error("[MQGA] renderer 段注入失败 " + item.slug, e);
        }
        console.log("[MQGA] renderer 段已注入: " + item.slug);
    }
    return Promise.allSettled(jobs);
}

// 宿主自带脚本：设置界面注入（+ 可选 DOM 转储，便于适配新版 QQ）
function loadHostScripts() {
    const root = info?.paths?.root;
    if (!root) return;
    try {
        // 设置界面完全用 LiteLoaderQQNT 的渲染层（组件 + 钩子 + 设置 trigger），esbuild 打成单文件
        const lq = readText(root + "\\src\\lq.bundle.js");
        if (lq) runInMainWorld(lq, root + "\\src\\lq.bundle.js", "mqga-lq");
        else console.error("[MQGA] 缺少 src\\lq.bundle.js（请运行 install.ps1 或手动 esbuild 打包）");
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
            // 调试用：直接把当前窗口切到设置路由（新版 QQ 的 session 路由可能是 #/chat 等）
            if (openSettings && location.href.indexOf("#/setting") < 0) {
                setTimeout(function () {
                    try { location.hash = "#/setting/settings/common"; write("open-settings.txt", new Date().toISOString()); } catch (e) { }
                }, 6000);
            }
        })();`;
        runInMainWorld(dumper, "mqga-dom-dump.js");
    }
}

// 立即安装（不等待 DOMContentLoaded）
if (!MQGA_AUTH_PAGE) {
    setTimeout(loadVueHook, 0);
    setTimeout(loadConsoleBridge, 0);
}

let started = false;
function startRenderer() {
    if (started) return;
    if (MQGA_AUTH_PAGE) return;
    started = true;
    loadPluginPreloads();
    // 先等插件 renderer 段全部注册完，再注入设置面板（lq.bundle.js 会遍历这张登记表给插件加左栏项）
    Promise.resolve(loadRendererScripts())
        .then(() => loadHostScripts())
        .catch((e) => { try { console.error("[MQGA] 注入设置面板失败", e); } catch (e2) { } loadHostScripts(); });
    // 诊断：确认主世界里的插件 renderer 导出登记表已生效（contextBridge 暴露的对象是只读代理，
    // 因此登记表必须挂在普通全局变量上）
    setTimeout(() => {
        const probe = `(function(){try{
            var map = window.__MQGA_RENDERER_EXPORTS__ || {};
            var out = {};
            Object.keys(map).forEach(function (k) { out[k] = Object.keys(map[k] || {}); });
            return { registry: out, liteLoaderSeen: ("LiteLoader" in window), mqgaSeen: ("MQGA" in window),
                     liteToolsApi: typeof window.lite_tools };
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
