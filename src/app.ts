/**
 * MKN 应用入口 —— 把编辑器内核、文件树、文件操作集成成完整应用壳。
 *
 * 两条路径:
 *  - 有 shell(Electron):文件树/大纲侧栏 + 编辑器 + 顶栏(文件名 + 字数 +
 *    特性开关),接全套原生菜单。
 *  - 无 shell(纯浏览器 npm run dev):降级为「编辑器 + 字数 + 特性开关 +
 *    大纲」,无文件系统(图片粘贴会提示先保存),保证内核与 Phase 3 特性
 *    在浏览器下仍可单独把玩。
 *
 * 与内核的边界:本文件只调 createEditor / loadDoc / setSourceMode 等冻结
 * 接口;Phase 3 特性(专注·打字机 / 数学 / Mermaid / 图片粘贴)作为自包含
 * CM 扩展经 createEditor 的 `extra` 注入,绝不改动 src/core 装配。变更监听
 * 与 dirty/自保存封装在 src/shell/doc.ts。
 */

import "./styles/theme-default.css";
import { openSearchPanel } from "@codemirror/search";
import { keymap, EditorView } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { createEditor, toggleSourceMode, isSourceMode } from "./core/editor";
import { getShell } from "./shell/ipc";
import type { MknApi } from "./shell/ipc";
import { createDocLifecycle } from "./shell/doc";
import type { DocLifecycle } from "./shell/doc";
import { createFileTree } from "./ui/fileTree";
import type { FileTree } from "./ui/fileTree";
import { createOutline } from "./ui/outline";
import {
  createSettings,
  applyStoredPreferencesEarly,
  getFocusDefault,
  getTypewriterDefault,
} from "./ui/settings";
import type { SettingsExportActions } from "./ui/settings";
// 导出渲染器(Agent A 并行新建 src/export/render.ts;按冻结签名 import)。
// renderStandaloneHtml(markdown, { title? }) → 内联主题 CSS 的完整 HTML。
// A 与本文件并行,typecheck 时该模块可能尚未就位 → 报"找不到模块"属预期
// 跨 agent 缺口;签名严格对齐,协调者统一 typecheck 时即闭合。
import { renderStandaloneHtml } from "./export/render";

// ── Phase 3 特性扩展(A/B agent 并行新建;按冻结签名 import)──────────────
//  这些模块由其它 agent 并行创建;统一 typecheck 由协调者跑。本文件严格
//  对齐其冻结导出签名,A/B 未就位仅会报"找不到模块",属预期跨 agent 缺口。
import {
  focusTypewriterExtension,
  setFocusMode,
  setTypewriterMode,
  getFocusMode,
  getTypewriterMode,
} from "./core/focusMode";
import { mathExtension } from "./core/livePreview/math";
import { mermaidExtension } from "./core/livePreview/mermaid";

/* =========================================================================
   图片粘贴 / 拖拽入 assets —— 自包含 CM 扩展,经 createEditor 的 extra 注入。

   捕获剪贴板/拖拽里的图片 → 读成 Uint8Array → 经 IPC saveAsset 写进当前
   文档同级 assets/ → 在光标处插入 ![](相对路径)。无 shell 或文档未保存
   (拿不到 path)→ 友好提示,绝不崩、绝不吞图当文本。

   时序:扩展在 createEditor 时注入,而 docPath 由稍后创建的 doc.ts 维护。
   故用 getDocPath 闭包延迟取路径(每次粘贴时现取),而非构造期快照。
   ========================================================================= */

/** 从 MIME(image/png)推扩展名;不含点。未知图片类型回退 png。 */
function mimeToExt(mime: string): string | null {
  if (!mime.startsWith("image/")) return null;
  const sub = mime.slice("image/".length).toLowerCase();
  const map: Record<string, string> = {
    "jpeg": "jpg",
    "jpg": "jpg",
    "png": "png",
    "gif": "gif",
    "webp": "webp",
    "bmp": "bmp",
    "svg+xml": "svg",
    "x-icon": "ico",
    "avif": "avif",
    "tiff": "tiff",
  };
  return map[sub] ?? "png";
}

/**
 * 从 DataTransfer 收集所有图片文件(剪贴板截图 / 拖入的图片文件)。
 * 截图常以 items 形式存在(kind:"file");拖文件走 files。两路都覆盖。
 */
function collectImages(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const imgs: File[] = [];
  // files 优先(拖拽多文件、复制图片文件)
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i];
    if (f && f.type.startsWith("image/")) imgs.push(f);
  }
  // 截图类粘贴常只在 items 里(无 files);补采,避免漏
  if (imgs.length === 0 && dt.items) {
    for (let i = 0; i < dt.items.length; i++) {
      const it = dt.items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
  }
  return imgs;
}

/** 在当前选区处插入文本(替换选区);随后把光标落到插入文本之后。 */
function insertAtCursor(view: EditorView, text: string): void {
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    scrollIntoView: true,
  });
}

/**
 * 图片粘贴/拖拽扩展。
 * @param getDocPath 现取当前文档绝对路径;未命名草稿返回 null
 * @param notify     用户提示(无 shell / 未保存 / 失败时调用)
 */
