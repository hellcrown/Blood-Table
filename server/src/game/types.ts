import type { Card, GameOverView, HandResultView, LogLine, Phase, RoomSettings } from '@shared/protocol';

/** 单次行动时限 */
export const TURN_MS = 60_000;
/** 结算展示后自动进入下一手 */
export const RESULT_MS = 6_000;

export class GameError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

export interface GPlayer {
  id: string;
  name: string;
  seat: number;
  chips: number;
  hole: Card[];
  /** 是否参与本手（有筹码即参与） */
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  /** 本轮街内是否已行动（自最近一次完整加注后） */
  acted: boolean;
  /** 本轮街已投入 */
  bet: number;
  /** 本手总投入 */
  committed: number;
  lastAction: string | null;
  won: number;
  handScore: number;
  handName: string | null;
}

export interface GState {
  phase: Phase;
  handNumber: number;
  deck: Card[];
  community: Card[];
  /** 按 seat 升序 */
  players: GPlayer[];
  seatCount: number;
  buttonSeat: number;
  sbSeat: number | null;
  bbSeat: number | null;
  settings: RoomSettings;
  currentBet: number;
  /** 最近一次完整下注/加注的幅度（最小加注增量） */
  minRaise: number;
  /** 本街是否存在不足最小加注的全下（此时已行动者不能再加注） */
  shortAllIn: boolean;
  toActSeat: number | null;
  deadline: number | null;
  log: LogLine[];
  logSeq: number;
  result: HandResultView | null;
  resultAt: number | null;
  final: GameOverView | null;
}
