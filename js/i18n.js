/*!
 * 中英文案表与取词函数
 *
 * 浏览器、终端界面与后端服务共用这一份。设计上有两点讲究：
 *
 * 1. 对局本身不带语言。js/session.js 只产出结构化数据（哪一方、从哪个点到哪个点、
 *    是否吃子、谁赢、因为什么结束），由各个界面按自己的语言渲染。因此网页看中文、
 *    终端看英文，看到的仍然是同一局棋——后端不会把中文串塞给英文界面。
 * 2. 取词一律走 t()，缺词会回退到默认语言，再回退到词条名本身；测试会检查
 *    两种语言的词条集合完全一致，不会出现「加了新文案忘了翻译」。
 */
(function (global) {
  'use strict';

  /*
   * 默认语言是英文：不跟随系统语言，启动时一律先显示英文，
   * 想换中文由使用者自己在界面上切（网页右下角按钮 / 终端按 L / 启动参数 --lang zh）。
   */
  var DEFAULT_LOCALE = 'en';

  var LOCALES = [
    { code: 'en', label: 'English' },
    { code: 'zh', label: '中文' }
  ];

  var MESSAGES = {
    zh: {
      'app.title': '苏拉卡尔塔',
      'app.subtitle': 'Surakarta · 6×6 交叉点 · 每方 12 子 · 绕角环吃子',

      'side.black': '黑方',
      'side.red': '红方',
      'side.blackShort': '黑',
      'side.redShort': '红',
      'who.you': '你',
      'who.ai': 'AI',

      'status.connecting': '正在连接…',
      'status.toMove': '{side}行棋',
      'status.withWho': '{side}行棋（{who}）',
      'status.gameOver': '对局结束',
      'status.thinking': '{side} AI 思考中 · {level}',
      'status.depthDone': '已完成 {depth} 层',

      'conn.label': '连接方式：',
      'conn.probing': '正在探测后端服务…',
      'conn.online': '在线（共用后端服务，与终端 TUI 是同一局棋）',
      'conn.offline': '离线（本页直接对局）',
      'conn.tuiHint': '（在终端运行 node tui.js 可以打开终端界面，与网页共用同一局棋）',
      'conn.lost': '与后端服务的连接中断：{error}',
      'conn.unreadable': '无法读取对局状态：{error}',
      'conn.badResponse': '后端返回了无法解析的内容',
      'conn.badState': '后端返回的状态不完整',
      'conn.offlineOnly': '在线模式下局面归后端所有，不能直接载入局面',

      'panel.levels': '搜索深度',
      'panel.sides': '执子',
      'panel.actions': '操作',
      'panel.aiStats': 'AI 状态',
      'panel.moveLog': '行棋记录',
      'panel.rules': '规则说明',

      'level.1': '入门',
      'level.2': '进阶',
      'level.3': '高手',
      'level.4': '大师',
      'level.depthTag': '搜索深度 {depth} 层',
      'level.desc.1': '随机性较大，会走出明显不够好的着法，适合熟悉规则。',
      'level.desc.2': '能看到几步之内的得失，偶尔漏算。',
      'level.desc.3': '完整搜索到第 6 层并延伸吃子，攻防较为严谨。',
      'level.desc.4': '搜索到第 8 层，时间上限 10 秒，棋力最强。',

      'btn.new': '新对局',
      'btn.undo': '悔棋',
      'btn.agree': '协商终局',
      'side.playBlack': '执先手（黑）',
      'side.playRed': '执后手（红）',
      'side.hint': '更换执子方会立即开始新对局。',

      'stat.depth': '搜索深度',
      'stat.score': '局面评分',
      'stat.nodes': '搜索节点',
      'stat.time': '思考用时',
      'stat.winning': '必胜',
      'stat.losing': '必败',
      'stat.searching': '（搜索中 {depth}）',
      'stat.preparing': '（准备中）',
      'stat.seconds': '{seconds} 秒',

      'card.first': '先手',
      'card.second': '后手',

      'legend.inner': '内侧回路（第 1、4 行与第 1、4 列）',
      'legend.outer': '外侧回路（第 2、3 行与第 2、3 列）',
      'legend.edge': '最外侧的线（没有环）',

      'rule.1': '棋盘为 6×6 交叉点，每方 12 枚棋子，开局时各占靠近自己的两行，中间两行为空。黑方先行。',
      'rule.2': '普通走子：把一枚棋子沿横、竖、斜任一方向走到相邻的空点，不能跳子，也不能落到已有棋子的点上。',
      'rule.3': '吃子：棋子沿所在的行或列直线前进，途中经过的交叉点必须全部为空；走到该直线的尽头时，如果那里有角环，就沿切线离开棋盘，绕过棋盘外的四分之三圆弧，从相邻的另一条线切回棋盘继续前进。方向只在绕环时改变 90°。',
      'rule.4': '至少绕过 1 个角环之后，才允许落在途中遇到的第一枚敌方棋子上把它吃掉；途中遇到己方棋子则此方向不能吃子。绕行过程中同一个空点可以多次经过。',
      'rule.5': '吃子不是强制动作，可以放弃。',
      'rule.6': '角环只用于吃子，普通走子不会走环（不允许沿回路滑行）。第 0、5 行与第 0、5 列这四条最外圈线上没有环；四个角点两条线都没有环，因此角上的棋子永远无法吃子。最外圈上其余的交叉点仍可沿带环的那条线绕行吃子——它们正是圆弧与边的切点。',
      'rule.7': '吃掉对方全部 12 枚棋子即获胜。局面无法继续时由双方协商终局，剩余棋子多的一方获胜。',

      'move.captureSuffix': ' 吃子',
      'move.text': '{side} {from}→{to}',

      'result.wipeout': '{winner}吃光对方全部 12 枚棋子，获胜。',
      'result.agreed': '双方协商终局：{judge}。',
      'result.stalemate': '{side}无子可动，按双方协商终局处理：{judge}。',
      'result.aiError': 'AI 给出了无法执行的着法，对局中止（{error}）。',
      'judge.blackWins': '黑方以 {a} 比 {b} 获胜',
      'judge.redWins': '红方以 {a} 比 {b} 获胜',
      'judge.draw': '双方各剩 {n} 子，和棋',

      'err.gameOver': '对局已经结束',
      'err.illegalMove': '非法着法：{from}→{to}',
      'err.notYourTurn': '现在轮到 AI 走子',
      'err.nothingToUndo': '没有可以撤销的着法',
      'err.notPlaying': '对局不在进行中',
      'err.badSide': '执子方必须是黑或红',
      'err.badCell': '交叉点编号无效',
      'err.badLevel': '难度编号无效',
      'err.missingMove': '缺少着法',
      'err.badBoard': '棋盘应当有 {n} 个交叉点',
      'err.badRequest': '请求体不是合法的 JSON',
      'err.tooLarge': '请求体过大',
      'err.unknownRoute': '没有这个接口：{route}',
      'err.badMethod': '不支持的请求方法',
      'err.forbidden': '禁止访问',
      'err.notFound': '找不到 {path}',
      'err.actionFailed': '操作失败',

      'tui.title': '苏拉卡尔塔 终端界面',
      'tui.connected': '已连接',
      'tui.youPlay': '你执',
      'tui.turn': '轮次',
      'tui.level': '难度',
      'tui.pieces': '棋子',
      'tui.score': '评分',
      'tui.scoreFromAI': '（AI 最近一手）',
      'tui.cursor': '光标',
      'tui.selected': '选中 {cell}（{n} 个落点）',
      'tui.selectedCapture': '选中 {cell}（{n} 个落点）',
      'tui.yourTurn': '轮到你了（{side}）',
      'tui.yourTurnHint': '方向键移动光标，Enter 选中棋子',
      'tui.aiTurn': '轮到 {side}（AI）',
      'tui.thinking': '{side}（AI）思考中',
      'tui.preparing': '正在准备搜索…',
      'tui.progress': '{depth}/{total} 层 · {nodes} 节点 · {seconds} 秒 · 当前第 {current} 层',
      'tui.moveLog': '着法记录（{n} 手）',
      'tui.noMoves': '尚无着法',
      'tui.hintBar': '? 帮助 · q 退出 · hjkl 移动 · Enter 落子',
      'tui.hintBarYourTurn': '方向键移动光标，Enter 选中棋子',
      'tui.captureTrail': '绕过角环才能吃掉这枚棋子',
      'tui.hoverPath': '绕行 {path}',
      'tui.tooSmall': '终端太小，画不下棋盘。当前 {cols}×{rows}，至少需要 {needCols}×{needRows}。',
      'tui.tooSmallHint': '请放大窗口，或改用 --plain 输出到文件查看。',
      'tui.gameOver': '对局已经结束，按 n 可以新开一局',
      'tui.waitAI': '现在轮到 AI，请稍候',
      'tui.loading': '正在读取对局状态…',
      'tui.connectFailed': '无法连接苏拉卡尔塔后端服务：{server}',
      'tui.connectFailedHint': '请先在项目目录下启动后端服务，再运行终端界面：',
      'tui.refused': '连接被拒绝，服务没有在运行',
      'tui.newFailed': '新开一局失败',
      'tui.undoFailed': '悔棋失败',
      'tui.sideFailed': '交换执子失败',
      'tui.agreeFailed': '协商终局失败',
      'tui.levelFailed': '调整难度失败',
      'tui.moveFailed': '这一手被后端拒绝了',
      'tui.hintsFailed': '取提示失败',
      'tui.crashed': '终端界面出错：{error}',
      'tui.helpTitle': '按键说明',
      'tui.helpAny': '按任意键回到棋盘',
      'tui.help.move': '移动光标',
      'tui.help.moveKeys': '方向键 ↑↓←→，或 h j k l，或 w s d（左移用 h）',
      'tui.help.confirm': '选中/落子',
      'tui.help.confirmKeys': 'Enter 或 空格：落在自己的棋子上选中它，落在高亮处走子',
      'tui.help.esc': '取消选中',
      'tui.help.escKeys': 'Esc，或对着同一枚棋子再按一次 Enter',
      'tui.help.new': '新开一局',
      'tui.help.undo': '悔棋',
      'tui.help.undoKeys': 'u（双方各撤一步）',
      'tui.help.side': '交换执子',
      'tui.help.sideKeys': 'c（黑 / 红 互换，会重开一局）',
      'tui.help.agree': '协商终局',
      'tui.help.level': '调整难度',
      'tui.help.levelKeys': '1 {l1} · 2 {l2} · 3 {l3} · 4 {l4}',
      'tui.help.lang': '切换语言',
      'tui.help.langKeys': 'L（中文 / English）',
      'tui.help.help': '按键帮助',
      'tui.help.quit': '退出',
      'tui.help.quitKeys': 'q 或 Ctrl+C',
      'tui.help.legend': '图例',
      'tui.help.loop': '角环切点',
      'tui.help.loopText': '棋子走到这里可以拐进环里吃子',
      'tui.help.dot': '可落点',
      'tui.help.dotText': '选中棋子后，空心的圆圈是可以走到的位置',
      'tui.help.enemy': '可以被吃掉的敌方棋子',
      'tui.help.trail': '吃子的绕行路线：至少绕过 1 个角环才能吃子',
      'tui.help.play': '玩法',
      'tui.help.playText1': '走子每次一格（八邻域）；吃子沿直线走到角环，',
      'tui.help.playText2': '绕过四分之三圆后从相邻的那条线切回棋盘，',
      'tui.help.playText3': '落在路上遇到的第一枚敌方棋子上。',
      'tui.help.playText4': '吃光对方 12 枚棋子即获胜。',
      'tui.usage.lang': '界面语言：zh 或 en（默认英文，运行中按 L 可随时切换）',
      'tui.usage.line': '用法：',
      'tui.usage.options': '选项：',
      'tui.usage.server': '后端服务地址，默认 {url}',
      'tui.usage.noColor': '不输出任何 ANSI 转义（保留 Unicode 字形）',
      'tui.usage.plain': '纯 ASCII 且不着色，适合日志与无样式终端',
      'tui.usage.help': '显示本帮助',
      'tui.usage.keys': '按键：',
      'tui.usage.needBackend': '需要先启动后端服务：node server.js --port 8123',
      'tui.captureMark': '吃',
      'tui.disconnected': '连接中断',
      'tui.badUrl': '服务地址不合法：{url}',
      'tui.timeout': '请求超时',
      'tui.responseTooLarge': '后端返回内容过大',

      'server.started': '苏拉卡尔塔后端服务已启动',
      'server.web': '  网页界面：{url}',
      'server.tui': '  终端界面：node tui.js --server {url}',
      'server.shared': '  两者共用同一局棋，可以同时开着。按 Ctrl+C 结束服务。',
      'server.portBusy': '端口 {port} 已经被占用。换一个端口试试：node server.js --port {next}',
      'server.failed': '服务启动失败：{error}',
      'server.stopped': '服务已停止。',
      'server.usage': '用法：node server.js [--port 8123] [--host 127.0.0.1] [--lang zh|en]'
    },

    en: {
      'app.title': 'Surakarta',
      'app.subtitle': '6×6 intersections · 12 pieces each · capture by riding the corner loops',

      'side.black': 'Black',
      'side.red': 'Red',
      'side.blackShort': 'B',
      'side.redShort': 'R',
      'who.you': 'you',
      'who.ai': 'AI',

      'status.connecting': 'Connecting…',
      'status.toMove': '{side} to move',
      'status.withWho': '{side} to move ({who})',
      'status.gameOver': 'Game over',
      'status.thinking': '{side} AI thinking · {level}',
      'status.depthDone': '{depth} plies done',

      'conn.label': 'Connection: ',
      'conn.probing': 'Looking for a backend service…',
      'conn.online': 'online (shared backend — same game as the terminal TUI)',
      'conn.offline': 'offline (playing in this page)',
      'conn.tuiHint': '(Run node tui.js in a terminal to play in the console — same game as this page.)',
      'conn.lost': 'Lost connection to the backend: {error}',
      'conn.unreadable': 'Could not read the game state: {error}',
      'conn.badResponse': 'the backend returned an unreadable response',
      'conn.badState': 'the backend returned an incomplete state',
      'conn.offlineOnly': 'Online the position lives on the backend and cannot be set directly',

      'panel.levels': 'Difficulty',
      'panel.sides': 'Play as',
      'panel.actions': 'Actions',
      'panel.aiStats': 'AI status',
      'panel.moveLog': 'Move log',
      'panel.rules': 'Rules',

      'level.1': 'Beginner',
      'level.2': 'Casual',
      'level.3': 'Strong',
      'level.4': 'Master',
      'level.depthTag': 'search depth {depth}',
      'level.desc.1': 'Loose and rather random — it will make plainly bad moves. Good for learning the rules.',
      'level.desc.2': 'Sees a few moves ahead and occasionally misses something.',
      'level.desc.3': 'Full 6-ply search with capture extensions; solid attacking and defending.',
      'level.desc.4': '8-ply search, up to 10 seconds per move. The strongest level.',

      'btn.new': 'New game',
      'btn.undo': 'Undo',
      'btn.agree': 'Agree to end',
      'side.playBlack': 'Play Black (first)',
      'side.playRed': 'Play Red (second)',
      'side.hint': 'Changing sides starts a new game right away.',

      'stat.depth': 'Search depth',
      'stat.score': 'Evaluation',
      'stat.nodes': 'Nodes',
      'stat.time': 'Think time',
      'stat.winning': 'Winning',
      'stat.losing': 'Losing',
      'stat.searching': 'searching {depth}',
      'stat.preparing': 'preparing',
      'stat.seconds': '{seconds} s',

      'card.first': 'first',
      'card.second': 'second',

      'legend.inner': 'Inner circuit (rows 1, 4 and columns 1, 4)',
      'legend.outer': 'Outer circuit (rows 2, 3 and columns 2, 3)',
      'legend.edge': 'Outermost lines (no loop)',

      'rule.1': 'The board is a 6×6 grid of intersections. Each player has 12 pieces, starting on the two rows nearest them; the middle two rows are empty. Black moves first.',
      'rule.2': 'A normal move takes one piece a single step in any of the eight directions onto an adjacent empty point. Pieces may not jump, and may not land on an occupied point.',
      'rule.3': 'Capturing: the piece travels in a straight line along its row or column, and every intersection it passes over must be empty. When it reaches the end of that line, if there is a corner loop there, it leaves the board tangentially, travels three-quarters of the way around the circle outside the board, and re-enters along the adjacent perpendicular line. The direction turns by 90° only while riding a loop.',
      'rule.4': 'Only after riding around at least one corner loop may the piece land on the first enemy piece it meets and capture it. Meeting one of your own pieces, or meeting any piece before a loop has been ridden, makes that direction unable to capture. The same empty point may be passed over more than once during the journey.',
      'rule.5': 'Capturing is never compulsory — you may decline it.',
      'rule.6': 'Corner loops are used only for capturing; a normal move never rides one (sliding along a circuit without capturing is not part of the standard rules). The four outermost lines — rows 0 and 5, columns 0 and 5 — carry no loop. All four corners have two loop-less lines, so a piece sitting on a corner can never capture. Other points on the outer ring can still capture by travelling along their other line; those points are exactly where the arcs touch the board edge.',
      'rule.7': 'Capturing all 12 enemy pieces wins. When the position cannot be pushed any further, the players agree to end the game and whoever has more pieces left wins.',

      'move.captureSuffix': ' captures',
      'move.text': '{side} {from}→{to}',

      'result.wipeout': '{winner} captured all 12 enemy pieces and wins.',
      'result.agreed': 'Ended by agreement: {judge}.',
      'result.stalemate': '{side} has no legal move; adjudicated under the agreement rule: {judge}.',
      'result.aiError': 'The AI produced an unplayable move; the game was stopped ({error}).',
      'judge.blackWins': 'Black wins {a}–{b}',
      'judge.redWins': 'Red wins {a}–{b}',
      'judge.draw': 'Draw — {n} pieces each',

      'err.gameOver': 'The game is already over',
      'err.illegalMove': 'Illegal move: {from}→{to}',
      'err.notYourTurn': 'It is the AI’s turn',
      'err.nothingToUndo': 'There is nothing to undo',
      'err.notPlaying': 'The game is not in progress',
      'err.badSide': 'Side must be black or red',
      'err.badCell': 'Invalid intersection number',
      'err.badLevel': 'Invalid difficulty level',
      'err.missingMove': 'No move was given',
      'err.badBoard': 'The board must have {n} intersections',
      'err.badRequest': 'Request body is not valid JSON',
      'err.tooLarge': 'Request body is too large',
      'err.unknownRoute': 'No such endpoint: {route}',
      'err.badMethod': 'Unsupported request method',
      'err.forbidden': 'Forbidden',
      'err.notFound': '{path} not found',
      'err.actionFailed': 'The action failed',

      'tui.title': 'Surakarta · terminal',
      'tui.connected': 'connected',
      'tui.youPlay': 'You play',
      'tui.turn': 'Turn',
      'tui.level': 'Difficulty',
      'tui.pieces': 'Pieces',
      'tui.score': 'Eval',
      'tui.scoreFromAI': '(AI’s last move)',
      'tui.cursor': 'Cursor',
      'tui.selected': 'Selected {cell} ({n} destinations)',
      'tui.selectedCapture': 'Selected {cell} ({n} destinations)',
      'tui.yourTurn': 'Your turn ({side})',
      'tui.yourTurnHint': 'arrow keys move the cursor, Enter selects a piece',
      'tui.aiTurn': '{side} to move (AI)',
      'tui.thinking': '{side} (AI) thinking',
      'tui.preparing': 'getting ready…',
      'tui.progress': '{depth}/{total} plies · {nodes} nodes · {seconds} s · now on ply {current}',
      'tui.moveLog': 'Moves ({n})',
      'tui.noMoves': 'no moves yet',
      'tui.hintBar': '? help · q quit · hjkl move · Enter play',
      'tui.hintBarYourTurn': 'arrow keys move the cursor, Enter selects a piece',
      'tui.captureTrail': 'this piece can only be taken by riding a corner loop',
      'tui.hoverPath': 'path {path}',
      'tui.tooSmall': 'Terminal too small to draw the board. It is {cols}×{rows}; at least {needCols}×{needRows} is needed.',
      'tui.tooSmallHint': 'Please enlarge the window, or use --plain and redirect to a file.',
      'tui.gameOver': 'The game is over — press n for a new one',
      'tui.waitAI': 'The AI is thinking, please wait',
      'tui.loading': 'Reading the game state…',
      'tui.connectFailed': 'Cannot reach the Surakarta backend at {server}',
      'tui.connectFailedHint': 'Start the backend in the project directory, then run the terminal UI:',
      'tui.refused': 'connection refused — the service is not running',
      'tui.newFailed': 'Could not start a new game',
      'tui.undoFailed': 'Undo failed',
      'tui.sideFailed': 'Could not switch sides',
      'tui.agreeFailed': 'Could not end the game by agreement',
      'tui.levelFailed': 'Could not change the difficulty',
      'tui.moveFailed': 'the backend rejected this move',
      'tui.hintsFailed': 'Could not fetch the destinations',
      'tui.crashed': 'Terminal UI error: {error}',
      'tui.helpTitle': 'Keys',
      'tui.helpAny': 'press any key to go back to the board',
      'tui.help.move': 'Move cursor',
      'tui.help.moveKeys': 'arrow keys ↑↓←→, or h j k l, or w s d (use h to go left)',
      'tui.help.confirm': 'Select / play',
      'tui.help.confirmKeys': 'Enter/Space: select a piece, or play a highlighted move',
      'tui.help.esc': 'Cancel selection',
      'tui.help.escKeys': 'Esc, or Enter again on the same piece',
      'tui.help.new': 'New game',
      'tui.help.undo': 'Undo',
      'tui.help.undoKeys': 'u (takes back one move by each side)',
      'tui.help.side': 'Switch sides',
      'tui.help.sideKeys': 'c (swap black/red, starts a new game)',
      'tui.help.agree': 'Agree to end',
      'tui.help.level': 'Difficulty',
      'tui.help.levelKeys': '1 {l1} · 2 {l2} · 3 {l3} · 4 {l4}',
      'tui.help.lang': 'Language',
      'tui.help.langKeys': 'L (中文 / English)',
      'tui.help.help': 'This help',
      'tui.help.quit': 'Quit',
      'tui.help.quitKeys': 'q or Ctrl+C',
      'tui.help.legend': 'Legend',
      'tui.help.loop': 'loop tangent',
      'tui.help.loopText': 'a piece here can turn into the loop and capture',
      'tui.help.dot': 'destination',
      'tui.help.dotText': 'hollow circles: where the selected piece can move to',
      'tui.help.enemy': 'an enemy piece that can be captured',
      'tui.help.trail': 'the capture path: at least one corner loop must be ridden',
      'tui.help.play': 'How it plays',
      'tui.help.playText1': 'Moves are one step in any of eight directions. A capture',
      'tui.help.playText2': 'travels to a corner loop, rides three-quarters of the',
      'tui.help.playText3': 'circle, comes back on the next line and lands on the',
      'tui.help.playText4': 'first enemy piece met. Capture all 12 pieces to win.',
      'tui.usage.lang': 'UI language: zh or en (English by default; L switches)',
      'tui.usage.line': 'Usage: ',
      'tui.usage.options': 'Options: ',
      'tui.usage.server': 'backend address, default {url}',
      'tui.usage.noColor': 'no ANSI escapes (Unicode glyphs kept)',
      'tui.usage.plain': 'plain ASCII, no colour; good for logs',
      'tui.usage.help': 'show this help',
      'tui.usage.keys': 'Keys: ',
      'tui.usage.needBackend': 'Start the backend first: node server.js --port 8123',
      'tui.captureMark': 'capture',
      'tui.disconnected': 'disconnected',
      'tui.badUrl': 'Invalid server address: {url}',
      'tui.timeout': 'The request timed out',
      'tui.responseTooLarge': 'the backend response was too large',

      'server.started': 'Surakarta backend is running',
      'server.web': '  Web UI:  {url}',
      'server.tui': '  Terminal UI: node tui.js --server {url}',
      'server.shared': '  Both share the same game, and can be open at once. Press Ctrl+C to stop.',
      'server.portBusy': 'Port {port} is already in use. Try another one: node server.js --port {next}',
      'server.failed': 'Could not start the service: {error}',
      'server.stopped': 'Service stopped.',
      'server.usage': 'Usage: node server.js [--port 8123] [--host 127.0.0.1] [--lang zh|en]'
    }
  };

  function isLocale(code) {
    return Object.prototype.hasOwnProperty.call(MESSAGES, code);
  }

  /** 规整一个语言标记（"zh-CN"、"en_US" → "zh" / "en"），不认识就返回默认语言 */
  function normalize(preferred) {
    if (preferred) {
      var code = String(preferred).trim().toLowerCase().split(/[._-]/)[0];
      if (isLocale(code)) return code;
    }
    return DEFAULT_LOCALE;
  }

  /** 把 {name} 占位符替换成实际值 */
  function fill(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, function (whole, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole;
    });
  }

  /**
   * 取词。语言不认识或词条缺失时逐级回退：
   * 目标语言 → 其它语言 → 词条名本身（漏翻会一眼看出来，而不是显示空白）。
   */
  function t(locale, key, params) {
    var text = MESSAGES[locale] ? MESSAGES[locale][key] : undefined;
    if (text === undefined) text = MESSAGES[DEFAULT_LOCALE][key];
    if (text === undefined) {
      for (var i = 0; i < LOCALES.length; i++) {
        if (MESSAGES[LOCALES[i].code][key] !== undefined) { text = MESSAGES[LOCALES[i].code][key]; break; }
      }
    }
    if (text === undefined) return key;
    return fill(text, params);
  }

  function sideName(locale, side, short) {
    var key = side === 2
      ? (short ? 'side.redShort' : 'side.red')
      : (short ? 'side.blackShort' : 'side.black');
    return t(locale, key);
  }

  function levelName(locale, key) {
    return t(locale, 'level.' + key);
  }

  /** 交叉点名字，如 a2；与语言无关 */
  function cellName(cell, size) {
    size = size || 6;
    return String.fromCharCode(97 + (cell % size)) + (Math.floor(cell / size) + 1);
  }

  /** 把一条结构化着法渲染成文字 */
  function formatMove(locale, move, size) {
    var text = t(locale, 'move.text', {
      side: sideName(locale, move.side, true),
      from: cellName(move.from, size),
      to: cellName(move.to, size)
    });
    if (move.capture) text += t(locale, 'move.captureSuffix');
    return text;
  }

  function formatJudge(locale, judge) {
    if (judge.winner === 1) return t(locale, 'judge.blackWins', { a: judge.black, b: judge.red });
    if (judge.winner === 2) return t(locale, 'judge.redWins', { a: judge.red, b: judge.black });
    return t(locale, 'judge.draw', { n: judge.black });
  }

  /** 把结构化的终局结果渲染成文字；对局进行中返回空串 */
  function formatResult(locale, result) {
    if (!result) return '';
    var judge;
    switch (result.kind) {
      case 'wipeout':
        return t(locale, 'result.wipeout', { winner: sideName(locale, result.winner) });
      case 'agreed':
        judge = formatJudge(locale, result.counts);
        return t(locale, 'result.agreed', { judge: judge });
      case 'stalemate':
        judge = formatJudge(locale, result.counts);
        return t(locale, 'result.stalemate', { side: sideName(locale, result.side), judge: judge });
      case 'aiError':
        return t(locale, 'result.aiError', { error: t(locale, 'err.illegalMove', {
          from: result.from, to: result.to }) });
      default:
        return '';
    }
  }

  var api = {
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    LOCALES: LOCALES,
    MESSAGES: MESSAGES,
    isLocale: isLocale,
    normalize: normalize,
    t: t,
    sideName: sideName,
    levelName: levelName,
    cellName: cellName,
    formatMove: formatMove,
    formatJudge: formatJudge,
    formatResult: formatResult
  };

  global.SurakartaI18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
