import { useEffect } from 'react';

/**
 * 弹层通用行为：按 Esc 关闭。
 *
 * 此前全站没有任何 Esc 处理（唯一键盘交互是个别输入框的 Enter），弹层只能靠点关闭按钮或
 * 点遮罩关闭 —— 桌面端用户习惯性按 Esc 会毫无反应。
 */
export function useEscClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, enabled]);
}

/**
 * 遮罩点击关闭的守卫：草稿非空时先确认，避免误触点一下就把已写的内容丢掉
 * （反馈框可写 500 字，滑动/误触面板外空白即全丢且无二次确认）。
 */
export function guardDirtyClose(hasDraft: boolean, onClose: () => void): void {
  if (hasDraft && !window.confirm('已填写的内容将不会保存，确定要关闭吗？')) return;
  onClose();
}
