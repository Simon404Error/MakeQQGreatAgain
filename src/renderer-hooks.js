/**
 * MQGA 渲染进程钩子：为 LiteLoaderQQNT 插件提供 onVueComponentMount / onVueComponentUnmount。
 *
 * 思路（与 LiteLoaderQQNT 相同路线）：QQ 的界面是 Vue 3 渲染的，Vue 在创建组件实例时会用到
 * 运行时的 Proxy 构造器，因此包装一次全局 Proxy 即可捕获「组件实例创建」这一时机；
 * 拿到组件实例后再观察它的 vnode.el（挂载完成）与 isUnmounted（卸载），据此回调插件导出。
 * 该脚本需要在 QQ 页面脚本之前执行，因此由 preload 在启动时立即注入。
 */
(function () {
    if (window.__MQGA_VUE_HOOK__) return;
    window.__MQGA_VUE_HOOK__ = { mounted: 0, unmounted: 0 };

    const state = window.__MQGA_VUE_HOOK__;

    function exportsMap() {
        return window.__MQGA_RENDERER_EXPORTS__ || {};
    }

    function trigger(name, args) {
        const map = exportsMap();
        for (const slug of Object.keys(map)) {
            const handler = map[slug] && map[slug][name];
            if (typeof handler !== "function") continue;
            try {
                handler(...args);
            } catch (e) {
                console.error("[MQGA] " + name + " 插件异常 " + slug, e);
            }
        }
    }

    /**
     * 记录「DOM 元素 ↔ Vue 组件」的映射（与 LiteLoaderQQNT 的 recordComponent 一致）。
     * 插件（如轻量工具箱）会通过 element.__VUE__ 与 .vue-component 找到组件再打补丁，
     * 只回调 onVueComponentMount 而不建立这个映射，插件就会「开关点了没反应」。
     */
    function recordComponent(component) {
        try {
            let element = component && component.vnode ? component.vnode.el : null;
            let guard = 0;
            while (!(element instanceof HTMLElement) && element && element.parentElement && guard++ < 50) {
                element = element.parentElement;
            }
            if (!(element instanceof HTMLElement)) return;
            if (!element.__VUE__) element.__VUE__ = [];
            if (element.__VUE__.indexOf(component) === -1) element.__VUE__.push(component);
            element.classList.add("vue-component");
        } catch (e) { /* 记录失败不影响页面 */ }
    }

    // 低频汇报：确认组件钩子确实在工作（每 300 个组件或首次挂载时记一次）
    let lastReport = 0;
    function reportState() {
        try {
            if (state.mounted - lastReport < 300) return;
            lastReport = state.mounted;
            if (window.MQGA && window.MQGA.api && window.MQGA.api.log) {
                window.MQGA.api.log("Vue 组件钩子: mounted=" + state.mounted + " unmounted=" + state.unmounted);
            }
        } catch (e) { /* 忽略 */ }
    }
    window.__MQGA_REPORT_VUE__ = reportState;

    const RealProxy = window.Proxy;
    if (typeof RealProxy !== "function") return;

    const Wrapped = new RealProxy(RealProxy, {
        construct(target, args, newTarget) {
            try {
                const component = args && args[0] && args[0]._;
                if (component && typeof component.uid === "number" && component.uid >= 0) {
                    if (component.vnode && component.vnode.el) {
                        if (!component.__mqgaMounted) {
                            component.__mqgaMounted = true;
                            state.mounted++;
                            recordComponent(component);
                            trigger("onVueComponentMount", [component]);
                            reportState();
                        }
                    } else if (component.vnode && !component.__mqgaMountWatch) {
                        component.__mqgaMountWatch = true;
                        let value = null;
                        let fired = false;
                        Object.defineProperty(component.vnode, "el", {
                            configurable: true,
                            get: () => value,
                            set(next) {
                                value = next;
                                if (!fired && next) {
                                    fired = true;
                                    component.__mqgaMounted = true;
                                    state.mounted++;
                                    recordComponent(component);
                                    trigger("onVueComponentMount", [component]);
                                    reportState();
                                }
                            },
                        });
                    }
                    if (!component.__mqgaUnmountWatch) {
                        component.__mqgaUnmountWatch = true;
                        let unmounted = null;
                        let fired = false;
                        Object.defineProperty(component, "isUnmounted", {
                            configurable: true,
                            get: () => unmounted,
                            set(next) {
                                unmounted = next;
                                if (!fired && next) {
                                    fired = true;
                                    state.unmounted++;
                                    trigger("onVueComponentUnmount", [component]);
                                }
                            },
                        });
                    }
                }
            } catch (e) {
                /* 组件探测失败不能影响页面本身 */
            }
            return Reflect.construct(target, args, newTarget);
        },
    });

    window.Proxy = Wrapped;
})();
