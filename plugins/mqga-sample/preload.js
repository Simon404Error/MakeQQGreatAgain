// 预加载段（渲染进程隔离世界）：验证迷你 require、MQGA 注入与 IPC 桥
const report = (msg) => {
    try { console.log("[mqga-sample]", msg); } catch (e) { /* 忽略 */ }
    try {
        const api = (typeof MQGA !== "undefined" && MQGA && MQGA.api) || null;
        if (api && api.loader && typeof api.loader.log === "function") api.loader.log("mqga-sample(preload): " + msg);
        else if (api && typeof api.log === "function") api.log("mqga-sample(preload): " + msg);
    } catch (e) { /* 忽略 */ }
};

report("preload段注入成功 MQGA=" + typeof MQGA + " LiteLoader=" + typeof LiteLoader);

// 迷你模块系统自检：require 一个插件内的本地模块
try {
    const helper = require("./lib/helper.js");
    report("本地模块加载成功: " + helper.describe());
} catch (e) {
    report("本地模块加载失败: " + (e && e.message));
}

// 尝试真实 Node 能力（sandbox 下会失败，属预期）
try {
    const path = require("path");
    report("Node path 模块可用: " + path.basename("a\\b\\c.js"));
} catch (e) {
    report("无 Node 内置模块（sandbox 预期行为）");
}
