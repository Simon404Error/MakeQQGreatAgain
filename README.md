# MakeQQGreatAgain

面向 **QQNT（Windows / QQ 9.9.35-52892 及同代版本）** 的插件宿主，带 QQ 设置界面内的管理面板（**MGQA Ctrl**）。

上游 [LiteLoaderQQNT](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT) 归档后的一次**独立重实现**，插件接口保持兼容：LiteLoaderQQNT 的插件放进 `plugins/` 即可直接使用。

> ⚠️ 本仓库**部分公开**，仅作技术学习，请在 24h 内删除。
> 所有后果由使用者自行承担，与作者无关。

## 这是什么

- **插件宿主**：扫描 `plugins/*/manifest.json`，按 `injects.main / preload / renderer` 三段加载插件；
- **QQ 设置内面板**：在 QQ 设置左侧导航里多出一项 **MGQA Ctrl**，可安装/卸载插件、启停插件、重载插件；
- **兼容层**：`LiteLoader` / `MQGA` 全局对象、`local://` 与 `mqga://` 协议、`onSettingWindowCreated`、`onVueComponentMount` 等 LQ 插件常用接口全部提供。

## 功能一览

| 区域 | 能力 |
| --- | --- |
| 插件管理 | 从 zip / 文件夹安装（含覆盖安装）、卸载（可保留数据）、启用/禁用、重载 |
| 面板 | 左侧导航项与 QQ 原生设置项同款样式；插件注册迟到或漏注册时自动对账补项 |
| 多账号 | 每个 QQ 账号独立进程与会话分区，配置可全局共享（LiteLoaderQQNT 配置格式兼容） |
| 登录保护 | 登录页（`login.html` / passport）不注入任何脚本，避免影响 QQ 安全登录控件 |
| 诊断 | 日志集中在 `logs/`：`loader.log`（宿主/插件）、`main-console.log`（主进程 console） |

## 目录结构

```
src/
  main.js        宿主主进程入口：启动、插件扫描、IPC、API
  host.js        插件目录扫描 / 清单校验 / 安装与卸载 / 日志
  hooks.js       Electron 侧挂钩：浏览器窗口创建、协议注册、IPC
  preload.js     渲染进程预加载：三段注入、ESM 兼容、主世界导出登记表
  lq-entry.js    LiteLoaderQQNT 设置 UI 的打包入口
  lq.bundle.js   lq-entry.js 的构建产物（已提交，开箱即用）
  renderer/      与 LiteLoaderQQNT 对齐的设置界面组件（MIT，见下方致谢）
plugins/
  mqga-sample/   示例/自检插件：验证 main / preload / renderer 三段注入是否生效
```

## 不包含什么

**启动期文件校验的处理方式不在本仓库。** 本仓库只有插件宿主框架代码，
不含相关二进制、生成器、安装脚本或目标文件信息，详见 [SECURITY-NOTICE.md](SECURITY-NOTICE.md)。

## 安装

本仓库是框架源码，**不含完整安装方式**（见上一节）。
框架的运行需要宿主进程能正常加载 `src/main.js`，这一步由使用者自行解决。

## 开发

```bash
node --check src/main.js        # 语法自检
```

插件开发直接参考 `plugins/mqga-sample/`，或任何 LiteLoaderQQNT 插件的写法。

## 致谢

- [LiteLoaderQQNT](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT)：`src/renderer/**` 的界面组件与 `lq.bundle.js` 来自其 MIT 许可源码，本仓库做了品牌与功能裁剪；
- [ltxhhz/lite-tools](https://github.com/ltxhhz/lite-tools)、[xh321/LiteLoaderQQNT-Kill-Update](https://github.com/xh321/LiteLoaderQQNT-Kill-Update) 等插件在本宿主上验证过兼容性。

## 许可

MIT，见 `LICENSE`。
