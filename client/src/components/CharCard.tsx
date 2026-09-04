import { BLOOD_CHAR_BY_ID, type BloodCharDef } from '@shared/bloodChars';

/** 实装状态徽标文案 */
function implLabel(def: BloodCharDef): string | null {
  if (def.impl === 'full') return '已实装';
  if (def.impl === 'partial') return '部分实装';
  return null;
}

/** 角色立绘卡（当前以 emoji + 主题渐变呈现，后续可替换为手绘立绘） */
export function CharPortrait({
  def,
  size = 'md',
  onClick,
}: {
  def: BloodCharDef;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
}) {
  const impl = implLabel(def);
  return (
    <div
      className={`char-card ${size} ${onClick ? 'clickable' : ''}`}
      style={{ '--hue': def.hue } as React.CSSProperties}
      onClick={onClick}
    >
      <div className="char-frame">
        <span className="char-art">{def.emoji}</span>
      </div>
      <div className="char-plate">
        <b>{def.name}</b>
        {def.tags.length > 0 && <span className="char-tags">{def.tags.join(' · ')}</span>}
      </div>
      {impl && <span className={`char-impl ${def.impl}`}>{impl}</span>}
    </div>
  );
}

/** 角色技能详情弹层（选将确认 / 座位徽章查看共用） */
export function CharDetail({
  charId,
  pickable,
  onPick,
  onClose,
}: {
  charId: string;
  pickable?: boolean;
  onPick?: () => void;
  onClose: () => void;
}) {
  const def = BLOOD_CHAR_BY_ID.get(charId);
  if (!def) return null;
  const impl = implLabel(def);
  return (
    <div className="overlay char-detail" onClick={onClose}>
      <div className="panel char-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="char-detail-side">
          <CharPortrait def={def} size="lg" />
        </div>
        <div className="char-detail-body">
          <h3>
            {def.emoji} {def.name}
            {impl && <span className={`char-impl ${def.impl}`}>{impl}</span>}
          </h3>
          <div className="char-tags-line">{def.tags.map((t) => `【${t}】`).join(' ') || '【常驻】'}</div>
          <p className="char-skill-text">{def.text}</p>
          {def.implNote && <p className="char-impl-note">⚙️ {def.implNote}</p>}
          {def.impl === 'todo' && (
            <p className="char-impl-note todo">
              ⚙️ 该角色的技能需要玩家间自由互动（谈判、质疑、指定目标等），暂未接入自动结算；
              拓展选将开启时仍可能抽到，请按卡面文本与同桌协商执行
            </p>
          )}
          <div className="char-detail-actions">
            {pickable && onPick && (
              <button className="btn primary" onClick={onPick}>
                选择【{def.name}】
              </button>
            )}
            <button className="btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
