/**
 * MakeQQGreatAgain 的 Electron 接入层：
 *  - 代理 electron 模块，拦截 BrowserWindow 构造，向会话注册预加载脚本
 *  - 注册 mqga:// 协议供渲染进程读取宿主/插件目录（含插件资源）
 *  - 建立主进程 <-> 渲染进程的 API 桥（同步 + 异步）
 */
const path = require("path");
const host = require("./host.js");
const safePaths = require("./paths-safe.js");
const { pathToFileURL } = require("url");
const nativePreloadSessions = new WeakSet();
const ipcInstalled = new WeakSet();

const windowProxyCache = new WeakMap();
const exportsProxyCache = new WeakMap();
const instrumentedSessions = new WeakSet();

function registerSchemes(electron) {
    try {
        electron.protocol.registerSchemesAsPrivileged([
            {
                scheme: "mqga",
                privileges: {
                    standard: false,
                    secure: true,
                    supportFetchAPI: true,
                    stream: true,
                    bypassCSP: true,
                    corsEnabled: true,
                },
            },
        ]);
        // 兼容 LiteLoaderQQNT 生态：local:// 用于插件读取自身资源（如 dist/renderer/assets/*.html）
        electron.protocol.registerSchemesAsPrivileged([
            {
                scheme: "local",
                privileges: {
                    standard: false,
                    secure: true,
                    supportFetchAPI: true,
                    stream: true,
                    bypassCSP: true,
                    corsEnabled: true,
                },
            },
        ]);
    } catch (e) {
        host.log("注册协议失败:", e);
    }
}

const protocolRegistered = new WeakMap();

function registerProtocolOn(electron, protocol) {
    if (!protocol || !electron.app.isReady()) return;
    let registered = protocolRegistered.get(protocol);
    if (!registered) { registered = new Set(); protocolRegistered.set(protocol,registered); }
    if (registered.has("mqga") && registered.has("local")) return;
    const allowed = [host.PATHS.root, host.PATHS.profile, host.PATHS.plugins];
    const fetchFile = async (file) => {
        const target = safePaths.assertAllowed(file, allowed);
        return electron.net.fetch(pathToFileURL(target).href);
    };
    const register = (scheme, handler) => {
        if (registered.has(scheme)) return;
        try { protocol.handle(scheme, handler); registered.add(scheme); host.log(scheme + ":// 协议处理器已注册"); }
        catch (e) {
            host.log(scheme + ":// 注册未完成，将允许重试:", e);
        }
    };
    register("mqga", async (request) => {
        try {
            const url = new URL(request.url);
            if (url.hostname !== "root" && url.hostname !== "profile") return new Response("bad host", {status:400});
            const base = url.hostname === "profile" ? host.PATHS.profile : host.PATHS.root;
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
            return await fetchFile(path.join(base, relative));
        } catch (e) { return new Response("forbidden", {status:403}); }
    });
    register("local", async (request) => {
        try {
            const url = new URL(String(request.url).replace(/\\/g, "/"));
            const decoded = decodeURIComponent(url.pathname || "");
            let target;
            if (url.hostname === "root" || url.hostname === "profile") {
                const base = url.hostname === "profile" ? host.PATHS.profile : host.PATHS.root;
                target = path.join(base, decoded.replace(/^\/+/, ""));
            } else {
                target = decoded.replace(/^\/([a-zA-Z]:)/, "$1");
            }
            return await fetchFile(target);
        } catch (e) { return new Response("forbidden", {status:403}); }
    });
    // Successful schemes remain registered if the other scheme needs a retry.
}

function registerProtocol(electron, protocol) {
    // 需要 app ready 之后才能拿到默认会话，因此这里只做尽力而为的尝试
    try {
        registerProtocolOn(electron, protocol || electron.protocol);
    } catch (e) {
        if (!String(e && e.message).includes("app is ready")) {
            host.log("默认会话暂不可用（等待 app ready 后重试）:", e && e.message);
        }
    }
}

function injectPreloadIntoSession(session) {
    if (!session) return false;
    if (nativePreloadSessions.has(session)) return true;
    if (instrumentedSessions.has(session)) return false;
    if (typeof session.registerPreloadScript === "function") {
        try {
            session.registerPreloadScript({ type: "frame", filePath: host.PATHS.preload });
            nativePreloadSessions.add(session);
            instrumentedSessions.add(session);
            host.log("已向会话注册预加载脚本（registerPreloadScript）");
            return true;
        } catch (e) { host.log("registerPreloadScript 失败，保留后续重试:", e); }
    }
    try {
        const origin = session.getPreloadScripts?.bind(session);
        if (origin) {
            Object.defineProperty(session, "getPreloadScripts", { configurable: true, value: (...args) => {
                const list = Array.from(origin(...args) || []);
                if (!list.some((item) => item?.filePath === host.PATHS.preload)) list.unshift({ filePath: host.PATHS.preload, type: "frame" });
                return list;
            }});
            instrumentedSessions.add(session);
            host.log("已注册兼容预加载路径");
        }
    } catch (e) { host.log("包装 getPreloadScripts 失败，保留重试:", e); }
    return false;
}

