const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const rooms = new Map();
const rateBuckets = new Map();
const roomCreateBuckets = new Map();
const COUNTDOWN_MS = 3000;
const ROUND_MS = 210000;
const INITIAL_ROUND_MS = 90000;
const INITIAL_DESCRIPTION_HINT_MS = 6000;
const INITIAL_LETTER_HINT_MS = 12000;
const INITIAL_QUESTION_MS = 20000;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 90;
const READY_IDLE_KICK_MS = 0;
const SSE_KEEPALIVE_MS = 15000;
const SOLO_WAITING_ROOM_TTL_MS = 10 * 60000;
const MAX_BODY_BYTES = 10000;
const MAX_ACTIVE_ROOMS_PER_IP = 5;
const ROOM_CREATE_WINDOW_MS = 10 * 60000;
const ROOM_CREATE_MAX = 8;
const RATE_LIMIT_RULES = {
  "GET /api/rooms": { windowMs: 10000, max: 30 },
  "GET /events": { windowMs: 60000, max: 20 },
  "POST /api/room": { windowMs: 60000, max: 6 },
  "POST /api/join": { windowMs: 60000, max: 20 },
  "POST /api/start": { windowMs: 60000, max: 20 },
  "POST /api/initial-guess": { windowMs: 10000, max: 40 },
  "POST /api/result": { windowMs: 60000, max: 45 },
  "POST /api/chat": { windowMs: 60000, max: 20 },
  "POST /api/length": { windowMs: 60000, max: 20 },
  "POST /api/ready": { windowMs: 60000, max: 30 },
  "POST /api/leave": { windowMs: 60000, max: 30 },
  "POST /api/kick": { windowMs: 60000, max: 20 }
};
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains"
};

function parseAnswerBlock(html, name) {
  const block = html.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!block) throw new Error(`${name} not found in index.html`);
  return [...block[1].matchAll(/word: "([^"]+)", jamo: \[([^\]]+)\]/g)].map((match) => ({
    word: match[1],
    jamo: [...match[2].matchAll(/"([^"]+)"/g)].map((item) => item[1])
  }));
}

function loadAnswers() {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  return {
    5: parseAnswerBlock(html, "ANSWERS_5"),
    6: parseAnswerBlock(html, "ANSWERS_6")
  };
}

const answers = loadAnswers();
const invalidInitialWords = new Set(["강아", "누룽", "자물"]);
const initialAnswers = answers[5].filter((answer) => (
  [...answer.word].length === 2
  && !invalidInitialWords.has(answer.word)
  && makeInitialDescription(answer.word)
));

function sendJson(res, status, body) {
  res.writeHead(status, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function getClientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function consumeBucket(store, key, windowMs, max) {
  const now = Date.now();
  const bucket = store.get(key) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  store.set(key, bucket);
  return bucket.count > max;
}

function isRateLimited(req, pathname) {
  const rule = RATE_LIMIT_RULES[`${req.method} ${pathname}`] || { windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX };
  return consumeBucket(rateBuckets, `${getClientIp(req)}:${req.method}:${pathname}`, rule.windowMs, rule.max);
}

function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function normalizeRoomCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
}

function clampTries(value) {
  const tries = Number(value);
  if (!Number.isFinite(tries)) return 0;
  return Math.max(0, Math.min(5, Math.floor(tries)));
}

function countActiveRoomsForIp(ip) {
  let count = 0;
  for (const room of rooms.values()) {
    if (room.ownerIp === ip) count += 1;
  }
  return count;
}

function findWaitingRoomByClientId(clientId) {
  if (!clientId) return null;
  for (const room of rooms.values()) {
    if (room.started || room.countdownUntil) continue;
    for (const player of room.players.values()) {
      if (player.clientId === clientId) return { room, player };
    }
  }
  return null;
}

function sweepBuckets() {
  const now = Date.now();
  for (const store of [rateBuckets, roomCreateBuckets]) {
    for (const [key, bucket] of store.entries()) {
      if (bucket.resetAt <= now) store.delete(key);
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("요청이 너무 큽니다"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON을 읽을 수 없습니다"));
      }
    });
  });
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? makeRoomCode() : code;
}

function makePlayerId() {
  return crypto.randomBytes(8).toString("hex");
}

function cleanClientId(clientId) {
  return String(clientId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function cleanName(name) {
  return String(name || "손님").trim().replace(/\s+/g, " ").slice(0, 14) || "손님";
}

function cleanGameMode(mode) {
  return mode === "initial" ? "initial" : "jamo";
}

const INITIALS = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

function getInitialsFromWord(word) {
  const initials = [];
  for (const char of String(word || "")) {
    const code = char.charCodeAt(0);
    if (code < 0xac00 || code > 0xd7a3) continue;
    initials.push(INITIALS[Math.floor((code - 0xac00) / 588)]);
  }
  return initials;
}

function getInitialKey(word) {
  return getInitialsFromWord(word).join("");
}

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    countdownUntil: room.countdownUntil,
    endsAt: room.endsAt,
    gameMode: cleanGameMode(room.gameMode),
    wordLength: room.wordLength,
    chat: room.chat.slice(-30),
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      ready: player.ready,
      result: player.result,
      tries: player.tries,
      score: player.score || 0,
      leftRound: Boolean(player.leftRound),
      finishedAt: player.finishedAt
    })).sort((a, b) => {
      if (a.finishedAt && b.finishedAt) return a.finishedAt - b.finishedAt;
      if (a.finishedAt) return -1;
      if (b.finishedAt) return 1;
      return a.name.localeCompare(b.name, "ko");
    })
  };
}

function broadcast(room, message) {
  const text = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of room.clients) {
    client.write(text);
  }
}

function sendToPlayer(room, playerId, message) {
  const text = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of room.clients) {
    if (client.playerId === playerId) client.write(text);
  }
}

function broadcastState(room) {
  broadcast(room, { type: "state", state: publicState(room) });
}

function broadcastSystem(room, text) {
  const message = { id: makePlayerId(), name: "알림", text, at: Date.now(), system: true };
  room.chat.push(message);
  room.chat = room.chat.slice(-30);
  broadcast(room, { type: "chat", message });
}

function closeRoom(room, reason) {
  broadcast(room, { type: "roomClosed", reason });
  for (const client of room.clients) {
    client.end();
  }
  if (room.timer) clearTimeout(room.timer);
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  if (room.initialHintTimer) clearTimeout(room.initialHintTimer);
  if (room.initialLetterHintTimer) clearTimeout(room.initialLetterHintTimer);
  if (room.initialQuestionTimer) clearTimeout(room.initialQuestionTimer);
  rooms.delete(room.code);
}

