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

// 每个插件的三段注入状态：{ slug: { main: {ok,error}, preload: {...}, renderer: {...} } }
const stageStatus = Object.create(null);
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
    try {
        const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); // 容忍 BOM（PowerShell 写出的 JSON 常带 BOM）
        return JSON.parse(text);
    } catch (e) { return fallback; }
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
    protect_login: true, // 登录页(login.html/passport)不注入任何钩子，避免「安全登录控件被破坏」
    protected_plugins: [], // 需要保护、禁止在面板里卸载的插件 slug（默认不保护任何插件）
};

function loaderConfig() {
    const cfg = Object.assign({}, LOADER_CONFIG_DEFAULT, readJson(LOADER_CONFIG_FILE, {}));
    // LiteLoaderQQNT 的面板把 enable_plugins / disabled_plugins 写在 data\LiteLoader\config.json，
    // 这里做一次桥接：只要那份文件存在就以它为准（面板上拨的开关才能真的生效）。
    const lqFile = path.join(PATHS.data, "LiteLoader", "config.json");
    const lq = readJson(lqFile, null);
    if (lq && typeof lq === "object") {
        if (typeof lq.enable_plugins === "boolean") cfg.enable_plugins = lq.enable_plugins;
        if (Array.isArray(lq.disabled_plugins)) cfg.disabled_plugins = lq.disabled_plugins;
    }
    return cfg;
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
        if (entry.name.startsWith(".")) continue; // .trash / .installing-* 不算插件
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

function setStage(slug, stage, ok, error) {
    if (!slug) return;
    const entry = stageStatus[slug] || (stageStatus[slug] = {});
    entry[stage] = { ok: !!ok, error: error ? String(error).slice(0, 300) : "", at: Date.now() };
}

function stagesFor(slug) {
    return Object.assign({ main: null, preload: null, renderer: null }, stageStatus[slug] || {});
}

/* ------------------------------ 插件安装 ------------------------------
 * 支持 LiteLoaderQQNT 生态的插件：zip 压缩包（GitHub Release 的常见形态）或已经解压好的文件夹。
 * 判定依据就是插件根目录里的 manifest.json（manifest_version 4 / injects.*）。
 */
const AdmZipHolder = { module: null };

function loadAdmZip() {
    // QQ 自带 majar.node 里的 internal_admzip（upstream LiteLoaderQQNT 也用这个），失败则回退到内置解压
    if (AdmZipHolder.module) return AdmZipHolder.module;
    try {
        const majorNode = path.join(process.resourcesPath, "app", "major.node");
        const holder = {};
        require(majorNode).load("internal_admzip", holder);
        const AdmZip = holder.exports.admZip.default;
        AdmZipHolder.module = AdmZip;
        return AdmZip;
    } catch (e) {
        return null;
    }
}

/** 内置的最小 zip 解压（仅支持 store / deflate，够用于插件包） */
function extractZipFallback(zipFile, destDir) {
    const zlib = require("zlib");
    const buf = fs.readFileSync(zipFile);
    // 从尾部找 EOCD
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的 zip（找不到 EOCD）");
    const count = buf.readUInt16LE(eocd + 10);
    let ptr = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
        const flags = buf.readUInt16LE(ptr + 8);
        const method = buf.readUInt16LE(ptr + 10);
        const compSize = buf.readUInt32LE(ptr + 20);
        const nameLen = buf.readUInt16LE(ptr + 28);
        const extraLen = buf.readUInt16LE(ptr + 30);
        const commentLen = buf.readUInt16LE(ptr + 32);
        const localOff = buf.readUInt32LE(ptr + 42);
        const rawName = buf.subarray(ptr + 46, ptr + 46 + nameLen);
        const name = (flags & 0x800) ? rawName.toString("utf8") : rawName.toString("latin1");
        ptr += 46 + nameLen + extraLen + commentLen;
        const safe = path.normalize(name.replace(/\\/g, "/")).replace(/^([/\\])+/, "");
        if (!safe || safe.startsWith("..")) continue;
        const outPath = path.join(destDir, safe);
        if (/[/\\]$/.test(name)) { fs.mkdirSync(outPath, { recursive: true }); continue; }
        // 本地头长度以真实值为准
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataOff = localOff + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(dataOff, dataOff + compSize);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        if (method === 0) fs.writeFileSync(outPath, data);
        else if (method === 8) fs.writeFileSync(outPath, zlib.inflateRawSync(data));
        else throw new Error("不支持的压缩方式 method=" + method + " (" + name + ")");
    }
}

