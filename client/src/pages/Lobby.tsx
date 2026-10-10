import { useEffect, useRef, useState } from 'react';
import { loadLastRoom, net, type ConnStatus } from '../net/socket';
import type { PublicRoomInfo } from '@shared/protocol';
import { AdminPanel } from '../components/AdminPanel';
import { AuthPanel } from '../components/AuthPanel';
import { CodexModal } from '../components/CodexModal';
import { FeedbackModal } from '../components/FeedbackModal';
import { LeaderboardModal } from '../components/LeaderboardModal';
import { TutorialModal } from '../components/TutorialModal';
import { ChangelogModal } from '../components/ChangelogModal';
import { ChatModal } from '../components/ChatModal';
import { SettingsModal } from '../components/SettingsModal';
import { UpdateNotice } from '../components/UpdateNotice';
import { hasUnseen, initSeenIfFirstVisit, markSeen } from '../net/version';

export function Lobby({ connected, status }: { connected: boolean; status?: ConnStatus }) {
  const [name, setName] = useState(net.loadName());
  /** 登录态：已登录时对局昵称强制为账号名（服务端口径），昵称输入框隐藏 */
  const [account, setAccount] = useState(net.account);
  /** 公开房间列表快照（null = 尚未收到过） */
  const [publicRooms, setPublicRooms] = useState<PublicRoomInfo[] | null>(null);
  const [code, setCode] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [mode, setMode] = useState<'blood' | 'classic' | 'mines'>('blood');
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
  const [chatOpen, setChatOpen] = useState(false);
  /** 聊天未读数：弹层关闭期间收到消息即累计，打开即清零（入口按钮红点） */
  const [chatUnread, setChatUnread] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qqCopied, setQqCopied] = useState(false);
  /** 有未读的更新日志内容：大厅入口显示角标 */
  const [unseenLog, setUnseenLog] = useState(() => hasUnseen());

  // 首次到访静默记下当前版本（新玩家不该看到「新版本已发布」），之后发版才会提示
  useEffect(() => {
    initSeenIfFirstVisit();
  }, []);

  // 登录/登出/他页同步：登录后隐藏昵称输入（对局昵称即账号名）
  useEffect(() => {
    return net.onAccount(setAccount);
  }, []);

  // 聊天未读：弹层关闭期间收到的消息计数；打开弹层清零
  useEffect(() => {
    if (chatOpen) {
      setChatUnread(0);
      return;
    }
    return net.onChatMsg(() => setChatUnread((n) => n + 1));
  }, [chatOpen]);

  // 公开房间列表：连接后立即拉一次 + 每 10s 轮询（onRoomList 收快照）；断开/卸载清理
  useEffect(() => {
    const fetchList = (): void => {
      if (net.status === 'open') net.send({ t: 'listRooms' });
    };
    const off = net.onRoomList(setPublicRooms);
    if (connected) fetchList();
    const timer = connected ? window.setInterval(fetchList, 10_000) : null;
    return () => {
      off();
      if (timer != null) window.clearInterval(timer);
    };
  }, [connected]);

  /** 打开更新日志：读到即消角标（点提示条的「查看更新」也走这里） */
  const openChangelog = () => {
    markSeen();
    setUnseenLog(false);
    setLogOpen(true);
  };

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

  // 昵称校验只约束匿名玩家；登录玩家的对局昵称为账号名，发送时也用它（服务端本就强制覆盖）
  const nameOk = account != null || name.trim().length > 0;
  const displayName = account?.name ?? name.trim();

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
    net.saveName(displayName);
    net.send({
      t: 'create',
      name: displayName,
      maxPlayers: mode === 'mines' ? 2 : maxPlayers, // 扫雷固定 1~2 人
      mode,
      ...(createPw.trim() ? { password: createPw.trim() } : {}),
    });
  };

  const joinMsg = (roomCode: string): { t: 'join'; name: string; code: string; password?: string } => ({
    t: 'join',
    name: displayName,
    code: roomCode,
    ...(pwForCode === roomCode && joinPw ? { password: joinPw } : {}),
  });

  const join = () => {
    net.saveName(displayName);
    net.send(joinMsg(code.trim().toUpperCase()));
  };
  const spectate = () => {
    net.saveName(displayName);
    net.send({
      t: 'spectate',
      name: displayName,
      code: code.trim().toUpperCase(),
      ...(pwForCode === code.trim().toUpperCase() && joinPw ? { password: joinPw } : {}),
    });
  };

  /** 上次房间的 join 被拒（满员：座位仍被保留中）时自动降级为观战进入，别把回房的人挡在大厅 */
  const pendingJoinRef = useRef<string | null>(null);
  useEffect(() => {
    return net.onError((code, msg) => {
      const target = pendingJoinRef.current;
      if (code !== 'ROOM_FULL' || !target) return;
      pendingJoinRef.current = null;
      void msg;
      net.saveName(displayName);
      net.send({ t: 'spectate', name: displayName, code: target });
    });
    // displayName 变化极少；订阅一次即可，处理时读最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 公开房间列表点击：预填房间码并直接加入（对局中转观战、已结束仅预填）。
   *  匿名未填昵称/未连接时只预填（与加入按钮 disabled 口径一致）。 */
  const openPublicRoom = (r: PublicRoomInfo): void => {
    setCode(r.code);
    setPwForCode(null);
    if (!nameOk || !connected) return;
    if (r.phase === 'gameover') return;
    net.saveName(displayName);
    // 对局中的「上次房间」走加入而非观战：以玩家身份回到座位（血色坐等下一局、
    // 扫雷坐等下一轮），否则重进自己的房间只能观战干等
    if (r.phase === 'waiting' || lastRoom?.code === r.code) {
      pendingJoinRef.current = r.code; // 满员被拒时降级观战（见 onError 订阅）
      net.send(joinMsg(r.code));
    } else {
      net.send({
        t: 'spectate',
        name: displayName,
        code: r.code,
      });
    }
  };

  /** ⚡ 回到上次房间：填码并直接加入（昵称为空时仅填码） */
  const rejoinLast = () => {
    if (!lastRoom) return;
    setCode(lastRoom.code);
    if (!nameOk || !connected) return;
    net.saveName(displayName);
    pendingJoinRef.current = lastRoom.code; // 满员被拒时降级观战
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

        {account ? (
          <div className="field acct-name">
            <span>对局昵称</span>
            <b>👤 {account.name}</b>
            <span className="hint">已登录：对局昵称即账号名（排行榜/战绩按此归属），如需改名可重新注册新账号</span>
          </div>
        ) : (
          <label className="field">
            <span>你的昵称</span>
            <input
              value={name}
              maxLength={12}
              placeholder="给自己起个名字"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}

        <div className="lobby-actions">
          <div className="create-box">
            <div className="box-title">创建房间</div>
            <div className="row">
              <select value={mode} onChange={(e) => setMode(e.target.value as 'blood' | 'classic' | 'mines')}>
                <option value="blood">血色牌局（卡片对决）</option>
                <option value="classic">经典德州扑克</option>
                <option value="mines">扫雷竞速</option>
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
              {mode === 'mines' ? (
                <span className="hint" style={{ alignSelf: 'center' }}>1~2 人竞速（各自独立棋盘）</span>
              ) : (
                <select value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))}>
                  <option value={2}>2 人局</option>
                  <option value={3}>3 人局</option>
                  <option value={4}>4 人局</option>
                </select>
              )}
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
                  if (e.key === 'Enter' && nameOk && code.length === 4 && connected) join();
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
                    if (e.key === 'Enter' && nameOk && joinPw && connected) join();
                  }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="lobby-rooms">
          <div className="box-title room-list-head">
            <span>公开房间</span>
            <span className="spacer" />
            <button
              className="btn tiny ghost"
              disabled={!connected}
              title="刷新列表（每 10 秒也会自动刷新）"
              onClick={() => net.send({ t: 'listRooms' })}
            >
              🔄
            </button>
          </div>
          {publicRooms == null ? (
            <p className="hint">{connected ? '正在获取房间列表…' : '连接服务器后显示公开房间'}</p>
          ) : publicRooms.length === 0 ? (
            <p className="hint">暂无公开房间 —— 创建一个，把房间码发给朋友吧</p>
          ) : (
            <div className="room-rows">
              {publicRooms.map((r) => {
                const status =
                  r.phase === 'waiting'
                    ? { label: '等待中', cls: 'st-wait' }
                    : r.phase === 'gameover'
                      ? { label: '已结束', cls: 'st-over' }
                      : { label: '对局中', cls: 'st-live' };
                return (
                  <button
                    key={r.code}
                    className="room-row"
                    onClick={() => openPublicRoom(r)}
                    title={
                      r.phase === 'waiting'
                        ? '加入该房间'
                        : r.phase === 'gameover'
                          ? '对局已结束（房主可重开）'
                          : '对局进行中：以观战身份进入，点击空座位可随时加入'
                    }
                  >
                    <b className="room-code">{r.code}</b>
                    <span className="room-mode">{r.mode === 'blood' ? '血色牌局' : r.mode === 'mines' ? '扫雷竞速' : '经典德扑'}</span>
                    <span className={`tag room-st ${status.cls}`}>{status.label}</span>
                    <span className="room-players">
                      {r.players}/{r.maxPlayers} 人
                    </span>
                    <span className="spacer" />
                    <span className="room-host">{r.host ? `房主 ${r.host}` : ''}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {!connected &&
          (status === 'replaced' ? (
            // 被顶号（同 token 的第二条连接出现）后本窗口永不重连：此前只显示「正在连接服务器…」，
            // 而按钮全是 disabled —— 玩家看到一个永远转圈的死页，只能自己想到刷新
            <p className="hint">
              本房间已在其他窗口打开，此窗口已断开。{' '}
              <button className="btn small primary" onClick={() => net.reconnectFresh()}>
                重新连接
              </button>
            </p>
          ) : (
            <p className="hint">正在连接服务器…</p>
          ))}

        <UpdateNotice
          unseen={unseenLog}
          onOpenChangelog={openChangelog}
          onDismissUnseen={() => {
            markSeen();
            setUnseenLog(false);
          }}
        />

        <div className="lobby-links">
          <button className="btn small ghost chat-entry" onClick={() => setChatOpen(true)} title="全服聊天：所有在线玩家可见">
            💬 聊天
            {chatUnread > 0 && <span className="chat-dot">{chatUnread > 9 ? '9+' : chatUnread}</span>}
          </button>
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
          <button className="btn small ghost" onClick={openChangelog}>
            📜 更新日志
            {unseenLog && <span className="new-dot">新</span>}
          </button>
        </div>

        <div className="rules-hint">
          <div className="box-title">玩法速览</div>
          <ul>
            <li>血色牌局：每人一副 54 张牌，暗扣 5 张同时亮牌比牌型，黑市购芯片强化手牌，集齐目标车票获胜</li>
            <li>选将后特权证暗标：每人秘密出价 0~3（0=不参与；少拿几血筹换先手特权证），最高者得证、开局血筹 = 3 − 出价</li>
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
        <FeedbackModal onClose={() => setFeedbackOpen(false)} playerName={displayName || undefined} />
      )}
      {chatOpen && <ChatModal onClose={() => setChatOpen(false)} />}
      {codexOpen && <CodexModal onClose={() => setCodexOpen(false)} />}
      {boardOpen && <LeaderboardModal onClose={() => setBoardOpen(false)} />}
      {tutorialOpen && <TutorialModal onClose={() => setTutorialOpen(false)} />}
      {logOpen && <ChangelogModal onClose={() => setLogOpen(false)} />}
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
    </div>
  );
}
