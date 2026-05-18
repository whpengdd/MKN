import type { MknApi, FileEntry } from "../shell/ipc";
import "./fileTree.css";

/**
 * ★ 文件树侧栏(Phase 2)。
 *
 * 设计取向贴 Typora 侧栏:窄、安静、懒。三条原则:
 *
 *  - 懒加载:目录默认折叠,只有展开那一刻才 `api.readDir` 拉子项。
 *    结果缓存在节点上 —— 再次折叠/展开是纯 DOM 显隐(显隐而非重建,
 *    保留滚动位置、保留更深层已展开的子树),不重复打文件系统。
 *  - 健壮兜底:`readDir` 任何失败(权限/路径不存在/竞态)都被吞掉,
 *    在该目录下渲染一行淡灰提示,整棵树绝不崩。
 *  - 自管生命周期:每个可点击行的监听都登记进 `disposers`,
 *    `destroy()` 一次性解绑;切根时先彻底清理旧树再建新树。
 *
 * 仅通过注入的 `MknApi` 访问文件系统,不直接碰 fs(契约见 shell/ipc.ts)。
 * 纯 DOM + TS,无第三方 UI 库。
 */

export interface FileTreeOptions {
  api: MknApi;
  onOpenFile: (path: string) => void; // 点击文件时回调
}

export interface FileTree {
  element: HTMLElement; // 挂载用根元素
  setRoot(rootPath: string): Promise<void>; // 设置/切换根目录并渲染
  setActive(path: string | null): void; // 高亮当前打开的文件
  destroy(): void;
}

/**
 * 一个目录节点的运行时状态。文件节点不需要状态(无展开/无子项),
 * 因此只为目录建 NodeState 并以路径为键存进 Map,供 setActive 之外的
 * 折叠/展开逻辑就近取用。
 */
interface DirNode {
  entry: FileEntry;
  depth: number;
  row: HTMLElement; // 该目录自身那一行
  twisty: HTMLElement; // 行首折叠箭头
  childrenBox: HTMLElement; // 容纳子节点的容器(折叠时 display:none)
  loaded: boolean; // 是否已成功拉过一次子项
  expanded: boolean;
}

const INDENT_STEP = 14; // 每层缩进像素;与箭头/图标宽度配合让层级一眼可辨
const BASE_PAD = 6; // 根层左内边距,留一点呼吸

