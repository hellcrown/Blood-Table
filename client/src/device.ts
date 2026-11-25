/**
 * 设备能力探测。
 *
 * 勿停是电脑端玩法（键盘开车 + 鼠标环顾/点地图），以「主指针是否精确（鼠标/触控板）」作为电脑判据：
 * 手机/平板的主指针是粗指针（手指）。探测不可用时按电脑处理——宁可放进去让玩家自己发现，
 * 也不因为一个探测 API 缺失就无故拦人。
 */
export function isKeyboardPC(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  try {
    return window.matchMedia('(pointer: fine)').matches;
  } catch {
    return true;
  }
}