function imagePasteExtension(
  getDocPath: () => string | null,
  notify: (msg: string) => void
): Extension {
  /**
   * 处理一次图片输入(粘贴或拖拽共用)。成功插入返回 true(调用方据此
   * preventDefault,阻止编辑器把图片再当文本/文件二次处理)。
   */
  async function handle(view: EditorView, files: File[]): Promise<boolean> {
    if (files.length === 0) return false; // 非图片:放行默认行为(如粘贴文本)

    const shell = getShell();
    if (!shell) {
      notify("当前为浏览器预览模式,无法保存图片。请在 Electron 外壳中使用。");
      return true; // 已是图片但无处可存:吞掉默认(否则会插入 file:// 之类)
    }
    const docPath = getDocPath();
    if (!docPath) {
      notify("请先保存文档,再插入图片(图片会存到文档同级 assets/)。");
      return true;
    }

    for (const file of files) {
      const ext = mimeToExt(file.type);
      if (!ext) continue; // 防御:collectImages 已过滤,这里再兜一层
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        // 写进当前文档同级 assets/,返回可直接写进 md 的相对路径
        const rel = await shell.saveAsset(docPath, bytes, ext);
        insertAtCursor(view, `![](${rel})`);
      } catch (err) {
        // 单张失败不影响其它张;给一句明确提示而非静默
        const m = err instanceof Error ? err.message : String(err);
        notify(`图片保存失败:${m}`);
      }
    }
    return true;
  }

  return EditorView.domEventHandlers({
    paste(event, view) {
      const imgs = collectImages(event.clipboardData);
      if (imgs.length === 0) return false; // 纯文本粘贴:不拦,走默认
      event.preventDefault();
      void handle(view, imgs);
      return true;
    },
    drop(event, view) {
      const imgs = collectImages(event.dataTransfer);
      if (imgs.length === 0) return false; // 拖入非图片(如 .md):不拦
      event.preventDefault();
      // 把光标移到落点,再插图(否则会插到旧光标处,违背"拖到哪插哪")
      const posAt = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (posAt != null) {
        view.dispatch({ selection: { anchor: posAt } });
      }
      void handle(view, imgs);
      return true;
    },
  });
}

/* =========================================================================
   特性开关 keymap —— 与顶栏按钮等价的快捷键(克制,不与内核既有键冲突)。
   ⌘/Ctrl-/ 源码模式;⌘/Ctrl-⇧-F 专注;⌘/Ctrl-⇧-T 打字机;⌘/Ctrl-⇧-O 大纲。
   内核已用 ⌘F(查找)、⌘Z/⌘Y(撤销)等,这里只取未占用组合。
   ========================================================================= */

function featureKeymap(handlers: {
  toggleSource: () => void;
  toggleFocus: () => void;
  toggleTypewriter: () => void;
  toggleOutline: () => void;
}): Extension {
  return keymap.of([
    {
      key: "Mod-/",
      run: () => {
        handlers.toggleSource();
        return true;
      },
    },
    {
      key: "Mod-Shift-f",
      run: () => {
        handlers.toggleFocus();
        return true;
      },
    },
    {
      key: "Mod-Shift-t",
      run: () => {
        handlers.toggleTypewriter();
        return true;
      },
    },
    {
      key: "Mod-Shift-o",
      run: () => {
        handlers.toggleOutline();
        return true;
      },
    },
  ]);
}

/* =========================================================================
   字数统计 —— 中文按字符计,英文(及其它拉丁/数字串)按词计。
   纯函数,便于自审与未来单测。
   ========================================================================= */

/**
 * 统计「字数」与「词数」。
 *  - 字数:CJK 表意文字按单字计 + 非 CJK 的「词」按 1 计(贴 Typora/中文
 *    写作习惯:一个汉字一个字,一串英文算一个字)。
 *  - 词数:CJK 单字 + 拉丁/数字词,各计 1(纯统计参考)。
 * 实现:剥离 markdown 不计意义的噪声(代码围栏、行内代码、标记符)后再数,
 * 否则 ``` 之类会污染计数;但保留链接文字与正文。
 */
function countWords(text: string): { chars: number; words: number } {
  // 去掉代码围栏块(内容不计入写作字数,贴 Typora 口径)
  let t = text.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  // 去行内代码
  t = t.replace(/`[^`]*`/g, " ");
  // 去图片/链接的 URL 部分,保留可读文字:![alt](url) / [text](url)
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 去常见标记符号(标题 #、强调 *_、引用 >、列表符),它们不是「字」
  t = t.replace(/[#>*_~`|=-]/g, " ");

  // CJK 统一表意文字 + 扩展A + 兼容 + 假名(中日韩按单字)
  const cjk = t.match(
    /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g
  );
  const cjkCount = cjk ? cjk.length : 0;

  // 把 CJK 抠掉后,剩下按空白切出的非空段就是「拉丁/数字词」
  const rest = t.replace(
    /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g,
    " "
  );
  const latin = rest.match(/[A-Za-z0-9À-ɏ]+/g);
  const latinCount = latin ? latin.length : 0;

  return { chars: cjkCount + latinCount, words: cjkCount + latinCount };
}

/* =========================================================================
   纯浏览器降级:无文件系统,但 Phase 3 特性(数学/图/专注/大纲/字数/
   特性开关)仍全量可用 —— 这正是"内核 + 特性可单独把玩"的体验。
   图片粘贴在此模式会友好提示"无法保存"。
   ========================================================================= */

