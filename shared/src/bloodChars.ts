/**
 * 血色牌局 · 角色牌定义（58 张，技能文本严格按卡面录入）
 * - impl: full = 技能已完整自动化；partial = 部分自动化（见 implNote）；todo = 暂未自动化（技能文本展示，实际效果待后续实装）
 * - 立绘当前以 emoji + 渐变主题色呈现，后续可替换为手绘立绘图片（替换 CharCard 组件的 art 渲染即可）
 */
import { ALL_RANKS, ALL_SUITS, type EvalCard } from './bloodEval';

export interface BloodCharDef {
  id: string;
  name: string;
  /** 技能原文 */
  text: string;
  /** 技能生效阶段标签（展示用） */
  tags: string[];
  /** 立绘主图案 */
  emoji: string;
  /** 立绘渐变色相（0-360） */
  hue: number;
  impl: 'full' | 'partial' | 'todo';
  /** 实装说明（partial 时解释自动化范围） */
  implNote?: string;
  /** 基础版角色（编号 1~4）；未标记的为拓展版角色 */
  basic?: true;
  /** 性别（魅魔结算用）；未标注视为无性别（同时视为男性与女性） */
  gender?: 'm' | 'f';
}

export const BLOOD_CHARS: BloodCharDef[] = [
  { id: 'dealer', name: '赌场荷官', emoji: '🎰', hue: 45, tags: ['结算'], impl: 'full', basic: true, text: '【结算阶段】你的牌型的总点数+20。', implNote: '仅在比较总点数时+20（不提高牌型等级），按官方FAQ实现。' },
  { id: 'clerk', name: '银行职员', emoji: '🏦', hue: 210, tags: ['重整', '游戏开始'], impl: 'full', basic: true, text: '【重整阶段】获得2血筹。游戏开始时，额外获得2血筹。' },
  { id: 'magician', name: '魔术师', emoji: '🎩', hue: 275, tags: ['常驻'], impl: 'full', basic: true, text: '你的手牌上限+1。' },
  { id: 'bartender', name: '酒保', emoji: '🍸', hue: 330, tags: ['换牌'], impl: 'full', basic: true, text: '【换牌阶段】你的换牌次数+1，当剩余可换牌次数为0时，获得1血筹。' },
  { id: 'actor', name: '特型演员', emoji: '🎭', hue: 15, tags: ['对决', '游戏开始'], impl: 'full', text: '【对决阶段】你的2视为joker。游戏开始时，删除2张2。' },
  { id: 'miner', name: '矿工', emoji: '⛏️', hue: 100, tags: ['对决'], impl: 'full', text: '【对决阶段】若你打出的牌均为黑色，获得3血筹。' },
  { id: 'acrobat', name: '杂技演员', emoji: '🤹', hue: 190, tags: ['对决'], impl: 'full', text: '【对决阶段】你的【6】可视为【9】，【9】可视为【6】。', implNote: '评估时自动取6/9互换后的最优解释。' },
  { id: 'pirate', name: '海盗', emoji: '🏴‍☠️', hue: 220, tags: ['购买'], impl: 'full', implNote: '抢劫→放弃/抵抗（轮流掷骰）全流程自动化，购买阶段前触发。', text: '【购买阶段】前，你可以抢劫一位对手，其必须选择【放弃】或者【抵抗】。若【放弃】，则交给你2血筹（不足则全给）。若【抵抗】，则与你轮流掷骰，若你的点数更大，则抢夺其至多4血筹，否则无事发生。' },
  { id: 'stockholder', name: '股民', emoji: '📈', hue: 140, tags: ['购买'], impl: 'full', text: '【购物阶段】结束时，若你剩余0血筹，则获得3血筹。' },
  { id: 'tarot', name: '塔罗师', emoji: '🔮', hue: 260, tags: ['换牌'], impl: 'full', implNote: '每次换牌改为先抽（≤2）后弃（≤2），换牌界面双步确认。', text: '【换牌阶段】你的每次换牌：可先抽牌，再弃牌。但每次最多抽2张再弃2张牌。' },
  { id: 'mascot', name: '吉祥物', emoji: '🧸', hue: 30, tags: ['购买'], impl: 'full', text: '每回合【购物阶段】当你第一次购买时，价格优惠一半（向上取整）。例：价格3血筹的牌以1血筹购入。' },
  { id: 'fryer', name: '炸鸡店老板', emoji: '🍗', hue: 25, tags: ['换牌', '结算'], impl: 'full', implNote: '换牌期付1抽1（无限次）；结算期付1删本回合打出的牌（≤3张）。', text: '【换牌阶段】你可花费1血筹，并抽1张牌（无次数限制）。【结算阶段】结束时，你可用1血筹删除1张本回合打出的牌（最多3张）。' },
  { id: 'laundry', name: '洗衣房店主', emoji: '🧺', hue: 200, tags: ['常驻', '重整'], impl: 'full', text: '任何时候，当重洗牌库时，获得1血筹。【重整阶段】若选择不重洗牌库，则额外获得2血筹。' },
  { id: 'idol', name: '偶像', emoji: '🌟', hue: 50, tags: ['换牌'], impl: 'full', text: '【换牌阶段】每次换牌，可选择任意数量的牌（而非至多3张），若一次弃了4张或者更多的牌，获得1血筹。' },
  { id: 'chef', name: '特级大厨', emoji: '👨‍🍳', hue: 10, tags: ['换牌', '对决', '常驻'], impl: 'full', text: '【换牌阶段】每当你弃置1张【3】时，可展示之并获得1血筹。\n【对决阶段】你每打出1张【3】，获得1血筹。\n任意时候，每当你或你的队伍删除1张【3】，获得4血筹。', implNote: '换牌弃3/对决打3/自己删除3（含初始构筑）均已实装，按最终点数判定。' },
  { id: 'student', name: '高中生', emoji: '🎒', hue: 320, tags: ['对决'], impl: 'full', implNote: '对决前弃光出牌区（高牌0点）+2血筹并执行一次标准删牌（付2）。', text: '【对决阶段】前，你可将出牌区的牌全部弃置（牌型视为高牌，总点数为0），获得2血筹，并可执行一次删牌。' },
  { id: 'gunner', name: '枪手', emoji: '🔫', hue: 0, tags: ['对决', '结算'], impl: 'full', text: '【对决阶段】你可将【4】视为joker。【结算阶段】结束时，将本回合视为joker的【4】删除。', implNote: '评估自动取“4视为joker”的最优解释；结算后删除本回合打出的所有4。' },
  { id: 'cleaner', name: '清洁工', emoji: '🧹', hue: 180, tags: ['重整'], impl: 'full', text: '【重整阶段】结束时，可从全牌库删除1张牌。若删除的是抽牌堆的牌，则重洗抽牌堆。', implNote: '重整结束从全牌库（所有玩家抽牌堆/弃牌区）自选1张删除；删自抽牌堆则重洗该堆。' },
  { id: 'gambler', name: '职业赌徒', emoji: '🎲', hue: 240, tags: ['对决', '结算'], impl: 'full', implNote: '出牌前竞猜夺魁者（可猜自己），猜中+（人数+2）血筹。', text: '【对决阶段】前，你可以猜测本回合【夺魁】的玩家（可以猜自己）\n【结算阶段】若猜对，获得【人数+2】血筹' },
  { id: 'samurai', name: '武士', emoji: '⚔️', hue: 350, tags: ['结算'], impl: 'full', text: '【结算阶段】你额外获得【本回合获得的车票数量】的血筹' },
  { id: 'hacker', name: '黑客', emoji: '💻', hue: 130, tags: ['初始构筑', '删牌'], impl: 'full', text: '你的初始构筑改为从全牌库中挑选8张牌删除。【删牌阶段】你可以额外免费删除1张牌。', implNote: '初始构筑改为从自己全牌库自选8张删除；删牌阶段免费删2张。' },
  { id: 'imp', name: '捣蛋鬼', emoji: '👿', hue: 285, tags: ['特殊'], impl: 'full', implNote: '无个人牌堆全流程改写：对手换牌结束后进行抽换小回合（自选对手抽牌）、弃牌公开、结算含魁首牌+1票、购回机制、免于失效。', text: '你没有个人牌堆，必须跳过初始构筑。其他玩家【换牌阶段】结束时，你开始【抽牌阶段】和【换牌阶段】，当你需要抽牌时，必须从对手的抽牌堆中抽牌（自选数量与目标），弃置的牌放入你的弃牌区（你的弃牌区始终对其他人可见）。【结算阶段】若你的出牌区有【夺魁】玩家的牌，你获得1车票。【购买阶段】前，每位对手可支付你1血筹，从你的牌库中拿回所有属于自己的牌，并放到自己的弃牌堆中。你必须跳过【重整阶段】。你的技能无法被无效。' },
  { id: 'designer', name: '桌游设计师', emoji: '🎮', hue: 170, tags: ['出牌'], impl: 'full', implNote: '出牌结束时弃出牌区1/2张得2/4血筹。', text: '【出牌阶段】结束时，你可以弃置出牌区的1张牌获得2血筹，或2张牌获得4血筹' },
  { id: 'curse', name: '咒术师', emoji: '📜', hue: 290, tags: ['换牌'], impl: 'full', implNote: '换牌中随时藏【5】入角色牌下（抽1+1血筹），结束时可取回。', text: '【换牌阶段】你可随时展示手中的【5】置于你的角色牌下（此牌视为在游戏外），并抽一张牌，获得1血筹。【换牌阶段】结束时，你可以将角色牌下任意数量的5置入手中。' },
  { id: 'maid', name: '女仆', emoji: '👗', hue: 335, tags: ['对决', '删牌'], impl: 'full', gender: 'f', text: '【对决阶段】你的红桃=黑桃。你必须跳过【删牌阶段】' },
  { id: 'biker', name: '飞车党', emoji: '🏍️', hue: 5, tags: ['游戏开始', '删牌'], impl: 'full', text: '游戏开始时，删除所有的J/Q/K/A，但跳过初始构筑。删牌阶段，你只可支付血筹进行删牌。' },
  { id: 'twinB', name: '双生子（弟）', emoji: '👶', hue: 205, tags: ['初始构筑', '结算'], impl: 'full', implNote: '初始构筑后自动将双生镜片插入弃牌区1张并置顶；结算期获得血筹-2（最低0）。', text: '初始构筑结束后，从黑市牌堆中找出【双生镜片】并插入弃牌区的1张牌中，挑出此牌并重洗牌库，然后将此牌放在抽牌堆顶。接下来的游戏中，在【结算阶段】你获得血筹-2（最低为0）' },
  { id: 'twinA', name: '双生子（兄）', emoji: '👦', hue: 215, tags: ['初始构筑', '删牌'], impl: 'full', implNote: '初始构筑后自动将双生镜片插入弃牌区1张并置顶；删牌只可付费。', text: '初始构筑结束后，从黑市牌堆中找出【双生镜片】插入弃牌区的1张牌中，挑出此牌并重洗牌库，然后将此牌放在抽牌堆顶。接下来的游戏中，【删牌阶段】你只可支付血筹进行删牌。' },
  { id: 'noble', name: '贵族', emoji: '💎', hue: 55, tags: ['游戏开始'], impl: 'full', text: '游戏开始时，获得12血筹' },
  { id: 'streamer', name: '主播', emoji: '📹', hue: 310, tags: ['换牌'], impl: 'full', text: '【换牌阶段】若你一次性弃置了至少2张点数相同的牌，公示并获得3血筹（每回合一次）' },
  { id: 'smuggler', name: '走私客', emoji: '🚢', hue: 195, tags: ['购买'], impl: 'full', implNote: '购买前标记黑市1张：自己-2，他人须先支付2血筹。', text: '【购买阶段】开始前，你可以指定黑市区的1张牌，本回合你购买此牌价格-2；若有玩家想购买此牌，则需先交给你2血筹，否则无法购买。' },
  { id: 'painter', name: '画家', emoji: '🎨', hue: 20, tags: ['对决'], impl: 'full', text: '【对决阶段】若你的出牌区存在3种花色，则获得2血筹；若存在4种花色，则再获得1血筹。' },
  { id: 'godOfGambling', name: '赌神', emoji: '🀄', hue: 355, tags: ['换牌'], impl: 'full', implNote: '换牌结束查看所有人手牌后选额外换牌或+1血筹。', text: '【换牌阶段】结束时，你可查看每一位玩家的手牌，之后你可额外执行一次换牌行动，或获得1血筹。' },
  { id: 'inspector', name: '质检员', emoji: '🔍', hue: 160, tags: ['重整'], impl: 'full', implNote: '不重洗+2时可从弃牌区公示1张置顶；重洗则+1血筹。', text: '【重整阶段】若你选择不重洗牌库（并获得2血筹），则可以从弃牌区中选择1张牌公示后放到抽牌堆顶。若重洗牌库，则获得1血筹。' },
  { id: 'general', name: '将军', emoji: '🎖️', hue: 225, tags: ['换牌'], impl: 'full', implNote: '换牌结束可令一名玩家随机弃1摸1或自己额外换牌一次（不兑血筹）。', text: '【换牌阶段】结束时，你可以选择一位玩家，其随机弃置1张牌并摸1张牌，或你再额外进行一次换牌（不可兑换成血筹）。' },
  { id: 'scalper', name: '票贩子', emoji: '🎫', hue: 65, tags: ['结算'], impl: 'full', implNote: '结算未夺魁可付3血筹强购夺魁者1车票。', text: '【结算阶段】若你本回合未夺魁，则可以向夺魁玩家支付3血筹，强制购买其1车票。' },
  { id: 'detective', name: '私家侦探', emoji: '🕵️', hue: 235, tags: ['抽牌'], impl: 'full', implNote: '抽牌前弃牌区1张置顶/至多3张置底（公示）或+1血筹。', text: '【抽牌阶段】前，可将弃牌区的1张牌放到抽牌堆顶，或将弃牌区的至多3张牌放到抽牌堆底（均需公示后放置）。若未如此做，则获得1血筹' },
  { id: 'faceless', name: '无面人', emoji: '👤', hue: 250, tags: ['特殊'], impl: 'full', implNote: '每回合抽牌前从角色牌堆抽2选1为临时技能；持技能期间可永久转化（不可逆）。', text: '【游戏开始】及每回合【抽牌阶段开始前】，你从角色牌堆中抽取2张牌，并须选择其中1张获得其技能（持续至下个抽牌阶段开始前）。\n若你当前持有某角色技能（即便已抽角色牌但尚未进行2选1抉择），你可令【无面人】永久转化为该角色。此转化不可逆转。' },
  { id: 'bluffer', name: '瞎掰王', emoji: '🗣️', hue: 40, tags: ['对决'], impl: 'full', implNote: '对决前逐张宣告点数/花色→顺时针质疑；无人质疑按宣告牌对决，被质疑核对一致性结算血筹。', text: '【对决阶段】前可宣告自己出牌区每一张牌的点数、花色与牌型，从持有临时特权证的玩家开始顺时针依次选择是否质疑（自己除外）。\n若无人质疑，则将出牌区的牌弃置并按宣告的牌进行牌局对决。\n若有人质疑，则【对决阶段】检查出牌区的牌是否与宣告均一致，若一致，则质疑的玩家均交给你1血筹；若不一致，则质疑的玩家获得1血筹。' },
  { id: 'rose', name: '白蔷薇', emoji: '🌹', hue: 340, tags: ['换牌'], impl: 'full', gender: 'f', text: '【换牌阶段】若你是第一位宣告换牌结束的玩家，则获得3血筹。' },
  { id: 'octopus', name: '神作章鱼', emoji: '🐙', hue: 300, tags: ['换牌'], impl: 'full', text: '【换牌阶段】结束时，你可以将弃牌区洗混，并从中随机抽取至多2张牌加入手牌。', implNote: '停止换牌时自动发动（洗混弃牌区随机取回至多2张）。' },
  { id: 'myname', name: '我的名字？', emoji: '❓', hue: 265, tags: ['常驻'], impl: 'full', implNote: '开局自定义牌型名并全桌展示；任何玩家打出该牌型自动+2血筹。纠错罚血条款因客户端自动宣告恒符合而不会触发。', text: '游戏开始时，你将一种牌型的名称改为你自定义的名称（例：将“两对”改为“咕咕嘎嘎”），游戏过程中每当有玩家（包括自己）打出此牌型时，你获得2血筹。若有玩家在【对决阶段】宣告牌型时未按你设定的名称宣告，则需交给你2血筹。' },
  { id: 'auctioneer', name: '瞎掰帝', emoji: '🔨', hue: 35, tags: ['购买'], impl: 'full', implNote: '第一回合购买前看牌堆顶2张暗置1张顺时针叫价，最高价者于其购买回合得牌。', text: '【购买阶段】前，你可查看黑市牌堆顶的2张牌，选择其中一张暗置在桌面上，另一张放回原处。并由你开始顺时针一轮叫价（不可超过其目前持有的血筹），出价最高的玩家花费相应血筹，获得此牌。若得牌者不为你，你获得2血筹。' },
  { id: 'seer', name: '窥天师', emoji: '👁️', hue: 245, tags: ['常驻', '购买'], impl: 'full', implNote: '常驻可见自己抽牌堆顶；第一回合购买前暗置7张天意（-2价购买，全购则车票归0）。', text: '你始终可以查看抽牌堆顶的1张牌。\n第一回合【购买阶段】前，你将黑市牌堆顶的7张牌暗置在你身边，称为“天意”，你可随时查看天意。\n【购买阶段】你可购买“天意”，每张价格-2。\n若“天意”均被购买,则被天意侵蚀，车票归0。' },
  { id: 'wei', name: '魏王', emoji: '🐉', hue: 275, tags: ['购买'], impl: 'full', text: '整局游戏你最多只可同时拥有3张强化芯片。（若获得更多则直接弃置新获得的强化芯片）\n【购买阶段】你购买强化芯片价格-2。\n【购买阶段】结束时，若你购买过黑市牌，则获得2血筹。' },
  { id: 'liu', name: '皇叔', emoji: '🛡️', hue: 5, tags: ['删牌', '特殊'], impl: 'full', implNote: '删牌1血筹/张无限制；删光整副54张且分数过半即获胜（只能以此方式获胜）。', text: '【删牌阶段】你可用每1血筹删除1张牌（无次数限制）。\n任何时候，若你分数达到目标数量一半，且把整副牌（54张牌）全部删除，你直接获得胜利。（你只可以此方法获胜）' },
  { id: 'sunwu', name: '江东之主', emoji: '🌊', hue: 185, tags: ['常驻', '结算'], impl: 'full', text: '你始终拥有临时特权证（对手无法以任意方式获得临时特权证），当你夺魁时，获得2血筹', implNote: '始终持有临时特权证（开局获得且不可被夺）；夺魁+2血筹。' },
  { id: 'dungeon', name: '地下城主', emoji: '🕳️', hue: 30, tags: ['换牌'], impl: 'full', text: '【换牌阶段】前可掷一次骰子，若点数≥3则本回合默认可换牌次数（即3次）调整为该点数；若点数＜3，则获得该点数的血筹。', implNote: '进入换牌阶段时自动掷骰结算（特权证+1等修正照常叠加）。' },
  { id: 'ceo', name: '霸道总裁', emoji: '💼', hue: 215, tags: ['换牌'], impl: 'full', implNote: '换牌结束可依次给予血筹，对方收下弃光重抽或拒绝付双倍。', text: '【换牌阶段】结束时，你可以依次选择任意位玩家并交给其任意血筹，其必须选择：\n1.收下相应血筹，丢弃所有手牌并抽取等量的牌。并说：“不愧是顾家。”\n2.拒绝换牌，支付双倍血筹给你，并说：“你顾家算什么东西。”' },
  { id: 'vagrant', name: '无业游民', emoji: '🍺', hue: 45, tags: ['换牌', '对决', '结算'], impl: 'full', implNote: '换牌结束抽对手牌堆顶2张；对决出牌区对手牌各收1血筹；结算归还牌库中对手的牌。', text: '【换牌阶段】结束时，你可从任意对手的抽牌区抽取总计2张牌加入自己的手牌（对手抽牌区至少有2张牌）。【对决阶段】你出牌区每有1张对手的牌，则该对手必须给你1血筹。【结算阶段】结束时，将牌库中对手的牌放入其弃牌区。' },
  { id: 'screenwriter', name: '编剧', emoji: '✍️', hue: 150, tags: ['对决'], impl: 'full', text: '【对决阶段】若打出的牌总点数恰好等于50，获得5血筹。否则跳过本回合的【购买阶段】与【删牌阶段】' },
  { id: 'princess', name: '双重人格公主', emoji: '👑', hue: 325, tags: ['对决'], impl: 'full', gender: 'f', text: '当你使用过技能后，必须将弃牌堆翻面切换人格。游戏开始时为常时人格。\n常时人格（弃牌堆背面朝上）：【对决阶段】若你打出的牌均为黑色，获得3血筹。\n躁狂人格（弃牌堆正面朝上，其他玩家可查看）：【对决阶段】若你打出的牌均为红色，获得1车票' },
  { id: 'undertaker', name: '入殓师', emoji: '⚰️', hue: 255, tags: ['换牌'], impl: 'full', implNote: '特殊换牌（≤3张置角色牌上+弃牌区随机取回等量），结束置弃；未用过+2血筹。', text: '【换牌阶段】你的每次换牌可改为【特殊换牌】：将至多3张手牌置于角色牌上，然后从弃牌区随机抽取等量的牌。\n【换牌阶段】结束时，将在角色牌上的所有牌置入弃牌区。若你未执行过【特殊换牌】，则获得2血筹。' },
  { id: 'dogGambler', name: '赌狗', emoji: '🐕', hue: 70, tags: ['删牌'], impl: 'full', implNote: '删牌阶段指定一名玩家掷骰删其抽牌堆顶X-1张。', text: '【销牌阶段】你可以选择一位玩家，该玩家进行掷骰，并删除其抽牌堆顶的【X-1】张牌（X为本次掷骰点数），若抽牌堆不足【X-1】张，则删除抽牌堆剩余的牌。' },
  { id: 'agent', name: '特工', emoji: '🕶️', hue: 205, tags: ['出牌', '结算'], impl: 'full', implNote: '全员出牌后询问交换出牌区，拒绝付2血筹；结算结束自动归还。', text: '【出牌阶段】结束时，你可指定一位玩家，询问是否愿意与你交换出牌区的所有牌，若其拒绝，则必须给你2血筹；【结算阶段】结束时，双方归还交换的牌。' },
  { id: 'barista', name: '咖啡师', emoji: '☕', hue: 25, tags: ['购买'], impl: 'full', implNote: '首次购买原价≥3的黑市牌后免费获得牌堆顶一张。', text: '每回合【购买阶段】当你第一次购买一张原价格不小于3血筹的黑市牌时，免费获得一张黑市牌堆顶的黑市牌。' },
  { id: 'succubus', name: '魅魔', emoji: '😈', hue: 315, tags: ['结算'], impl: 'full', implNote: '结算夺魁抢男性3血筹/未夺魁抢女性1血筹；无性别视为男+女；无法抢夺改为直接获得。', text: '【结算阶段】若你夺魁，可以抢夺一位男性角色3血筹。若未夺魁，可以抢夺一位女性角色1血筹（无性别同时视为男性与女性）。若无法抢夺则改为获得等量血筹。' },
  { id: 'bomber', name: '炸弹客', emoji: '💣', hue: 0, tags: ['换牌', '结算'], impl: 'full', implNote: '换牌前宣告X(0-2)得X血筹；结算结束时其他玩家随机删X张、自己删X+1张本回合打出的牌。', text: '【换牌阶段】前，你可宣称0-2中一个数字【X】，并获得x血筹。【结算阶段】结束时，其他玩家必须随机删除【X】张本回合打出的牌，你必须随机删除【X+1】张本回合打出的牌。' },
];

