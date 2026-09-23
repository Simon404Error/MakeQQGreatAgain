# MakeQQGreatAgain

面向 **QQNT（Windows / QQ 9.9.35-52892 及同代版本）** 的插件宿主，带 QQ 设置界面内的管理面板。
本项目是在 [LiteLoaderQQNT](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT) 归档后的一次**独立重实现**：

## 1. 工作原理（公开部分）


> 公开的是宿主框架本身；绕过由使用者自行准备，放在宿主目录下的 `bin\` 中，
> 详情不在此讨论。这样做的原因是：一旦把绕过实现完整公开，官方可以照着定向封堵。

宿主框架的职责（本仓库全部内容）：

1. 由安装动作把 QQ 的 `package.json` 的 `main` 指向本宿主；
2. 宿主在 QQ 主进程里建立插件运行环境（`MQGA` / `LiteLoader` 兼容对象、IPC 桥、`mqga://` 与 `local://` 协议）；
4. 在页面主世界执行插件 renderer 段（自动把 ESM 改写成 CJS）并登记其导出；
5. 包装全局 `Proxy` 捕获 Vue 组件挂载/卸载，建立 `element.__VUE__` 映射后回调插件钩子；

## 2. 目录

```
MakeQQGreatAgain\
  src\main.js        宿主主进程入口（QQ 的 package.json main 指向它）
  src\host.js        路径 / 配置 / 插件扫描 / API 对象
  src\hooks.js       Electron 挂钩：BrowserWindow 拦截、预加载注册、IPC 桥、mqga:// 协议、窗口 URL 日志
  src\preload.js     渲染进程预加载：暴露 window.MQGA / window.LiteLoader，执行插件 preload/renderer 段
  bin\config.json    { qq, helper, patch }
  plugins\           插件
  data\              配置与数据（loader.json 为宿主总配置）
  logs\              日志
  LaunchQQ-with-MQGA.vbs   路线 B 启动器（双击运行）
```

## 3. 安装

本仓库只提供宿主框架，安装过程依赖使用者自行准备的绕过方式（本仓库不含其实现）。
把 `src/`、`plugins/mqga-sample/` 放到宿主目录，并让 QQ 的 `resources\app\package.json` 的
`main` 指向本宿主的入口即可；具体步骤请参考你获取绕过方式时附带的说明。

## 4. 设置界面（位置与 LiteLoaderQQNT 一致）

宿主在 QQ 设置窗口左栏新增一条**独立导航条**（`.nav-bar.mqga`），里面的条目为：

```
MGQA Ctrl          ← 宿主自己的管理面板（插件列表 / 启停 / 打开目录 / 刷新）
<插件名>            ← 每个导出了 onSettingWindowCreated 的插件各一项（如「轻量工具箱」）
```

即：**插件操作面板与宿主面板合并进同一个设置界面**，都直接显示在 QQ 设置左栏，点谁就切换右侧内容
（与 LiteLoaderQQNT 的 `add(plugin)` 行为一致）；点击 QQ 原生项会自动切回 QQ 自己的页面。
宿主显示名称为 **MGQA Ctrl**（完整项目名 MakeQQGreatAgain 作为面板副标题保留）。


调试用开关（`data\loader.json`，默认关闭）：

