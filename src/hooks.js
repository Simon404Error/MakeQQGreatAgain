/**
 * MakeQQGreatAgain 的 Electron 接入层：
 *  - 代理 electron 模块，拦截 BrowserWindow 构造，向会话注册预加载脚本
 *  - 注册 mqga:// 协议供渲染进程读取宿主/插件目录（含插件资源）
 *  - 建立主进程 <-> 渲染进程的 API 桥（同步 + 异步）
 */
const path = require("path");
const host = require("./host.js");

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

const protocolRegistered = new WeakSet();

function registerProtocolOn(electron, protocol) {
    if (!protocol || protocolRegistered.has(protocol)) return;
    protocolRegistered.add(protocol);
    try {
        protocol.handle("mqga", (request) => {
            const url = new URL(request.url);
            const hostname = url.hostname;
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
            const base = hostname === "profile" ? host.PATHS.profile : host.PATHS.root;
            const target = path.normalize(path.join(base, relative));
            if (!target.startsWith(host.PATHS.root) && !target.startsWith(host.PATHS.profile)) {
                return new Response("forbidden", { status: 403 });
            }
            return electron.net.fetch(`file:///${target.replace(/\\/g, "/")}`);
        });
        host.log("mqga:// 协议处理器已注册");
        // local:// 兼容层：local:///绝对路径 或 local://root|profile/相对路径
        // 注意：Windows 插件常拼出 local:///D:\a\b.html 这种带反斜杠的 URL，这里统一归一化
        protocol.handle("local", async (request) => {
            try {
                let rawPath = "";
                let hostname = "";
                try {
                    const url = new URL(request.url);
                    hostname = url.hostname || "";
                    rawPath = decodeURIComponent(url.pathname || "");
                } catch (e) {
                    // URL 无法解析时退化为手工拆分
                    const rest = String(request.url).replace(/^local:\/\//i, "");
                    const slash = rest.indexOf("/");
                    hostname = slash >= 0 ? rest.slice(0, slash) : rest;
                    rawPath = slash >= 0 ? rest.slice(slash) : "/";
                }
                rawPath = rawPath.replace(/\\/g, "/");
                let target;
                if (hostname === "root" || hostname === "profile") {
                    const base = hostname === "profile" ? host.PATHS.profile : host.PATHS.root;
                    target = path.normalize(path.join(base, rawPath.replace(/^\/+/, "")));
                } else {
                    target = path.normalize(decodeURIComponent(rawPath.replace(/^\/([a-zA-Z]:)/, "$1")));
                }
                const fileUrl = `file:///${target.replace(/\\/g, "/")}`;
                const response = await electron.net.fetch(fileUrl);
                host.log("local:// -> " + (response.ok ? "ok" : "status " + response.status) + " " + target);
                return response;
            } catch (e) {
                host.log("local:// 处理失败: " + request.url + " :: " + ((e && e.message) || e));
                return new Response("not found", { status: 404 });
            }
        });
        host.log("local:// 兼容协议已注册");
    } catch (e) {
        protocolRegistered.delete(protocol);
        if (String(e && e.message).includes("Failed to register protocol")) {
            host.log("mqga:// 处理器已在其它会话注册，跳过");
        } else {
            host.log("注册 mqga:// 处理器失败:", e);
        }
    }
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
    if (!session || instrumentedSessions.has(session)) return;
    instrumentedSessions.add(session);
    try {
        if (typeof session.registerPreloadScript === "function") {
            session.registerPreloadScript({ type: "frame", filePath: host.PATHS.preload });
            host.log("已向会话注册预加载脚本（registerPreloadScript）");
        }
    } catch (e) {
        host.log("registerPreloadScript 失败:", e);
    }
    try {
        // 兼容旧式 Electron：包装 session.getPreloadScripts 与 webContents._getPreloadPaths
        const origin = session.getPreloadScripts?.bind(session);
        if (origin) {
            const patched = function (...args) {
                const list = origin(...args) || [];
                if (!list.some((item) => item?.filePath === host.PATHS.preload)) {
                    list.unshift({ filePath: host.PATHS.preload, type: "frame" });
                }
                return list;
            };
            Object.defineProperty(session, "getPreloadScripts", { value: patched, configurable: true });
        }
    } catch (e) {
        host.log("包装 getPreloadScripts 失败:", e);
    }
}

function instrumentWindow(win) {
    const webContents = win?.webContents;
    if (!webContents) return;
    host.log("BrowserWindow 已拦截，注入预加载脚本（session=" + (webContents.session ? "ok" : "?") + "）");
    injectPreloadIntoSession(webContents.session);
    try {
        const original = webContents._getPreloadPaths?.bind(webContents);
        if (original) {
            Object.defineProperty(webContents, "_getPreloadPaths", {
                configurable: true,
                value: (...args) => {
                    const list = original(...args) || [];
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
                        host.emit("login", payload[1]?.payload?.uid);
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
                try { host.log("窗口加载完成: url=" + webContents.getURL() + " title=" + (win.getTitle ? win.getTitle() : "")); } catch (e) { }
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
        try {
            Object.defineProperty(electron, "BrowserWindow", {
                configurable: true,
                get: () => wrapBrowserWindow(electron, Object.getPrototypeOf(electron).constructor && require("electron").BrowserWindow),
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

function resolveApi(root, methodPath, args) {
    try {
        let target = root;
        for (const key of methodPath) {
            target = target?.[key];
            if (target === undefined) throw new Error(`未知的 API 路径: ${methodPath.join(".")}`);
        }
        const result = typeof target === "function" ? target(...(args || [])) : target;
        return sanitize(result);
    } catch (e) {
        host.log(`API 调用失败 ${methodPath?.join?.(".")}:`, e);
        return { mqga_error: String((e && e.message) || e) };
    }
}

function installIpc(electron, state) {
    const { ipcMain } = electron;
    ipcMain.on("mqga.sync", (event, methodPath, args) => {
        event.returnValue = resolveApi(state.api, methodPath, args);
    });
    ipcMain.handle("mqga.async", async (event, methodPath, args) => resolveApi(state.api, methodPath, args));
    ipcMain.handle("mqga.readFile", async (event, file) => {
        const resolved = path.resolve(String(file));
        const allowed = [host.PATHS.root, host.PATHS.profile, host.PATHS.plugins];
        if (!allowed.some((base) => resolved.toLowerCase().startsWith(base.toLowerCase()))) {
            throw new Error("拒绝读取宿主之外的路径: " + resolved);
        }
        return readUtf8(resolved);
    });
    const assertAllowed = (file) => {
        const resolved = path.resolve(String(file));
        const allowed = [host.PATHS.root, host.PATHS.profile, host.PATHS.plugins];
        if (!allowed.some((base) => resolved.toLowerCase().startsWith(base.toLowerCase()))) {
            throw new Error("拒绝访问宿主之外的路径: " + resolved);
        }
        return resolved;
    };
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
    host.log("IPC 桥已建立");
}

module.exports = {
    installElectronHook,
    installIpc,
    registerProtocol,
    registerProtocolOn,
    injectPreloadIntoSession,
    readUtf8,
};
