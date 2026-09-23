// 主进程段：验证插件主进程注入是否生效
const fs = require("fs");
const path = require("path");

const dataDir = path.join(MQGA.path.profile, "data", "mqga-sample");
fs.mkdirSync(dataDir, { recursive: true });
const marker = path.join(dataDir, "main-inject.ok");

let windowCount = 0;

module.exports = {
    onLoad() {
        fs.writeFileSync(marker, new Date().toISOString() + " main段注入成功\n", "utf8");
        MQGA.api.log("mqga-sample: 主进程段已加载");
    },
    onBrowserWindowCreated(win) {
        windowCount += 1;
        fs.appendFileSync(marker, `窗口创建 #${windowCount} ${new Date().toISOString()}\n`, "utf8");
    },
    onLogin(uid) {
        fs.appendFileSync(marker, `登录事件 uid=${uid}\n`, "utf8");
        MQGA.api.log("mqga-sample: 收到登录事件 " + uid);
    },
};

module.exports.onLoad();