/* --------------------------- 目录移走 / 删除（绝不半删） ---------------------------
 * Windows 上插件目录里的文件可能正被已加载的插件占用：
 *   · rmSync 会抛 ENOTEMPTY/EPERM 并【把目录删一半】——之前就是这样把用户的主题目录掏空，
 *     装不回去、也进不去；
 *   · 但"整体改名"是原子的：即使里面有文件被占用，多数情况下目录本身仍能被 rename。
 * 所以策略是"先挪走，再删"：
 *   1) moveAside() 把目录 rename 到 plugins\.trash\<名字>-<时间戳>，成功即代表 <slug> 已空出；
 *   2) moveDirRobust() 在挪走后尽力删除 .trash 里的副本（删不掉也无所谓，.trash 不会被当插件加载）；
 *   3) 连 rename 都失败（被强占用）时，保持原样并报错 —— 绝不先删再失败。
 */
function moveAside(dir) {
    try {
        const trash = path.join(PATHS.plugins, ".trash");
        fs.mkdirSync(trash, { recursive: true });
        const dest = path.join(trash, path.basename(dir) + "-" + Date.now());
        fs.renameSync(dir, dest);
        return { ok: true, to: dest };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

function removeDirRobust(dir) {
    if (!fs.existsSync(dir)) return "not-found";
    const aside = moveAside(dir);
    if (!aside.ok) {
        // 挪不动 = 还被占用：保持原样，交给调用方决定（安装会中止，不会破坏现有插件）
        return "error: " + aside.error;
    }
    for (let i = 0; i < 3; i++) {
        try { fs.rmSync(aside.to, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        if (!fs.existsSync(aside.to)) return "removed";
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); } catch (e) { /* 忽略 */ }
    }
    log("目录被占用，已挪到回收站（以后不会再半删）: " + aside.to);
    return "moved-to-trash";
}

function extractZip(zipFile, destDir) {
    const AdmZip = loadAdmZip();
    if (AdmZip) {
        const zip = new AdmZip(zipFile);
        zip.extractAllTo(destDir, true);
        log("插件包已解压（QQ 内置 admZip）: " + zipFile);
        return;
    }
    extractZipFallback(zipFile, destDir);
    log("插件包已解压（内置回退解压器）: " + zipFile);
}

function findPluginRoot(dir) {
    // 1) 根目录就有 manifest.json
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
    // 2) Release 包常见形态：压缩包内只有一层 <插件名>/ 目录
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("__MACOSX"));
    if (dirs.length === 1) {
        const inner = path.join(dir, dirs[0].name);
        if (fs.existsSync(path.join(inner, "manifest.json"))) return inner;
    }
    // 3) 兜底：任意一层找到 manifest.json
    for (const e of entries) {
        const inner = path.join(dir, e.name);
        if (e.isDirectory() && fs.existsSync(path.join(inner, "manifest.json"))) return inner;
    }
    return null;
}

function installPlugin(source, options = {}) {
    const src = String(source || "").trim();
    if (!src) { log("安装插件失败: 未指定来源"); return { ok: false, error: "未指定插件来源" }; }
    if (!fs.existsSync(src)) { log("安装插件失败: 路径不存在 " + src); return { ok: false, error: "路径不存在: " + src }; }

    log("安装插件开始: source=" + src);
    const isZip = fs.statSync(src).isFile();
    if (isZip && !/\.zip$/i.test(src)) { log("安装插件失败: 不是 zip " + src); return { ok: false, error: "只支持 .zip 压缩包或文件夹: " + src }; }

    const staging = path.join(PATHS.plugins, ".installing-" + Date.now());
    try {
        fs.mkdirSync(staging, { recursive: true });
        if (isZip) extractZip(src, staging);
        else fs.cpSync(src, staging, { recursive: true });

        const root = findPluginRoot(staging);
        if (!root) {
            fs.rmSync(staging, { recursive: true, force: true });
            log("安装插件失败: 未找到 manifest.json（source=" + src + "）");
            return { ok: false, error: "压缩包/文件夹里没有找到 manifest.json，不是有效的插件" };
        }
        let manifest = {};
        try {
            manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
        } catch (e) {
            fs.rmSync(staging, { recursive: true, force: true });
            log("安装插件失败: manifest.json 解析失败 " + ((e && e.message) || e));
            return { ok: false, error: "manifest.json 解析失败: " + ((e && e.message) || e) };
        }
        const slug = String(manifest.slug || path.basename(root)).trim();
        if (!slug || /[\\/]|\.\./.test(slug)) {
            fs.rmSync(staging, { recursive: true, force: true });
            log("安装插件失败: slug 非法 " + slug);
            return { ok: false, error: "插件 slug 非法: " + slug };
        }
        const dest = path.join(PATHS.plugins, slug);
        let replaced = false;
        if (fs.existsSync(dest)) {
            // 覆盖安装：只做"整体挪走"，挪不动就中止安装（绝不先删后失败，避免把现有插件掏空）
            const aside = moveAside(dest);
            if (!aside.ok) {
                fs.rmSync(staging, { recursive: true, force: true });
                return { ok: false, error: "同名插件已存在且无法挪走（文件正被 QQ 占用，先关掉 QQ 再装）: " + aside.error, exists: true, slug };
            }
            replaced = true;
            // 挪走后再尽力清掉回收站里那份
            try { fs.rmSync(aside.to, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        }
        fs.renameSync(root, dest);
        fs.rmSync(staging, { recursive: true, force: true });
        log("已安装插件: " + slug + " (" + ((manifest.name) || "?") + " v" + ((manifest.version) || "?") + ")"
            + (replaced ? " [覆盖原目录]" : "") + " <- " + src);
        return { ok: true, slug, replaced, manifest: { name: manifest.name, version: manifest.version, description: manifest.description } };
    } catch (e) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e2) { /* 忽略 */ }
        log("安装插件失败: " + ((e && e.message) || e));
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

/* ------------------------- 插件卸载（仅保护 loader.json 里显式列出的 slug） ------------------------- */

function protectedPlugins() {
    // MQGA 本体不是插件，因此默认不保护任何插件；只有 loader.json 的 protected_plugins 明确列出的才受保护。
    const cfg = loaderConfig();
    return Array.isArray(cfg.protected_plugins) ? cfg.protected_plugins.slice() : [];
}

function uninstallPlugin(slug, options = {}) {
    const name = String(slug || "").trim();
    if (!name) return { ok: false, error: "缺少插件 slug" };
    if (/[\\/]|\.\./.test(name)) return { ok: false, error: "非法 slug: " + name };
    if (options.force !== true && protectedPlugins().includes(name)) {
        return { ok: false, error: "该插件在 protected_plugins 中，已受保护: " + name, protected: true, slug: name };
    }
    // mode: all(默认) | plugin(只删本体) | data(只删数据)
    const mode = options.mode || (options.keepData === true ? "plugin" : "all");
    const pluginDir = path.join(PATHS.plugins, name);
    const dataDir = path.join(PATHS.data, name);
    const dirs = {};
    const removeDir = (dir, label) => {
        if (!fs.existsSync(dir)) { dirs[label] = "not-found"; return; }
        try {
            dirs[label] = removeDirRobust(dir);
        } catch (e) {
            dirs[label] = "error: " + ((e && e.message) || e);
        }
    };
    if (mode !== "data") removeDir(pluginDir, "plugin");
    if (mode !== "plugin") removeDir(dataDir, "data");
    try {
        const cfg = loaderConfig();
        if (Array.isArray(cfg.disabled_plugins) && cfg.disabled_plugins.includes(name)) {
            cfg.disabled_plugins = cfg.disabled_plugins.filter((item) => item !== name);
            saveLoaderConfig(cfg);
            dirs.config = "cleaned";
        }
    } catch (e) {
        dirs.config = "error: " + ((e && e.message) || e);
    }
    log("已卸载插件: " + name + " mode=" + mode + " " + JSON.stringify(dirs));
    const ok = mode === "data" ? dirs.data === "removed" : (dirs.plugin === "removed");
    return { ok, slug: name, mode, dirs };
}

/* ---------- LiteLoaderQQNT 面板的"排队删除"：deleting_plugins 在下次启动时执行 ---------- */

function applyPendingPluginDeletions() {
    const lqFile = path.join(PATHS.data, "LiteLoader", "config.json");
    const cfg = readJson(lqFile, null);
    if (!cfg || typeof cfg !== "object" || !cfg.deleting_plugins) return [];
    const done = [];
    for (const slug of Object.keys(cfg.deleting_plugins)) {
        const entry = cfg.deleting_plugins[slug] || {};
        const result = uninstallPlugin(slug, {
            force: true,
            mode: entry.self && entry.data === false ? "plugin" : (entry.self === false && entry.data ? "data" : "all"),
        });
        delete cfg.deleting_plugins[slug];
        done.push({ slug, result });
    }
    try { writeJson(lqFile, cfg); } catch (e) { /* 忽略 */ }
    if (done.length) log("已执行 LQ 面板排队的插件删除: " + JSON.stringify(done));
    return done;
}

module.exports = {
    setStage, stagesFor,
    ROOT, PROFILE, PATHS, LOG_FILE,
    log, readJson, writeJson,
    loaderConfig, saveLoaderConfig, getConfig, setConfig,
    scanPluginDirectory, loadPlugins, instantiate,
    on, emit, createApi,
    uninstallPlugin, protectedPlugins, installPlugin, applyPendingPluginDeletions,
};