* `"dom_dump": true` —— 把每个渲染帧的 DOM 快照写入 `logs\dom\`（用于适配新版 QQ）
* `"open_settings": true` —— 启动后自动把主窗口切到设置路由（便于开发调试）
* `"renderer_inject": "execute"` —— 渲染段改用 `contextBridge.executeInMainWorld`（便于拿到真实报错）
* `"debug_console": true` —— 主进程 console 落盘 `logs\main-console.log`，并把渲染进程
  console/未捕获异常桥接到 `logs\loader.log`（前缀 `renderer:`），排查插件报错时很有用

## 4.1 第三方插件兼容性

渲染段宿主会把插件脚本包装成 CommonJS 模块执行，并**自动把 ESM 语法改写成 CJS**
（`export{a as b}` / `export default` / `export const|function|class`），因此像 lite-tools 这类由
esbuild 打包成 ESM 的插件也能直接加载；插件的 `module.exports` 会登记到
`window.__MQGA_RENDERER_EXPORTS__[slug]`。宿主另外补齐了 LiteLoaderQQNT 生态的常用约定：

* `local://` 协议（`local:///绝对路径`、`local://root|profile/相对路径`）
* 设置界面出现即为每个插件创建设置页容器并回调 `onSettingWindowCreated(view)`；
  `onVueComponentMount/Unmount` 由 `src/renderer-hooks.js` 驱动

**插件设置页（与 LiteLoaderQQNT 一致）**：设置界面一出现，宿主就为每个导出了 `onSettingWindowCreated(view)`
的插件创建**独立的容器元素**并回调该钩子（`view` 即该插件自己的设置页容器，插件把 HTML 追加进去）；
各插件的设置页与宿主面板并列显示在 QQ 设置左栏（见 §4）。这与 LLQQNT 的
`Runtime.triggerHooks("onSettingWindowCreated", plugin => [add(plugin)])` 语义相同。

**fetch 白名单**：QQ 只允许渲染进程 fetch `app/appimg/cacheimg`，因此宿主在启动时把 `local,mqga`
追加进 Chromium 的 `--fetch-schemes`（LiteLoaderQQNT 也做同样的事，见其 `src/main/api.js`），
否则插件用 `fetch("local:///<绝对路径>")` 读自身资源会直接得到 `TypeError: Failed to fetch`。
`local://` 处理器另外会把 Windows 反斜杠路径（`local:///D:\a\b.html`）归一化后再交给 `file://`。

**自适应窗口缩放**：内容视图 `.mqga-view` 以 `absolute inset:0` 锚在 `.setting-main__content` 上，
内边距随可用宽度收窄；插件设置页在「自然宽度 > 可用宽度」时按比例整体 `zoom` 缩小（下限 0.5），
窗口 resize（含最大化/还原、拖拽边缘）后 150ms 重算一次，因此非最大化时不会再出现文字溢出窗口外。
若某插件对缩放敏感，可在 `data\loader.json` 里设 `"ui_scale": "off"` 关闭自动缩放。

**Vue 组件钩子**：`src/renderer-hooks.js` 在页面脚本之前包装一次全局 `Proxy`，捕获 Vue 3 组件实例的
创建 / 挂载 / 卸载，并像 LiteLoaderQQNT 那样**建立 DOM ↔ 组件的映射**
（写入 `element.__VUE__` 数组、并给元素加 `vue-component` 类），然后才回调插件的
`onVueComponentMount` / `onVueComponentUnmount`。只回调而不建映射时，像轻量工具箱这种
「靠 `element.__VUE__` 找组件再打补丁」的插件会出现**开关点了没反应**。

