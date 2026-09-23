/**
 * MakeQQGreatAgain 主进程入口。
 * QQ 的 package.json main 会被安装脚本指向本文件的本机绝对路径（经由 app_launcher 里的转发脚本）。
 * 本文件负责：建立 API -> 挂钩 Electron -> 加载插件（主进程段）-> 交还控制权给 QQ 本体入口。
 */
const path = require("path");
const host = require("./host.js");
const hooks = require("./hooks.js");

const ORIGINAL_ENTRY = "./application.asar/app_launcher/index.js";

const state = {
    plugins: {},
    pluginModules: new Map(),
    reloadRequested: false,
    installPlugin: () => ({ mqga_error: "插件安装功能尚未实现，请手动放入 plugins 目录" }),
    deletePlugin: () => ({ mqga_error: "插件卸载功能尚未实现，请手动删除 plugins 下目录" }),
    disablePlugin: (slug) => {
        const config = host.loaderConfig();
        if (!config.disabled_plugins.includes(slug)) config.disabled_plugins.push(slug);
        host.saveLoaderConfig(config);
        return true;
    },
    enablePlugin: (slug) => {
        const config = host.loaderConfig();
        config.disabled_plugins = config.disabled_plugins.filter((item) => item !== slug);
        host.saveLoaderConfig(config);
        return true;
    },
    rendererScripts: () => {
        const list = [];
        for (const plugin of Object.values(state.plugins)) {
            if (plugin.disabled || plugin.incompatible) continue;
            const file = plugin.path.injects.renderer;
            if (!file) continue;
            const source = hooks.readUtf8(file);
            if (source === null) continue;
            list.push({ slug: plugin.manifest.slug, file, source });
        }
        return list;
    },
};

/* ------------------------------ API 与兼容层 ------------------------------ */

function buildApi() {
    const api = host.createApi(state);
    api.rendererScripts = () => state.rendererScripts();
    api.pluginsInfo = () => publicPlugins();
    api.info = () => ({
        plugins: publicPlugins(),
        paths: host.PATHS,
        versions: globals.versions,
        preferences: host.loaderConfig(),
    });
    api.loader = {
        version: require(path.join(host.PATHS.root, "package.json")).version,
        paths: host.PATHS,
        versions: {
            qqnt: readQqVersion(),
            electron: process.versions.electron,
            node: process.versions.node,
            chrome: process.versions.chrome,
        },
        plugins: () => publicPlugins(),
        log: host.log,
    };
    return api;
}

function readQqVersion() {
    try {
        return require(path.join(process.resourcesPath, "app", "package.json")).version;
    } catch (e) {
        return "unknown";
    }
}

function publicPlugins() {
    const result = {};
    for (const [slug, plugin] of Object.entries(state.plugins)) {
        result[slug] = {
            manifest: plugin.manifest,
            disabled: plugin.disabled,
            incompatible: plugin.incompatible,
            path: plugin.path,
        };
    }
    return result;
}

function installGlobals() {
    const descriptor = {
        configurable: true,
        get() {
            const stack = new Error().stack || "";
            const allowed = [host.PATHS.root, host.PATHS.profile];
            return allowed.some((item) => stack.includes(item)) ? globals : null;
        },
    };
    Object.defineProperty(globalThis, "MQGA", descriptor);
    Object.defineProperty(globalThis, "LiteLoader", descriptor);
}

const globals = {
    api: null,
    plugins: {},
    path: host.PATHS,
    paths: host.PATHS,
    versions: {
        qqnt: null,
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        liteloader: null,
        mqga: null,
    },
    package: {},
    os: { platform: process.platform },
};

/* ------------------------------- 插件主进程段 ------------------------------ */

function loadPluginMainScripts() {
    state.plugins = host.loadPlugins();
    globals.plugins = publicPlugins();
    for (const plugin of Object.values(state.plugins)) {
        if (plugin.disabled || plugin.incompatible || !plugin.path.injects.main) continue;
        try {
            const exports = require(plugin.path.injects.main);
            state.pluginModules.set(plugin, exports || {});
            host.log(`插件已加载（主进程）: ${plugin.manifest.slug}`);
        } catch (e) {
            host.log(`插件主进程脚本加载失败 [${plugin.manifest.slug}]:`, e);
        }
    }
}

function triggerPlugins(hookName, argsFactory) {
    for (const [plugin, exports] of state.pluginModules) {
        const handler = exports?.[hookName];
        if (typeof handler !== "function") continue;
        try {
            const args = typeof argsFactory === "function" ? argsFactory(plugin) : argsFactory;
            handler(...(Array.isArray(args) ? args : [args]));
        } catch (e) {
            host.log(`插件钩子 ${hookName} 异常 [${plugin.manifest.slug}]:`, e);
        }
    }
}

/* --------------------------------- 启动流程 -------------------------------- */

