import { BLOOD_MARKET_BY_ID } from '@shared/bloodCards';
import type { BloodCardView } from '@shared/bloodProtocol';
import { effRankOf } from '@shared/bloodShowdown';
import { CardView } from './Card';

// 纯逻辑（排序/核心牌/有效点数）已上移到 @shared/bloodShowdown，供服务端共用；此处重导出保持既有导入路径
export { effRankOf, sortHandByType, coreOrder } from '@shared/bloodShowdown';

/**
 * 一张牌的**最终点数**：优先用服务端下发的结果（c.effR）。
 * 本地 effRankOf 只看芯片的 def，看不到复制芯片复制到的效果快照（copiedFx）——
 * 于是"复制了校准器+2"的牌在客户端算 5、服务端算 7，会出现「点不动服务端期望的那张牌」
 * （pinpointVictim 等按点数筛选的交互）与角标显示不一致。老服务端不下发 effR 时回退本地推算。
 */
export function cardEffRank(c: BloodCardView): number {
  if (c.s == null || c.r === 0) return 0;
  return c.effR ?? effRankOf(c).r;
}

/** 原始牌面文本（如 A♠ / 🃏） */
export function cardLabel(c: BloodCardView): string {
  if (c.s == null || c.r === 0) return '🃏';
  const r = c.r === 14 ? 'A' : c.r === 13 ? 'K' : c.r === 12 ? 'Q' : c.r === 11 ? 'J' : String(c.r);
  const s = c.s === 's' ? '♠' : c.s === 'h' ? '♥' : c.s === 'd' ? '♦' : '♣';
  return `${r}${s}`;
}

/** 有效牌面文本（含芯片修正后的点数） */
export function effLabel(c: BloodCardView): string {
  if (c.s == null || c.r === 0) return '🃏';
  const r = cardEffRank(c);
  const rr = r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : String(r);
  const s = c.s === 's' ? '♠' : c.s === 'h' ? '♥' : c.s === 'd' ? '♦' : '♣';
  return `${rr}${s}`;
}

export function BCard({
  c,
  size = 'md',
  selected,
  dim,
  onClick,
}: {
  c: BloodCardView;
  size?: 'sm' | 'md' | 'lg';
  selected?: boolean;
  dim?: boolean;
  onClick?: () => void;
}) {
  const joker = c.s == null || c.r === 0;
  const mod = joker ? null : effRankOf(c).mod; // 角标（±X）本地按已知芯片推算即可
  const effRank = joker ? c.r : cardEffRank(c);
  return (
    <div
      className={`bcard-wrap ${selected ? 'sel' : ''} ${dim ? 'dim' : ''} ${onClick ? 'clickable' : ''}`}
      onClick={onClick}
      title={c.chipIds.map((id) => BLOOD_MARKET_BY_ID.get(id)?.text).join('\n')}
    >
      {joker ? (
        <div className={`pcard ${size} joker`}>
          <span className="joker-text">JOKER</span>
          <span className="joker-star">★</span>
          <span className="joker-label">王</span>
        </div>
      ) : (
        <CardView card={{ r: effRank as never, s: c.s as never }} size={size} />
      )}
      {mod !== null && mod !== 0 && (
        <span className={`mod-badge ${mod > 0 ? 'up' : 'down'}`}>
          {mod > 0 ? `+${mod}` : mod}
        </span>
      )}
      {c.chipIds.length > 0 && (
        <span className="chip-badge" title={c.chipIds.map((id) => BLOOD_MARKET_BY_ID.get(id)?.text).join('\n')}>
          片{c.chipIds.length > 1 ? c.chipIds.length : ''}
        </span>
      )}
    </div>
  );
}