function bootBrowser(): void {
  injectShellStyles();
  const { editorHost, fileNameEl, dotEl, sidebarEl, sideTabsEl, toolbarRight } =
    buildLayout(/* showSidebarTabs */ true);

  // 浏览器无文件:文件名固定占位,圆点常灭。
  fileNameEl.textContent = "浏览器预览";
  fileNameEl.title = "纯浏览器模式 · 无文件系统";
  dotEl.style.display = "none";

  // doc.ts 在无 api 时退化为「只跟踪 dirty 不落盘」的内存文档;
  // 这里仅用它的 currentPath()(恒 null)给图片扩展做未保存兜底。
  let docRef: DocLifecycle | null = null;
  const getDocPath = () => docRef?.currentPath() ?? null;

  const { extra, wireUi } = buildFeatureExtras(getDocPath);

  const view = createEditor(editorHost, BROWSER_SAMPLE, extra);
  (window as unknown as { __mknView?: EditorView }).__mknView = view; // 调试出口
  docRef = createDocLifecycle(view, null);

  // 侧栏:浏览器无文件树,只放大纲(隐藏"文件/大纲"Tab,侧栏即大纲区)。
  const outline = createOutline({ view });
  sideTabsEl.style.display = "none"; // 无文件树,Tab 切换无意义
  const outlinePane = el("div", "mkn-side-pane");
  outlinePane.appendChild(outline.element);
  sidebarEl.appendChild(outlinePane);

  // 大纲显隐 == 折叠/展开整条侧栏(此模式侧栏只有大纲)。
  const { syncButtons } = wireUi(view, toolbarRight, {
    toggle: () => toggleSidebar(),
    isVisible: () => isSidebarOpen(),
  });

  // 设置面板 + 已存写作模式默认值(浏览器无 shell:面板/暗色/字号仍全可用,
  // 三路导出会给"仅 Electron 可用"提示,不崩)。齿轮入口塞进顶栏右区。
  wireSettings(
    view,
    toolbarRight,
    () => view.state.doc.toString(),
    () => getDocPath(),
    syncButtons
  );

  view.focus();
}

const BROWSER_SAMPLE = `# 隐墨 · 浏览器预览模式

当前在 \`npm run dev\` 浏览器下运行,**没有文件系统接入**。这是纯内核 + Phase 3 特性体验:移动光标看语法隐现,试试中文输入法。

要使用文件树、打开/保存本地 .md、把图片粘贴进 assets,请在 Electron 外壳里运行。

## 试试这些

- **加粗**、*斜体*、\`行内代码\`、~~删除线~~、[链接](https://example.com)
- 按 ⌘F / Ctrl-F 打开查找
- 顶栏开关:专注 / 打字机 / 源码 / 大纲(快捷键 ⌘⇧F / ⌘⇧T / ⌘/ / ⌘⇧O)
- 行内数学 $E = mc^2$,块级:

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

## 标题二(看左侧大纲)

### 标题三

> 本地 .md 的读写、自动保存、文件树、图片粘贴入 assets,只在 Electron 外壳启用。
`;

/* =========================================================================
   特性扩展装配 —— Electron 与浏览器两条路径共用,保证特性集一致。
   ========================================================================= */

/** 调用方注入的「大纲显隐」语义:点了按钮做什么 + 当前是否可见(供回读)。 */
interface OutlineToggle {
  /** 切换大纲显隐(bootShell=切 Tab/折叠;bootBrowser=折叠侧栏)。 */
  toggle(): void;
  /** 当前大纲是否可见,用于开关按钮态回读(不自己记状态,问真值)。 */
  isVisible(): boolean;
}

/**
 * 组装注入 createEditor 的 extra,并返回 wireUi:在 view 建好后把顶栏字数
 * + 开关按钮接好。开关态全部用 get*Mode/isSourceMode/outline.isVisible 回读,
 * 不自维护影子状态,避免与真值脱节。
 *
 * keymap 必须在 createEditor 时就进 extra(扩展只能装配期注入);而它要调
 * 的 toggle 行为依赖之后建好的 view —— 故用可变 wiring 持有真实句柄,
 * view 建好后由 wireUi 填入(填入前点快捷键是无害空操作)。
 */
function buildFeatureExtras(getDocPath: () => string | null): {
  extra: Extension[];
  wireUi: (
    view: EditorView,
    toolbarRight: HTMLElement,
    outlineToggle: OutlineToggle
  ) => { syncButtons: () => void };
} {
  const wiring = {
    toggleSource: () => {},
    toggleFocus: () => {},
    toggleTypewriter: () => {},
    toggleOutline: () => {},
  };

  const extra: Extension[] = [
    focusTypewriterExtension(),
    mathExtension(),
    mermaidExtension(),
    imagePasteExtension(getDocPath, (m) => window.alert(m)),
    featureKeymap({
      toggleSource: () => wiring.toggleSource(),
      toggleFocus: () => wiring.toggleFocus(),
      toggleTypewriter: () => wiring.toggleTypewriter(),
      toggleOutline: () => wiring.toggleOutline(),
    }),
  ];

  function wireUi(
    view: EditorView,
    toolbarRight: HTMLElement,
    outlineToggle: OutlineToggle
  ): { syncButtons: () => void } {
    // ---- 字数统计:顶栏右侧,防抖刷新(挂动态 updateListener,不碰内核)
    const wc = el("span", "mkn-wordcount");
    let wcTimer: ReturnType<typeof setTimeout> | null = null;
    function renderWordCount(): void {
      const { chars, words } = countWords(view.state.doc.toString());
      wc.textContent = `${chars} 字 · ${words} 词`;
      wc.title = "中文按字计,英文按词计;不含代码块";
    }
    function scheduleWordCount(): void {
      if (wcTimer !== null) clearTimeout(wcTimer);
      wcTimer = setTimeout(() => {
        wcTimer = null;
        renderWordCount();
      }, 250);
    }
    // 动态追加监听 —— 与 doc.ts 同一手法(StateEffect.appendConfig),
    // 给 view 加监听而不碰内核装配。
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((u) => {
          if (u.docChanged) scheduleWordCount();
        })
      ),
    });
    renderWordCount(); // 首屏即出(打开文档/降级样例都立刻显示)

    // ---- 开关按钮组:专注 / 打字机 / 源码 / 大纲;状态全部回读 ----
    const btnFocus = makeToggleBtn("专注", "专注模式 (⌘⇧F)");
    const btnTypewriter = makeToggleBtn("打字机", "打字机模式 (⌘⇧T)");
    const btnSource = makeToggleBtn("源码", "源码模式 (⌘/)");
    const btnOutline = makeToggleBtn("大纲", "大纲面板 (⌘⇧O)");

    /** 按钮态一律向真值回读(focusMode/typewriter/source/outline 可见性)。 */
    function syncButtons(): void {
      btnFocus.classList.toggle("mkn-tb-on", getFocusMode(view));
      btnTypewriter.classList.toggle("mkn-tb-on", getTypewriterMode(view));
      btnSource.classList.toggle("mkn-tb-on", isSourceMode(view));
      btnOutline.classList.toggle("mkn-tb-on", outlineToggle.isVisible());
    }

    // 把 keymap 的延迟句柄填上真实行为(与按钮点击同一路径,单一事实源)
    wiring.toggleFocus = () => {
      setFocusMode(view, !getFocusMode(view));
      syncButtons();
      view.focus();
    };
    wiring.toggleTypewriter = () => {
      setTypewriterMode(view, !getTypewriterMode(view));
      syncButtons();
      view.focus();
    };
    wiring.toggleSource = () => {
      toggleSourceMode(view); // 内核已实现源码模式,壳层只调它
      syncButtons();
      view.focus();
    };
    wiring.toggleOutline = () => {
      outlineToggle.toggle(); // 显隐语义由调用方定义
      syncButtons();
    };

    btnFocus.addEventListener("click", () => wiring.toggleFocus());
    btnTypewriter.addEventListener("click", () => wiring.toggleTypewriter());
    btnSource.addEventListener("click", () => wiring.toggleSource());
    btnOutline.addEventListener("click", () => wiring.toggleOutline());

    // 顺序:字数 → 专注 → 打字机 → 源码 → 大纲
    toolbarRight.append(
      wc,
      btnFocus,
      btnTypewriter,
      btnSource,
      btnOutline
    );
    syncButtons();

    // 暴露 syncButtons:设置面板改了专注/打字机默认值后,顺手回刷顶栏
    // 开关按钮态(单一事实源:set*Mode 改的是 view,按钮永远向其回读)。
    return { syncButtons };
  }

  return { extra, wireUi };
}

