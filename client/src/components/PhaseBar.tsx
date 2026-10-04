import type { ReactNode } from 'react';
import { BLOOD_PHASES, BLOOD_PHASE_LABELS } from '@shared/bloodConstants';
import type { BloodView } from '@shared/bloodProtocol';

/**
 * 血色阶段条。阶段清单与标签来自 shared 契约常量（单一数据源：服务端类型/视图协议/管理端共用，
 * 缺项由 Record 类型在编译期拦下）；gameover 仅作终态，不进阶段条。
 * 从 BloodTable 抽出：该处此前「只能人肉看」的 14 阶段渲染与当前阶段高亮，现在可直接组件测试。
 */
export const PHASE_BAR_ITEMS: { key: BloodView['phase']; label: string }[] = BLOOD_PHASES.filter(
  (k) => k !== 'gameover',
).map((k) => ({ key: k, label: BLOOD_PHASE_LABELS[k] }));

export function PhaseBar({ phase, children }: { phase: BloodView['phase']; children?: ReactNode }) {
  const idx = PHASE_BAR_ITEMS.findIndex((p) => p.key === phase);
  return (
    <div className="phase-bar">
      {PHASE_BAR_ITEMS.map((p, i) => (
        <span key={p.key} className={`ph-step ${i === idx ? 'cur' : i < idx ? 'done' : ''}`}>
          {p.label}
        </span>
      ))}
      <span className="spacer" />
      {children}
    </div>
  );
}
