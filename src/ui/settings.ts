/**
 * ★ 设置面板(Phase 4)。
 *
 * 一个右侧滑出的轻量浮层,集中放可持久化的偏好:
 *  - 主题:浅色 / 暗色 / 跟随系统(prefers-color-scheme)
 *  - 正文字号:编辑器内容区字号(标题用 em,跟着等比缩放)
 *  - 默认开启专注 / 打字机(下次启动即生效;面板里切换也即时应用)
 *  - 导出快捷入口(可选;原生菜单为主,这里给一组直达按钮)
 *
 * 设计取向贴 Typora:窄、安静、靠留白说话,配色全用 --mkn-* 变量,
 * 圆角与低饱和 accent 保持克制。暗色由 theme-default.css 的变量覆盖
 * 自动跟随,本模块不写任何硬编码颜色。
 *
 * 边界:
 *  - 偏好用 localStorage(键名带 `mkn.` 前缀)持久化,不引入新 IPC。
 *  - 主题切换 = document.documentElement.setAttribute("data-theme",…);
 *    "跟随系统"时监听 prefers-color-scheme 实时改 data-theme。
 *  - 字号靠本模块自有的注入样式作用到 .cm-content(只用自有
 *    --mkn-font-size 变量),不改冻结主题文件、不碰 src/core。
 *  - 不直接依赖编辑器:专注/打字机的"读初值 + 即时应用"由 app.ts
 *    通过 onFocusDefaultChange / onTypewriterDefaultChange 回调接线。
 */

import "./settings.css";

/* ── localStorage 偏好读写 ─────────────────────────────────────────────── */

const LS = {
  theme: "mkn.theme", // "light" | "dark" | "system"
  fontSize: "mkn.fontSize", // 字号数值字符串(px)
  focusDefault: "mkn.focusDefault", // "1" | "0"
  typewriterDefault: "mkn.typewriterDefault", // "1" | "0"
} as const;

export type ThemePref = "light" | "dark" | "system";

/** 字号边界与默认(默认对齐 core/theme.ts 里 .cm-editor 的 16px)。 */
const FONT_MIN = 13;
const FONT_MAX = 22;
const FONT_DEFAULT = 16;

/** 安全读 localStorage(隐私模式/禁用时不抛,回退默认)。 */
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* 存不进去就算了:本次会话内仍按内存态工作,不影响功能 */
  }
}

