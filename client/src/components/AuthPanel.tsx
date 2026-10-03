import { useEffect, useState } from 'react';
import { net, type AccountInfo } from '../net/socket';
import { MyStatsModal } from './MyStatsModal';

interface MeData {
  account: AccountInfo;
  ladder: { points: number; wins: number };
}

/**
 * 大厅账号面板：注册 / 登录 / 已登录态展示（昵称 + 天梯积分 + 个人战绩 + 退出）。
 * 不登录完全不影响游玩（匿名即玩）；登录后入房自动携带令牌，战绩与天梯积分按账号归属。
 */
export function AuthPanel() {
  const [account, setAccount] = useState<AccountInfo | null>(net.account);
  const [me, setMe] = useState<MeData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(net.loadName());
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statsOpen, setStatsOpen] = useState(false);

  const refreshMe = (token: string | null) => {
    if (!token) {
      setMe(null);
      return;
    }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        // 仅 401（令牌确已过期/失效）才登出：网络抖动 / 5xx（如部署重启瞬间）不清令牌，避免用户被无声登出
        if (r.status === 401) {
          net.clearAuthToken();
          setMe(null);
          return;
        }
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<MeData & { ok: boolean }>;
      })
      .then((d) => {
        if (!d) return; // 401 分支已处理
        if (net.authToken !== token) return; // 响应期间已登出/换号：丢弃过期响应，防复活假登录态
        setMe(d);
        net.setAccount(d.account);
        net.saveName(d.account.name); // 房内强制显示账号名：本地昵称以服务端为准，避免预填值与实际显示不一致
      })
      .catch(() => {
        // 网络异常/服务端错误：保留令牌，仅不展示积分（下个生命周期或 storage 事件会重试）
        setMe(null);
      });
  };

  useEffect(() => {
    refreshMe(net.authToken);
    // 其他标签页登录/登出（localStorage blood.auth 变化）时同步本页登录态
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'blood.auth' || e.key === null) refreshMe(net.authToken);
    };
    window.addEventListener('storage', onStorage);
    const offAccount = net.onAccount(setAccount);
    return () => {
      window.removeEventListener('storage', onStorage);
      offAccount();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (kind: 'register' | 'login') => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const r = await fetch(`/api/auth/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), password: pw }),
      });
      const d = (await r.json()) as { ok: boolean; msg?: string; token?: string };
      if (!d.ok || !d.token) {
        setError(d.msg ?? '操作失败，请稍后再试');
        return;
      }
      net.saveAuthToken(d.token);
      net.saveName(name.trim());
      setPw('');
      setExpanded(false);
      refreshMe(d.token);
    } catch {
      setError('网络异常，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    // 先通知服务端吊销令牌（黑名单落盘）：公共电脑上「退出」必须真正失效，而非仅清本机存储。
    // fire-and-forget：网络失败也不阻塞本地登出（令牌最迟 30 天自然过期）
    const token = net.authToken;
    if (token) {
      void fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => {
        /* 网络异常：本地照常登出 */
      });
    }
    net.clearAuthToken();
    setMe(null);
    setExpanded(false);
  };

  if (account) {
    return (
      <div className="auth-box logged">
        <span className="auth-chip" title="登录后赢真人局可累积天梯积分">
          👤 <b>{account.name}</b>
          {me && (
            <span className="auth-pts">
              ⭐ {me.ladder.points} 分 · {me.ladder.wins} 胜
            </span>
          )}
        </span>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => setStatsOpen(true)}>
          📊 个人战绩
        </button>
        <button className="btn small ghost" onClick={logout} title="退出后回到匿名游玩，战绩与积分保留在账号上">
          退出
        </button>
        {statsOpen && <MyStatsModal onClose={() => setStatsOpen(false)} />}
      </div>
    );
  }

  if (!expanded) {
    return (
      <div className="auth-box">
        <span className="auth-chip">当前：匿名游玩</span>
        <span className="spacer" />
        <button
          className="btn small primary"
          onClick={() => {
            setExpanded(true);
            setError('');
          }}
        >
          注册 / 登录
        </button>
      </div>
    );
  }

  return (
    <div className="auth-box expanded">
      <div className="auth-form">
        <input
          value={name}
          maxLength={12}
          placeholder="昵称（2-12 字）"
          onChange={(e) => setName(e.target.value)}
        />
        <input
          value={pw}
          maxLength={32}
          placeholder="密码（6-32 位）"
          type="password"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim() && pw) void submit('login');
          }}
        />
      </div>
      <div className="auth-form">
        <button className="btn small primary" disabled={busy || name.trim().length < 2 || pw.length < 6} onClick={() => void submit('register')}>
          注册新账号
        </button>
        <button className="btn small" disabled={busy || !name.trim() || !pw} onClick={() => void submit('login')}>
          登录
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            setExpanded(false);
            setError('');
          }}
        >
          收起
        </button>
      </div>
      {error && <p className="auth-error">{error}</p>}
      <p className="auth-hint">匿名可直接玩，无需注册；注册后赢真人局累积天梯积分（对手全机器人不计分）。</p>
    </div>
  );
}