function sessionName(webContents) {
    // QQ 多账号用不同的 session 分区（persist:qqnt_<uid>），日志里带上便于区分账号窗口
    try {
        const s = webContents?.session;
        if (!s) return "?";
        const parts = [];
        try { if (typeof s.getPartition === "function") parts.push("partition=" + (s.getPartition() || "default")); } catch (e) { /* 忽略 */ }
        try { if (typeof s.getStoragePath === "function") parts.push("storage=" + s.getStoragePath()); } catch (e) { /* 忽略 */ }
        try { if (!parts.length && s.storagePath) parts.push("storage=" + s.storagePath); } catch (e) { /* 忽略 */ }
        return parts.length ? parts.join(" ") : "?";
    } catch (e) { return "?"; }
}

function instrumentWindow(win) {
    const webContents = win?.webContents;
    if (!webContents) return;
    host.log("BrowserWindow 已拦截，注入预加载脚本（session=" + (webContents.session ? "ok" : "?") + " partition=" + sessionName(webContents) + " id=" + webContents.id + "）");
    const nativePreload = injectPreloadIntoSession(webContents.session);
    try {
        const original = webContents._getPreloadPaths?.bind(webContents);
        if (original && !nativePreload) {
            Object.defineProperty(webContents, "_getPreloadPaths", {
                configurable: true,
                value: (...args) => {
                    const list = Array.from(original(...args) || []);
                    if (!list.includes(host.PATHS.preload)) list.unshift(host.PATHS.preload);
                    return list;
                },
            });
        }
    } catch (e) {
        host.log("包装 _getPreloadPaths 失败:", e);
    }
    try {
        const send = webContents.send?.bind(webContents);
        if (send) {
            webContents.send = (...args) => {
                const [channel, payload] = args;
                if (typeof channel === "string" && channel.includes("RM_IPCFROM_")) {
                    const command = payload?.[1]?.cmdName;
                    if (command === "nodeIKernelSessionListener/onSessionInitComplete") {
                        host.emit("login", payload[1]?.payload?.uid, sessionName(webContents));
                    }
                }
                return send(...args);
            };
        }
    } catch (e) {
        host.log("包装 webContents.send 失败:", e);
    }
    try {
        if (typeof webContents.on === "function") {
            webContents.on("did-finish-load", () => {
                try { host.log("窗口加载完成: url=" + webContents.getURL() + " partition=" + sessionName(webContents) + " id=" + webContents.id + " title=" + (win.getTitle ? win.getTitle() : "")); } catch (e) { }
            });
        }
    } catch (e) {
        host.log("监听 did-finish-load 失败:", e);
    }
    host.emit("window-created", win);
}

function wrapBrowserWindow(electron, Original) {
    if (typeof Original !== "function") return Original;
    if (windowProxyCache.has(Original)) return windowProxyCache.get(Original);
    const Wrapped = new Proxy(Original, {
        construct(target, args, newTarget) {
            host.emit("window-creating", target, args);
            const win = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
            try {
                instrumentWindow(win);
            } catch (e) {
                host.log("窗口预处理失败:", e);
            }
            return win;
        },
    });
    windowProxyCache.set(Original, Wrapped);
    return Wrapped;
}

function wrapElectronExports(electron, exportsObject) {
    if (!exportsObject || typeof exportsObject !== "object") return exportsObject;
    if (exportsProxyCache.has(exportsObject)) return exportsProxyCache.get(exportsObject);
    const wrapped = new Proxy(exportsObject, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property === "BrowserWindow") return wrapBrowserWindow(electron, value);
            return value;
        },
    });
    exportsProxyCache.set(exportsObject, wrapped);
    return wrapped;
}

function installElectronHook() {
    const electron = require("electron");
    registerSchemes(electron);
    const cached = require.cache["electron"];
    if (!cached) {
        host.log("警告：require.cache 中没有 electron 模块，退回直接改写导出对象");
        const Original = electron.BrowserWindow;
        try {
            Object.defineProperty(electron, "BrowserWindow", {
                configurable: true,
                get: () => wrapBrowserWindow(electron, Original),
            });
        } catch (e) {
            host.log("直接改写 BrowserWindow 失败:", e);
        }
        return electron;
    }
    const proxy = new Proxy(cached, {
        get(target, property, receiver) {
            if (property === "exports") return wrapElectronExports(electron, target.exports);
            return Reflect.get(target, property, receiver);
        },
    });
    require.cache["electron"] = proxy;
    host.log("electron 模块已挂钩，BrowserWindow 将被自动注入");
    return electron;
}