export const BLOOD_CHAR_BY_ID = new Map(BLOOD_CHARS.map((c) => [c.id, c]));

/** 本局可选角色池：基础版仅前 4 名基础角色；拓展版并入全部拓展角色 */
export function charPoolIds(includeExpansion: boolean): string[] {
  return includeExpansion ? BLOOD_CHARS.map((c) => c.id) : BLOOD_CHARS.filter((c) => c.basic).map((c) => c.id);
}

/** 默认手牌上限（魔术师+1） */
export function charHandCap(charId: string | null | undefined): number {
  return charId === 'magician' ? 7 : 6;
}

/** 每次换牌最多弃置张数（偶像任意） */
export function charSwapMax(charId: string | null | undefined): number {
  return charId === 'idol' ? 99 : 3;
}

/**
 * 角色技能对“评估输入”的改写（对决评估/出牌提示共用）：
 * - 特型演员：最终点数为 2 的牌视为 joker（全 wild）
 * - 枪手：4 可视为 joker（全 wild，评估取最优）
 * - 杂技演员：6/9 可互换（候选点数加另一值）
 * - 女仆：红桃=黑桃（候选花色合并）
 */
export function applyCharEval(cards: EvalCard[], charId: string | null | undefined): EvalCard[] {
  switch (charId) {
    case 'actor':
      return cards.map((c) =>
        c.ranks.length === 1 && c.ranks[0] === 2 ? { ...c, ranks: [...ALL_RANKS], suits: [...ALL_SUITS] } : c,
      );
    case 'gunner':
      return cards.map((c) =>
        c.ranks.length === 1 && c.ranks[0] === 4 ? { ...c, ranks: [...ALL_RANKS], suits: [...ALL_SUITS] } : c,
      );
    case 'acrobat':
      return cards.map((c) => {
        if (c.ranks.length === 1 && c.ranks[0] === 6) return { ...c, ranks: [6, 9] };
        if (c.ranks.length === 1 && c.ranks[0] === 9) return { ...c, ranks: [9, 6] };
        return c;
      });
    case 'maid':
      return cards.map((c) => {
        if (c.suits.length === 1 && c.suits[0] === 'h') return { ...c, suits: ['h', 's'] as EvalCard['suits'] };
        if (c.suits.length === 1 && c.suits[0] === 's') return { ...c, suits: ['s', 'h'] as EvalCard['suits'] };
        return c;
      });
    default:
      return cards;
  }
}
