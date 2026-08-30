import type { Card } from '@shared/protocol';

const SUIT_CHAR: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK_TEXT: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function CardView({
  card,
  faceDown,
  size = 'md',
}: {
  card?: Card;
  faceDown?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}) {
  if (faceDown || !card) return <div className={`pcard back ${size}`} aria-label="暗牌" />;
  const red = card.s === 'h' || card.s === 'd';
  return (
    <div className={`pcard ${size} ${red ? 'red' : 'black'}`}>
      <span className="pc-rank">{RANK_TEXT[card.r] ?? card.r}</span>
      <span className="pc-suit">{SUIT_CHAR[card.s]}</span>
    </div>
  );
}