function readUtf8(file) {
    try {
        return require("fs").readFileSync(file, "utf8");
    } catch (e) {
        host.log(`读取 ${file} 失败:`, e);
        return null;
    }
}

function sanitize(value) {
    if (value === undefined || value === null) return value;
    if (typeof value === "function") return undefined;
    if (typeof value !== "object") return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return String(value); }
}

function invokeApi(root, methodPath, args) {
    if (!Array.isArray(methodPath) || !methodPath.length || !methodPath.every((key) => typeof key === "string" && !["__proto__", "prototype", "constructor"].includes(key))) throw new Error("无效 API 路径");
    let owner = root, target = root;
    for (const key of methodPath) {
        owner = target;
        target = target?.[key];
        if (target === undefined) throw new Error("未知 API 路径: " + methodPath.join("."));
    }
    return typeof target === "function" ? target.apply(owner, Array.isArray(args) ? args : []) : target;
}
function apiError(methodPath, error) {
    host.log("API 调用失败 " + (Array.isArray(methodPath) ? methodPath.join(".") : "?"), error);
    return { mqga_error: error?.message || String(error) };
}
function resolveApi(root, methodPath, args) {
    try {
        const result = invokeApi(root, methodPath, args);
        if (result && typeof result.then === "function") {
            Promise.resolve(result).catch(() => {});
            throw new Error("异步 API 必须使用 mqga.async / ipcRenderer.invoke");
        }
        return sanitize(result);
    } catch (e) { return apiError(methodPath, e); }
}
async function resolveApiAsync(root, methodPath, args) {
    try { return sanitize(await invokeApi(root, methodPath, args)); }
    catch (e) { return apiError(methodPath, e); }
}

function installIpc(electron, state) {
    const { ipcMain } = electron;
    if (ipcInstalled.has(ipcMain)) return;
    ipcMain.on("mqga.sync", (event, methodPath, args) => {
        // 渲染进程来的日志带上账号分区（persist:qqnt_<uid>），便于区分是哪个账号的窗口
        if (Array.isArray(methodPath) && methodPath[0] === "log" && Array.isArray(args) && args.length) {
            try { args = ["[" + sessionName(event.sender) + "] " + String(args[0])]; } catch (e) { /* 忽略 */ }
        }
        event.returnValue = resolveApi(state.api, methodPath, args);
    });
    ipcMain.handle("mqga.async", async (event, methodPath, args) => resolveApiAsync(state.api, methodPath, args));
    const assertAllowed = (file) => safePaths.assertAllowed(file, [host.PATHS.root, host.PATHS.profile, host.PATHS.plugins]);
    ipcMain.handle("mqga.readFile", async (event, file) => readUtf8(assertAllowed(file)));
    ipcMain.on("mqga.readText", (event, file) => {
        try { event.returnValue = readUtf8(assertAllowed(file)); }
        catch (e) { host.log("readText 失败:", e); event.returnValue = null; }
    });
    ipcMain.on("mqga.exists", (event, file) => {
        try { event.returnValue = require("fs").existsSync(assertAllowed(file)); }
        catch (e) { event.returnValue = false; }
    });
    ipcMain.on("mqga.writeText", (event, file, content) => {
        try {
            const resolved = assertAllowed(file);
            require("fs").mkdirSync(path.dirname(resolved), { recursive: true });
            require("fs").writeFileSync(resolved, String(content ?? ""), "utf8");
            event.returnValue = true;
        } catch (e) {
            host.log("writeText 失败:", e);
            event.returnValue = false;
        }
    });
    ipcMain.on("mqga.preloadHit", (event, detail) => {
        try {
            const markerDir = path.join(host.PATHS.logs);
            require("fs").mkdirSync(markerDir, { recursive: true });
            require("fs").appendFileSync(path.join(markerDir, "preload-hit.log"),
                `[${new Date().toISOString()}] ${JSON.stringify(detail)}\r\n`, "utf8");
            event.returnValue = true;
        } catch (e) {
            event.returnValue = false;
        }
    });
    ipcMain.handle("mqga.rendererScripts", async () => state.rendererScripts());
    ipcInstalled.add(ipcMain);
    host.log("IPC 桥已建立");
}

module.exports = {
    installElectronHook,
    installIpc,
    sessionName,
    registerProtocol,
    registerProtocolOn,
    injectPreloadIntoSession,
    readUtf8,
};
