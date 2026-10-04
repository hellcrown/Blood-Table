/**
 * 批次 D 回归测试：契约常量与文案的「单一事实来源」。
 *
 * 背景（都是本轮真实踩到的坑）：
 * 1. 阶段清单/时限原先在服务端类型、视图协议、客户端阶段条、管理端列表里**各抄一份**：
 *    管理端那张表漏了 crownBid/swapItem/revealPre，对局列表会直接显示英文相位名，
 *    而客户端阶段条漏项只是"某阶段一个都不高亮"——两边都不会报错。
 * 2. 收进 shared 后仍有两个隐性坑，本文件把它们钉住：
 *    - `export type { X } from '...'` **不会**把名字绑进本文件作用域。写成这样会让
 *      `BloodState.phase` 退化成未解析类型，进而让 rooms.ts 里的可辨识联合收窄失效，
 *      在完全无关的 startHand 调用处报错（错误信息不指向根因，极易被误改到别处）。
 *    - 时限字面量（60000/30000）在客户端重新出现时不会报错，只会让倒计时条与真实时限静默失配。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BLOOD_PHASE_LABELS,
  BLOOD_PHASES,
  BLOOD_SD_WAIT_MS,
  BLOOD_SETUP_KEEP,
  BLOOD_TURN_MS,
  CLASSIC_PHASE_LABELS,
  RESULT_MS,
  TURN_MS,
} from '@shared/bloodConstants';
import { BLOOD_TURN_MS as T_BLOOD_TURN, BLOOD_SD_WAIT_MS as T_BLOOD_SD, BLOOD_SETUP_KEEP as T_KEEP } from '../src/blood/types';
import { TURN_MS as T_TURN, RESULT_MS as T_RESULT } from '../src/game/types';

const ROOT = path.resolve(process.cwd(), '..');
const CLIENT_SRC = path.join(ROOT, 'client', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('批次 D · 血色阶段清单与标签', () => {
  it('阶段清单无重复，且标签表恰好覆盖全部阶段（不多不少）', () => {
    expect(new Set(BLOOD_PHASES).size).toBe(BLOOD_PHASES.length);
    expect(Object.keys(BLOOD_PHASE_LABELS).sort()).toEqual([...BLOOD_PHASES].sort());
  });

  it('每个阶段都有非空中文名（缺项会让界面显示英文相位名）', () => {
    for (const k of BLOOD_PHASES) {
      expect(BLOOD_PHASE_LABELS[k], `阶段 ${k} 缺少中文名`).toBeTruthy();
      expect(BLOOD_PHASE_LABELS[k]).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('阶段条不展示终态 gameover（它不属于"进行中的阶段"）', () => {
    expect(BLOOD_PHASES).toContain('gameover');
    expect(BLOOD_PHASES.filter((k) => k !== 'gameover')).toHaveLength(13);
  });

  it('经典德扑阶段标签覆盖全部 7 个相位且都非空', () => {
    expect(Object.keys(CLASSIC_PHASE_LABELS).sort()).toEqual(
      ['flop', 'gameover', 'preflop', 'result', 'river', 'turn', 'waiting'].sort(),
    );
    for (const v of Object.values(CLASSIC_PHASE_LABELS)) expect(v).toBeTruthy();
  });
});

describe('批次 D · 服务端重导出必须与 shared 是同一份值', () => {
  it('血色时限/构筑上限重导出一致', () => {
    expect(T_BLOOD_TURN).toBe(BLOOD_TURN_MS);
    expect(T_BLOOD_SD).toBe(BLOOD_SD_WAIT_MS);
    expect(T_KEEP).toBe(BLOOD_SETUP_KEEP);
  });

  it('经典时限重导出一致（对局逻辑与客户端倒计时同源）', () => {
    expect(T_TURN).toBe(TURN_MS);
    expect(T_RESULT).toBe(RESULT_MS);
  });

  it('时限取值符合设计：行动 60s、摊牌展示等待 30s、结算展示 6s、每轮删牌上限 4', () => {
    expect([TURN_MS, BLOOD_TURN_MS]).toEqual([60_000, 60_000]);
    expect(BLOOD_SD_WAIT_MS).toBe(30_000);
    expect(RESULT_MS).toBe(6_000);
    expect(BLOOD_SETUP_KEEP).toBe(4);
  });
});

describe('批次 D · 客户端不得重新抄一份', () => {
  const files = walk(CLIENT_SRC);

  it('扫描到客户端源码（防止目录结构变化导致下面的断言空转）', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('客户端源码不出现时限字面量：必须从 @shared/bloodConstants 取', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((ln, i) => {
        // 允许注释里出现，只看实际代码（去掉行内的 // 之后部分过于脆弱，改用整行判断）
        if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
        if (/\b(60_000|60000|30_000|30000|6_000|6000)\b/.test(ln)) {
          bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${ln.trim()}`);
        }
      });
    }
    expect(bad, '客户端出现时限字面量，会与服务端静默失配').toEqual([]);
  });

  it('管理端阶段中文名来自 shared 的两张表，而不是手抄一份', () => {
    const src = readFileSync(path.join(CLIENT_SRC, 'components', 'AdminPanel.tsx'), 'utf8');
    expect(src).toContain('...CLASSIC_PHASE_LABELS');
    expect(src).toContain('...BLOOD_PHASE_LABELS');
  });

  it('血色阶段条由 BLOOD_PHASES 派生（漏阶段不再是"静默不高亮"）', () => {
    // 派生已抽到独立组件 PhaseBar（BloodTable 引用之），守卫随之指向真实数据源
    const bar = readFileSync(path.join(CLIENT_SRC, 'components', 'PhaseBar.tsx'), 'utf8');
    expect(bar).toContain('BLOOD_PHASES');
    expect(bar).toContain('BLOOD_PHASE_LABELS');
    expect(bar).toContain("k !== 'gameover'"); // 终态不进阶段条
    const table = readFileSync(path.join(CLIENT_SRC, 'pages', 'BloodTable.tsx'), 'utf8');
    expect(table).toContain('PhaseBar'); // 页面仍渲染阶段条，而非重新抄一份
  });
});

/**
 * 部署卫生：线上仓库是 `receive.denyCurrentBranch=updateInstead` 的部署目标 ——
 * 部署脚本一旦改动**被跟踪的文件**，工作区就脏了，此后所有改到该文件的推送都会被拒，
 * 而报错只有 "Entry 'xxx' not uptodate. Cannot merge."（不指向根因；若再被 skip-worktree
 * 位掩盖，服务器上连 git status 都显示干净）。本轮就是这么卡住的：deploy.sh 用 npm install
 * 重写了 package-lock.json。故把「不许在部署路径上重写 lock」钉成测试。
 */
describe('批次 D · 部署脚本不得改脏部署工作区', () => {
  const deploy = readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  const bloodtable = readFileSync(path.join(ROOT, 'bin', 'bloodtable'), 'utf8');

  it('deploy.sh 用 npm ci 安装依赖，而不是 npm install（后者会重写 package-lock.json）', () => {
    expect(deploy).toContain('npm ci');
    expect(deploy).not.toMatch(/^\s*npm install\b/m);
  });

  it('deploy.sh 在安装后断言 lock 未被改动（有工具绕过 npm ci 时的兜底告警）', () => {
    expect(deploy).toContain('git diff --quiet -- package-lock.json');
  });

  it('bloodtable 提供 doctor 自检（脏工作区 / skip-worktree 标记 / 进程状态）', () => {
    expect(bloodtable).toContain('doctor)');
    expect(bloodtable).toContain('no-skip-worktree');
    expect(bloodtable).toMatch(/ls-files -t \| grep '\^S'/);
  });
});
