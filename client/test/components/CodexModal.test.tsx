/**
 * CodexModal（图鉴弹层）组件测试（jsdom）：双页签、筛选计数、角色详情二级弹层。
 * 数据直接来自 shared 定义——断言数量用导入的数组动态计算，不写死（数据增减不碎测试）。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodexModal } from '../../src/components/CodexModal';
import { BLOOD_CHARS } from '@shared/bloodChars';
import { BLOOD_MARKET_DEFS, BLOOD_MARKET_EXPANSION_DEFS } from '@shared/bloodCards';

const basicCount = BLOOD_CHARS.filter((c) => c.basic).length;
const expCharCount = BLOOD_CHARS.length - basicCount;
const allCardCount = BLOOD_MARKET_DEFS.length + BLOOD_MARKET_EXPANSION_DEFS.length;
const basicCardCount = BLOOD_MARKET_DEFS.length; // 基础数组即非拓展牌

describe('CodexModal · 图鉴弹层', () => {
  it('默认角色页签：基础+拓展全部角色可见', () => {
    const { container } = render(<CodexModal onClose={() => {}} />);
    expect(screen.getByText(`全部 ${BLOOD_CHARS.length}`)).toBeInTheDocument();
    expect(container.querySelectorAll('.codex-grid.chars .char-card')).toHaveLength(BLOOD_CHARS.length);
  });

  it('难度筛选：入门只显示 difficulty===1 的角色', async () => {
    const user = userEvent.setup();
    const { container } = render(<CodexModal onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: '★ 入门' }));
    const d1 = BLOOD_CHARS.filter((c) => c.difficulty === 1).length;
    expect(container.querySelectorAll('.codex-grid.chars .char-card')).toHaveLength(d1);
  });

  it('切到黑市页签：基础+拓展全量；「仅基础」过滤拓展牌', async () => {
    const user = userEvent.setup();
    const { container } = render(<CodexModal onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: '黑市图鉴' }));
    expect(container.querySelectorAll('.codex-grid.cards .codex-card')).toHaveLength(allCardCount);
    await user.click(screen.getByRole('button', { name: '含拓展 ✓' })); // 点击后翻转为「仅基础」
    expect(container.querySelectorAll('.codex-grid.cards .codex-card')).toHaveLength(basicCardCount);
  });

  it('角色池页签筛选：基础/拓展计数与数据一致', async () => {
    const user = userEvent.setup();
    const { container } = render(<CodexModal onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: `基础 ${basicCount}` }));
    expect(container.querySelectorAll('.codex-grid.chars .char-card')).toHaveLength(basicCount);
    await user.click(screen.getByRole('button', { name: `拓展 ${expCharCount}` }));
    expect(container.querySelectorAll('.codex-grid.chars .char-card')).toHaveLength(expCharCount);
  });

  it('点击角色卡打开详情弹层，点遮罩关闭', async () => {
    const user = userEvent.setup();
    render(<CodexModal onClose={() => {}} />);
    expect(document.querySelector('.char-detail')).toBeNull();
    await user.click(screen.getAllByText(BLOOD_CHARS[0]!.name)[0]!);
    const detail = document.querySelector('.char-detail');
    expect(detail).not.toBeNull();
    // 点遮罩（overlay 本体，panel 已 stopPropagation）关闭；fireEvent 包 act 保证状态刷新
    fireEvent.click(detail!);
    expect(document.querySelector('.char-detail')).toBeNull();
  });
});