/* =========================================================================
   导出接线(Phase 4)—— HTML / PDF / Word(.docx via pandoc)。

   统一一处实现,菜单(onMenuAction)与设置面板的直达按钮共用,保证两条
   入口行为完全一致。三路全程只读当前 markdown(doc.snapshot()),经
   renderStandaloneHtml 渲染或交 pandoc,绝不修改编辑器内容。

   降级:无 shell(纯浏览器)时三个动作均给"仅 Electron 可用"提示并
   立即返回,不崩、不产生半截文件。
   ========================================================================= */

/** 取导出默认文件名(取当前文件名去扩展名;未命名草稿用「未命名」)。 */
function exportBaseName(docPath: string | null): string {
  if (!docPath) return "未命名";
  const base = basename(docPath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 组装三个导出动作。getMarkdown 现取当前全文(零转换),getDocPath 现取
 * 当前路径(用于默认名)。notify 给用户提示(无 shell / 无 pandoc / 失败)。
 *
 * 时序与图片粘贴同思路:动作可能在 view/doc 建好之前就被组装进对象,故
 * 用闭包延迟取值,每次点导出时现读,而非构造期快照。
 */
function buildExportActions(
  getMarkdown: () => string,
  getDocPath: () => string | null,
  notify: (msg: string) => void
): SettingsExportActions {
  /** 渲染当前文档为独立 HTML(标题取默认名,贴近文件名)。 */
  function renderHtml(): { html: string; name: string } {
    const name = exportBaseName(getDocPath());
    const html = renderStandaloneHtml(getMarkdown(), { title: name });
    return { html, name };
  }

  async function exportHtml(): Promise<void> {
    const shell = getShell();
    if (!shell) {
      notify("导出 HTML 仅在 Electron 外壳中可用(浏览器预览无文件系统)。");
      return;
    }
    try {
      const { html, name } = renderHtml();
      await shell.exportHtml(html, `${name}.html`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notify(`导出 HTML 失败:${m}`);
    }
  }

  async function exportPdf(): Promise<void> {
    const shell = getShell();
    if (!shell) {
      notify("导出 PDF 仅在 Electron 外壳中可用(浏览器预览无文件系统)。");
      return;
    }
    try {
      // PDF 用与 HTML 完全相同的独立 HTML,主进程离屏 printToPDF。
      const { html, name } = renderHtml();
      await shell.exportPdf(html, `${name}.pdf`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notify(`导出 PDF 失败:${m}`);
    }
  }

  async function exportDocx(): Promise<void> {
    const shell = getShell();
    if (!shell) {
      notify("导出 Word 仅在 Electron 外壳中可用(浏览器预览无文件系统)。");
      return;
    }
    try {
      // Word 走 pandoc:先探测,没有就明确提示去装,而不是静默失败。
      const ok = await shell.hasPandoc();
      if (!ok) {
        notify(
          "导出 Word(.docx)需要系统安装 pandoc。\n\n" +
            "安装后重启 隐墨 即可使用(macOS:brew install pandoc)。"
        );
        return;
      }
      const name = exportBaseName(getDocPath());
      // pandoc 直接吃 markdown 源(零转换),不经 HTML,保真度更高。
      await shell.pandocExport(getMarkdown(), "docx", `${name}.docx`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notify(`导出 Word 失败:${m}`);
    }
  }

  return {
    exportHtml: () => void exportHtml(),
    exportPdf: () => void exportPdf(),
    exportDocx: () => void exportDocx(),
  };
}

/**
 * 设置面板接线(两条启动路径共用)。在 view 建好后调用:
 *  - 读已存的专注/打字机默认值,应用到当前编辑器(开机即按偏好);
 *  - 创建设置面板,拨动默认开关时即时反映到编辑器(单一路径,与
 *    顶栏按钮等价 —— 都走 set*Mode);
 *  - 把齿轮入口按钮塞进顶栏右区;
 *  - 接好三路导出动作(注入设置面板,菜单侧另行接)。
 *
 * 返回 exportActions 供菜单(onMenuAction)复用,保证菜单与面板一致。
 * syncToolbar:设置里改了专注/打字机后,顺手回刷顶栏开关按钮态。
 */
function wireSettings(
  view: EditorView,
  toolbarRight: HTMLElement,
  getMarkdown: () => string,
  getDocPath: () => string | null,
  syncToolbar: () => void
): SettingsExportActions {
  // 开机应用已存的写作模式默认值(主题/字号已在 boot 前 early 应用)。
  // wireUi 已先跑过一次 syncButtons,此处改了模式后必须再回刷一次,
  // 否则顶栏「专注/打字机」按钮态会与刚应用的默认值脱节。
  const focusDef = getFocusDefault();
  const twDef = getTypewriterDefault();
  if (focusDef) setFocusMode(view, true);
  if (twDef) setTypewriterMode(view, true);
  if (focusDef || twDef) syncToolbar();

  const exportActions = buildExportActions(getMarkdown, getDocPath, (m) =>
    window.alert(m)
  );

  const settings = createSettings({
    exportActions,
    onFocusDefaultChange: (on) => {
      setFocusMode(view, on); // 与顶栏「专注」按钮同一真值源
      syncToolbar();
      view.focus();
    },
    onTypewriterDefaultChange: (on) => {
      setTypewriterMode(view, on);
      syncToolbar();
      view.focus();
    },
  });

  toolbarRight.appendChild(settings.triggerButton);
  return exportActions;
}

/* =========================================================================
   Electron 外壳:文件树/大纲侧栏 + 编辑器 + 顶栏(文件名 + 字数 + 开关)。
   ========================================================================= */

function bootShell(api: MknApi): void {
  injectShellStyles();
  const {
    editorHost,
    fileNameEl,
    dotEl,
    sidebarEl,
    sideTabsEl,
    toolbarRight,
  } = buildLayout(/* showSidebarTabs */ true);

  // 文档路径要给图片粘贴扩展用,但扩展在 createEditor 时就注入、doc 之后才建。
  // 用可变引用 + getDocPath 闭包打破时序:每次粘贴时现取 doc.currentPath()。
  let doc: DocLifecycle;
  const getDocPath = () => doc?.currentPath() ?? null;

  // 访达/Dock/命令行显式打开的文件优先级高于 hot-exit 会话恢复:
  // 用户双击的就是想看这个文件,别被"恢复上次"覆盖掉。
  let explicitOpen = false;

  const { extra, wireUi } = buildFeatureExtras(getDocPath);

  const view = createEditor(editorHost, "", extra);
  (window as unknown as { __mknView?: EditorView }).__mknView = view; // 调试出口
  doc = createDocLifecycle(view, api);

  // 文件树:点节点 → 询问脏文档后打开。
  const tree: FileTree = createFileTree({
    api,
    onOpenFile: (p) => {
      void openWithGuard(p);
    },
  });

  // 大纲面板:与文件树同处侧栏,顶部「文件 / 大纲」页签切换。
  const outline = createOutline({ view });

  // 侧栏头部:打开文件夹/文件 按钮(不依赖原生菜单,既是 UX 也是自诊断)。
  const sideHead = el("div", "mkn-side-head");
  const btnFolder = el("button", "mkn-side-btn");
  btnFolder.textContent = "📂 打开文件夹";
  const btnFile = el("button", "mkn-side-btn");
  btnFile.textContent = "📄 打开文件";
  const sideHint = el("div", "mkn-side-hint");
  sideHint.textContent = "未打开文件夹";
  btnFolder.addEventListener("click", () => void doOpenFolder());
  btnFile.addEventListener("click", () => void doOpenFile());
  sideHead.append(btnFolder, btnFile, sideHint);

  // 侧栏装配:头部 → 「文件/大纲」Tab → 文件树容器 + 大纲容器(互斥显示)。
  const filePane = el("div", "mkn-side-pane");
  filePane.appendChild(tree.element);
  const outlinePane = el("div", "mkn-side-pane");
  outlinePane.appendChild(outline.element);

  const tabFile = el("button", "mkn-side-tab");
  tabFile.textContent = "文件";
  const tabOutline = el("button", "mkn-side-tab");
  tabOutline.textContent = "大纲";
  sideTabsEl.append(tabFile, tabOutline);

  type SideView = "files" | "outline";
  let sideView: SideView = "files";
  function setSidebarView(v: SideView): void {
    sideView = v;
    const onFiles = v === "files";
    filePane.style.display = onFiles ? "" : "none";
    outlinePane.style.display = onFiles ? "none" : "";
    tabFile.classList.toggle("mkn-side-tab-on", onFiles);
    tabOutline.classList.toggle("mkn-side-tab-on", !onFiles);
    // 切到大纲时刷新一次(文件树展开期间文档可能已变,保持新鲜)
    if (!onFiles) outline.refresh();
  }
  tabFile.addEventListener("click", () => {
    if (!isSidebarOpen()) setSidebarCollapsed(false); // 折叠态点 Tab 先展开
    setSidebarView("files");
  });
  tabOutline.addEventListener("click", () => {
    if (!isSidebarOpen()) setSidebarCollapsed(false);
    setSidebarView("outline");
  });

  sidebarEl.append(sideHead, filePane, outlinePane);
  setSidebarView("files");

  /**
   * 大纲显隐(顶栏「大纲」按钮 / ⌘⇧O 的语义):
   *  - 大纲已可见(侧栏展开且在大纲页) → 折叠侧栏(收起)
   *  - 否则 → 展开侧栏并切到大纲页(让大纲露出来)
   * isVisible 据真值回读:侧栏展开 且 当前在大纲页。
   */
  const outlineToggle: OutlineToggle = {
    toggle() {
      const visible = isSidebarOpen() && sideView === "outline";
      if (visible) {
        setSidebarCollapsed(true);
      } else {
        setSidebarCollapsed(false);
        setSidebarView("outline");
      }
    },
    isVisible: () => isSidebarOpen() && sideView === "outline",
  };

  /** 打开文件夹(菜单与侧栏按钮共用)。 */
  async function doOpenFolder(): Promise<void> {
    const root = await api.openFolderDialog();
    if (!root) return;
    await tree.setRoot(root);
    sideHint.textContent = basename(root) || root;
    setSidebarView("files"); // 刚开文件夹,自然切回文件树
  }

  /** 打开单个文件(菜单与侧栏按钮共用)。 */
  async function doOpenFile(): Promise<void> {
    const picked = await api.openFileDialog();
    if (!picked) return;
    if (doc.isDirty() && !window.confirm("有未保存修改,放弃并打开新文件?"))
      return;
    doc.openWithContent(picked.path, picked.content); // 对话框已读好内容
  }

  /** 顶栏文件名 + 未保存圆点跟随当前文档。 */
  function refreshHeader(): void {
    const p = doc.currentPath();
    fileNameEl.textContent = p ? basename(p) : "未命名";
    fileNameEl.title = p ?? "未命名草稿";
    dotEl.classList.toggle("mkn-dot-on", doc.isDirty());
    // 同步系统窗口标题 / macOS 代理图标,"文档名"在原生层也跟随。
    api.setDocTitle(p);
  }
  doc.onDirtyChange(refreshHeader);
  doc.onPathChange((p) => {
    tree.setActive(p);
    refreshHeader();
    outline.refresh(); // 换文档后大纲立刻重抽(不必等防抖)
  });
  // 打开二进制/非文本(.docx/.pdf/图片等):友好拒绝,不灌乱码。
  doc.onOpenError((p) => {
    window.alert(
      `「${basename(p)}」不是纯文本 / Markdown 文件,打不开。\n\n` +
        `隐墨 是 Markdown 编辑器,只支持 .md / .markdown / .txt 等纯文本;` +
        `.docx / .pdf / 图片 等是二进制格式。`
    );
  });
  refreshHeader();

  /** 打开前对当前未保存修改做拦截确认。 */
  async function openWithGuard(p: string): Promise<void> {
    if (p === doc.currentPath()) return; // 已是当前文件,忽略
    if (doc.isDirty()) {
      const ok = window.confirm(
        `「${doc.currentPath() ? basename(doc.currentPath()!) : "未命名"}」有未保存修改,放弃并打开新文件?`
      );
      if (!ok) return;
    }
    await doc.openPath(p);
  }

  // 顶栏字数 + 开关(大纲按钮按上面 outlineToggle 的语义:展开侧栏并切到
  // 大纲页 / 已可见则收起,按钮态据真值回读)。先于菜单接线,使设置面板
  // 与导出动作就位 —— 导出三路要被 onMenuAction 引用。
  const { syncButtons } = wireUi(view, toolbarRight, outlineToggle);

  // 设置面板 + 已存写作模式默认值;返回三路导出动作供菜单复用,保证
  // 「菜单」与「设置面板按钮」两个入口行为完全一致。导出只读
  // doc.snapshot()(零转换),全程不改文档。
  const exportActions = wireSettings(
    view,
    toolbarRight,
    () => doc.snapshot(),
    () => doc.currentPath(),
    syncButtons
  );

  // ---- 原生菜单 / 快捷键动作闭环 ----
  api.onMenuAction((action) => {
    switch (action) {
      case "new":
        if (doc.isDirty() && !window.confirm("有未保存修改,放弃并新建?")) return;
        doc.newDoc();
        refreshHeader();
        outline.refresh();
        break;

      case "open":
        void doOpenFile();
        break;

      case "openFolder":
        void doOpenFolder();
        break;

      case "save":
        void doc.save();
        break;

      case "saveAs":
        void doc.saveAs();
        break;

      case "find":
        // 触发编辑器查找面板(等价 ⌘F);内核已装 search 扩展。
        openSearchPanel(view);
        break;

      case "toggleSidebar":
        toggleSidebar();
        break;

      // ---- Phase 4 导出:与设置面板按钮同一实现(buildExportActions),
      // 渲染当前 markdown → IPC 落盘;无 pandoc / 失败均有友好提示。----
      case "exportHtml":
        exportActions.exportHtml();
        break;

      case "exportPdf":
        exportActions.exportPdf();
        break;

      case "exportDocx":
        exportActions.exportDocx();
        break;
    }
  });

  // ---- 外部改动:不脏静默重载,脏则询问 ----
  api.onFileChanged((changedPath) => {
    if (changedPath !== doc.currentPath()) return;
    if (!doc.isDirty()) {
      void doc.openPath(changedPath); // 静默重载(applyContent 不会误判 dirty)
      return;
    }
    const ok = window.confirm(
      `「${basename(changedPath)}」在外部被修改。放弃本地修改并重载磁盘版本?`
    );
    if (ok) void doc.openPath(changedPath);
    // 选否:保留本地修改,什么都不做(后续自保存会覆盖外部改动)。
  });

  // ---- 访达双击 / 拖到 Dock / 命令行打开 ----
  // Phase 2 后补:之前主进程完全不接 open-file/argv,这类打开会空开成
  // "未命名"。走 openWithGuard(脏文档先确认),并置位 explicitOpen 让
  // hot-exit 恢复给它让路 —— 用户双击的就是想看这个文件。
  api.onOpenPath((p) => {
    explicitOpen = true;
    void openWithGuard(p);
  });

  // ---- hot-exit:启动恢复上次会话 ----
  // 关闭从不提示保存,全靠这里把上次缓存的文件 + 全文恢复回来。
  void (async () => {
    if (explicitOpen) return; // 已有显式打开请求:不拿旧会话覆盖它
    const sess = await api.loadSession();
    // loadSession 是异步往返,期间可能刚收到 open-file → 再判一次
    if (explicitOpen) return;
    if (!sess || sess.content.trim() === "") return; // 无缓存 / 空草稿:正常空开
    if (sess.path) {
      try {
        // baseline 取磁盘现内容 → dirty 真实反映"缓存里还没存盘的改动"。
        const onDisk = await api.readFile(sess.path);
        doc.restoreSession(sess.path, sess.content, onDisk);
      } catch {
        // 文件已被移走/删除:当未命名草稿留住内容,不绑死失效路径。
        doc.restoreSession(null, sess.content, "");
      }
    } else {
      doc.restoreSession(null, sess.content, ""); // 未命名草稿:恢复即为未保存
    }
  })();

  // ---- 失焦 / 关闭前补一次缓存 ----
  // 防抖只有 350ms,但关窗瞬间可能还差最后几下;失焦、页面隐藏、卸载前
  // 各补一次 flush,把"关闭丢失窗口"压到最小。
  const flush = () => doc.flushCache();
  window.addEventListener("blur", flush);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  view.focus();
}

/* ----------------------------- 布局构建 -------------------------------- */

interface Layout {
  editorHost: HTMLElement;
  fileNameEl: HTMLElement;
  dotEl: HTMLElement;
  sidebarEl: HTMLElement;
  sideTabsEl: HTMLElement;
  toolbarRight: HTMLElement;
}

let sidebarCollapsed = false;
let rootEl: HTMLElement;

function buildLayout(showSidebarTabs: boolean): Layout {
  document.body.innerHTML = "";

  rootEl = el("div", "mkn-root");

  // 顶栏:品牌 + 文件名 + 未保存圆点 | (右)字数 + 特性开关。
  const toolbar = el("div");
  toolbar.id = "toolbar";
  const brand = el("span", "brand");
  brand.textContent = "隐墨";
  const fileWrap = el("span", "mkn-filewrap");
  const dot = el("span", "mkn-dot");
  const fileName = el("span", "mkn-filename");
  fileName.textContent = "未命名";
  fileWrap.append(dot, fileName);
  // 右侧区:margin-left:auto 推到最右,容纳字数 + 开关组
  const right = el("span", "mkn-toolbar-right");
  toolbar.append(brand, fileWrap, right);

  // 主体:侧栏 + 编辑器区。
  const body = el("div", "mkn-body");
  const sidebar = el("aside", "mkn-sidebar");
  const sideTabs = el("div", "mkn-side-tabs");
  if (!showSidebarTabs) sideTabs.style.display = "none";
  const editorArea = el("div");
  editorArea.id = "app"; // 复用主题里 #app/.cm-editor 的高度规则
  body.append(sidebar, editorArea);

  rootEl.append(toolbar, body);
  document.body.appendChild(rootEl);

  // 注:sideTabs 的实际位置由调用方插进 sidebar(在 head 之后、pane 之前);
  // 这里只创建并交回引用,布局函数不强加侧栏内部结构。
  return {
    editorHost: editorArea,
    fileNameEl: fileName,
    dotEl: dot,
    sidebarEl: sidebar,
    sideTabsEl: sideTabs,
    toolbarRight: right,
  };
}

function toggleSidebar(): void {
  setSidebarCollapsed(!sidebarCollapsed);
}

/** 显式设置侧栏折叠态(幂等;大纲显隐逻辑要精确控制而非盲翻)。 */
function setSidebarCollapsed(collapsed: boolean): void {
  sidebarCollapsed = collapsed;
  rootEl.classList.toggle("mkn-sidebar-collapsed", sidebarCollapsed);
}

/** 侧栏当前是否展开(供大纲显隐回读)。 */
function isSidebarOpen(): boolean {
  return !sidebarCollapsed;
}

/* ----------------------------- 小工具 ---------------------------------- */

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** 一个顶栏开关小按钮(状态由调用方按 get*Mode 回读后 toggle .mkn-tb-on)。 */
function makeToggleBtn(label: string, title: string): HTMLElement {
  const b = el("button", "mkn-tb-btn");
  b.textContent = label;
  b.title = title;
  return b;
}

/** 取路径末段文件名(兼容 / 与 \\)。 */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/* =========================================================================
   外壳布局样式 —— 仅用 --mkn-* 变量,贴 Typora 的克制感。
   动态注入,避免改主题 CSS(主题文件冻结)。
   ========================================================================= */

function injectShellStyles(): void {
  const css = `
  .mkn-root {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  /* #toolbar 基础样式来自主题;这里补外壳特有部分 */
  #toolbar .mkn-filewrap {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--mkn-fg);
  }
  #toolbar .mkn-filename {
    max-width: 32vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 未保存圆点:dirty 时点亮 accent,干净时透明占位(不跳动) */
  #toolbar .mkn-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: transparent;
    flex: 0 0 auto;
  }
  #toolbar .mkn-dot.mkn-dot-on {
    background: var(--mkn-accent);
  }
  /* 顶栏右区:字数 + 特性开关,推到最右,克制留白 */
  #toolbar .mkn-toolbar-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #toolbar .mkn-wordcount {
    font-size: 12px;
    color: var(--mkn-fg-faint);
    white-space: nowrap;
    margin-right: 4px;
  }
  /* 特性开关小按钮:默认描边淡,激活时 accent 实底感(低饱和) */
  #toolbar .mkn-tb-btn {
    font-family: var(--mkn-font-body);
    font-size: 12px;
    line-height: 1;
    color: var(--mkn-fg-soft);
    background: var(--mkn-bg);
    border: 1px solid var(--mkn-rule);
    border-radius: 6px;
    padding: 5px 9px;
    cursor: pointer;
    user-select: none;
  }
  #toolbar .mkn-tb-btn:hover {
    border-color: var(--mkn-accent);
    color: var(--mkn-accent);
  }
  #toolbar .mkn-tb-btn.mkn-tb-on {
    color: var(--mkn-accent);
    border-color: var(--mkn-accent);
    background: color-mix(in srgb, var(--mkn-accent) 12%, transparent);
  }

  .mkn-body {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
  }
  .mkn-sidebar {
    flex: 0 0 240px;
    width: 240px;
    border-right: 1px solid var(--mkn-rule);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: color-mix(in srgb, var(--mkn-code-bg) 55%, var(--mkn-bg));
    transition: flex-basis 0.14s ease, width 0.14s ease;
  }
  /* 折叠:宽度归零并隐藏,编辑器自然铺满 */
  .mkn-root.mkn-sidebar-collapsed .mkn-sidebar {
    flex-basis: 0;
    width: 0;
    border-right: none;
    overflow: hidden;
  }
  /* 侧栏头部:打开文件夹/文件 按钮 + 当前根目录提示 */
  .mkn-side-head {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border-bottom: 1px solid var(--mkn-rule);
  }
  .mkn-side-btn {
    font-family: var(--mkn-font-body);
    font-size: 12px;
    text-align: left;
    color: var(--mkn-fg);
    background: var(--mkn-bg);
    border: 1px solid var(--mkn-rule);
    border-radius: 6px;
    padding: 6px 9px;
    cursor: pointer;
  }
  .mkn-side-btn:hover {
    border-color: var(--mkn-accent);
    color: var(--mkn-accent);
  }
  .mkn-side-hint {
    font-size: 11px;
    color: var(--mkn-fg-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 侧栏「文件 / 大纲」页签条 */
  .mkn-side-tabs {
    flex: 0 0 auto;
    display: flex;
    gap: 4px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--mkn-rule);
  }
  .mkn-side-tab {
    flex: 1 1 auto;
    font-family: var(--mkn-font-body);
    font-size: 12px;
    line-height: 1;
    color: var(--mkn-fg-soft);
    background: var(--mkn-bg);
    border: 1px solid var(--mkn-rule);
    border-radius: 6px;
    padding: 6px 0;
    cursor: pointer;
    user-select: none;
  }
  .mkn-side-tab:hover {
    border-color: var(--mkn-accent);
    color: var(--mkn-accent);
  }
  .mkn-side-tab.mkn-side-tab-on {
    color: var(--mkn-accent);
    border-color: var(--mkn-accent);
    background: color-mix(in srgb, var(--mkn-accent) 12%, transparent);
  }
  /* 侧栏内容区(文件树 / 大纲 互斥):占满剩余高度并可滚 */
  .mkn-side-pane {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  /* 启动失败兜底面板:不再静默白屏 */
  .mkn-fatal {
    margin: 40px auto;
    max-width: 680px;
    padding: 20px 24px;
    border: 1px solid var(--mkn-rule);
    border-radius: 10px;
    font-family: var(--mkn-font-mono);
    font-size: 13px;
    color: var(--mkn-code-fg);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .mkn-body > #app {
    flex: 1 1 auto;
    min-width: 0;
    overflow: auto;
  }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/* =========================================================================
   入口分发 —— 必须放在文件末尾:bootBrowser/bootShell 会用到上面用
   const/let 声明的 BROWSER_SAMPLE、rootEl 等;若在顶部就调用会落入
   暂时性死区(TDZ),createEditor 拿到未初始化的 BROWSER_SAMPLE 直接抛错。
   ========================================================================= */

const shell = getShell();
try {
  // ★ 开机最先做:按已存偏好把 <html data-theme> 与字号设好,必须早于
  // buildLayout/createEditor —— 否则会先渲染浅色再切暗色,出现"白光一闪"。
  // 纯前端态(不依赖 shell/view),两条启动路径共用同一起点。
  applyStoredPreferencesEarly();

  if (shell) {
    bootShell(shell);
  } else {
    bootBrowser();
  }
} catch (e) {
  // 不再静默白屏:启动异常直接显示到页面(沙箱/真机都看得到)。
  const err = e instanceof Error ? `${e.message}\n\n${e.stack ?? ""}` : String(e);
  document.body.innerHTML = "";
  const box = document.createElement("pre");
  box.textContent =
    `隐墨 启动失败(${shell ? "Electron 外壳" : "浏览器"}模式):\n\n` + err;
  box.style.cssText =
    "margin:40px auto;max-width:680px;padding:20px 24px;border:1px solid #e8e8e8;border-radius:10px;font:13px/1.6 ui-monospace,Menlo,monospace;color:#d1395a;white-space:pre-wrap;word-break:break-word";
  document.body.appendChild(box);
  // eslint-disable-next-line no-console
  console.error("[隐墨] boot failed:", e);
}

// 控制台留一行明确的模式标记,便于真机排障(window.mkn 有没有注入一目了然)。
// eslint-disable-next-line no-console
console.info(
  `[隐墨] shell = ${shell ? "Electron(window.mkn 已注入)" : "browser(window.mkn 缺失 → 降级)"}`
);