实测（v4.0.6）：[`xiyuesaves/lite-tools`](https://github.com/xiyuesaves/lite-tools) 加上依赖
[`qwqnt-community/qwqnt-ipc-interceptor`](https://github.com/qwqnt-community/qwqnt-ipc-interceptor) 之后，
主进程段 / 预加载段 / 渲染段**全部执行成功**，渲染段正确导出
`["onSettingWindowCreated","onVueComponentMount","onVueComponentUnmount"]`；
主世界登记表实测为 `{"lite-tools":["onSettingWindowCreated",...]}`。
安装方法：把 Release 压缩包解压为 `plugins\lite-tools\`，依赖解压为 `plugins\ipc_interceptor\`，重启 QQ。

> 排错备忘：`contextBridge.exposeInMainWorld` 暴露出去的 `window.MQGA` 是**只读代理**，
> 插件渲染段的 `module.exports` 不能挂在它上面（会静默失败，导致插件设置钩子永远不被调用）。
> 宿主因此把登记表放在普通全局 `window.__MQGA_RENDERER_EXPORTS__` 上。

## 5. 插件

目录：`plugins\<任意目录>\manifest.json`

```json
{
  "manifest_version": 4,
  "type": "extension",
  "slug": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "示例",
  "platform": ["win32"],
  "dependencies": [],
  "injects": { "main": "main.js", "preload": "preload.js", "renderer": "renderer.js" }
}
```


* **main**：主进程（完整 Node）。导出 `onLoad()`、`onBrowserWindowCreated(win, plugin)`、`onLogin(uid, plugin)`、`onReady()`。
* **preload**：渲染进程隔离世界。**沙箱下没有 Node 内置模块**，宿主提供迷你模块系统，`require("./lib/x.js")`、`require("./x.json")` 可用。

宿主 API（主进程全局 `MQGA`，同时以 `LiteLoader` 暴露以兼容旧插件）：

```js
MQGA.api.config.get("my-plugin", { 默认值: 1 })   // data\my-plugin\config.json
MQGA.api.config.set("my-plugin", { ... })
MQGA.api.plugin.enable / disable(slug)
MQGA.api.openExternal(url) / openPath(p) / log(...)
MQGA.path.root / profile / data / plugins / logs
MQGA.plugins[slug].manifest / .path / .disabled / .incompatible
```

渲染进程里 `window.MQGA` / `window.LiteLoader` 提供同名 API，另有同步文件助手
`MQGA.readText(p)`、`MQGA.exists(p)`、`MQGA.writeText(p, text)`（限制在宿主目录内）。

自检插件 `mqga-sample` 会在 `data\mqga-sample\` 写 `main-inject.ok` / `renderer-inject.ok`，

## 6. 日志与排错

| 文件 | 内容 |
| --- | --- |
| `logs\loader.log` | 宿主启动、插件加载、窗口 URL、钩子与 API 调用 |
| `logs\preload-hit.log` | 每个渲染帧是否命中预加载脚本 |
| `logs\renderer-error.log` | 渲染进程段异常 |
| `logs\main-console.log` | 主进程 console（含插件主进程段日志，如轻量工具箱 / IPC Proxy），需 debug_console: true |

  若没有，打开 `dom_dump` 并查看 `logs\dom\*setting*.html`，据实际结构微调 `src\settings-ui.js` 的选择器。

## 7. 实测记录（Windows + QQ 9.9.35-52892 x64 / Electron 40.0.0 / Node 24.11.1）

| 项目 | 结果 |
| --- | --- |
| 路线 A：原版方式启动 `QQ.exe`（无启动器） | `logs\loader.log` 出现宿主启动与插件加载，QQ 正常起多进程 |
| 主进程段 / 预加载段 / 渲染进程段 | `main-inject.ok` / preload 日志（含迷你 require）/ `renderer-inject.ok` |
| 第三方插件 | lite-tools v4.0.6 + ipc_interceptor v1.2.1：三段全部执行成功，renderer 导出 3 个钩子，无报错 |

## 8. 风险

QQ 安全中心可能把任何插件加载行为判为「非法外挂工具」，存在下线设备甚至封号风险，请自行评估。
本项目不做对抗性检测规避，仅绕过启动期文件校验以便加载插件。

## 9. 后续路线

* 用自研内存补丁取代外部辅助 DLL：`bin\config.json` 的 `patch` 字段支持 `RVA:十六进制字节`
  定位到即可完全摆脱外部 DLL。
* 插件市场 / 主题：宿主已预留 `mqga://root|profile/...`、`local://` 协议与 IPC 桥，设置面板也已可扩展。
* Vue 组件钩子：LLQQNT 插件还会用 `onVueComponentMount/onVueComponentUnmount`（例如 lite-tools 的
  聊天区增强）；宿主目前只登记不驱动，后续可在渲染段挂钩 Vue 的挂载点来补齐。
