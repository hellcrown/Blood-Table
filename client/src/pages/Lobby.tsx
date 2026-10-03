import { useEffect, useState } from 'react';
import { loadLastRoom, net } from '../net/socket';
import { AdminPanel } from '../components/AdminPanel';
import { AuthPanel } from '../components/AuthPanel';
import { CodexModal } from '../components/CodexModal';
import { FeedbackModal } from '../components/FeedbackModal';
import { LeaderboardModal } from '../components/LeaderboardModal';
import { TutorialModal } from '../components/TutorialModal';
import { ChangelogModal } from '../components/ChangelogModal';
import { SettingsModal } from '../components/SettingsModal';

export function Lobby({ connected }: { connected: boolean }) {
  const [name, setName] = useState(net.loadName());
  const [code, setCode] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [mode, setMode] = useState<'blood' | 'classic'>('blood');
  const [createPw, setCreatePw] = useState('');
  const [joinPw, setJoinPw] = useState('');
  const [pwForCode, setPwForCode] = useState<string | null>(null);
  const [lastRoom, setLastRoom] = useState(loadLastRoom());
  const [adminOpen, setAdminOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [codexOpen, setCodexOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qqCopied, setQqCopied] = useState(false);

  /** 复制 QQ 群号到剪贴板（https 下可用；失败时按钮文本本身仍展示群号） */
  const copyQqGroup = async () => {
    try {
      await navigator.clipboard.writeText('730193109');
      setQqCopied(true);
      window.setTimeout(() => setQqCopied(false), 1600);
    } catch {
      /* 剪贴板不可用：忽略，群号已展示在按钮上 */
    }
  };

  const nameOk = name.trim().length > 0;

  /** 粘贴识别：支持直接粘贴邀请文本（网址 — 血色牌局房间码：XXXX），自动提取房间码 */
  const applyCode = (raw: string): void => {
    const m =
      /房间码\s*[：:]\s*([A-Z0-9]{4})/i.exec(raw) ??
      /[?&]room=([A-Za-z0-9]{4})/i.exec(raw) ??
      /\/([A-Z0-9]{4})\/?\s*$/.exec(raw.trim());
    if (m) {
      setCode(m[1].toUpperCase());
      return;
    }
    setCode(raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4));
  };

  // 深链支持：?room=CODE 或 /CODE 直接预填房间码
  useEffect(() => {
    const m = /[?&]room=([A-Za-z0-9]{4})/.exec(location.search) ?? /^\/([A-Za-z0-9]{4})\/?$/.exec(location.pathname);
    if (m) setCode(m[1].toUpperCase());
  }, []);

  // 加入带密码房间：服务端返回 WRONG_PASSWORD 后展开密码输入
  useEffect(() => {
    return net.onError((errorCode) => {
      if (errorCode === 'WRONG_PASSWORD' && code.length === 4) setPwForCode(code);
    });
  }, [code]);

  const create = () => {
    net.saveName(name.trim());
    net.send({
      t: 'create',
      name: name.trim(),
      maxPlayers,
      mode,
      ...(createPw.trim() ? { password: createPw.trim() } : {}),
    });
  };

  const joinMsg = (roomCode: string): { t: 'join'; name: string; code: string; password?: string } => ({
    t: 'join',
    name: name.trim(),
    code: roomCode,
    ...(pwForCode === roomCode && joinPw ? { password: joinPw } : {}),
  });

  const join = () => {
    net.saveName(name.trim());
    net.send(joinMsg(code.trim().toUpperCase()));
  };
  const spectate = () => {
    net.saveName(name.trim());
    net.send({
      t: 'spectate',
      name: name.trim(),
      code: code.trim().toUpperCase(),
      ...(pwForCode === code.trim().toUpperCase() && joinPw ? { password: joinPw } : {}),
    });
  };

  /** ⚡ 回到上次房间：填码并直接加入（昵称为空时仅填码） */
  const rejoinLast = () => {
    if (!lastRoom) return;
    setCode(lastRoom.code);
    if (!nameOk || !connected) return;
    net.saveName(name.trim());
    net.send(joinMsg(lastRoom.code));
  };

  return (
    <div className="lobby">
      <div className="lobby-card">
        <h1 className="title">
          血色牌局
          <small>德州扑克联机</small>
        </h1>
        <p className="subtitle">2-4 人 · 建房后把房间码告诉朋友即可开局</p>
        <p className="subtitle dim">支持匿名即玩（无需注册）· 注册登录后赢真人局可累积天梯积分上榜</p>

        <AuthPanel />

        {lastRoom && (
          <div className="rejoin-banner">
            <span>
              上次房间 <b>{lastRoom.code}</b>
            </span>
            <span className="spacer" />
            <button className="btn small primary" disabled={!nameOk || !connected} onClick={rejoinLast}>
              ⚡ 回到房间
            </button>
            <button
              className="btn small ghost"
              title="不再提示"
              onClick={() => {
                net.forgetLastRoom();
                setLastRoom(null);
              }}
            >
              ×
            </button>
          </div>
        )}

        <label className="field">
          <span>你的昵称</span>
          <input
            value={name}
            maxLength={12}
            placeholder="给自己起个名字"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="lobby-actions">
          <div className="create-box">
            <div className="box-title">创建房间</div>
            <div className="row">
              <select value={mode} onChange={(e) => setMode(e.target.value as 'blood' | 'classic')}>
                <option value="blood">血色牌局（卡片对决）</option>
                <option value="classic">经典德州扑克</option>
              </select>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <input
                value={createPw}
                maxLength={12}
                placeholder="密码（可选）"
                title="设置后朋友加入时需输入密码；留空为公开房间"
                onChange={(e) => setCreatePw(e.target.value)}
              />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <select value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))}>
                <option value={2}>2 人局</option>
                <option value={3}>3 人局</option>
                <option value={4}>4 人局</option>
              </select>
              <button className="btn primary" disabled={!nameOk || !connected} onClick={create}>
                创建
              </button>
            </div>
          </div>

          <div className="join-box">
            <div className="box-title">加入房间</div>
            <div className="row">
              <input
                className="code-input"
                value={code}
                maxLength={64}
                placeholder="房间码（可粘贴邀请文本）"
                onChange={(e) => applyCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameOk && code.length === 4) join();
                }}
              />
              <button className="btn" disabled={!nameOk || code.length !== 4 || !connected} onClick={join}>
                加入
              </button>
              <button
                className="btn"
                disabled={!nameOk || code.length !== 4 || !connected}
                title="进入房间观看对局，不参与游戏；点击空座位可随时加入"
                onClick={spectate}
              >
                观战
              </button>
            </div>
            {pwForCode === code.trim().toUpperCase() && (
              <div className="row" style={{ marginTop: 10 }}>
                <input
                  value={joinPw}
                  maxLength={12}
                  placeholder="房间密码"
                  type="password"
                  onChange={(e) => setJoinPw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && nameOk && joinPw) join();
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {!connected && <p className="hint">正在连接服务器…</p>}

        <div className="lobby-links">
          <button className="btn small primary" onClick={() => setTutorialOpen(true)}>
            📚 教程
          </button>
          <button className="btn small ghost" onClick={() => setCodexOpen(true)}>
            📖 图鉴
          </button>
          <button className="btn small ghost" onClick={() => setBoardOpen(true)}>
            🏆 排行榜
          </button>
          <button
            className="btn small ghost"
            title="点击复制群号，加入 QQ 交流群"
            onClick={() => void copyQqGroup()}
          >
            {qqCopied ? '✓ 已复制群号' : '💬 QQ交流群 730193109'}
          </button>
          <button className="btn small ghost" onClick={() => setFeedbackOpen(true)}>
            📨 反馈
          </button>
          <button className="btn small ghost" onClick={() => setLogOpen(true)}>
            📜 更新日志
          </button>
        </div>

        <div className="rules-hint">
          <div className="box-title">玩法速览</div>
          <ul>
            <li>血色牌局：每人一副 54 张牌，暗扣 5 张同时亮牌比牌型，黑市购芯片强化手牌，集齐目标车票获胜</li>
            <li>开局特权证暗标：每人秘密出价 0~3（0=不参与；少拿几血筹换先手特权证），最高者得证、开局血筹 = 3 − 出价</li>
            <li>经典德州扑克：两张底牌 + 五张公共牌组成最佳牌型，筹码打光即出局</li>
            <li>每回合名次奖励：第1名 +4🎫、第2名 +2🎫+2🩸（2人局 +4🩸）、第3名 +1🎫+3🩸（4人局）、末位 +4🩸；2人局：首胜 +1🎫、连胜再 +1🎫</li>
            <li>所有阶段 60 秒超时托管，断线重连自动恢复座位与手牌</li>
            <li>支持 2/3/4 人局（血色模式 2 人目标 24 车票、3 人 20、4 人 16）；拓展选将开启时 3/4 人局同样抽 2 选 1</li>
          </ul>
        </div>
        <p className="beian">
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
            鄂ICP备2026054300号
          </a>
        </p>
      </div>
      <button className="admin-link" onClick={() => setAdminOpen(true)}>
        管理员
      </button>
      <button className="admin-link" style={{ bottom: 'calc(42px + var(--sab))' }} onClick={() => setSettingsOpen(true)}>
        ⚙ 音量
      </button>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {feedbackOpen && (
        <FeedbackModal onClose={() => setFeedbackOpen(false)} playerName={name.trim() || undefined} />
      )}
      {codexOpen && <CodexModal onClose={() => setCodexOpen(false)} />}
      {boardOpen && <LeaderboardModal onClose={() => setBoardOpen(false)} />}
      {tutorialOpen && <TutorialModal onClose={() => setTutorialOpen(false)} />}
      {logOpen && <ChangelogModal onClose={() => setLogOpen(false)} />}
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
    </div>
  );
}
