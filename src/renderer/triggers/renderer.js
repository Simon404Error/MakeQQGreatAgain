// MGQA: 只启用 setting 这一个 trigger。
// search.js（随机 Furry 图片菜单）/ title.js（1/1000 概率把面板改名）/ update.js（连点 20 次弹通知）
// 都是 LQ 品牌或彩蛋相关，MGQA 不需要 —— 文件still照搬在仓库里，只是不 import。
import setting from "./selector/setting.js";

/**
 * 触发器注册表
 */
const TRIGGERS = [
    setting
];

/**
 * 监听指定元素，如果不存在则等待其出现
 * @param {string} target - 目标选择器
 * @param {Function} callback - 回调函数
 */
function watchElement(target, callback) {
    const check = () => {
        const element = document.querySelector(target);
        if (!element) return false;
        try {
            callback(element);
        } catch (e) {
            // MGQA: action 抛错时不要吞掉观察器（upstream 会让异常穿透 MutationObserver，
            // 一旦 .setting-main__content 还没出现就会永久失败），这里退回去等下一次变更再试。
            console.warn("[MQGA] trigger action failed, will retry:", e);
            return false;
        }
        return true;
    };
    if (check()) return;
    const observer = new MutationObserver(() => {
        if (check()) observer.disconnect();
    });
    observer.observe(document, {
        subtree: true,
        childList: true
    });
}

/**
 * 监听 hash 变化
 * @param {string} target - 目标页面
 * @param {Function} callback - 回调函数
 */
function watchHash(target, callback) {
    const check = () => {
        if (!location.hash.includes(target)) return false;
        callback();
        return true;
    };
    if (check()) return;
    // MGQA: upstream 只监听 Navigation API 的 navigatesuccess —— 但 QQ 的 Vue hash 路由走的是
    // location.hash / history.pushState，不会触发 navigatesuccess，于是"打开设置时面板不出现"。
    // 这里补上 hashchange / popstate + 500ms 轮询兜底，语义仍是 upstream 的"hash 命中就执行一次"。
    let done = false;
    let timer = null;
    const stop = () => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        window.removeEventListener("hashchange", onNav);
        window.removeEventListener("popstate", onNav);
        try { navigation.removeEventListener("navigatesuccess", onNav); } catch (e) { /* 忽略 */ }
    };
    const onNav = () => { if (check()) stop(); };
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    try { navigation.addEventListener("navigatesuccess", onNav); } catch (e) { /* 环境没有 Navigation API */ }
    timer = setInterval(onNav, 500);
}

/**
 * 注册所有触发器
 */
TRIGGERS.forEach((trigger) => {
    watchHash(trigger.hash, () => {
        watchElement(trigger.selector, trigger.action);
    })
});