function publicRoomList() {
  return [...rooms.values()]
    .filter((room) => !room.started && !room.countdownUntil && room.players.size > 0 && room.players.size < 5)
    .map((room) => ({
      code: room.code,
      count: room.players.size,
      gameMode: cleanGameMode(room.gameMode),
      wordLength: room.wordLength,
      hostName: room.players.get(room.hostId)?.name || "방장"
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function removePlayer(room, playerId, options = {}) {
  const player = requirePlayer(room, playerId);
  const name = player.name;
  const kicked = Boolean(options.kicked);
  const reason = options.reason || (kicked ? "강퇴당했습니다." : "방에서 나갔어요");
  const notice = options.notice || `${name}님이 ${kicked ? "강퇴당했습니다." : "나가셨습니다."}`;
  sendToPlayer(room, player.id, { type: kicked ? "kicked" : "left", reason });
  room.players.delete(player.id);
  if (room.players.size === 0) {
    if (room.timer) clearTimeout(room.timer);
    if (room.countdownTimer) clearTimeout(room.countdownTimer);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === player.id) {
    room.hostId = [...room.players.keys()][0];
    const host = room.players.get(room.hostId);
    if (host) host.ready = true;
  }
  broadcastState(room);
  broadcastSystem(room, notice);
}

function sweepIdlePlayers() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.started || room.countdownUntil) continue;
    if (room.players.size === 1 && now - (room.createdAt || now) >= SOLO_WAITING_ROOM_TTL_MS) {
      closeRoom(room, "10분 동안 혼자 남아 있어 방이 자동으로 닫혔어요.");
      continue;
    }
    for (const player of [...room.players.values()]) {
      if (!READY_IDLE_KICK_MS || player.id === room.hostId || player.ready) continue;
      if (now - (player.lastActive || player.joinedAt || now) >= READY_IDLE_KICK_MS) {
        removePlayer(room, player.id, { kicked: true, reason: "30초 동안 준비하지 않아 자동 강퇴됐어요" });
      }
    }
  }
}

function finishTimedOutPlayers(room) {
  if (!room.started) return;
  if (cleanGameMode(room.gameMode) === "initial") {
    finishInitialRound(room);
    return;
  }
  const now = Date.now();
  for (const player of room.players.values()) {
    if (!player.result) {
      player.result = "loss";
      player.tries = 0;
      player.finishedAt = now;
    }
  }
  room.started = false;
  room.countdownUntil = 0;
  room.endsAt = 0;
  room.timer = null;
  room.countdownTimer = null;
  for (const player of room.players.values()) {
    player.ready = player.id === room.hostId;
    player.leftRound = false;
  }
  broadcast(room, { type: "timeout", state: publicState(room) });
}

function finishInitialRound(room) {
  if (!room.started) return;
  const now = Date.now();
  const players = [...room.players.values()].filter((player) => !player.leftRound);
  const highScore = Math.max(0, ...players.map((player) => player.score || 0));
  for (const player of room.players.values()) {
    player.result = !player.leftRound && highScore > 0 && (player.score || 0) === highScore ? "win" : "loss";
    player.tries = player.score || 0;
    player.finishedAt = now;
  }
  finishRound(room);
  broadcast(room, { type: "timeout", state: publicState(room) });
}

function finishRound(room) {
  room.started = false;
  room.countdownUntil = 0;
  room.endsAt = 0;
  if (room.timer) clearTimeout(room.timer);
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  if (room.initialHintTimer) clearTimeout(room.initialHintTimer);
  if (room.initialLetterHintTimer) clearTimeout(room.initialLetterHintTimer);
  if (room.initialQuestionTimer) clearTimeout(room.initialQuestionTimer);
  room.timer = null;
  room.countdownTimer = null;
  room.initialHintTimer = null;
  room.initialLetterHintTimer = null;
  room.initialQuestionTimer = null;
  room.initialQuestionStartedAt = 0;
  for (const player of room.players.values()) {
    player.ready = player.id === room.hostId;
    player.leftRound = false;
  }
}

function finishRoundWithWinner(room, winnerId, loserIds = []) {
  const now = Date.now();
  for (const player of room.players.values()) {
    if (player.id === winnerId) {
      player.result = "win";
      player.tries = player.tries || 0;
      player.finishedAt = player.finishedAt || now;
    } else if (loserIds.length === 0 || loserIds.includes(player.id) || !player.result) {
      player.result = "loss";
      player.tries = player.tries || 0;
      player.finishedAt = player.finishedAt || now;
    }
  }
  finishRound(room);
  broadcastState(room);
}

function leaveDuringRound(room, playerId) {
  const player = requirePlayer(room, playerId);
  if (!room.started) {
    removePlayer(room, playerId, { reason: "방에서 나갔어요" });
    return;
  }

  const now = Date.now();
  const players = [...room.players.values()];
  if (players.length === 2) {
    const winner = players.find((item) => item.id !== player.id);
    if (winner) finishRoundWithWinner(room, winner.id, [player.id]);
    return;
  }

  if (!player.result) {
    player.result = "loss";
    player.tries = 0;
    player.finishedAt = now;
  }
  player.leftRound = true;
  player.ready = false;
  sendToPlayer(room, player.id, { type: "roundLeft", state: publicState(room) });
  const activePlayers = [...room.players.values()].filter((item) => !item.result && !item.leftRound);
  if (activePlayers.length === 1) {
    finishRoundWithWinner(room, activePlayers[0].id);
    return;
  }
  if (activePlayers.length === 0) {
    finishRound(room);
  }
  broadcastState(room);
}

function requireRoom(code) {
  const room = rooms.get(normalizeRoomCode(code));
  if (!room) throw new Error("방을 찾을 수 없습니다");
  return room;
}

function requirePlayer(room, playerId) {
  const player = room.players.get(String(playerId || ""));
  if (!player) throw new Error("참가자를 찾을 수 없습니다");
  return player;
}

function pickAnswer(previousWord = "", wordLength = 5) {
  const list = answers[wordLength] || answers[5];
  if (list.length <= 1) return list[0];
  let answer = list[Math.floor(Math.random() * list.length)];
  while (answer.word === previousWord) {
    answer = list[Math.floor(Math.random() * list.length)];
  }
  return answer;
}

function pickInitialAnswer(previousWord = "") {
  const list = initialAnswers.length ? initialAnswers : answers[5];
  if (list.length <= 1) return list[0];
  let answer = list[Math.floor(Math.random() * list.length)];
  while (answer.word === previousWord) {
    answer = list[Math.floor(Math.random() * list.length)];
  }
  return answer;
}

function makeInitialDescription(word) {
  const text = String(word || "");
  const directHints = {
    가게: "물건을 사고파는 작은 상점이에요.",
    가격: "물건을 살 때 내야 하는 돈의 양이에요.",
    가방: "물건을 넣고 들고 다니는 물건이에요.",
    가슴: "몸의 앞쪽 위, 심장이 있는 부위예요.",
    가위: "종이나 천을 자를 때 쓰는 도구예요.",
    가을: "여름 다음, 낙엽이 지고 선선해지는 계절이에요.",
    가정: "가족이 함께 생활하는 집이나 생활 단위를 뜻해요.",
    가족: "부모, 형제처럼 가까운 집안 사람들이에요.",
    가죽: "동물의 피부를 가공해 만든 재료예요.",
    각도: "두 선이나 면이 벌어진 정도를 나타내는 말이에요.",
    감기: "기침, 콧물, 열이 나는 흔한 병이에요.",
    감자: "땅속에서 나는 둥근 작물로 튀김이나 찜으로 먹어요.",
    개미: "작고 부지런히 줄지어 다니는 곤충이에요.",
    거울: "내 모습이 비쳐 보이는 물건이에요.",
    겨울: "눈이 오고 날씨가 추운 계절이에요.",
    경기: "운동이나 시합에서 승부를 겨루는 일이에요.",
    경치: "눈으로 보는 자연이나 주변의 아름다운 모습이에요.",
    고래: "바다에 사는 아주 큰 포유류예요.",
    고민: "마음속으로 걱정하며 깊이 생각하는 일이에요.",
    고집: "자기 생각을 쉽게 바꾸지 않는 태도예요.",
    공기: "우리가 숨 쉴 때 필요한 보이지 않는 기체예요.",
    공부: "지식이나 기술을 배우는 일이에요.",
    공포: "무섭고 두려운 느낌이에요.",
    과자: "바삭하거나 달콤하게 먹는 간식이에요.",
    교실: "학생들이 수업을 듣는 방이에요.",
    교통: "사람이나 차가 오가고 이동하는 일과 관련돼요.",
    구경: "무언가를 눈으로 보고 즐기는 일이에요.",
    구름: "하늘에 떠 있는 물방울이나 얼음 알갱이 덩어리예요.",
    구멍: "뚫려서 비어 있는 자리예요.",
    국가: "국민, 영토, 정부를 가진 큰 공동체예요.",
    국수: "가늘고 긴 면을 삶아 먹는 음식이에요.",
    규칙: "함께 지키기로 정한 약속이나 기준이에요.",
    그늘: "빛이 가려져 어둡거나 서늘한 곳이에요.",
    그림: "선이나 색으로 표현한 모습이에요.",
    금고: "돈이나 귀중품을 안전하게 넣어두는 상자예요.",
    기계: "힘을 이용해 일을 하도록 만든 장치예요.",
    기록: "잊지 않게 글이나 숫자로 남기는 일이에요.",
    기름: "미끄럽고 불에 잘 타는 액체예요.",
    기분: "좋거나 나쁜 마음의 상태예요.",
    기술: "어떤 일을 잘 해내는 방법이나 능력이에요.",
    기억: "지난 일을 머릿속에 간직하는 능력이에요.",
    기온: "공기의 따뜻하고 차가운 정도예요.",
    기준: "판단하거나 비교할 때 삼는 바탕이에요.",
    김치: "배추나 무를 양념해 발효시킨 음식이에요.",
    남자: "성별이 남성인 사람을 가리키는 말이에요.",
    노래: "가락에 맞춰 부르는 소리예요.",
    노력: "목표를 이루려고 힘쓰는 일이에요.",
    농구: "공을 골대에 넣어 점수를 얻는 운동이에요.",
    단서: "문제를 풀거나 사건을 알아내는 실마리예요.",
    단어: "뜻을 가진 말의 작은 단위예요.",
    단추: "옷을 여미거나 잠그는 작은 물건이에요.",
    도움: "다른 사람에게 힘이 되어 주는 일이에요.",
    도장: "이름이나 표시를 찍는 물건 또는 찍은 자국이에요.",
    도전: "어려운 일에 맞서 시도하는 일이에요.",
    도착: "목적지에 다다르는 일이에요.",
    독서: "책을 읽는 일이에요.",
    라면: "면과 수프를 끓여 먹는 간편한 음식이에요.",
    마늘: "음식에 향과 맛을 더하는 매운 채소예요.",
    마당: "집 앞이나 안쪽에 있는 빈터예요.",
    마법: "현실에서 불가능해 보이는 신비한 힘이에요.",
    마술: "손기술이나 장치로 신기하게 보이게 하는 공연이에요.",
    마음: "생각, 감정, 기분이 생기는 안쪽 느낌이에요.",
    만두: "얇은 피에 속을 넣고 빚어 먹는 음식이에요.",
    먼지: "공기 중이나 바닥에 쌓이는 아주 작은 가루예요.",
    메모: "잊지 않으려고 짧게 적어 두는 글이에요.",
    모래: "잘게 부서진 돌 알갱이예요.",
    무게: "물건이 얼마나 무거운지를 나타내는 정도예요.",
    무늬: "겉에 나타나는 모양이나 패턴이에요.",
    무대: "공연이나 발표가 이루어지는 자리예요.",
    무릎: "다리 가운데 접히는 관절 부위예요.",
    문구: "글에 쓰인 말이나 학용품을 뜻하기도 해요.",
    문어: "다리가 여덟 개 달린 바다 생물이에요.",
    미래: "아직 오지 않은 앞으로의 시간이에요.",
    미술: "그림, 조각처럼 눈으로 보는 예술이에요.",
    바늘: "실을 꿰어 바느질할 때 쓰는 가는 도구예요.",
    바닥: "사람이 밟고 서는 아래쪽 면이에요.",
    바둑: "검은 돌과 흰 돌로 집을 겨루는 놀이예요.",
    바람: "공기가 움직이며 느껴지는 흐름이에요.",
    바위: "크고 단단한 돌이에요.",
    바퀴: "굴러가도록 둥글게 만든 물건이에요.",
    박수: "손뼉을 쳐서 칭찬이나 호응을 나타내는 일이에요.",
    반지: "손가락에 끼는 둥근 장신구예요.",
    배려: "다른 사람의 입장을 생각해 챙기는 마음이에요.",
    배우: "영화나 연극에서 역할을 연기하는 사람이에요.",
    배추: "김치를 담글 때 많이 쓰는 잎채소예요.",
    버릇: "자주 반복되어 몸에 밴 행동이에요.",
    버섯: "습한 곳에서 자라는 갓 모양의 식재료예요.",
    번호: "순서나 구분을 위해 붙인 숫자예요.",
    보물: "귀하고 소중하게 여기는 물건이에요.",
    보석: "아름답고 값진 돌이에요.",
    복도: "건물 안에서 방과 방 사이를 이어 주는 길이에요.",
    부엌: "음식을 만들고 조리하는 공간이에요.",
    부채: "바람을 일으키거나 장식으로 쓰는 물건이에요.",
    분노: "몹시 화가 난 감정이에요.",
    분리: "붙어 있던 것을 따로 나누는 일이에요.",
    비밀: "남에게 알리지 않고 숨기는 일이에요.",
    비상: "갑작스럽고 위험한 상황을 뜻해요.",
    사건: "일어나서 문제가 되거나 기억되는 일이에요.",
    사과: "빨갛거나 초록빛이 나는 둥근 과일이에요.",
    사냥: "동물을 잡거나 쫓는 일이에요.",
    사람: "생각하고 말하며 살아가는 존재예요.",
    사랑: "아끼고 좋아하는 깊은 마음이에요.",
    사막: "비가 적고 모래가 많은 넓은 땅이에요.",
    사슴: "뿔이 나고 숲에 사는 동물이에요.",
    사진: "카메라로 남긴 장면이에요.",
    산소: "숨 쉬는 데 꼭 필요한 기체예요.",
    상어: "바다에 사는 날카로운 이빨의 물고기예요.",
    상자: "물건을 넣는 네모난 통이에요.",
    상처: "몸이 다치거나 마음이 아플 때 남는 흔적이에요.",
    서랍: "책상이나 장 안에 밀어 넣고 빼는 보관 공간이에요.",
    서점: "책을 파는 가게예요.",
    세수: "얼굴을 씻는 일이에요.",
    소금: "짠맛을 내는 하얀 조미료예요.",
    소망: "이루어지기를 바라는 마음이에요.",
    소문: "사람들 사이에 퍼지는 이야기예요.",
    소설: "상상하거나 꾸민 이야기를 글로 쓴 작품이에요.",
    속도: "움직임이 빠르거나 느린 정도예요.",
    수건: "물기를 닦을 때 쓰는 천이에요.",
    수면: "잠을 자는 상태를 뜻해요.",
    수박: "초록 껍질과 빨간 속을 가진 여름 과일이에요.",
    수술: "병을 고치려고 몸을 치료하는 의료 행위예요.",
    수업: "선생님에게 배우는 시간이에요.",
    수영: "물속에서 몸을 움직여 나아가는 운동이에요.",
    수학: "숫자와 도형, 계산을 배우는 학문이에요.",
    숫자: "수를 나타내는 기호예요.",
    시간: "시계로 재거나 약속을 정할 때 쓰는 개념이에요.",
    시계: "시간을 알려 주는 물건이에요.",
    시장: "물건을 사고파는 곳이에요.",
    신호: "뜻을 전하기 위한 표시나 소리예요.",
    실수: "잘못하거나 놓쳐서 생긴 틀림이에요.",
    아침: "하루가 시작되는 이른 시간이에요.",
    악기: "음악을 연주할 때 쓰는 도구예요.",
    엄마: "나를 낳았거나 길러 준 어머니를 부르는 말이에요.",
    여름: "덥고 햇빛이 강한 계절이에요.",
    역사: "과거에 있었던 일들의 기록이에요.",
    연구: "깊이 조사하고 살펴보는 일이에요.",
    열차: "철길 위를 달리는 여러 칸의 차량이에요.",
    영어: "세계 여러 나라에서 쓰이는 언어 중 하나예요.",
    온도: "따뜻하거나 차가운 정도를 나타내는 수치예요.",
    우물: "땅을 파서 물을 길어 올리는 곳이에요.",
    우산: "비를 막으려고 쓰는 물건이에요.",
    우정: "친구 사이의 믿음과 정이에요.",
    위기: "위험하고 어려운 상황이에요.",
    위로: "힘든 사람의 마음을 달래 주는 일이에요.",
    음료: "마시는 물이나 주스 같은 것을 뜻해요.",
    의자: "앉을 때 쓰는 가구예요.",
    이름: "사람이나 사물을 부르는 말이에요.",
    이별: "서로 헤어지는 일이에요.",
    이불: "잘 때 몸을 덮는 침구예요.",
    이웃: "가까운 곳에 사는 사람이나 집이에요.",
    인기: "많은 사람에게 좋아하고 관심받는 정도예요.",
    인사: "만나거나 헤어질 때 예의를 나타내는 말이나 행동이에요.",
    일기: "하루 동안 겪은 일을 적는 글이에요.",
    입구: "안으로 들어가는 문이나 길목이에요.",
    자석: "쇠붙이를 끌어당기는 물건이에요.",
    자연: "사람이 만들지 않은 산, 강, 숲 같은 세계예요.",
    자음: "한글에서 ㄱ, ㄴ 같은 소리 글자예요.",
    작가: "글이나 작품을 만드는 사람이에요.",
    잔디: "마당이나 운동장에 낮게 깔린 풀예요.",
    잠수: "물속으로 들어가거나 물속에 머무는 일이에요.",
    장마: "비가 오래 계속 내리는 시기예요.",
    장미: "가시가 있고 향기로운 꽃이에요.",
    장소: "어떤 일이 일어나는 곳이에요.",
    재료: "무언가를 만들 때 바탕이 되는 물건이에요.",
    재미: "즐겁고 흥미로운 느낌이에요.",
    저금: "돈을 모아 두는 일이에요.",
    저녁: "해가 지는 무렵이나 그때 먹는 식사예요.",
    저울: "무게를 재는 도구예요.",
    전구: "전기로 빛을 내는 물건이에요.",
    전기: "불을 켜고 기계를 움직이게 하는 에너지예요.",
    점수: "시험이나 경기에서 얻은 숫자예요.",
    정리: "흩어진 것을 가지런히 하거나 내용을 바로잡는 일이에요.",
    정보: "알고 판단하는 데 도움이 되는 내용이에요.",
    제비: "봄에 찾아오는 날렵한 새예요.",
    조각: "작게 나뉜 부분이나 깎아 만든 작품이에요.",
    조개: "단단한 껍데기를 가진 바다 생물이에요.",
    조명: "빛을 비추는 장치나 그 빛이에요.",
    종이: "글씨를 쓰거나 그림을 그리는 얇은 물건이에요.",
    주말: "토요일과 일요일 무렵의 쉬는 날이에요.",
    주먹: "손가락을 모두 쥔 손 모양이에요.",
    주문: "물건이나 음식을 달라고 요청하는 일이에요.",
    주방: "음식을 만드는 공간이에요.",
    주변: "어떤 것의 가까운 둘레예요.",
    주식: "회사의 지분을 나타내는 증권이에요.",
    준비: "일을 하기 전에 미리 갖추는 일이에요.",
    지갑: "돈이나 카드를 넣고 다니는 물건이에요.",
    지붕: "집이나 건물의 위를 덮는 부분이에요.",
    지식: "배우거나 경험해서 알게 된 내용이에요.",
    창고: "물건을 보관해 두는 곳이에요.",
    채소: "밭에서 기르는 먹는 식물이에요.",
    청소: "더러운 것을 치우고 깨끗하게 하는 일이에요.",
    초록: "풀이나 나뭇잎에서 많이 보이는 색이에요.",
    추억: "지난 일을 떠올리며 간직하는 기억이에요.",
    축구: "발로 공을 차서 골을 넣는 운동이에요.",
    친구: "가깝게 지내며 함께 노는 사람이에요.",
    커튼: "창문을 가리거나 장식하는 천이에요.",
    키위: "갈색 껍질과 초록 속을 가진 과일이에요.",
    탁구: "작은 공을 라켓으로 주고받는 운동이에요.",
    토끼: "긴 귀와 짧은 꼬리를 가진 동물이에요.",
    토론: "의견을 나누며 따지는 말하기 활동이에요.",
    편지: "안부나 마음을 적어 보내는 글이에요.",
    표정: "얼굴에 드러나는 감정의 모습이에요.",
    하늘: "구름과 해와 달을 볼 수 있는 위쪽 공간이에요.",
    학교: "학생들이 공부하러 가는 곳이에요.",
    항구: "배가 드나드는 바닷가 시설이에요.",
    호흡: "숨을 들이마시고 내쉬는 일이에요.",
    혼자: "다른 사람 없이 홀로 있는 상태예요.",
    홍보: "많은 사람에게 알리는 일이에요.",
    회사: "사람들이 모여 일을 하는 조직이에요.",
    후배: "나보다 뒤에 들어오거나 어린 사람을 부르는 말이에요.",
    후회: "지난 일을 아쉽게 여기는 마음이에요.",
    목표: "이루려고 정한 대상이나 방향이에요.",
    중요: "가치가 크고 꼭 필요한 상태예요.",
    최고: "가장 높거나 가장 좋은 것을 뜻해요.",
    향기: "좋게 느껴지는 냄새예요.",
    어른: "다 자란 사람을 뜻해요.",
    주인: "물건이나 집을 가진 사람을 뜻해요.",
    하품: "졸리거나 피곤할 때 입을 크게 벌리는 행동이에요.",
    약사: "약을 다루고 설명해 주는 직업의 사람이에요.",
    진료: "의사가 환자를 살펴보고 치료 방향을 정하는 일이에요.",
    접수: "신청이나 서류를 받아 처리하는 일이에요.",
    가락: "노래나 말에서 느껴지는 높낮이와 흐름을 뜻해요.",
    가면: "얼굴을 감추거나 꾸미려고 쓰는 물건이에요.",
    간호: "아픈 사람을 보살피고 회복을 돕는 일이에요.",
    갈비: "가슴 쪽 뼈나 그 부위의 고기를 가리키는 말이에요.",
    강도: "억지로 남의 물건을 빼앗는 범죄나 센 정도를 뜻해요.",
    강사: "학원이나 학교 등에서 강의를 하는 사람이에요.",
    강타: "세게 치거나 큰 영향을 주는 일을 뜻해요.",
    개표: "투표함을 열어 표를 세는 일이에요.",
    건조: "물기나 습기가 말라 없어지는 일이에요.",
    검사: "잘못이나 상태를 살펴 확인하는 일이에요.",
    검토: "내용을 자세히 살펴 따져 보는 일이에요.",
    검표: "표나 승차권이 맞는지 확인하는 일이에요.",
    겨냥: "목표를 향해 방향을 맞추는 일이에요.",
    경고: "위험이나 잘못을 미리 알려 주는 말이에요.",
    경로: "지나가거나 이동하는 길과 순서를 뜻해요.",
    경비: "일에 드는 비용이나 지키는 일을 뜻해요.",
    경주: "누가 더 빠른지 겨루는 일이에요.",
    고개: "목을 포함한 머리 부분이나 넘어가는 언덕길을 뜻해요.",
    고동: "심장이 뛰는 움직임이나 배에서 울리는 소리를 뜻해요.",
    고등: "등급이나 수준이 높은 것을 뜻해요.",
    고속: "매우 빠른 속도를 뜻해요.",
    고함: "크고 세게 지르는 소리예요.",
    공모: "작품이나 의견을 공개적으로 모집하는 일이에요.",
    공터: "집이나 건물이 없이 비어 있는 땅이에요.",
    교대: "차례나 순번을 서로 바꾸는 일이에요.",
    구석: "한쪽 끝의 후미지고 잘 보이지 않는 자리예요.",
    구역: "일정하게 나누어 정한 범위나 지역이에요.",
    구입: "돈을 주고 물건을 사는 일이에요.",
    근무: "직장이나 맡은 자리에서 일을 하는 것이에요.",
    글자: "말을 적는 데 쓰는 하나하나의 기호예요.",
    금리: "빌리거나 맡긴 돈에 붙는 이자의 비율이에요.",
    기념: "뜻깊은 일을 오래 기억하려는 일이에요.",
    기본: "무엇을 이루는 가장 바탕이 되는 것이에요.",
    기상: "날씨와 하늘 상태, 또는 자리에서 일어남을 뜻해요.",
    기와: "지붕을 덮는 데 쓰는 구운 흙 조각이에요.",
    기적: "상식으로 설명하기 어려운 놀라운 일이에요.",
    기회: "무언가를 할 수 있는 좋은 때나 경우예요.",
    길이: "한쪽 끝에서 다른 끝까지의 거리예요.",
    까치: "검고 흰 깃을 가진, 울음소리가 또렷한 새예요.",
    꼬리: "동물 몸의 뒤쪽 끝에 붙은 부분이에요.",
    나름: "각자의 형편이나 생각에 따른 방식을 뜻해요.",
    나물: "먹을 수 있는 풀이나 채소를 무친 음식이에요.",
    나방: "밤에 많이 날아다니는 나비와 비슷한 곤충이에요.",
    나선: "빙빙 돌며 감기는 모양이나 그런 선을 뜻해요.",
    나흘: "네 날을 뜻하는 순우리말이에요.",
    낙지: "다리가 여덟 개이고 갯벌에도 사는 바다 생물이에요.",
    난로: "방이나 실내를 따뜻하게 하는 기구예요.",
    난리: "소란스럽고 어지러운 일을 뜻해요.",
    내기: "승부를 걸고 겨루거나 약속하는 일이에요.",
    노선: "버스나 기차 등이 다니는 정해진 길이에요.",
    노을: "해가 뜨거나 질 때 하늘이 붉게 물드는 현상이에요.",
    노인: "나이가 많은 사람을 뜻해요.",
    논리: "생각이나 말이 이치에 맞게 이어지는 법칙이에요.",
    농부: "농사를 짓는 사람이에요.",
    다락: "집 안의 높은 곳에 만든 작은 공간이에요.",
    다섯: "넷보다 하나 많은 수예요.",
    다짐: "마음을 굳게 먹거나 꼭 약속하는 일이에요.",
    대기: "차례나 때를 기다리는 일, 또는 지구를 둘러싼 공기예요.",
    도둑: "남의 물건을 몰래 훔치는 사람이에요.",
    동료: "같은 일이나 같은 곳에서 함께하는 사람이에요.",
    동요: "어린이가 부르기 좋게 만든 노래예요.",
    두근: "가슴이 뛰는 느낌을 나타내는 말이에요.",
    두뇌: "생각하고 판단하는 머리의 기능을 뜻해요.",
    두통: "머리가 아픈 증상이에요.",
    마감: "일이나 접수를 끝내는 시점이에요.",
    마개: "병이나 구멍을 막는 물건이에요.",
    마을: "여러 집이 모여 사는 곳이에요.",
    말투: "말하는 버릇이나 느낌이 드러나는 방식이에요.",
    먹이: "동물이 먹고 살아가는 음식이에요.",
    멀리: "거리가 많이 떨어진 곳이나 상태를 뜻해요.",
    메뉴: "음식점의 차림표나 선택 목록을 뜻해요.",
    면도: "수염이나 털을 깎는 일이에요.",
    면허: "특정한 일을 할 수 있도록 공식적으로 허락받은 자격이에요.",
    모금: "돈이나 물건을 여러 사람에게서 모으는 일이에요.",
    모범: "본받을 만한 좋은 예나 행동이에요.",
    모습: "겉으로 드러나 보이는 생김새나 상태예요.",
    모음: "한글에서 ㅏ, ㅓ처럼 홀로 소리의 중심이 되는 글자예요.",
    모임: "사람들이 한곳에 모이는 일이나 그 자리예요.",
    무덤: "죽은 사람을 묻은 곳이에요.",
    무역: "나라와 나라 사이에서 물건을 사고파는 일이에요.",
    미궁: "길이 복잡해 빠져나오기 어려운 곳이나 상태예요.",
    미역: "국이나 반찬으로 먹는 바닷말이에요.",
    미움: "밉게 여기는 마음이에요.",
    미팅: "사람들이 만나 의논하거나 교류하는 자리예요.",
    민요: "민간에서 오래 전해 내려오는 노래예요.",
    방구: "배 속 가스가 항문으로 나오는 것을 낮잡아 이르는 말이에요.",
    벽지: "벽에 바르는 종이나 마감재예요.",
    보름: "음력으로 달이 둥글게 차는 열닷새 무렵이에요.",
    보상: "손해나 수고에 대해 갚아 주는 일이에요.",
    본부: "어떤 조직의 중심이 되는 사무소예요.",
    부분: "전체를 이루는 일부예요.",
    분수: "전체를 몇으로 나눈 몫이나 정도를 나타내는 말이에요.",
    비극: "슬프고 불행한 사건이나 그런 내용의 작품이에요.",
    비닐: "얇고 질긴 합성수지 재료예요.",
    비단: "누에고치에서 뽑은 실로 짠 고운 천이에요.",
    비용: "어떤 일을 하는 데 드는 돈이에요.",
    비율: "서로 견주었을 때의 크기나 양의 관계예요.",
    사실: "실제로 있었거나 있는 일을 뜻해요.",
    사의: "고마운 뜻이나 사직하려는 뜻을 나타내는 말이에요.",
    살구: "노란빛이 도는 달콤새콤한 과일이에요.",
    서명: "이름을 직접 쓰거나 표시하는 일이에요.",
    서민: "평범한 생활을 하는 일반 사람들을 뜻해요.",
    서빙: "음식점에서 음식을 손님에게 내는 일이에요.",
    서울: "대한민국의 수도예요.",
    소매: "옷에서 팔을 감싸는 부분이에요.",
    소방: "불을 끄고 화재를 막는 일을 뜻해요.",
    소식: "멀리 있는 사람이나 일의 형편을 알려 주는 말이에요.",
    소풍: "바람을 쐬거나 놀러 밖으로 나가는 일이에요.",
    수상: "상을 받음, 또는 물 위와 관련된 말을 뜻해요.",
    수염: "사람의 턱이나 입가에 나는 털이에요.",
    수첩: "간단한 내용을 적어 두는 작은 책자예요.",
    순서: "일이나 차례가 이어지는 정해진 앞뒤 관계예요.",
    시골: "도시에서 떨어진 농촌이나 지방을 뜻해요.",
    시민: "도시에 살거나 국가·사회 구성원으로서 권리를 가진 사람이에요.",
    시선: "눈이 향하는 방향이나 바라보는 관심이에요.",
    시인: "시를 쓰는 사람이에요.",
    시작: "어떤 일이 처음으로 되는 때나 행동이에요.",
    식구: "한집에서 함께 사는 사람들을 뜻해요.",
    아들: "남자인 자식을 뜻해요.",
    안부: "잘 지내는지 묻거나 전하는 소식이에요.",
    암기: "외워서 기억하는 일이에요.",
    야외: "집이나 건물 밖의 넓은 곳이에요.",
    양보: "자기 차례나 권리를 남에게 내주는 일이에요.",
    양파: "겹겹이 껍질이 있는 매운맛의 채소예요.",
    어둠: "빛이 없어 어두운 상태예요.",
    언니: "여자가 손위 여자 형제를 부르는 말이에요.",
    언어: "생각과 뜻을 전하는 말이나 글의 체계예요.",
    업무: "직장이나 맡은 자리에서 하는 일이에요.",
    연기: "불에 탈 때 나는 기체나, 배우가 역할을 표현하는 일이에요.",
    열기: "뜨거운 기운이나 열띤 분위기를 뜻해요.",
    염소: "수염과 뿔이 있는 가축 동물이에요.",
    오른: "왼쪽의 반대쪽을 가리키는 말이에요.",
    오븐: "음식을 굽거나 데우는 조리 기구예요.",
    오전: "밤 열두 시부터 낮 열두 시까지의 시간이에요.",
    외투: "추위를 막으려고 겉에 입는 옷이에요.",
    요금: "시설이나 서비스를 이용하고 내는 돈이에요.",
    요술: "신기한 재주로 이상한 일을 보이는 기술이에요.",
    용기: "씩씩하게 해내는 마음이나 물건을 담는 그릇을 뜻해요.",
    유명: "이름이 널리 알려져 있는 상태예요.",
    유물: "옛날부터 전해 내려온 물건이나 자취예요.",
    유산: "죽은 사람이 남긴 재산이나 후대에 물려줄 가치를 뜻해요.",
    의류: "몸에 입는 옷 종류를 통틀어 이르는 말이에요.",
    의무: "마땅히 해야 하는 일이나 책임이에요.",
    의미: "말이나 행동이 지니는 뜻이에요.",
    이론: "사물이나 현상을 설명하는 체계적인 생각이에요.",
    이민: "다른 나라로 옮겨 가서 사는 일이에요.",
    이상: "보통과 다르거나, 더 높은 목표를 뜻해요.",
    이슬: "새벽이나 밤에 물방울처럼 맺히는 것이에요.",
    이용: "대상을 필요에 맞게 쓰는 일이에요.",
    자극: "감각이나 마음에 반응을 일으키게 하는 것이에요.",
    자동: "사람이 직접 하지 않아도 저절로 움직이는 방식이에요.",
    자랑: "자기나 남의 좋은 점을 드러내어 말하는 일이에요.",
    자신: "바로 그 사람 스스로를 가리키는 말이에요.",
    자의: "자기 생각이나 뜻에 따른 것을 뜻해요.",
    전자: "전기 현상과 관련된 아주 작은 입자나 전기 장치를 뜻해요.",
    전투: "서로 맞서 싸우는 일을 뜻해요.",
    제기: "의견이나 문제를 내놓는 일, 또는 발로 차는 놀이 도구예요.",
    제도: "사회에서 정해 놓은 규칙이나 조직의 틀이에요.",
    조끼: "소매 없이 몸에 걸쳐 입는 옷이에요.",
    조상: "자기보다 앞선 세대의 어른들이에요.",
    조용: "소리나 움직임이 없이 고요한 상태예요.",
    좌우: "왼쪽과 오른쪽을 아울러 이르는 말이에요.",
    주름: "피부나 천에 생긴 접힌 선이에요.",
    주위: "어떤 것의 둘레나 가까운 곳이에요.",
    주의: "마음을 기울여 조심하거나 살피는 일이에요.",
    지각: "학교나 약속한 시간에 늦는 일이에요.",
    지름: "원이나 공의 중심을 지나 양끝을 잇는 선의 길이예요.",
    지방: "서울이나 중심지에서 떨어진 지역, 또는 몸속 기름 성분을 뜻해요.",
    지점: "어떤 곳의 한 위치나 갈라져 나온 사무소를 뜻해요.",
    차례: "정해진 순서나 돌아오는 번이에요.",
    차림: "옷을 입거나 음식을 차려 놓은 모양이에요.",
    참기: "하고 싶은 것을 누르고 견디는 일이에요.",
    처방: "의사가 약이나 치료 방법을 정해 주는 일이에요.",
    철도: "기차가 다니는 쇠길이나 그 교통 체계를 뜻해요.",
    초대: "사람을 불러 오게 하는 일이에요.",
    추락: "높은 곳에서 아래로 떨어지는 일이에요.",
    출구: "밖으로 나가는 문이나 길이에요.",
    취미: "즐기려고 하는 일이나 좋아하는 활동이에요.",
    타격: "때려 치는 일이나 큰 손해를 입히는 일을 뜻해요.",
    타일: "벽이나 바닥에 붙이는 얇은 판 모양의 마감재예요.",
    태도: "말이나 행동에서 드러나는 마음가짐이에요.",
    토막: "잘라진 한 부분이나 짧은 조각이에요.",
    통로: "사람이나 물건이 지나가는 길이에요.",
    파랑: "맑은 하늘이나 바다에서 볼 수 있는 푸른빛 색이에요.",
    파일: "서류를 끼워 두는 물건이나 컴퓨터 자료 묶음이에요.",
    편리: "이용하기 쉽고 편한 상태예요.",
    포근: "따뜻하고 부드럽게 느껴지는 상태예요.",
    포장: "물건을 싸거나 꾸리는 일이에요.",
    한우: "한국에서 기르는 고기소 품종이에요.",
    허공: "아무것도 잡히지 않는 빈 공중이에요.",
    현미: "겉껍질만 벗겨 낸 쌀이에요.",
    화로: "숯이나 불을 담아 난방이나 조리에 쓰는 그릇이에요.",
    모험: "위험을 무릅쓰고 새롭거나 어려운 일을 해 보는 것이에요.",
    차별: "둘 이상의 대상을 다르게 대우하는 일이에요.",
    거실: "집에서 가족이 함께 지내는 중심 공간이에요.",
    거품: "액체 표면에 생기는 공기 방울이에요.",
    다음: "어떤 것의 바로 뒤나 뒤따르는 차례예요.",
    보건: "건강을 지키고 병을 예방하는 일을 뜻해요.",
    초점: "관심이나 빛, 시선이 모이는 중심점이에요.",
    기능: "어떤 것이 할 수 있는 역할이나 작용이에요."
  };
  const hints = {
    수박: "초록 껍질과 빨간 속을 가진 여름 과일이에요.",
    운동: "건강해지려면 몸을 움직이며 꾸준히 해야 하는 일이에요.",
    학교: "학생들이 공부하러 가는 곳이에요.",
    바다: "넓고 짠물이 가득한 곳이에요.",
    하늘: "구름과 해와 달을 볼 수 있는 위쪽 공간이에요.",
    의자: "앉을 때 쓰는 가구예요.",
    책상: "책을 펴거나 글을 쓸 때 쓰는 가구예요.",
    사과: "빨갛거나 초록빛이 나는 둥근 과일이에요.",
    버스: "여러 사람이 함께 타는 대중교통이에요.",
    기차: "철길 위를 달리는 긴 교통수단이에요.",
    사진: "카메라로 남긴 장면이에요.",
    음악: "소리와 리듬으로 듣는 예술이에요.",
    영화: "화면으로 이야기를 보여주는 작품이에요.",
    가족: "부모, 형제처럼 가까운 집안 사람들이에요.",
    친구: "가깝게 지내며 함께 노는 사람이에요.",
    시간: "시계로 재거나 약속을 정할 때 쓰는 개념이에요.",
    시장: "물건을 사고파는 곳이에요.",
    병원: "아픈 사람이 진료받으러 가는 곳이에요.",
    공원: "산책하거나 쉬러 가는 넓은 쉼터예요.",
    전화: "멀리 있는 사람과 말할 때 쓰는 수단이에요.",
    모자: "머리에 쓰는 물건이에요.",
    신발: "발에 신고 걷는 물건이에요.",
    연필: "글씨를 쓰거나 그림을 그릴 때 쓰는 도구예요.",
    냉장: "차갑게 보관하는 것과 관련된 말이에요.",
    커피: "볶은 원두로 만드는 향이 강한 음료예요.",
    과자: "바삭하거나 달콤하게 먹는 간식이에요.",
    김치: "배추나 무를 양념해 발효시킨 음식이에요.",
    구름: "하늘에 떠 있는 하얗거나 회색의 물방울 덩어리예요.",
    마음: "기분이나 생각이 생기는 안쪽 느낌이에요.",
    사람: "생각하고 말하며 살아가는 존재예요."
    ,상처: "몸이 다치거나 마음이 아플 때 남는 흔적이에요."
    ,수치: "숫자로 나타낸 정도나 값을 뜻해요."
    ,성취: "노력해서 목표를 이루었을 때 쓰는 말이에요."
    ,신체: "머리, 팔, 다리처럼 몸 전체를 가리키는 말이에요."
    ,사치: "필요 이상으로 돈이나 물건을 화려하게 쓰는 일이에요."
    ,선착: "먼저 도착하는 것과 관련된 말이에요."
  };
  const foodWords = new Set(["갈비", "감자", "과자", "국수", "김치", "나물", "낙지", "라면", "마늘", "만두", "먹이", "문어", "미역", "배추", "버섯", "비닐", "사과", "살구", "소금", "수박", "양파", "오븐", "음료", "키위", "한우", "현미"]);
  const animalWords = new Set(["개미", "고래", "까치", "나방", "문어", "사슴", "상어", "염소", "제비", "조개", "토끼"]);
  const placeWords = new Set(["가게", "공터", "교실", "구석", "구역", "다락", "마당", "마을", "무대", "무덤", "복도", "부엌", "사막", "서울", "서점", "시장", "야외", "우물", "입구", "장소", "창고", "출구", "통로", "하늘", "학교", "항구", "허공", "회사", "거실"]);
  const objectWords = new Set(["가방", "가위", "거울", "금고", "기계", "기와", "단추", "도장", "메모", "모자", "문구", "바늘", "바닥", "반지", "벽지", "보석", "부채", "비단", "사진", "상자", "서랍", "소매", "수건", "수첩", "시계", "악기", "우산", "외투", "의류", "의자", "이불", "입구", "자석", "잔디", "재료", "저울", "전구", "전자", "종이", "지갑", "지붕", "채소", "커튼", "타일", "파일", "편지", "포장", "화로"]);
  const personWords = new Set(["강사", "남자", "노인", "동료", "배우", "사람", "서민", "시민", "시인", "식구", "아들", "언니", "엄마", "작가", "조상", "주인", "친구", "후배", "약사", "어른"]);
  const feelingWords = new Set(["고민", "기분", "마음", "미움", "분노", "사랑", "소망", "우정", "위로", "재미", "추억", "후회", "향기"]);
  const studyWorkWords = new Set(["간호", "검사", "검토", "공부", "교대", "근무", "기록", "기술", "기억", "기준", "독서", "업무", "역사", "연구", "영어", "이론", "일기", "정보", "제도", "처방", "토론", "진료", "접수", "기능"]);
  const numberMeasureWords = new Set(["가격", "각도", "금리", "길이", "무게", "번호", "비용", "비율", "분수", "속도", "숫자", "시간", "온도", "요금", "점수"]);
  const actionWords = new Set(["개표", "건조", "겨냥", "공모", "구경", "구입", "기념", "도움", "도전", "도착", "면도", "모금", "모임", "무역", "미팅", "박수", "배려", "보상", "분리", "사냥", "서명", "서빙", "세수", "소방", "소풍", "수면", "수술", "수업", "수영", "암기", "양보", "연기", "이민", "이별", "이용", "인사", "자동", "자랑", "잠수", "정리", "조명", "주문", "준비", "지각", "참기", "청소", "초대", "추락", "축구", "탁구", "타격", "포장", "홍보"]);
  if (hints[text]) return hints[text];
  if (foodWords.has(text)) return "먹거나 마시는 것과 관련된 단어예요.";
  if (animalWords.has(text)) return "살아 움직이는 동물과 관련된 단어예요.";
  if (placeWords.has(text)) return "사람이 가거나 머무를 수 있는 장소와 관련된 단어예요.";
  if (objectWords.has(text)) return "손으로 만지거나 사용할 수 있는 물건과 관련된 단어예요.";
  if (personWords.has(text)) return "사람이나 사람의 역할을 가리키는 단어예요.";
  if (feelingWords.has(text)) return "감정이나 마음속 느낌과 관련된 단어예요.";
  if (studyWorkWords.has(text)) return "공부, 일, 지식과 관련된 단어예요.";
  if (numberMeasureWords.has(text)) return "숫자, 기준, 크기나 양을 나타낼 때 쓰는 단어예요.";
  if (actionWords.has(text)) return "사람이 하는 행동이나 활동과 관련된 단어예요.";
  return "";
}

function makeInitialLetterHint(answer, index = 0) {
  const letters = [...String(answer?.word || "")];
  if (!letters.length) return null;
  const safeIndex = index === 1 && letters.length > 1 ? 1 : 0;
  return { index: safeIndex, letter: letters[safeIndex] };
}

function makeInitialHint(answer, elapsed = 0, letterIndex = 0) {
  if (elapsed < INITIAL_DESCRIPTION_HINT_MS) return null;
  const description = makeInitialDescription(answer?.word);
  if (!description) return null;
  const hint = { description };
  if (elapsed >= INITIAL_LETTER_HINT_MS) hint.letterHint = makeInitialLetterHint(answer, letterIndex);
  return hint;
}

function resetInitialHint(room, startedAt = Date.now()) {
  if (room.initialHintTimer) clearTimeout(room.initialHintTimer);
  if (room.initialLetterHintTimer) clearTimeout(room.initialLetterHintTimer);
  room.initialQuestionStartedAt = startedAt;
  room.initialHintIndex = Math.random() < 0.5 ? 0 : 1;
  room.initialHintTimer = null;
  room.initialLetterHintTimer = null;
}

function currentInitialHint(room) {
  if (!room || !room.answer || !room.initialQuestionStartedAt) return null;
  return makeInitialHint(room.answer, Date.now() - room.initialQuestionStartedAt, room.initialHintIndex);
}

function scheduleInitialHint(room) {
  if (room.initialHintTimer) clearTimeout(room.initialHintTimer);
  if (room.initialLetterHintTimer) clearTimeout(room.initialLetterHintTimer);
  if (!room.started || cleanGameMode(room.gameMode) !== "initial") return;
  const startedAt = room.initialQuestionStartedAt || Date.now();
  const descriptionDelay = Math.max(0, startedAt + INITIAL_DESCRIPTION_HINT_MS - Date.now());
  const letterDelay = Math.max(0, startedAt + INITIAL_LETTER_HINT_MS - Date.now());
  room.initialHintTimer = setTimeout(() => {
    room.initialHintTimer = null;
    if (!room.started || cleanGameMode(room.gameMode) !== "initial") return;
    broadcast(room, { type: "initialHint", answer: roomQuestion(room), state: publicState(room) });
  }, descriptionDelay);
  room.initialLetterHintTimer = setTimeout(() => {
    room.initialLetterHintTimer = null;
    if (!room.started || cleanGameMode(room.gameMode) !== "initial") return;
    broadcast(room, { type: "initialHint", answer: roomQuestion(room), state: publicState(room) });
  }, letterDelay);
}

function advanceInitialQuestion(room, winnerName = "") {
  if (!room.started || cleanGameMode(room.gameMode) !== "initial" || !room.answer) return null;
  const previousAnswer = room.answer;
  const guessedWord = previousAnswer.word;
  room.answer = pickInitialAnswer(room.previousWord);
  room.previousWord = room.answer.word;
  resetInitialHint(room, Date.now());
  scheduleInitialHint(room);
  scheduleInitialQuestionTimeout(room);
  broadcast(room, {
    type: "initialQuestion",
    answer: roomQuestion(room),
    winnerName,
    guessedWord,
    noWinner: !winnerName,
    previousAnswer: { word: guessedWord },
    state: publicState(room)
  });
  return room.answer;
}

function scheduleInitialQuestionTimeout(room) {
  if (room.initialQuestionTimer) clearTimeout(room.initialQuestionTimer);
  if (!room.started || cleanGameMode(room.gameMode) !== "initial" || !room.answer) return;
  const targetWord = room.answer.word;
  room.initialQuestionTimer = setTimeout(() => {
    try {
      room.initialQuestionTimer = null;
      if (!room.started || cleanGameMode(room.gameMode) !== "initial") return;
      if (!room.answer || room.answer.word !== targetWord) return;
      advanceInitialQuestion(room);
    } catch (error) {
      console.error("initial question advance failed", error);
    }
  }, INITIAL_QUESTION_MS);
}

function publicInitialQuestion(answer, room = null) {
  return {
    word: "",
    jamo: Array(answer?.jamo?.length || 5).fill(""),
    initials: getInitialsFromWord(answer?.word),
    hint: currentInitialHint(room)
  };
}

function roomQuestion(room) {
  return cleanGameMode(room.gameMode) === "initial" ? publicInitialQuestion(room.answer, room) : room.answer;
}

async function handleApi(req, res, pathname) {
  try {
    if (!isOriginAllowed(req)) {
      sendJson(res, 403, { error: "허용되지 않은 요청입니다" });
      return;
    }
    const body = await readJson(req);

    if (pathname === "/api/rooms") {
      sendJson(res, 200, { rooms: publicRoomList() });
      return;
    }

    if (pathname === "/api/room") {
      const ip = getClientIp(req);
      const clientId = cleanClientId(body.clientId);
      const existingSession = findWaitingRoomByClientId(clientId);
      if (existingSession) {
        existingSession.player.name = cleanName(body.name);
        existingSession.player.lastActive = Date.now();
        broadcastState(existingSession.room);
        sendJson(res, 200, { room: existingSession.room.code, playerId: existingSession.player.id, state: publicState(existingSession.room), reused: true });
        return;
      }
      if (consumeBucket(roomCreateBuckets, ip, ROOM_CREATE_WINDOW_MS, ROOM_CREATE_MAX)) {
        sendJson(res, 429, { error: "방을 너무 많이 만들었어요. 잠시 후 다시 시도하세요." });
        return;
      }
      if (countActiveRoomsForIp(ip) >= MAX_ACTIVE_ROOMS_PER_IP) {
        sendJson(res, 429, { error: "방 만들기 요청이 많아요. 잠시 후 다시 시도하세요." });
        return;
      }
      const code = makeRoomCode();
      const now = Date.now();
      const player = { id: makePlayerId(), clientId, name: cleanName(body.name), ready: true, result: "", tries: 0, score: 0, finishedAt: 0, joinedAt: now, lastActive: now };
      const room = {
        code,
        hostId: player.id,
        createdAt: now,
        players: new Map([[player.id, player]]),
        clients: new Set(),
        started: false,
        answer: null,
        ownerIp: ip,
        previousWord: "",
        gameMode: cleanGameMode(body.gameMode),
        wordLength: Number(body.wordLength) === 6 ? 6 : 5,
        countdownUntil: 0,
        endsAt: 0,
        timer: null,
        countdownTimer: null,
        initialHintTimer: null,
        initialLetterHintTimer: null,
        initialQuestionTimer: null,
        initialQuestionStartedAt: 0,
        initialHintIndex: 0,
        chat: []
      };
      rooms.set(code, room);
      broadcastSystem(room, `${player.name}님이 입장했습니다.`);
      sendJson(res, 200, { room: code, playerId: player.id, state: publicState(room) });
      return;
    }

    if (pathname === "/api/join") {
      const room = requireRoom(normalizeRoomCode(body.room));
      const name = cleanName(body.name);
      const clientId = cleanClientId(body.clientId);
      const sameClientPlayer = clientId
        ? [...room.players.values()].find((player) => player.clientId === clientId)
        : null;
      if (sameClientPlayer) {
        sameClientPlayer.name = name;
        sameClientPlayer.lastActive = Date.now();
        broadcastState(room);
        sendJson(res, 200, { room: room.code, playerId: sameClientPlayer.id, state: publicState(room), reused: true });
        return;
      }
      const existingPlayer = room.players.get(String(body.playerId || ""));
      if (existingPlayer && existingPlayer.name === name) {
        if (clientId && !existingPlayer.clientId) existingPlayer.clientId = clientId;
        existingPlayer.lastActive = Date.now();
        sendJson(res, 200, { room: room.code, playerId: existingPlayer.id, state: publicState(room) });
        return;
      }
      const duplicateName = [...room.players.values()].some((player) => player.name === name);
      if (duplicateName) throw new Error("이미 같은 닉네임이 이 방에 있어요");
      if (room.players.size >= 5) throw new Error("방은 최대 5명까지 입장할 수 있어요");
      if (room.started || room.countdownUntil) throw new Error("이미 시작한 방입니다");
      const now = Date.now();
      const player = { id: makePlayerId(), clientId, name, ready: false, result: "", tries: 0, score: 0, finishedAt: 0, joinedAt: now, lastActive: now };
      room.players.set(player.id, player);
      broadcastState(room);
      broadcastSystem(room, `${player.name}님이 입장했습니다.`);
      sendJson(res, 200, { room: room.code, playerId: player.id, state: publicState(room) });
      return;
    }

    if (pathname === "/api/ready") {
      const room = requireRoom(body.room);
      const player = requirePlayer(room, body.playerId);
      if (room.started || room.countdownUntil) throw new Error("이미 시작했어요");
      player.lastActive = Date.now();
      player.ready = !player.ready;
      broadcastState(room);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/length") {
      const room = requireRoom(body.room);
      const player = requirePlayer(room, body.playerId);
      if (room.hostId !== player.id) throw new Error("방장만 낱자 수를 바꿀 수 있어요");
      if (room.started || room.countdownUntil) throw new Error("게임 준비 중이나 진행 중에는 바꿀 수 없어요");
      const nextLength = Number(body.wordLength) === 6 ? 6 : 5;
      const nextMode = cleanGameMode(body.gameMode);
      if (room.wordLength !== nextLength || cleanGameMode(room.gameMode) !== nextMode) {
        const lengthChanged = room.wordLength !== nextLength;
        const modeChanged = cleanGameMode(room.gameMode) !== nextMode;
        room.wordLength = nextLength;
        room.gameMode = nextMode;
        for (const item of room.players.values()) {
          item.ready = item.id === room.hostId;
        }
        const modeLabel = nextMode === "initial" ? "초성" : "자모";
        if (lengthChanged && modeChanged) broadcastSystem(room, `방장이 ${modeLabel} · ${nextLength}낱자로 변경했습니다.`);
        else if (modeChanged) broadcastSystem(room, `방장이 ${modeLabel} 모드로 변경했습니다.`);
        else broadcastSystem(room, `방장이 ${nextLength}낱자로 변경했습니다.`);
      }
      broadcastState(room);
      sendJson(res, 200, { ok: true, state: publicState(room) });
      return;
    }

    if (pathname === "/api/leave") {
      const room = requireRoom(body.room);
      if (room.countdownUntil && Date.now() < room.countdownUntil) throw new Error("시작 준비 중에는 나갈 수 없어요");
      if (room.countdownUntil && Date.now() >= room.countdownUntil) {
        room.started = true;
        room.countdownUntil = 0;
      }
      leaveDuringRound(room, body.playerId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/kick") {
      const room = requireRoom(body.room);
      const host = requirePlayer(room, body.playerId);
      if (room.hostId !== host.id) throw new Error("방장만 강퇴할 수 있어요");
      if (room.started || room.countdownUntil) throw new Error("게임 중에는 강퇴할 수 없어요");
      const targetId = String(body.targetId || "");
      if (targetId === room.hostId) throw new Error("방장은 강퇴할 수 없어요");
      removePlayer(room, targetId, { kicked: true, reason: "방장이 강퇴했어요" });
      sendJson(res, 200, { ok: true });
      return;
    }

      if (pathname === "/api/start") {
      const room = requireRoom(body.room);
      requirePlayer(room, body.playerId);
      if (room.hostId !== body.playerId) throw new Error("방장만 시작할 수 있어요");
      if (room.players.size < 2) throw new Error("2명 이상 모이면 시작할 수 있어요");
      if (room.players.size > 5) throw new Error("최대 5명까지 플레이할 수 있어요");
      const everyoneReady = [...room.players.values()].every((player) => player.ready || player.id === room.hostId);
      if (!everyoneReady) throw new Error("아직 준비하지 않은 사람이 있어요");
      room.gameMode = cleanGameMode(body.gameMode);
      room.wordLength = room.gameMode === "initial" ? 5 : (Number(body.wordLength) === 6 ? 6 : 5);
      room.answer = room.gameMode === "initial" ? pickInitialAnswer(room.previousWord) : pickAnswer(room.previousWord, room.wordLength);
      room.previousWord = room.answer.word;
      if (room.gameMode === "initial") resetInitialHint(room, 0);
      room.started = false;
      room.countdownUntil = Date.now() + COUNTDOWN_MS;
      room.endsAt = room.countdownUntil + (room.gameMode === "initial" ? INITIAL_ROUND_MS : ROUND_MS);
      for (const player of room.players.values()) {
        player.result = "";
        player.tries = 0;
        player.score = 0;
        player.finishedAt = 0;
        player.leftRound = false;
      }
      if (room.countdownTimer) clearTimeout(room.countdownTimer);
      if (room.timer) clearTimeout(room.timer);
      broadcast(room, { type: "countdown", answer: roomQuestion(room), startsAt: room.countdownUntil, state: publicState(room) });
      room.countdownTimer = setTimeout(() => {
        room.started = true;
        room.countdownUntil = 0;
        if (room.gameMode === "initial") {
          resetInitialHint(room, Date.now());
          scheduleInitialHint(room);
          scheduleInitialQuestionTimeout(room);
        }
        broadcast(room, { type: "start", answer: roomQuestion(room), endsAt: room.endsAt, state: publicState(room) });
      }, COUNTDOWN_MS);
      room.timer = setTimeout(() => {
        finishTimedOutPlayers(room);
      }, Math.max(0, room.endsAt - Date.now()));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/result") {
      const room = requireRoom(body.room);
      const player = requirePlayer(room, body.playerId);
      if (!room.started) throw new Error("아직 시작하지 않았어요");
      if (!player.result) {
        player.result = body.result === "win" ? "win" : "loss";
        player.tries = clampTries(body.tries);
        player.finishedAt = Date.now();
      }
      if (player.result === "win") {
        const now = Date.now();
        for (const item of room.players.values()) {
          if (!item.result) {
            item.result = "loss";
            item.tries = 0;
            item.finishedAt = now;
          }
        }
        finishRound(room);
      } else {
        const everyoneFinished = [...room.players.values()].every((item) => item.result);
        if (everyoneFinished) finishRound(room);
      }
      broadcastState(room);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/initial-guess") {
      const room = requireRoom(body.room);
      const player = requirePlayer(room, body.playerId);
      if (cleanGameMode(room.gameMode) !== "initial") throw new Error("초성 모드가 아닙니다");
      if (!room.started) throw new Error("아직 시작하지 않았어요");
      if (player.leftRound || player.result) throw new Error("이미 이번 라운드에서 나갔어요");
      const candidates = Array.isArray(body.words) ? body.words : [body.word];
      const words = candidates
        .map((word) => String(word || "").trim().slice(0, 20))
        .filter(Boolean);
      if (!words.length) throw new Error("단어를 입력하세요");
      if (!words.includes(room.answer?.word)) {
        sendJson(res, 200, { ok: true, awarded: false, message: "정답이 아니에요", state: publicState(room) });
        return;
      }
      player.score = (player.score || 0) + 1;
      player.tries = player.score;
      player.lastActive = Date.now();
      advanceInitialQuestion(room, player.name);
      sendJson(res, 200, { ok: true, awarded: true, score: player.score, answer: roomQuestion(room), state: publicState(room) });
      return;
    }

    if (pathname === "/api/chat") {
      const room = requireRoom(body.room);
      const player = requirePlayer(room, body.playerId);
      if (room.started || room.countdownUntil) throw new Error("채팅은 시작 전에만 가능해요");
      player.lastActive = Date.now();
      const text = String(body.text || "").trim().slice(0, 120);
      if (!text) throw new Error("메시지를 입력하세요");
      const message = { id: makePlayerId(), name: player.name, text, at: Date.now() };
      room.chat.push(message);
      room.chat = room.chat.slice(-30);
      broadcast(room, { type: "chat", message });
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "없는 API입니다" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function handleEvents(req, res, url) {
  try {
    const room = requireRoom(url.searchParams.get("room"));
    const player = requirePlayer(room, url.searchParams.get("player"));
    player.lastActive = Date.now();
    res.writeHead(200, {
      ...securityHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.playerId = player.id;
    res.write(`data: ${JSON.stringify({ type: "state", state: publicState(room) })}\n\n`);
    room.clients.add(res);
    const keepalive = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, SSE_KEEPALIVE_MS);
    req.on("close", () => {
      clearInterval(keepalive);
      room.clients.delete(res);
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function serveFile(req, res, pathname) {
  const safePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(root, safePath);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.startsWith(".git") || path.basename(filePath).startsWith(".")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(mimeTypes, path.extname(filePath))) {
    res.writeHead(403, securityHeaders);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=3600";
    res.writeHead(200, { ...securityHeaders, "Content-Type": mimeTypes[ext] || "application/octet-stream", "Cache-Control": cacheControl });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/rooms") {
    if (isRateLimited(req, url.pathname)) {
      sendJson(res, 429, { error: "Too many requests" });
      return;
    }
    sendJson(res, 200, { rooms: publicRoomList() });
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    if (isRateLimited(req, url.pathname)) {
      sendJson(res, 429, { error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." });
      return;
    }
    handleApi(req, res, url.pathname);
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
    if (isRateLimited(req, url.pathname)) {
      sendJson(res, 429, { error: "Too many requests" });
      return;
    }
    handleEvents(req, res, url);
    return;
  }
  if (req.method === "GET") {
    serveFile(req, res, url.pathname);
    return;
  }
  res.writeHead(405);
  res.end("Method not allowed");
});

const port = Number(process.env.PORT) || 3000;
setInterval(sweepIdlePlayers, 5000);
setInterval(sweepBuckets, 60000);
server.listen(port, () => {
  console.log(`단어배틀 서버: http://localhost:${port}`);
});
