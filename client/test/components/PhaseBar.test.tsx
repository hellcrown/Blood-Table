/**
 * PhaseBar（血色阶段条）组件测试：阶段清单来自 shared 契约常量（14 阶段，gameover 仅终态不进条），
 * 渲染数量/当前高亮/已过阶段 mustache 此前只能人工看。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PhaseBar, PHASE_BAR_ITEMS } from '../../src/components/PhaseBar';
import { BLOOD_PHASES, BLOOD_PHASE_LABELS } from '@shared/bloodConstants';

describe('PhaseBar · 血色阶段条', () => {
  it('清单与 shared 契约一致：14 阶段去掉 gameover，顺序保留', () => {
    expect(BLOOD_PHASES).toHaveLength(14);
    expect(PHASE_BAR_ITEMS.map((p) => p.key)).toEqual(BLOOD_PHASES.filter((k) => k !== 'gameover'));
    expect(PHASE_BAR_ITEMS).toHaveLength(13);
  });

  it('渲染全部 13 个阶段；当前阶段唯一高亮（cur），之前的阶段标 done', () => {
    const { container } = render(<PhaseBar phase="buy" />);
    const steps = container.querySelectorAll('.ph-step');
    expect(steps).toHaveLength(13);
    const cur = container.querySelectorAll('.ph-step.cur');
    expect(cur).toHaveLength(1);
    expect(cur[0]!.textContent).toBe(BLOOD_PHASE_LABELS.buy);
    const buyIdx = PHASE_BAR_ITEMS.findIndex((p) => p.key === 'buy');
    container.querySelectorAll('.ph-step').forEach((el, i) => {
      if (i < buyIdx) expect(el.classList.contains('done')).toBe(true);
      if (i > buyIdx) expect(el.classList.contains('cur')).toBe(false);
    });
    // 每个阶段的中文标签都在（漏项会被契约 Record 拦住，这里再兜一道显示层）
    for (const p of PHASE_BAR_ITEMS) expect(screen.getByText(p.label)).toBeInTheDocument();
  });

  it('首阶段无 done；gameover 阶段无高亮（终态不进条）', () => {
    const first = render(<PhaseBar phase="pick" />);
    expect(first.container.querySelectorAll('.ph-step.done')).toHaveLength(0);
    expect(first.container.querySelectorAll('.ph-step.cur')).toHaveLength(1);

    const over = render(<PhaseBar phase="gameover" />);
    expect(over.container.querySelectorAll('.ph-step.cur')).toHaveLength(0);
    expect(over.container.querySelectorAll('.ph-step.done')).toHaveLength(0);
  });

  it('children（倒计时等）渲染在条内', () => {
    const { container } = render(
      <PhaseBar phase="draw">
        <b>00:59</b>
      </PhaseBar>,
    );
    expect(screen.getByText('00:59')).toBeInTheDocument();
    expect(container.querySelector('.phase-bar')).not.toBeNull();
  });
});