export function createFileTree(opts: FileTreeOptions): FileTree {
  const { api, onOpenFile } = opts;

  // 根元素:对外暴露给 app.ts 挂载
  const root = document.createElement("div");
  root.className = "mkn-filetree";

  // 所有行级监听的反注册函数;destroy / 切根时统一清空
  let disposers: Array<() => void> = [];

  // 当前根路径;用于忽略"切根后才返回"的过期 readDir(竞态防护)
  let currentRoot: string | null = null;

  // 路径 → 文件行,供 setActive O(1) 切换高亮(只索引文件,目录不高亮)
  const fileRows = new Map<string, HTMLElement>();
  let activePath: string | null = null;
  let activeEl: HTMLElement | null = null;

  /** 注册一个监听并记下其反注册,保证 destroy 能解干净 */
  function listen(
    el: HTMLElement,
    type: string,
    handler: (e: Event) => void
  ): void {
    el.addEventListener(type, handler);
    disposers.push(() => el.removeEventListener(type, handler));
  }

  /** 彻底清空当前树:解绑所有监听、清空 DOM 与索引 */
  function clearTree(): void {
    for (const off of disposers) off();
    disposers = [];
    fileRows.clear();
    activeEl = null;
    root.textContent = "";
  }

  /** 缩进:用左 padding 而非 margin,保证 hover/选中底色铺满整行宽 */
  function applyIndent(row: HTMLElement, depth: number): void {
    row.style.paddingLeft = BASE_PAD + depth * INDENT_STEP + "px";
  }

  /** 渲染一行通用骨架(箭头占位 + 图标 + 名称) */
  function buildRow(
    entry: FileEntry,
    depth: number
  ): { row: HTMLElement; twisty: HTMLElement } {
    const row = document.createElement("div");
    row.className = "mkn-ft-row";
    row.title = entry.name; // 悬停看全名(配合 CSS 省略号)
    applyIndent(row, depth);

    const twisty = document.createElement("span");
    twisty.className = "mkn-ft-twisty";
    if (entry.isDir) {
      twisty.textContent = "›"; // 折叠态;展开靠 CSS 旋转 90°
    } else {
      twisty.classList.add("mkn-ft-leaf"); // 文件:隐藏但占位,保证名称左缘对齐
    }

    const icon = document.createElement("span");
    icon.className = "mkn-ft-icon";
    icon.textContent = entry.isDir ? "📁" : "📄";

    const label = document.createElement("span");
    label.className = "mkn-ft-label";
    label.textContent = entry.name; // textContent:中文/特殊字符天然安全

    row.append(twisty, icon, label);
    return { row, twisty };
  }

  /** 一行淡灰提示(空目录 / 读取失败),不可点 */
  function noteRow(text: string, depth: number): HTMLElement {
    const note = document.createElement("div");
    note.className = "mkn-ft-note";
    note.textContent = text;
    note.style.paddingLeft = BASE_PAD + depth * INDENT_STEP + 18 + "px";
    return note;
  }

  /**
   * 渲染一个文件节点:点击即回调 onOpenFile。
   * 不在此处抢着 setActive —— 高亮以 app 实际打开成功后回调 setActive
   * 为准,避免"点了但打开失败仍高亮"的不一致。
   */
  function renderFile(entry: FileEntry, depth: number): HTMLElement {
    const { row } = buildRow(entry, depth);
    fileRows.set(entry.path, row);
    if (entry.path === activePath) {
      row.classList.add("mkn-ft-active");
      activeEl = row;
    }
    listen(row, "click", () => onOpenFile(entry.path));
    return row;
  }

  /**
   * 渲染一个目录节点:行 + 紧随其后的(初始折叠的)子容器。
   * 点击行切换展开/折叠;首次展开惰性拉子项并缓存。
   */
  function renderDir(entry: FileEntry, depth: number): DocumentFragment {
    const frag = document.createDocumentFragment();
    const { row, twisty } = buildRow(entry, depth);

    const childrenBox = document.createElement("div");
    childrenBox.className = "mkn-ft-children";
    childrenBox.style.display = "none"; // 默认折叠

    const node: DirNode = {
      entry,
      depth,
      row,
      twisty,
      childrenBox,
      loaded: false,
      expanded: false,
    };

    listen(row, "click", () => {
      void toggleDir(node);
    });

    frag.append(row, childrenBox);
    return frag;
  }

  /** 展开/折叠一个目录;首次展开惰性拉取并缓存子项 */
  async function toggleDir(node: DirNode): Promise<void> {
    if (node.expanded) {
      // 折叠:仅隐藏,保留已建子树(含更深层的展开态)与滚动位置
      node.expanded = false;
      node.childrenBox.style.display = "none";
      node.twisty.classList.remove("mkn-ft-open");
      return;
    }

    // 展开
    node.expanded = true;
    node.twisty.classList.add("mkn-ft-open");

    if (!node.loaded) {
      // 首次展开:拉子项。失败 → 标记未加载,下次展开可重试
      const rootAtCall = currentRoot;
      let entries: FileEntry[];
      try {
        entries = await api.readDir(node.entry.path);
      } catch {
        // 权限不足 / 路径已不存在 / 其它 IO 错:淡灰兜底,不崩
        node.childrenBox.textContent = "";
        node.childrenBox.appendChild(
          noteRow("无法读取此目录", node.depth + 1)
        );
        node.childrenBox.style.display = "";
        return;
      }

      // 竞态防护:若期间已切根,丢弃这批过期结果
      if (rootAtCall !== currentRoot) return;

      node.childrenBox.textContent = "";
      if (entries.length === 0) {
        node.childrenBox.appendChild(noteRow("空文件夹", node.depth + 1));
      } else {
        // readDir 已保证"目录在前、文件在后、各按名称排序",直接铺
        for (const child of entries) {
          node.childrenBox.appendChild(renderChild(child, node.depth + 1));
        }
      }
      node.loaded = true;
    }

    node.childrenBox.style.display = "";
  }

  /** 按类型分派:目录走 renderDir,文件走 renderFile */
  function renderChild(entry: FileEntry, depth: number): Node {
    return entry.isDir ? renderDir(entry, depth) : renderFile(entry, depth);
  }

  /**
   * 设置/切换根目录并渲染。
   * 先彻底拆掉旧树(解绑监听、清索引),再以最新 currentRoot 拉根级列表;
   * 期间任何旧的 readDir 回来都因 currentRoot 不符而被丢弃。
   */
  async function setRoot(rootPath: string): Promise<void> {
    currentRoot = rootPath;
    clearTree();

    // 顶部根目录名(取路径末段;Windows 反斜杠也兼容)
    const segs = rootPath.split(/[\\/]/).filter(Boolean);
    const rootName = document.createElement("div");
    rootName.className = "mkn-ft-rootname";
    rootName.textContent = segs[segs.length - 1] || rootPath;
    rootName.title = rootPath;
    root.appendChild(rootName);

    let entries: FileEntry[];
    try {
      entries = await api.readDir(rootPath);
    } catch {
      // 根目录本身读不了:整树位置给出兜底提示
      if (currentRoot === rootPath) {
        root.appendChild(noteRow("无法读取此文件夹", 0));
      }
      return;
    }

    // 竞态:返回前已被再次切根 → 放弃渲染本批
    if (currentRoot !== rootPath) return;

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mkn-ft-empty";
      empty.textContent = "此文件夹为空";
      root.appendChild(empty);
      return;
    }

    for (const child of entries) {
      root.appendChild(renderChild(child, 0));
    }
  }

  /**
   * 高亮当前打开的文件。
   * 传 null 清除高亮;传不在当前(已渲染)树里的路径则只记录,
   * 待其所在目录被展开、文件行建出时由 renderFile 据 activePath 补上。
   */
  function setActive(path: string | null): void {
    activePath = path;

    if (activeEl) {
      activeEl.classList.remove("mkn-ft-active");
      activeEl = null;
    }
    if (!path) return;

    const row = fileRows.get(path);
    if (row) {
      row.classList.add("mkn-ft-active");
      activeEl = row;
      // 若已折进可视区外,滚动带回(不抢焦点)
      row.scrollIntoView({ block: "nearest" });
    }
  }

  /** 销毁:解绑全部监听、清空 DOM 与索引;之后该实例不应再被使用 */
  function destroy(): void {
    clearTree();
    currentRoot = null;
    activePath = null;
  }

  return {
    element: root,
    setRoot,
    setActive,
    destroy,
  };
}
