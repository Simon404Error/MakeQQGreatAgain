(() => {
  // renderer/components/element.js
  var BaseElement = class extends HTMLElement {
    static observedAttributes = [
      "data-title",
      "data-value",
      "data-type",
      "data-direction",
      "is-collapsible",
      "is-selected",
      "is-active",
      "is-disabled"
    ];
    attributeChangedCallback() {
      this.update();
    }
    connectedCallback() {
      this.update();
    }
    getTemplate() {
    }
    getStyles() {
    }
    update() {
    }
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = this.getTemplate();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`
            :host([is-disabled]) { opacity: .3; cursor: not-allowed; pointer-events: none; }
            :host(.hidden), .hidden { display: none !important; }
            ${this.getStyles()}
        `);
      this.shadowRoot.adoptedStyleSheets = [sheet];
    }
    setTitle(title) {
      this.setAttribute("data-title", title);
    }
    getTitle() {
      return this.getAttribute("data-title");
    }
    setValue(value) {
      this.setAttribute("data-value", value);
    }
    getValue() {
      return this.getAttribute("data-value");
    }
    setType(type) {
      if (!["primary", "secondary"].includes(type)) {
        throw new Error("Type must be 'primary' or 'secondary'");
      }
      this.setAttribute("data-type", type);
    }
    getType() {
      return this.getAttribute("data-type");
    }
    setDirection(direction) {
      if (!["column", "row"].includes(direction)) {
        throw new Error("Direction must be 'column' or 'row'");
      }
      this.setAttribute("data-direction", direction);
    }
    getDirection() {
      return this.getAttribute("data-direction");
    }
    setCollapsible(collapsible) {
      this.toggleAttribute("is-collapsible", collapsible);
    }
    getCollapsible() {
      return this.hasAttribute("is-collapsible");
    }
    setSelected(selected) {
      this.toggleAttribute("is-selected", selected);
    }
    getSelected() {
      return this.hasAttribute("is-selected");
    }
    setActive(active) {
      this.toggleAttribute("is-active", active);
    }
    getActive() {
      return this.hasAttribute("is-active");
    }
    setDisabled(disabled) {
      this.toggleAttribute("is-disabled", disabled);
    }
    getDisabled() {
      return this.hasAttribute("is-disabled");
    }
  };

  // renderer/components/elements/section.js
  var Section = class extends BaseElement {
    #title = this.shadowRoot.querySelector("h1");
    update() {
      this.#title.textContent = this.getTitle();
    }
    getTemplate() {
      return (
        /*html*/
        `
            <h1></h1>
            <slot></slot>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            h1 {
                margin: 0px 0px 8px;
                padding: 0px 16px;
                color: var(--text_primary);
                font-weight: var(--font-bold);
                font-size: min(var(--font_size_3), 18px);
                line-height: min(var(--line_height_3), 24px);
            }
        `
      );
    }
  };

  // renderer/components/elements/panel.js
  var Panel = class extends BaseElement {
    getTemplate() {
      return (
        /*html*/
        `
            <slot></slot>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host {
                display: block;
                margin-bottom: 20px;
                background-color: var(--fill_light_primary, var(--fg_white));
                border-radius: 8px;
                font-size: min(var(--font_size_3), 18px);
                line-height: min(var(--line_height_3), 24px);
            }
        `
      );
    }
  };

  // renderer/components/elements/list.js
  var List = class extends BaseElement {
    #head = this.shadowRoot.querySelector("setting-item");
    #title = this.shadowRoot.querySelector("h2");
    #slot = this.shadowRoot.querySelector("slot");
    constructor() {
      super();
      this.#setupEventListeners();
      this.#setupMutationObserver();
    }
    update() {
      this.#updateTitle();
      this.#updateLayout();
      this.#updateDividers();
    }
    #setupEventListeners() {
      this.#head.addEventListener("click", () => {
        this.setActive(!this.getActive());
      });
    }
    #setupMutationObserver() {
      new MutationObserver((_, observer) => {
        observer.disconnect();
        this.update();
        observer.observe(this, { childList: true });
      }).observe(this, { childList: true });
    }
    #updateTitle() {
      this.#title.textContent = this.getTitle();
    }
    #updateLayout() {
      this.#head.classList.toggle("hidden", !this.getCollapsible());
    }
    #updateDividers() {
      const direction = this.getDirection();
      const collapsible = this.getCollapsible();
      const dividers = this.querySelectorAll("setting-divider");
      const children = this.#slot.assignedElements();
      dividers.forEach((node) => node.remove());
      children.forEach((node, index) => {
        const divider = document.createElement("setting-divider");
        const dividerDirection = direction == "column" ? "row" : "column";
        const shouldInsertBefore = collapsible && index < children.length;
        const shouldInsertAfter = !collapsible && index + 1 < children.length;
        requestAnimationFrame(() => {
          divider.setDirection(dividerDirection);
          node.setDirection?.(dividerDirection);
        });
        if (shouldInsertBefore) {
          node.before(divider);
        } else if (shouldInsertAfter) {
          node.after(divider);
        }
      });
    }
    getTemplate() {
      return (
        /*html*/
        `
            <setting-item data-direction="row" class="hidden">
                <h2></h2>
                <svg viewBox="0 0 24 24">
                    <use xlink:href="/_upper_/resource/icons/arrow_down_24.svg#arrow_down_24"></use>
                </svg>
            </setting-item>
            <slot></slot>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host([data-direction="column"]) { display: block; padding: 0px 16px; }
            :host([data-direction="row"]) { display: flex; justify-content: space-between; padding: 16px 0px; }
            :host([is-collapsible]) slot { display: none !important; }
            :host([is-active]) slot { display: block !important; }
            :host([is-active]) svg { transform: rotate(-180deg); }
            setting-item { cursor: pointer; font-size: min(var(--font_size_3), 18px); line-height: min(var(--line_height_3), 24px); }
            svg { width: 1rem; height: 1rem; transition: transform .2s ease; }
            h2 { font: inherit; border: 0px; margin: 0px; padding: 0px; }
        `
      );
    }
  };

  // renderer/components/elements/item.js
  var Item = class extends BaseElement {
    getTemplate() {
      return (
        /*html*/
        `
            <slot></slot>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host([data-direction="column"]) {
                flex: 1;
                padding: 0px 10px;
                text-align: center;
            }
            :host([data-direction="row"]) {
                padding: 12px 0px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
        `
      );
    }
  };

  // renderer/components/elements/select.js
  var Select = class extends BaseElement {
    #title = this.shadowRoot.querySelector("input");
    #button = this.shadowRoot.querySelector(".menu-button");
    #context = this.shadowRoot.querySelector("ul");
    constructor() {
      super();
      const pointerup = (event) => {
        if (event.target.tagName != "SETTING-SELECT") {
          click();
        }
      };
      const click = () => {
        this.#context.classList.toggle("hidden");
        if (!this.#context.classList.contains("hidden")) {
          window.addEventListener("pointerup", pointerup);
          this.#context.style.width = getComputedStyle(this).getPropertyValue("width");
        } else {
          window.removeEventListener("pointerup", pointerup);
          this.#context.style.width = null;
        }
      };
      this.#button.addEventListener("click", click);
      this.#context.addEventListener("click", (event) => {
        if (event.target.tagName == "SETTING-OPTION" && !event.target.getSelected()) {
          for (const node of this.querySelectorAll("setting-option[is-selected]")) {
            node.setSelected(!node.getSelected());
          }
          event.target.setSelected(!event.target.getSelected());
          this.#title.value = event.target.textContent;
          this.dispatchEvent(new CustomEvent("selected", {
            bubbles: true,
            composed: true,
            detail: {
              name: event.target.textContent,
              value: event.target.getValue()
            }
          }));
        }
      });
    }
    update() {
      this.#title.value = this.querySelector("setting-option[is-selected]")?.textContent;
    }
    getTemplate() {
      return (
        /*html*/
        `
            <div class="menu-button">
                <input type="text" readonly placeholder="\u8BF7\u9009\u62E9">
                <svg viewBox="0 0 16 16">
                    <use xlink:href="/_upper_/resource/icons/arrow_down_small_16.svg#arrow_down_small_16"></use>
                </svg>
            </div>
            <ul class="hidden">
                <slot></slot>
            </ul>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host {
                display: block;
                position: relative;
                width: 100px;
                color: var(--text_primary);
                font-size: 12px;
            }
            .menu-button {
                display: flex;
                justify-content: space-between;
                align-items: center;
                height: 24px;
                padding: 0px 8px;
                background-color: transparent;
                border: 1px solid var(--border_dark);
                border-radius: 4px;
                cursor: pointer;
            }
            .menu-button input {
                flex: 1;
                margin-right: 8px;
                padding: 0;
                background: none;
                border: none;
                outline: none;
                color: var(--text_primary);
                cursor: pointer;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .menu-button svg {
                width: 16px;
                height: 16px;
                color: var(--icon_primary);
            }
            ul {
                position: absolute;
                top: calc(100% + 5px);
                display: flex;
                flex-direction: column;
                gap: 4px;
                max-height: var(--q-contextmenu-max-height);
                margin: 0;
                padding: 4px;
                background-color: var(--blur_middle_standard);
                border: var(--border_secondary);
                border-radius: 4px;
                box-shadow: var(--shadow_bg_middle_secondary);
                backdrop-filter: blur(8px);
                list-style: none;
                overflow-y: auto;
                z-index: 999;
            }
        `
      );
    }
  };

  // renderer/components/elements/option.js
  var Option = class extends BaseElement {
    getTemplate() {
      return (
        /*html*/
        `
            <li>
                <span>
                    <slot></slot>
                </span>
                <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2 7L6.00001 11L14 3" stroke="currentColor" stroke-linejoin="round"></path>
                </svg>
            </li>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host { display: block; }
            :host([is-selected]) li { background-color: var(--overlay_active); }
            :host([is-selected]) svg { display: block; }
            li {
                display: flex;
                justify-content: space-between;
                padding: 0px 8px;
                color: var(--text_primary);
                font-size: 12px;
                line-height: 24px;
                border-radius: 4px;
                cursor: pointer;
            }
            li:hover { background-color: var(--overlay_hover); }
            li:active { background-color: var(--overlay_pressed); }
            span {
                margin-right: 8px;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }
            svg {
                display: none;
                flex-shrink: 0;
                width: 1em;
                height: 1em;
                margin: 7px -4px 0px 0px;
                color: var(--icon_primary);
            }
        `
      );
    }
  };

  // renderer/components/elements/switch.js
  var Switch = class extends BaseElement {
    getTemplate() {
      return (
        /*html*/
        `
            <span>
                <slot></slot>
            </span>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host {
                display: inline-flex;
                width: 28px;
                padding: 3px;
                background-color: var(--fill_standard_primary);
                border-radius: 14px;
                transition: all .2s cubic-bezier(.38, 0, .24, 1);
            }
            :host([is-active]) { background-color: var(--brand_standard); }
            :host([is-active]) span { transform: translateX(17px); }
            span {
                width: 10px;
                height: 10px;
                background: var(--icon_white);
                border-radius: 5px;
                box-shadow: 0px 2px 4px rgba(0, 0, 0, .09);
                transition: transform .2s cubic-bezier(.38, 0, .24, 1);
            }
        `
      );
    }
  };

  // renderer/components/elements/button.js
  var Button = class extends BaseElement {
    getTemplate() {
      return (
        /*html*/
        `
            <button>
                <slot></slot>
            </button>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host { position: relative; vertical-align: text-bottom; }
            button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background-color: var(--brand_standard);
                color: var(--on_brand_primary);
                border: 1px solid var(--brand_standard);
                border-radius: 4px;
                outline: none;
                font-size: 12px;
                line-height: 14px;
                min-width: 62px;
                margin: 0px;
                padding: 4px 7px;
                cursor: pointer;
            }
            button:hover { background-color: var(--nt_brand_standard_2_overlay_hover_brand_2_mix); }
            button:active { background-color: var(--nt_brand_standard_2_overlay_pressed_brand_2_mix); }
            :host([data-type="secondary"]) button {
                background-color: transparent;
                color: var(--text_primary);
                border-color: var(--fill_standard_primary);
            }
            :host([data-type="secondary"]) button:hover { background-color: var(--overlay_hover); }
            :host([data-type="secondary"]) button:active { background-color: var(--overlay_pressed); }
        `
      );
    }
  };

  // renderer/components/elements/text.js
  var Text = class extends BaseElement {
    getTemplate() {
      return (
        /*html*/
        `
            <slot></slot>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host {
                display: -webkit-box;
                word-break: break-all;
                text-overflow: ellipsis;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 1;
                overflow: hidden;
            }
            :host([data-type="secondary"]) {
                color: var(--text_secondary);
                font-size: min(var(--font_size_2), 16px);
                line-height: min(var(--line_height_2), 22px);
                margin-top: 4px;
            }
        `
      );
    }
  };

  // renderer/components/elements/link.js
  var Link = class extends BaseElement {
    #openExternalBound = this.#openExternal.bind(this);
    connectedCallback() {
      super.connectedCallback();
      this.addEventListener("click", this.#openExternalBound);
    }
    disconnectedCallback() {
      super.disconnectedCallback();
      this.removeEventListener("click", this.#openExternalBound);
    }
    #openExternal() {
      const value = this.getValue();
      try {
        new URL(value);
        LiteLoader.api.openExternal(value);
      } catch {
        LiteLoader.api.openPath(value);
      }
    }
    update() {
      this.textContent ||= this.getValue();
    }
    getTemplate() {
      return (
        /*html*/
        `
            <slot></slot>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host { color: var(--text_link); cursor: pointer; }
        `
      );
    }
  };

  // renderer/components/elements/divider.js
  var Divider = class extends BaseElement {
    getTemplate() {
      return (
        /*html*/
        `
            <slot></slot>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host { display: block; background-color: rgba(127, 127, 127, .15); }
            :host([data-direction="row"]) { height: 1px; }
            :host([data-direction="column"]) { width: 1px; }
        `
      );
    }
  };

  // renderer/components/elements/modal.js
  var Modal = class extends BaseElement {
    #title = this.shadowRoot.querySelector(".title");
    #close = this.shadowRoot.querySelector(".close");
    #modal = this.shadowRoot.querySelector(".modal");
    #toggleActiveBound = this.#toggleActive.bind(this);
    #toggleActive() {
      this.setActive(!this.getActive());
    }
    connectedCallback() {
      super.connectedCallback();
      this.#close.addEventListener("click", this.#toggleActiveBound);
      this.#modal.addEventListener("click", this.#toggleActiveBound);
    }
    disconnectedCallback() {
      super.disconnectedCallback();
      this.#close.removeEventListener("click", this.#toggleActiveBound);
      this.#modal.removeEventListener("click", this.#toggleActiveBound);
    }
    update() {
      this.#title.textContent = this.getTitle();
    }
    getTemplate() {
      return (
        /*html*/
        `
            <div class="modal"></div>
            <div class="main">
                <div class="header">
                    <div class="title"></div>
                    <svg class="close" viewBox="0 0 24 24">
                        <use xlink:href="/_upper_/resource/icons/close_24.svg#close_24"></use>
                    </svg>
                </div>
                <div class="body">
                    <slot></slot>
                </div>
            </div>
        `
      );
    }
    getStyles() {
      return (
        /*css*/
        `
            :host { display: none; }
            :host([is-active]) {
                display: flex;
                justify-content: center;
                align-items: center;
                position: fixed;
                inset: 0;
                z-index: 5000;
                animation: fadeIn .2s ease;
            }
            .modal {
                position: fixed;
                inset: 0;
                background-color: rgba(0, 0, 0, .5);
                animation: fadeIn .2s ease;
            }
            .main {
                position: relative;
                display: flex;
                flex-direction: column;
                width: 480px;
                background-color: var(--bg_top_light);
                border: var(--border_primary);
                border-radius: 8px;
                box-shadow: var(--shadow_bg_middle_primary);
                overflow: hidden;
                z-index: 1;
                animation: slideDown .3s cubic-bezier(.38, 0, .24, 1);
            }
            .header {
                position: relative;
                flex-shrink: 0;
                height: 28px;
                background-color: var(--bg_bottom_standard);
                border-bottom: 1px solid rgba(255, 255, 255, .06);
            }
            .title {
                font-size: 12px;
                line-height: 28px;
                text-align: center;
            }
            .close {
                position: absolute;
                right: 4px;
                top: 50%;
                width: 16px;
                height: 16px;
                color: var(--icon-primary);
                transform: translateY(-50%);
                cursor: pointer;
            }
            .body {
                flex: 1;
                padding: 20px;
                background-color: var(--bg_bottom_standard);
                overflow-y: auto;
            }
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes slideDown {
                from { opacity: 0; transform: translateY(-50px); }
                to { opacity: 1; transform: translateY(0); }
            }
        `
      );
    }
  };

  // renderer/components/renderer.js
  var COMPONENTS = [
    { tag: "setting-section", element: Section },
    { tag: "setting-panel", element: Panel },
    { tag: "setting-list", element: List },
    { tag: "setting-item", element: Item },
    { tag: "setting-select", element: Select },
    { tag: "setting-option", element: Option },
    { tag: "setting-switch", element: Switch },
    { tag: "setting-button", element: Button },
    { tag: "setting-text", element: Text },
    { tag: "setting-link", element: Link },
    { tag: "setting-divider", element: Divider },
    { tag: "setting-modal", element: Modal }
  ];
  COMPONENTS.forEach(({ tag, element }) => {
    if (!customElements.get(tag)) {
      customElements.define(tag, element);
    }
  });

  // renderer/runtime.js
  var Runtime = class {
    static #plugins = /* @__PURE__ */ new Map();
    static registerPlugin(plugin, exports) {
      this.#plugins.set(plugin, exports);
    }
    static triggerHooks(name, args) {
      for (const [plugin, exports] of this.#plugins) {
        try {
          exports[name]?.(...typeof args == "function" ? args(plugin) : args);
        } catch (error) {
          console.log(`[Renderer] [${plugin.manifest.slug}] [${name}]: `, error);
        }
      }
    }
  };

  // common/static/config.json
  var config_default = {
    enable_plugins: true,
    disabled_plugins: [],
    deleting_plugins: {}
  };

  // renderer/settings/renderer.js
  function initView(view, html) {
    view.innerHTML = html;
    initVersions(view);
    initPluginList(view);
    initPath(view);
    initAbout(view);
  }
  async function appropriateIcon(icon) {
    return icon.endsWith(".svg") ? await (await fetch(icon)).text() : `<img src="${icon}"/>`;
  }
  async function initVersions(view) {
    if (globalThis.qwqnt) view.querySelector(".versions .qwqnt").style.display = "block";
    view.querySelector(".versions .liteloader .version").textContent = LiteLoader.versions.liteloader;
    view.querySelector(".versions .qqnt .version").textContent = LiteLoader.versions.qqnt;
    view.querySelector(".versions .electron .version").textContent = LiteLoader.versions.electron;
    view.querySelector(".versions .chromium .version").textContent = LiteLoader.versions.chrome;
    view.querySelector(".versions .nodejs .version").textContent = LiteLoader.versions.node;
    const title = view.querySelector(".versions .new setting-text");
    const update_btn = view.querySelector(".versions .new setting-button");
    if (!title || !update_btn) return;
    const jump_link = () => LiteLoader.api.openExternal(update_btn.value);
    const try_again = () => {
      title.textContent = "\u6B63\u5728\u7785\u4E00\u773C LiteLoaderQQNT \u662F\u5426\u6709\u65B0\u7248\u672C";
      update_btn.textContent = "\u4F60\u5148\u522B\u6025";
      update_btn.value = null;
      update_btn.removeEventListener("click", jump_link);
      update_btn.removeEventListener("click", try_again);
      const repo_url = LiteLoader.package.liteloader.repository.url;
      const release_latest_url = `${repo_url.slice(0, repo_url.lastIndexOf(".git"))}/releases/latest`;
      fetch(release_latest_url).then((res) => {
        const new_version = res.url.slice(res.url.lastIndexOf("/") + 1);
        if (LiteLoader.versions.liteloader != new_version) {
          title.textContent = `\u53D1\u73B0 LiteLoaderQQNT \u65B0\u7248\u672C ${new_version}`;
          update_btn.textContent = "\u53BB\u7785\u4E00\u773C";
          update_btn.value = res.url;
          update_btn.removeEventListener("click", try_again);
          update_btn.addEventListener("click", jump_link);
        } else {
          title.textContent = "\u6682\u672A\u53D1\u73B0 LiteLoaderQQNT \u6709\u65B0\u7248\u672C\uFF0C\u76EE\u524D\u5DF2\u662F\u6700\u65B0";
          update_btn.textContent = "\u91CD\u65B0\u53D1\u73B0";
          update_btn.value = null;
          update_btn.removeEventListener("click", jump_link);
          update_btn.addEventListener("click", try_again);
        }
      }).catch((e) => {
        title.textContent = `\u68C0\u67E5\u66F4\u65B0\u65F6\u9047\u5230\u9519\u8BEF\uFF1A${e}`;
        update_btn.textContent = "\u91CD\u65B0\u53D1\u73B0";
        update_btn.value = null;
        update_btn.removeEventListener("click", jump_link);
        update_btn.addEventListener("click", try_again);
      });
    };
    try_again();
  }
  async function initPluginList(view) {
    const plugin_item_template = view.querySelector("#plugin-item");
    const plugin_install_button = view.querySelector(".plugins .plugin .install setting-button");
    const plugin_loader_switch = view.querySelector(".plugins .plugin .loader setting-switch");
    const plugin_lists = {
      extension: view.querySelector(".plugins .extension"),
      theme: view.querySelector(".plugins .theme"),
      framework: view.querySelector(".plugins .framework")
    };
    const plugin_install_folder_button = view.querySelector(".plugins .plugin .install-folder setting-button");
    const input_file = document.createElement("input");
    input_file.type = "file";
    input_file.accept = ".zip,.json";
    input_file.addEventListener("change", async () => {
      const file = input_file.files?.[0];
      let filepath = "";
      try {
        filepath = file && LiteLoader.api.getPathForFile ? LiteLoader.api.getPathForFile(file) : file?.path || "";
      } catch (e) {
        filepath = file?.path || "";
      }
      if (!filepath) {
        alert("\u62FF\u4E0D\u5230\u6240\u9009\u6587\u4EF6\u7684\u8DEF\u5F84\uFF08Electron \u5DF2\u79FB\u9664 File.path\uFF0C\u4E14\u5BBF\u4E3B\u7684 getPathForFile \u4E0D\u53EF\u7528\uFF09\u3002\n\u8BF7\u6539\u7528\u300C\u9009\u62E9\u6587\u4EF6\u5939\u300D\uFF0C\u6216\u628A\u63D2\u4EF6\u89E3\u538B\u540E\u653E\u5230 plugins \u76EE\u5F55\u3002");
        input_file.value = null;
        return;
      }
      const result = await LiteLoader.api.plugin.install(filepath);
      if (result === void 0 || result === null) {
        alert("\u5BBF\u4E3B\u6CA1\u6709\u8FD4\u56DE\u7ED3\u679C\uFF08IPC \u53EF\u80FD\u5931\u8D25\uFF09\uFF0C\u8BF7\u770B logs\\loader.log \u91CC\u300C\u5B89\u88C5\u63D2\u4EF6\u300D\u76F8\u5173\u884C\u3002");
      } else {
        const ok = result === true || result.ok === true;
        alert(ok ? "\u63D2\u4EF6\u5B89\u88C5\u6210\u529F\uFF0C\u91CD\u542F QQ \u540E\u751F\u6548" : "\u65E0\u6CD5\u5B89\u88C5\uFF1A" + (result.error || "\u8FD4\u56DE\u5185\u5BB9: " + JSON.stringify(result)));
      }
      input_file.value = null;
    });
    plugin_install_button.addEventListener("click", () => input_file.click());
    if (plugin_install_folder_button) {
      plugin_install_folder_button.addEventListener("click", async () => {
        try {
          const result = await LiteLoader.api.plugin.pickAndInstallFolder();
          if (result === void 0 || result === null) {
            alert("\u5BBF\u4E3B\u6CA1\u6709\u8FD4\u56DE\u7ED3\u679C\uFF08IPC \u53EF\u80FD\u5931\u8D25\uFF09\uFF0C\u8BF7\u770B\u65E5\u5FD7 logs\\loader.log \u91CC\u7684\u300C\u5B89\u88C5\u63D2\u4EF6\u300D\u76F8\u5173\u884C\u3002");
            return;
          }
          if (result.canceled) return;
          const ok = result === true || result.ok === true;
          if (ok) {
            alert("\u63D2\u4EF6\u5B89\u88C5\u6210\u529F\uFF0C\u91CD\u542F QQ \u540E\u751F\u6548");
          } else {
            alert("\u65E0\u6CD5\u5B89\u88C5\uFF1A" + (result.error || "\u8FD4\u56DE\u5185\u5BB9: " + JSON.stringify(result)));
          }
        } catch (e) {
          alert("\u5B89\u88C5\u6587\u4EF6\u5939\u5931\u8D25\uFF1A" + (e && e.message || e));
        }
      });
    }
    const config = await LiteLoader.api.config.get("LiteLoader", config_default);
    plugin_loader_switch.setActive(config.enable_plugins);
    plugin_loader_switch.addEventListener("click", () => {
      const isActive = plugin_loader_switch.getActive();
      plugin_loader_switch.setActive(!isActive);
      config.enable_plugins = !isActive;
      LiteLoader.api.config.set("LiteLoader", config);
    });
    const plugin_counts = {
      extension: 0,
      theme: 0,
      framework: 0
    };
    const default_icon = `local://root/src/common/static/default.png`;
    for (const [slug, plugin] of Object.entries(LiteLoader.plugins)) {
      if (plugin.incompatible) continue;
      const plugin_icon = `local:///${plugin.path.plugin}/${plugin.manifest?.icon}`;
      const icon = plugin.manifest?.icon ? plugin_icon : default_icon;
      const plugin_list = plugin_lists[plugin.manifest.type] || plugin_lists.extension;
      const plugin_item = document.importNode(plugin_item_template.content, true).querySelector("setting-item");
      const plugin_item_icon = plugin_item.querySelector(".icon");
      const plugin_item_name = plugin_item.querySelector(".name");
      const plugin_item_description = plugin_item.querySelector(".description");
      const plugin_item_version = plugin_item.querySelector(".version");
      const plugin_item_authors = plugin_item.querySelector(".authors");
      const plugin_item_repo = plugin_item.querySelector(".repo");
      const plugin_item_manager = plugin_item.querySelector(".manager");
      const plugin_item_manager_modal = plugin_item.querySelector(".manager-modal");
      const manager_modal_switch = plugin_item_manager_modal.querySelector(".switch");
      const manager_modal_data = plugin_item_manager_modal.querySelector(".data");
      const manager_modal_self = plugin_item_manager_modal.querySelector(".self");
      plugin_item_icon.innerHTML = await appropriateIcon(icon);
      plugin_item_name.textContent = plugin.manifest.name;
      plugin_item_name.title = plugin.manifest.name;
      plugin_item_description.textContent = plugin.manifest.description;
      plugin_item_description.title = plugin.manifest.description;
      const version_link = document.createElement("setting-link");
      version_link.textContent = plugin.manifest.version;
      plugin_item_version.append(version_link);
      plugin.manifest.authors?.forEach((author, index, array) => {
        const author_link = document.createElement("setting-link");
        author_link.textContent = author.name;
        author_link.setValue(author.link);
        plugin_item_authors.append(author_link);
        if (index < array.length - 1) plugin_item_authors.append(" | ");
      });
      if (plugin.manifest.repository) {
        const { repo, branch } = plugin.manifest.repository;
        const repo_link = document.createElement("setting-link");
        repo_link.textContent = repo;
        repo_link.setValue(`https://github.com/${repo}/tree/${branch}`);
        plugin_item_repo.append(repo_link);
      } else plugin_item_repo.textContent = "\u6682\u65E0\u4ED3\u5E93\u4FE1\u606F";
      plugin_item_manager_modal.setTitle(plugin.manifest.name);
      plugin_item_manager.addEventListener("click", () => {
        const isActive = plugin_item_manager_modal.getActive();
        plugin_item_manager_modal.setActive(!isActive);
      });
      manager_modal_switch.setActive(!config.disabled_plugins.includes(slug));
      manager_modal_switch.addEventListener("click", () => {
        const isActive = manager_modal_switch.getActive();
        manager_modal_switch.setActive(!isActive);
        plugin_item.classList.toggle("disabled", !isActive);
        LiteLoader.api.plugin.disable(slug, !isActive);
      });
      plugin_item.classList.toggle("disabled", !manager_modal_switch.getActive());
      manager_modal_data.setActive(!!config.deleting_plugins?.[slug]?.data_path);
      manager_modal_data.addEventListener("click", () => {
        const isActive = manager_modal_data.getActive();
        manager_modal_data.setActive(!isActive);
        plugin_item.classList.toggle("deleted", !isActive);
        LiteLoader.api.plugin.delete(slug, [manager_modal_self.getActive(), !isActive], false);
      });
      plugin_item.classList.toggle("deleted", manager_modal_data.getActive());
      manager_modal_self.setActive(!!config.deleting_plugins?.[slug]);
      manager_modal_self.addEventListener("click", () => {
        const isActive = manager_modal_self.getActive();
        manager_modal_self.setActive(!isActive);
        plugin_item.classList.toggle("deleted", !isActive);
        LiteLoader.api.plugin.delete(slug, [!isActive, manager_modal_data.getActive()], false);
      });
      plugin_item.classList.toggle("deleted", manager_modal_self.getActive());
      plugin_list.append(plugin_item);
      plugin_counts.total++;
      plugin_counts[plugin.manifest.type]++;
    }
    plugin_lists.extension.setTitle(`\u6269\u5C55 \uFF08 ${plugin_counts.extension} \u4E2A\u63D2\u4EF6 \uFF09`);
    plugin_lists.theme.setTitle(`\u4E3B\u9898 \uFF08 ${plugin_counts.theme} \u4E2A\u63D2\u4EF6 \uFF09`);
    plugin_lists.framework.setTitle(`\u4F9D\u8D56 \uFF08 ${plugin_counts.framework} \u4E2A\u63D2\u4EF6 \uFF09`);
  }
  async function initPath(view) {
  }
  async function initAbout(view) {
    const text = view.querySelector(".about .hitokoto_text");
    const author = view.querySelector(".about .hitokoto_author");
    if (!text || !author) return;
    let visible = true;
    const observer = new IntersectionObserver((entries) => visible = entries[0].isIntersecting);
    const update = async () => {
      if (!document.hidden && visible) {
        const { hitokoto, creator } = await (await fetch("https://v1.hitokoto.cn")).json();
        text.textContent = hitokoto;
        author.textContent = creator;
      }
    };
    observer.observe(text);
    setInterval(update, 1e3 * 10);
    update();
  }

  // renderer/triggers/selector/setting.js
  var liteloader_nav_bar = document.createElement("div");
  var liteloader_setting_view = document.createElement("div");
  function init() {
    const setting_view = document.querySelector(".setting-main .q-scroll-view");
    const setting_title = document.querySelector(".setting-main .setting-title");
    liteloader_nav_bar.classList.add("nav-bar", "liteloader");
    liteloader_setting_view.classList.add("q-scroll-view", "scroll-view--show-scrollbar", "liteloader");
    liteloader_setting_view.style.display = "none";
    document.querySelector(".setting-tab").append(liteloader_nav_bar);
    document.querySelector(".setting-main .setting-main__content").append(liteloader_setting_view);
    document.querySelector(".setting-tab").addEventListener("click", (event) => {
      const nav_item = event.target.closest(".nav-item");
      if (nav_item) {
        if (nav_item.parentElement.classList.contains("liteloader")) {
          setting_view.style.display = "none";
          liteloader_setting_view.style.display = "block";
        } else {
          setting_view.style.display = "block";
          liteloader_setting_view.style.display = "none";
        }
        document.querySelectorAll(".setting-tab .nav-item").forEach((element) => {
          element.classList.remove("nav-item-active");
        });
        nav_item.classList.add("nav-item-active");
        syncTitle();
      }
    });
    function syncTitle() {
      try {
        const active = document.querySelector(".nav-bar.liteloader .nav-item.nav-item-active");
        if (!active) return;
        const nameEl = active.querySelector(".name");
        const title = document.querySelector(".setting-main .setting-title");
        const name = nameEl && nameEl.textContent;
        if (!name || !title) return;
        if (title.textContent.trim() === name) return;
        let wrote = false;
        [...title.childNodes].forEach((node) => {
          if (node.nodeType === 3) {
            node.textContent = wrote ? "" : name;
            wrote = true;
          }
        });
        if (!wrote) title.append(document.createTextNode(name));
      } catch (e) {
      }
    }
    syncTitle();
    setInterval(syncTitle, 400);
  }
  function add(plugin) {
    const default_thumb = `local://root/src/common/static/default.svg`;
    const plugin_thumb = `local:///${plugin.path.plugin}/${plugin.manifest?.thumb}`;
    const thumb = plugin.manifest.thumb ? plugin_thumb : default_thumb;
    const nav_item = document.querySelector(".setting-tab .nav-item").cloneNode(true);
    const view = document.createElement("div");
    nav_item.classList.remove("nav-item-active");
    nav_item.setAttribute("data-slug", plugin.manifest.slug);
    appropriateIcon(thumb).then(async (text) => nav_item.querySelector(".q-icon").innerHTML = text);
    nav_item.querySelector(".name").textContent = plugin.manifest.name;
    nav_item.addEventListener("click", (event) => {
      if (!event.currentTarget.classList.contains("nav-item-active")) {
        liteloader_setting_view.textContent = null;
        liteloader_setting_view.append(view);
      }
    });
    liteloader_nav_bar.append(nav_item);
    view.classList.add("tab-view", plugin.manifest.slug);
    return view;
  }
  var setting_default = {
    hash: "#/setting",
    selector: ".setting-tab .nav-bar",
    action() {
      init();
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.type = "text/css";
      link.href = "local://root/src/renderer/settings/style.css";
      document.head.append(link);
      const view = add({
        manifest: {
          slug: "config_view",
          // MGQA: 只有这一处改了名字（upstream 写的是 "LiteLoaderQQNT"），其余逻辑原样
          name: "MGQA Ctrl"
        },
        path: {
          plugin: LiteLoader.path.root
        }
      });
      fetch("local://root/src/renderer/settings/view.html").then((res) => res.text()).then((html) => initView(view, html));
      Runtime.triggerHooks("onSettingWindowCreated", (plugin) => [add(plugin)]);
    }
  };
  function addPluginTab(plugin) {
    try {
      return add(plugin);
    } catch (e) {
      console.warn("[MQGA] addPluginTab failed:", e);
      return null;
    }
  }

  // renderer/triggers/renderer.js
  var TRIGGERS = [
    setting_default
  ];
  function watchElement(target, callback) {
    const check = () => {
      const element = document.querySelector(target);
      if (!element) return false;
      try {
        callback(element);
      } catch (e) {
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
  function watchHash(target, callback) {
    const check = () => {
      if (!location.hash.includes(target)) return false;
      callback();
      return true;
    };
    if (check()) return;
    let done = false;
    let timer = null;
    const stop = () => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
      try {
        navigation.removeEventListener("navigatesuccess", onNav);
      } catch (e) {
      }
    };
    const onNav = () => {
      if (check()) stop();
    };
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    try {
      navigation.addEventListener("navigatesuccess", onNav);
    } catch (e) {
    }
    timer = setInterval(onNav, 500);
  }
  TRIGGERS.forEach((trigger) => {
    watchHash(trigger.hash, () => {
      watchElement(trigger.selector, trigger.action);
    });
  });

  // renderer/hook.js
  function recordComponent(component) {
    let element = component.vnode.el;
    while (!(element instanceof HTMLElement)) {
      element = element.parentElement;
    }
    element.__VUE__ = element.__VUE__ || [];
    element.__VUE__.push(component);
    element.classList.add("vue-component");
  }
  function watchComponentMount(component) {
    let value = null;
    let hooked = false;
    Object.defineProperty(component.vnode, "el", {
      get: () => value,
      set(newValue) {
        value = newValue;
        if (!hooked && value) {
          hooked = true;
          watchComponentUnmount(component);
          recordComponent(component);
          Runtime.triggerHooks("onVueComponentMount", [component]);
        }
      }
    });
  }
  function watchComponentUnmount(component) {
    let value = null;
    let unhooked = false;
    Object.defineProperty(component, "isUnmounted", {
      get: () => value,
      set(newValue) {
        value = newValue;
        if (!unhooked && value) {
          unhooked = true;
          Runtime.triggerHooks("onVueComponentUnmount", [component]);
        }
      }
    });
  }
  function proxyProxy(func) {
    return new Proxy(func, {
      construct(target, argArray, newTarget) {
        const component = argArray[0]?._;
        const hasValidUid = component?.uid >= 0;
        if (hasValidUid) {
          const element = component.vnode?.el;
          if (element) {
            watchComponentUnmount(component);
            recordComponent(component);
            Runtime.triggerHooks("onVueComponentMount", [component]);
          } else {
            watchComponentMount(component);
          }
        }
        return Reflect.construct(target, argArray, newTarget);
      }
    });
  }
  function installHook() {
    Proxy = proxyProxy(Proxy);
  }

  // lq-entry.js
  installHook();
  var pluginsOf = () => globalThis.MQGA && (globalThis.MQGA.plugins || (typeof globalThis.MQGA.pluginList === "function" ? globalThis.MQGA.pluginList() : {})) || {};
  function registerPlugin(slug, exports) {
    if (!exports || typeof exports.onSettingWindowCreated !== "function") return false;
    const plugin = pluginsOf()[slug] || { manifest: { slug, name: slug, type: "extension" }, path: { plugin: "" } };
    Runtime.registerPlugin(plugin, exports);
    if (document.querySelector(".nav-bar.liteloader")) {
      try {
        addPluginTab(plugin);
      } catch (e) {
        console.warn("[MQGA] \u8FFD\u52A0\u63D2\u4EF6\u9762\u677F\u9879\u5931\u8D25:", e);
      }
    }
    return true;
  }
  for (const [slug, exports] of Object.entries(globalThis.__MQGA_RENDERER_EXPORTS__ || {})) {
    registerPlugin(slug, exports);
  }
  globalThis.__MQGA_LQ_REGISTER__ = (slug, exports) => registerPlugin(slug, exports);
  function reconcile() {
    try {
      const bar = document.querySelector(".nav-bar.liteloader");
      if (!bar) return;
      const registry = globalThis.__MQGA_RENDERER_EXPORTS__ || {};
      for (const slug of Object.keys(registry)) {
        if (bar.querySelector('[data-slug="' + slug + '"]')) continue;
        registerPlugin(slug, registry[slug]);
      }
    } catch (e) {
    }
  }
  setInterval(reconcile, 1e3);
  globalThis.__MQGA_LQ__ = { Runtime, initView, appropriateIcon, registerPlugin, reconcile };
  function probe() {
    try {
      const bar = document.querySelector(".nav-bar.liteloader");
      const names = bar ? [...bar.querySelectorAll(".nav-item .name")].map((n) => n.textContent).join(" | ") : "";
      const view = document.querySelector(".q-scroll-view.liteloader");
      const sections = view ? view.querySelectorAll("setting-section").length : 0;
      const msg = "[MQGA-LQ] hash=" + location.hash + " nav-bar=" + (bar ? bar.querySelectorAll(".nav-item").length + "\u9879[" + names + "]" : "\u65E0") + " view=" + (view ? "\u6709" : "\u65E0") + " sections=" + sections;
      if (globalThis.MQGA && typeof globalThis.MQGA.debugLog === "function") globalThis.MQGA.debugLog(msg);
      else console.log(msg);
    } catch (e) {
    }
  }
  setTimeout(probe, 3e3);
})();