/* 主进程 console -> logs\main-console.log（便于抓插件主进程段的输出，如轻量工具箱的调试日志） */
function installConsoleTee() {
    try {
        if (!host.loaderConfig().debug_console) return;
        const fs = require("fs");
        const pathMod = require("path");
        const file = pathMod.join(host.PATHS.logs, "main-console.log");
        for (const level of ["log", "warn", "error", "info"]) {
            const orig = console[level] ? console[level].bind(console) : null;
            console[level] = (...args) => {
                try {
                    const text = args.map((a) => {
                        if (typeof a === "string") return a;
                        try { return JSON.stringify(a); } catch (e) { return String(a); }
                    }).join(" ");
                    fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${text}\r\n`);
                } catch (e) { /* 忽略 */ }
                if (orig) orig(...args);
            };
        }
        host.log("主进程 console 已接入 logs\\main-console.log");
    } catch (e) {
        host.log("安装 console tee 失败:", e);
    }
}
function bootstrap() {
    host.log("================ MakeQQGreatAgain 启动 ================");
    host.log("宿主目录:", host.PATHS.root);
    host.log("数据目录:", host.PATHS.profile);

    const electron = hooks.installElectronHook();

    state.api = buildApi();
    globals.api = state.api;
    globals.plugins = publicPlugins();
    globals.package = {
        mqga: require(path.join(host.PATHS.root, "package.json")),
        qqnt: (() => { try { return require(path.join(process.resourcesPath, "app", "package.json")); } catch (e) { return {}; } })(),
    };
    globals.versions.mqga = globals.package.mqga.version;
    globals.versions.liteloader = globals.package.mqga.version;
    globals.versions.qqnt = globals.package.qqnt.version;
    installGlobals();

    hooks.installIpc(electron, state);

    hooks.registerProtocol(electron, electron.protocol);

    // 让渲染进程的 fetch() 能用 local:// 与 mqga://（QQ 自己只允许 app/appimg/cacheimg）。
    // LiteLoaderQQNT 插件（如 lite-tools）常用 fetch("local:///<绝对路径>") 读取自身资源，
    // 不追加 fetch-schemes 会直接得到 “TypeError: Failed to fetch”。
    const enableFetchSchemes = () => {
        try {
            const extra = ["local", "mqga"];
            const current = String(electron.app.commandLine.getSwitchValue("fetch-schemes") || "");
            const list = current.split(",").map((s) => s.trim()).filter(Boolean);
            for (const scheme of extra) if (!list.includes(scheme)) list.push(scheme);
            electron.app.commandLine.appendSwitch("fetch-schemes", list.join(","));
            host.log("fetch-schemes 已扩展: " + list.join(","));
        } catch (e) {
            host.log("扩展 fetch-schemes 失败:", e);
        }
    };
    enableFetchSchemes();
    try { electron.app.on("ready", enableFetchSchemes); } catch (e) { /* 忽略 */ }

    const setupSession = (session) => {
        try {
            hooks.injectPreloadIntoSession(session);
            hooks.registerProtocolOn(electron, session.protocol);
        } catch (e) {
            host.log("会话初始化失败:", e);
        }
    };

    try {
        electron.app.on("session-created", setupSession);
        if (electron.app.isReady()) {
            setupSession(electron.session.defaultSession);
            hooks.registerProtocolOn(electron, electron.protocol);
        } else {
            electron.app.once("ready", () => {
                try { setupSession(electron.session.defaultSession); } catch (e) { host.log("默认会话初始化失败:", e); }
                hooks.registerProtocolOn(electron, electron.protocol);
            });
        }
    } catch (e) {
        host.log("会话挂钩失败:", e);
    }

    loadPluginMainScripts();

    host.on("window-created", (win) => triggerPlugins("onBrowserWindowCreated", (plugin) => [win, plugin]));
    host.on("login", (uid) => triggerPlugins("onLogin", (plugin) => [uid, plugin]));

    try {
        electron.app.on("ready", () => triggerPlugins("onReady", () => []));
    } catch (e) {
        host.log("监听 app ready 失败:", e);
    }
}

installConsoleTee();

function startQq() {
    const target = path.join(process.resourcesPath, "app", ORIGINAL_ENTRY);
    try {
        require(target);
        host.log("QQ 本体入口已加载:", target);
        setImmediate(() => {
            try {
                if (global.launcher?.installPathPkgJson) {
                    global.launcher.installPathPkgJson.main = ORIGINAL_ENTRY;
                    host.log("已把内存态 package.json 的 main 还原为 " + ORIGINAL_ENTRY);
                }
            } catch (e) {
                host.log("还原 installPathPkgJson.main 失败:", e);
            }
        });
    } catch (e) {
        host.log("QQ 本体入口加载失败:", e);
    }
}

try {
    bootstrap();
    startQq();
    host.log("MakeQQGreatAgain 启动流程结束");
} catch (e) {
    host.log("MakeQQGreatAgain 启动失败:", e);
}
