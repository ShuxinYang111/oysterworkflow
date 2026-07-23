import type { KeyboardEvent } from "react";

/**
 * EN: Adds predictable keyboard paging to a focusable scroll region.
 * 中文: 为可聚焦的滚动区域提供一致的键盘翻页行为。
 * @param event Keyboard event emitted by the scroll region.
 * @returns Nothing.
 */
export function handleScrollableRegionKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
): void {
  const region = event.currentTarget;
  const target = event.target as HTMLElement;
  const editingField = target.matches("input, select, textarea");
  const pageDistance = Math.max(180, region.clientHeight * 0.8);
  let nextTop: number | null = null;

  switch (event.key) {
    case "PageDown":
      nextTop = region.scrollTop + pageDistance;
      break;
    case "PageUp":
      nextTop = region.scrollTop - pageDistance;
      break;
    case "Home":
      if (!editingField) nextTop = 0;
      break;
    case "End":
      if (!editingField) nextTop = region.scrollHeight;
      break;
    case "ArrowDown":
      if (!editingField) nextTop = region.scrollTop + 52;
      break;
    case "ArrowUp":
      if (!editingField) nextTop = region.scrollTop - 52;
      break;
    case " ":
      if (!editingField) {
        nextTop =
          region.scrollTop + (event.shiftKey ? -pageDistance : pageDistance);
      }
      break;
  }

  if (nextTop === null) {
    return;
  }
  event.preventDefault();
  region.scrollTo({ top: nextTop, behavior: "smooth" });
}
