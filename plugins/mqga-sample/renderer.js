// 渲染进程段（页面主世界）：验证主世界注入
(function () {
    try {
        window.__mqgaSample = { ok: true, at: new Date().toISOString(), hasMQGA: typeof window.MQGA };

        // 主世界可通过 MQGA.writeText 回写宿主的日志目录，便于自检
        try {
            if (window.MQGA && typeof window.MQGA.writeText === "function" && window.MQGA.paths && window.MQGA.paths.root) {
                window.MQGA.writeText(
                    window.MQGA.paths.root + "\\data\\mqga-sample\\renderer-inject.ok",
                    "renderer段注入成功\nurl=" + location.href + "\ntime=" + new Date().toISOString() + "\n"
                );
            }
        } catch (e) { /* 忽略 */ }

        const badge = document.createElement("div");
        badge.id = "mqga-sample-badge";
        badge.textContent = "MQGA";
        badge.style.cssText = [
            "position:fixed", "right:8px", "bottom:8px", "z-index:2147483647",
            "padding:2px 8px", "border-radius:10px", "font-size:12px",
            "background:rgba(120,80,200,.85)", "color:#fff", "pointer-events:none",
            "font-family:system-ui,sans-serif",
        ].join(";");
        const attach = () => document.body && document.body.appendChild(badge);
        if (document.body) attach();
        else document.addEventListener("DOMContentLoaded", attach, { once: true });
    } catch (e) {
        console.error("[mqga-sample] renderer 段异常", e);
    }
})();
