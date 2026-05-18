import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

/**
 * decoration 构建上下文。
 *
 * `decos`  —— 实际渲染的 decoration(mark / line / replace)。
 * `atomic` —— 需要被键盘光标当作"单一原子单位"跳过的范围。
 *
 * 规则:**每个 replace decoration 都同时登记为 atomic**。否则光标用
 * 方向键移动到隐藏标记(`**`/`#`)或 widget(列表圆点、任务复选框 `<input>`)
 * 附近时,浏览器 contentEditable 的原生 caret 会错乱、容易跳过一整段。
 * mark / line decoration 不进 atomic(它们不隐藏内容,光标需正常停靠)。
 */
export interface BuildCtx {
  decos: Range<Decoration>[];
  atomic: Range<Decoration>[];
}

const ATOMIC = Decoration.replace({}); // 仅作 atomic RangeSet 的占位值

/** 加一个 replace decoration,并同步登记为 atomic 范围。 */
export function addReplace(
  ctx: BuildCtx,
  from: number,
  to: number,
  spec: Parameters<typeof Decoration.replace>[0]
): void {
  if (to <= from) return;
  ctx.decos.push(Decoration.replace(spec).range(from, to));
  ctx.atomic.push(ATOMIC.range(from, to));
}
