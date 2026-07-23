import { useEffect, useRef, type RefObject } from "react";

interface ModalStackEntry {
  id: symbol;
  containerRef: RefObject<HTMLElement | null>;
}

interface InertSnapshot {
  inert: boolean;
  ariaHidden: string | null;
}

const modalStack: ModalStackEntry[] = [];
const inertSnapshots = new Map<HTMLElement, InertSnapshot>();

export interface TopmostModalOptions {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose?: () => void;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * EN: Traps focus in the topmost modal, makes background layers inert, and restores the opener.
 * 中文: 将焦点限制在最上层弹窗，使背景层不可交互，并在关闭后恢复触发元素。
 * @param options modal visibility, container, close behavior, and optional initial focus.
 * @returns void.
 */
export function useTopmostModal(options: TopmostModalOptions): void {
  const idRef = useRef(Symbol("oysterworkflow-modal"));
  const onCloseRef = useRef(options.onClose);
  onCloseRef.current = options.onClose;

  useEffect(() => {
    if (!options.open) {
      return;
    }
    const id = idRef.current;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    modalStack.push({ id, containerRef: options.containerRef });
    applyTopmostInertness();

    const frame = window.requestAnimationFrame(() => {
      if (!isTopmost(id)) {
        return;
      }
      const container = options.containerRef.current;
      const initial =
        options.initialFocusRef?.current ?? findFocusableElements(container)[0];
      if (initial) {
        initial.focus({ preventScroll: true });
      } else if (container) {
        if (!container.hasAttribute("tabindex")) {
          container.setAttribute("tabindex", "-1");
          container.dataset.modalTemporaryTabindex = "true";
        }
        container.focus({ preventScroll: true });
      }
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost(id)) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (options.closeOnEscape !== false) {
          onCloseRef.current?.();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const container = options.containerRef.current;
      const focusable = findFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container?.focus({ preventScroll: true });
        return;
      }
      const activeIndex = focusable.indexOf(
        document.activeElement as HTMLElement,
      );
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        focusable[focusable.length - 1].focus({ preventScroll: true });
      } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0].focus({ preventScroll: true });
      } else if (activeIndex === -1) {
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0].focus({
          preventScroll: true,
        });
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      const wasTopmost = isTopmost(id);
      const index = modalStack.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        modalStack.splice(index, 1);
      }
      const container = options.containerRef.current;
      if (container?.dataset.modalTemporaryTabindex === "true") {
        container.removeAttribute("tabindex");
        delete container.dataset.modalTemporaryTabindex;
      }
      applyTopmostInertness();
      if (wasTopmost && previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [
    options.closeOnEscape,
    options.containerRef,
    options.initialFocusRef,
    options.open,
  ]);
}

/**
 * EN: Clears module-level modal state between isolated UI tests.
 * 中文: 在隔离 UI 测试之间清理模块级弹窗状态。
 * @returns void.
 */
export function resetModalFocusForTests(): void {
  modalStack.splice(0, modalStack.length);
  restoreInertSnapshots();
}

function isTopmost(id: symbol): boolean {
  return modalStack[modalStack.length - 1]?.id === id;
}

function findFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) {
    return [];
  }
  const selector = [
    "button:not([disabled])",
    "a[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (element) =>
      !element.closest('[inert], [aria-hidden="true"]') &&
      element.getAttribute("hidden") === null,
  );
}

function applyTopmostInertness(): void {
  restoreInertSnapshots();
  const container = modalStack[modalStack.length - 1]?.containerRef.current;
  if (!container) {
    return;
  }
  let branch: HTMLElement | null = container;
  while (branch && branch !== document.body) {
    const parent: HTMLElement | null = branch.parentElement;
    if (!parent) {
      break;
    }
    Array.from(parent.children).forEach((sibling) => {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        makeInert(sibling);
      }
    });
    branch = parent;
  }
}

function makeInert(element: HTMLElement): void {
  if (!inertSnapshots.has(element)) {
    inertSnapshots.set(element, {
      inert: element.hasAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    });
  }
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
}

function restoreInertSnapshots(): void {
  inertSnapshots.forEach((snapshot, element) => {
    if (snapshot.inert) {
      element.setAttribute("inert", "");
    } else {
      element.removeAttribute("inert");
    }
    if (snapshot.ariaHidden === null) {
      element.removeAttribute("aria-hidden");
    } else {
      element.setAttribute("aria-hidden", snapshot.ariaHidden);
    }
  });
  inertSnapshots.clear();
}