/** 已存的主题偏好(非法值回退 system)。 */
export function getThemePref(): ThemePref {
  const v = lsGet(LS.theme);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

/** 已存的字号(越界/非法回退默认,并夹到 [MIN,MAX])。 */
export function getFontSize(): number {
  const n = Number(lsGet(LS.fontSize));
  if (!Number.isFinite(n) || n <= 0) return FONT_DEFAULT;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

/** 已存的"默认开启专注"。 */
export function getFocusDefault(): boolean {
  return lsGet(LS.focusDefault) === "1";
}

/** 已存的"默认开启打字机"。 */
export function getTypewriterDefault(): boolean {
  return lsGet(LS.typewriterDefault) === "1";
}

/* ── 主题应用 ──────────────────────────────────────────────────────────── */

/** 系统是否偏好暗色(无 matchMedia 时按浅色)。 */
function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** 把一个主题偏好解析成最终生效的 light/dark 并写到 <html data-theme>。 */
function resolveAndApplyTheme(pref: ThemePref): void {
  const dark = pref === "dark" || (pref === "system" && systemPrefersDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

/**
 * ★ 开机前(创建编辑器前)调用:依已存偏好把 data-theme 与字号设好,
 * 避免先白后切的闪烁。返回当前生效的偏好快照(app.ts 可据此读默认值)。
 *
 * 注:本函数只"设主题/字号"这类与编辑器无关的纯前端态;专注/打字机
 * 的默认值由 app.ts 在 view 建好后自行读 get*Default 并应用。
 */
export function applyStoredPreferencesEarly(): void {
  resolveAndApplyTheme(getThemePref());
  applyFontSize(getFontSize());
}

/* ── 字号应用(自有注入样式;只用自有 --mkn-font-size 变量)──────────── */

let fontStyleEl: HTMLStyleElement | null = null;

/**
 * 把字号写到一个本模块自有的 <style>:用 --mkn-font-size 变量驱动
 * .cm-content 的 font-size。core/theme.ts 在 .cm-editor 上设了 16px,
 * .cm-content 未显式设字号 → 这里给它一个变量值即可整体缩放;标题用
 * em,自动等比。不改冻结主题文件、不碰 src/core。
 */
function applyFontSize(px: number): void {
  const root = document.documentElement;
  root.style.setProperty("--mkn-font-size", `${px}px`);
  if (!fontStyleEl) {
    fontStyleEl = document.createElement("style");
    fontStyleEl.setAttribute("data-mkn", "settings-fontsize");
    fontStyleEl.textContent =
      ".cm-content{font-size:var(--mkn-font-size,16px);}";
    document.head.appendChild(fontStyleEl);
  }
}

/* ── 面板 ──────────────────────────────────────────────────────────────── */

/** 导出动作 —— app.ts 注入真实实现(渲染 + IPC + 兜底都在 app.ts)。 */
export interface SettingsExportActions {
  exportHtml(): void;
  exportPdf(): void;
  exportDocx(): void;
}

export interface SettingsOptions {
  /**
   * 专注默认值变化时回调(面板里拨动开关即时生效)。
   * app.ts 据此 setFocusMode(view, on),让当前编辑器立刻响应。
   */
  onFocusDefaultChange?(on: boolean): void;
  /** 打字机默认值变化时回调(同上)。 */
  onTypewriterDefaultChange?(on: boolean): void;
  /**
   * 导出动作。给了就在面板底部显示一组直达按钮;不给(如纯浏览器
   * 无 shell)则整组隐藏,避免点了没反应。
   */
  exportActions?: SettingsExportActions;
}

export interface Settings {
  /** 打开面板(滑入 + 遮罩)。 */
  open(): void;
  /** 关闭面板。 */
  close(): void;
  /** 顶栏入口按钮(已绑好点击=open);调用方塞进工具条即可。 */
  triggerButton: HTMLElement;
  /** 销毁:移除 DOM、解绑系统主题监听。之后该实例不应再使用。 */
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * 创建设置面板。挂载到 document.body(浮层,不占布局),返回控制器。
 * 入口按钮由调用方放进顶栏。
 */
export function createSettings(opts: SettingsOptions = {}): Settings {
  // 当前内存态(以已存偏好为初值;改动即写 localStorage 并即时应用)
  let themePref: ThemePref = getThemePref();
  let fontSize = getFontSize();
  let focusDefault = getFocusDefault();
  let typewriterDefault = getTypewriterDefault();

  /* ---- 遮罩 + 面板骨架 ---- */
  const mask = el("div", "mkn-settings-mask");
  const panel = el("div", "mkn-settings-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "设置");

  const head = el("div", "mkn-settings-head");
  const title = el("div", "mkn-settings-title");
  title.textContent = "设置";
  const closeBtn = el("button", "mkn-settings-close");
  closeBtn.textContent = "×";
  closeBtn.title = "关闭设置 (Esc)";
  head.append(title, closeBtn);

  const bodyEl = el("div", "mkn-settings-body");
  panel.append(head, bodyEl);

  /* ---- 主题分组:浅色 / 暗色 / 跟随系统 ---- */
  const gTheme = el("div", "mkn-settings-group");
  const lTheme = el("label", "mkn-settings-label");
  lTheme.textContent = "主题";
  const seg = el("div", "mkn-seg");
  const segDefs: Array<{ key: ThemePref; label: string }> = [
    { key: "light", label: "浅色" },
    { key: "dark", label: "暗色" },
    { key: "system", label: "跟随系统" },
  ];
  const segBtns = new Map<ThemePref, HTMLButtonElement>();
  for (const d of segDefs) {
    const b = el("button", "mkn-seg-btn");
    b.textContent = d.label;
    b.addEventListener("click", () => setTheme(d.key));
    seg.appendChild(b);
    segBtns.set(d.key, b);
  }
  const themeHint = el("div", "mkn-settings-hint");
  themeHint.textContent = "「跟随系统」会随操作系统外观自动切换。";
  gTheme.append(lTheme, seg, themeHint);

  /* ---- 字号分组 ---- */
  const gFont = el("div", "mkn-settings-group");
  const lFont = el("label", "mkn-settings-label");
  lFont.textContent = "正文字号";
  const step = el("div", "mkn-step");
  const minus = el("button", "mkn-step-btn");
  minus.textContent = "−";
  minus.title = "减小字号";
  const fontVal = el("div", "mkn-step-val");
  const plus = el("button", "mkn-step-btn");
  plus.textContent = "+";
  plus.title = "增大字号";
  step.append(minus, fontVal, plus);
  minus.addEventListener("click", () => setFont(fontSize - 1));
  plus.addEventListener("click", () => setFont(fontSize + 1));
  gFont.append(lFont, step);

  /* ---- 默认开启专注 / 打字机 ---- */
  const gModes = el("div", "mkn-settings-group");
  const lModes = el("label", "mkn-settings-label");
  lModes.textContent = "写作模式默认值";
  const rowFocus = el("div", "mkn-switch-row");
  const tFocus = el("span", "mkn-switch-text");
  tFocus.textContent = "默认开启专注模式";
  const swFocus = el("button", "mkn-switch");
  swFocus.title = "下次启动即按此;现在拨动也会立刻生效";
  rowFocus.append(tFocus, swFocus);
  const rowTw = el("div", "mkn-switch-row");
  const tTw = el("span", "mkn-switch-text");
  tTw.textContent = "默认开启打字机模式";
  const swTw = el("button", "mkn-switch");
  swTw.title = "下次启动即按此;现在拨动也会立刻生效";
  rowTw.append(tTw, swTw);
  swFocus.addEventListener("click", () => setFocusDefault(!focusDefault));
  swTw.addEventListener("click", () => setTypewriterDefault(!typewriterDefault));
  gModes.append(lModes, rowFocus, rowTw);

  bodyEl.append(gTheme, gFont, gModes);

  /* ---- 导出快捷入口(可选)---- */
  if (opts.exportActions) {
    const gExport = el("div", "mkn-settings-group");
    const lExport = el("label", "mkn-settings-label");
    lExport.textContent = "导出当前文档";
    const wrap = el("div", "mkn-settings-export");
    const ex = opts.exportActions;
    const mkBtn = (label: string, run: () => void) => {
      const b = el("button", "mkn-export-btn");
      b.textContent = label;
      b.addEventListener("click", () => {
        run();
        close(); // 触发导出后顺手收起面板,把另存对话框让到前面
      });
      return b;
    };
    wrap.append(
      mkBtn("导出为 HTML…", () => ex.exportHtml()),
      mkBtn("导出为 PDF…", () => ex.exportPdf()),
      mkBtn("导出为 Word (.docx)…", () => ex.exportDocx())
    );
    const exHint = el("div", "mkn-settings-hint");
    exHint.textContent = "导出只读取当前内容,绝不改动文档本身。";
    gExport.append(lExport, wrap, exHint);
    bodyEl.appendChild(gExport);
  }

  /* ---- 顶栏入口按钮 ---- */
  const triggerButton = el("button", "mkn-gear-btn");
  triggerButton.textContent = "⚙";
  triggerButton.title = "设置";
  triggerButton.addEventListener("click", () => open());

  document.body.append(mask, panel);

  /* ---- 系统主题监听(仅"跟随系统"时让其生效)---- */
  const mql =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  const onSystemThemeChange = (): void => {
    if (themePref === "system") resolveAndApplyTheme("system");
  };
  // addEventListener 现代浏览器/Electron 都支持;Electron 内核新,无需兼容旧 API
  mql?.addEventListener("change", onSystemThemeChange);

  /* ---- 状态 → UI 同步(单一事实源:内存态;UI 永远据它回读)---- */
  function syncUi(): void {
    for (const [key, b] of segBtns) {
      b.classList.toggle("mkn-seg-on", key === themePref);
    }
    fontVal.textContent = `${fontSize} px`;
    minus.disabled = fontSize <= FONT_MIN;
    plus.disabled = fontSize >= FONT_MAX;
    swFocus.classList.toggle("mkn-switch-on", focusDefault);
    swTw.classList.toggle("mkn-switch-on", typewriterDefault);
  }

  /* ---- 改动入口:写内存 → 持久化 → 即时应用 → 回刷 UI ---- */
  function setTheme(p: ThemePref): void {
    themePref = p;
    lsSet(LS.theme, p);
    resolveAndApplyTheme(p);
    syncUi();
  }
  function setFont(px: number): void {
    const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
    if (clamped === fontSize) return;
    fontSize = clamped;
    lsSet(LS.fontSize, String(clamped));
    applyFontSize(clamped);
    syncUi();
  }
  function setFocusDefault(on: boolean): void {
    focusDefault = on;
    lsSet(LS.focusDefault, on ? "1" : "0");
    opts.onFocusDefaultChange?.(on); // 让当前编辑器立刻响应
    syncUi();
  }
  function setTypewriterDefault(on: boolean): void {
    typewriterDefault = on;
    lsSet(LS.typewriterDefault, on ? "1" : "0");
    opts.onTypewriterDefaultChange?.(on);
    syncUi();
  }

  /* ---- 开 / 关 ---- */
  let isOpen = false;
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      close();
    }
  }
  function open(): void {
    if (isOpen) return;
    isOpen = true;
    syncUi(); // 打开时据当前态回读(防止外部/其它入口改过)
    mask.classList.add("mkn-settings-open");
    panel.classList.add("mkn-settings-open");
    document.addEventListener("keydown", onKeydown);
  }
  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    mask.classList.remove("mkn-settings-open");
    panel.classList.remove("mkn-settings-open");
    document.removeEventListener("keydown", onKeydown);
  }
  mask.addEventListener("click", () => close());
  closeBtn.addEventListener("click", () => close());

  syncUi(); // 首次据已存偏好把 UI 摆正

  return {
    open,
    close,
    triggerButton,
    destroy() {
      close();
      mql?.removeEventListener("change", onSystemThemeChange);
      mask.remove();
      panel.remove();
      triggerButton.remove();
    },
  };
}
