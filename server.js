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
const INITIAL_DESCRIPTION_HINT_MS = 5000;
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
const initialAnswers = answers[5].filter((answer) => [...answer.word].length === 2);

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
  return "뜻이나 상황을 떠올려 맞히는 두 글자 단어예요.";
}

function makeInitialLetterHint(answer, index = 0) {
  const letters = [...String(answer?.word || "")];
  if (!letters.length) return null;
  const safeIndex = index === 1 && letters.length > 1 ? 1 : 0;
  return { index: safeIndex, letter: letters[safeIndex] };
}

function makeInitialHint(answer, elapsed = 0, letterIndex = 0) {
  if (elapsed < INITIAL_DESCRIPTION_HINT_MS) return null;
  const hint = { description: makeInitialDescription(answer?.word) };
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
    room.initialQuestionTimer = null;
    if (!room.started || cleanGameMode(room.gameMode) !== "initial") return;
    if (!room.answer || room.answer.word !== targetWord) return;
    advanceInitialQuestion(room);
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
