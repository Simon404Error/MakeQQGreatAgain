// 主进程段：验证插件主进程注入、宿主 API 与钩子是否生效
// 自检痕迹写入 data/mqga-sample/main-inject.ok
const fs = require("fs");
const path = require("path");

// 宿主 API 的健壮取用：不同版本暴露位置略有差异，取不到就退回 console
function log(msg) {
    try {
        const api = (typeof MQGA !== "undefined" && MQGA && MQGA.api) || null;
        if (api && api.loader && typeof api.loader.log === "function") return api.loader.log("[mqga-sample] " + msg);
        if (api && typeof api.log === "function") return api.log("[mqga-sample] " + msg);
    } catch (e) { /* 忽略 */ }
    try { console.log("[mqga-sample] " + msg); } catch (e) { /* 忽略 */ }
}

const paths = (typeof MQGA !== "undefined" && MQGA && (MQGA.path || MQGA.paths)) || {};
const dataDir = path.join(paths.profile || __dirname, "data", "mqga-sample");
const marker = path.join(dataDir, "main-inject.ok");

let windowCount = 0;

module.exports = {
    onLoad() {
        try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* 忽略 */ }
        try {
            fs.writeFileSync(marker,
                "main 段注入成功\n" +
                "time    = " + new Date().toISOString() + "\n" +
                "root    = " + (paths.root || "?") + "\n" +
                "profile = " + (paths.profile || "?") + "\n", "utf8");
        } catch (e) { /* 忽略 */ }
        log("主进程段已加载，自检文件: " + marker);
    },
    onBrowserWindowCreated(win) {
        windowCount += 1;
        try { fs.appendFileSync(marker, "窗口创建 #" + windowCount + " " + new Date().toISOString() + "\n", "utf8"); } catch (e) { /* 忽略 */ }
    },
    onLogin(uid) {
        try { fs.appendFileSync(marker, "登录事件 uid=" + uid + " " + new Date().toISOString() + "\n", "utf8"); } catch (e) { /* 忽略 */ }
        log("收到登录事件 uid=" + uid);
    },
    onReady() {
        log("宿主 ready");
    },
};
