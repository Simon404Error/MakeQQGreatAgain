/**
 * MakeQQGreatAgain 宿主核心：路径、配置存储、插件扫描、对外 API（MQGA + LiteLoader 兼容层）
 * 独立实现，接口语义参考 LiteLoaderQQNT 生态，便于现有插件迁移。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PROFILE = process.env.MQGA_PROFILE || ROOT;

const PATHS = {
    root: ROOT,
    profile: PROFILE,
    data: path.join(PROFILE, "data"),
    plugins: path.join(PROFILE, "plugins"),
    bin: path.join(ROOT, "bin"),
    logs: path.join(ROOT, "logs"),
    preload: path.join(ROOT, "src", "preload.js"),
    main: path.join(ROOT, "src", "main.js"),
};
for (const dir of [PATHS.data, PATHS.plugins, PATHS.logs]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
}

const LOG_FILE = path.join(PATHS.logs, "loader.log");
function stringify(value) {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
}
function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.map(stringify).join(" ")}`;
    try {
        if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "\uFEFF", "utf8");
        fs.appendFileSync(LOG_FILE, line + "\r\n");
    } catch (e) { /* 忽略 */ }
    try { console.log("[MQGA]", line); } catch (e) { /* 忽略 */ }
}
function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 4), "utf8");
}

/* ------------------------------- 配置存储 ------------------------------- */

const LOADER_CONFIG_FILE = path.join(PATHS.data, "loader.json");
const LOADER_CONFIG_DEFAULT = {
    enable_plugins: true,
    disabled_plugins: [],
    inject_settings_entry: true,
    renderer_inject: "webframe", // webframe | execute（后者便于拿到渲染段真实报错）
};

function loaderConfig() {
    return Object.assign({}, LOADER_CONFIG_DEFAULT, readJson(LOADER_CONFIG_FILE, {}));
}
function saveLoaderConfig(config) {
    writeJson(LOADER_CONFIG_FILE, config);
    return true;
}

function getConfig(slug, defaults = {}) {
    const file = path.join(PATHS.data, slug, "config.json");
    const stored = readJson(file, null);
    if (stored === null || typeof stored !== "object") {
        writeJson(file, defaults);
        return defaults;
    }
    return Object.assign({}, defaults, stored);
}
function setConfig(slug, config) {
    writeJson(path.join(PATHS.data, slug, "config.json"), config);
    return true;
}

/* ------------------------------- 插件目录 ------------------------------- */

const MANIFEST_REQUIRED = ["manifest_version", "type", "slug", "name", "version"];
const MANIFEST_OPTIONAL = ["description", "author", "dependencies", "injects", "platform"];

function normalizeManifest(manifest) {
    // 保留清单中的扩展字段（icon / authors / repository ...），只对必需字段补默认值
    const out = Object.assign({}, manifest);
    for (const key of MANIFEST_REQUIRED) out[key] = manifest[key];
    out.platform = Array.isArray(out.platform) ? out.platform : ["win32", "linux", "darwin"];
    out.dependencies = Array.isArray(out.dependencies) ? out.dependencies : [];
    out.injects = out.injects && typeof out.injects === "object" ? out.injects : {};
    out.type = out.type || "plugin";
    out.manifest_version = out.manifest_version || 4;
    return out;
}

function scanPluginDirectory() {
    const plugins = [];
    let entries = [];
    try {
        entries = fs.readdirSync(PATHS.plugins, { withFileTypes: true });
    } catch (e) {
        log("扫描插件目录失败:", e);
        return plugins;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(PATHS.plugins, entry.name);
        const file = path.join(dir, "manifest.json");
        if (!fs.existsSync(file)) continue;
        const raw = readJson(file, null);
        if (!raw) {
            log(`插件 ${entry.name} 的 manifest.json 不是合法 JSON，已跳过`);
            continue;
        }
        const missing = MANIFEST_REQUIRED.filter((key) => raw[key] === undefined);
        if (missing.length) {
            log(`插件 ${entry.name} 缺少清单字段: ${missing.join(", ")}，已跳过`);
            continue;
        }
        plugins.push({ dir, manifest: normalizeManifest(raw) });
        writeJson(path.join(PATHS.data, raw.slug, "manifest.cache.json"), raw);
    }
    return plugins;
}

function instantiate(entry, disabled) {
    const manifest = entry.manifest;
    const join = (rel) => (rel ? path.resolve(entry.dir, rel) : null);
    return {
        manifest,
        disabled,
        incompatible: !manifest.platform.includes(process.platform),
        path: {
            plugin: entry.dir,
            data: path.join(PATHS.data, manifest.slug),
            injects: {
                main: join(manifest.injects.main),
                preload: join(manifest.injects.preload),
                renderer: join(manifest.injects.renderer),
            },
        },
    };
}

function topologicalSort(map) {
    const sorted = {};
    const visited = new Set();
    const visiting = new Set();
    const visit = (slug) => {
        if (visited.has(slug) || visiting.has(slug)) return;
        const plugin = map[slug];
        if (!plugin) return;
        visiting.add(slug);
        for (const dep of plugin.manifest.dependencies) visit(dep);
        visiting.delete(slug);
        visited.add(slug);
        sorted[slug] = plugin;
    };
    for (const slug of Object.keys(map)) visit(slug);
    return sorted;
}

function loadPlugins() {
    const config = loaderConfig();
    const registry = {};
    if (!config.enable_plugins) {
        log("插件总开关已关闭");
        return registry;
    }
    const map = {};
    for (const entry of scanPluginDirectory()) {
        const slug = entry.manifest.slug;
        map[slug] = instantiate(entry, config.disabled_plugins.includes(slug));
    }
    const sorted = topologicalSort(map);
    for (const slug of Object.keys(sorted)) registry[slug] = sorted[slug];
    log(`已发现插件 ${Object.keys(registry).length} 个: ${Object.keys(registry).join(", ") || "(空)"}`);
    return registry;
}

/* ------------------------------ 对外 API 对象 ----------------------------- */

const bus = new Map();
function on(event, handler) {
    if (!bus.has(event)) bus.set(event, []);
    bus.get(event).push(handler);
    return true;
}
function emit(event, ...args) {
    for (const handler of bus.get(event) || []) {
        try { handler(...args); } catch (e) { log(`事件 ${event} 处理器异常:`, e); }
    }
    return true;
}

function createApi(state) {
    const api = {
        config: { get: getConfig, set: setConfig },
        plugin: {
            install: state.installPlugin,
            delete: state.deletePlugin,
            disable: state.disablePlugin,
            enable: state.enablePlugin,
        },
        openExternal: (url) => (require("electron").shell.openExternal(String(url)), true),
        openPath: (target) => (require("electron").shell.openPath(String(target)), true),
        reload: () => (state.reloadRequested = true, true),
        log,
    };
    return api;
}

module.exports = {
    ROOT, PROFILE, PATHS, LOG_FILE,
    log, readJson, writeJson,
    loaderConfig, saveLoaderConfig, getConfig, setConfig,
    scanPluginDirectory, loadPlugins, instantiate,
    on, emit, createApi,
};
