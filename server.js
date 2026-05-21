const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const rooms = new Map();
const rateBuckets = new Map();
const COUNTDOWN_MS = 3000;
const ROUND_MS = 210000;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 90;
const READY_IDLE_KICK_MS = 30000;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
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

function sendJson(res, status, body) {
  res.writeHead(status, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function isRateLimited(req) {
  const now = Date.now();
  const key = getClientIp(req);
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count > RATE_LIMIT_MAX;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) {
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

function cleanName(name) {
  return String(name || "손님").trim().replace(/\s+/g, " ").slice(0, 14) || "손님";
}

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    countdownUntil: room.countdownUntil,
    endsAt: room.endsAt,
    wordLength: room.wordLength,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      ready: player.ready,
      result: player.result,
      tries: player.tries,
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

function publicRoomList() {
  return [...rooms.values()]
    .filter((room) => !room.started && !room.countdownUntil && room.players.size > 0 && room.players.size < 5)
    .map((room) => ({
      code: room.code,
      count: room.players.size,
      wordLength: room.wordLength,
      hostName: room.players.get(room.hostId)?.name || "방장"
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function removePlayer(room, playerId, reason = "") {
  const player = requirePlayer(room, playerId);
  sendToPlayer(room, player.id, { type: "kicked", reason: reason || "방에서 나갔어요" });
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
}

function sweepIdlePlayers() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.started || room.countdownUntil) continue;
    for (const player of [...room.players.values()]) {
      if (player.id === room.hostId || player.ready) continue;
      if (now - (player.lastActive || player.joinedAt || now) >= READY_IDLE_KICK_MS) {
        removePlayer(room, player.id, "30초 동안 준비하지 않아 자동 강퇴됐어요");
      }
    }
  }
}

function finishTimedOutPlayers(room) {
  if (!room.started) return;
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
  }
  broadcast(room, { type: "timeout", state: publicState(room) });
}

function finishRound(room) {
  room.started = false;
  room.countdownUntil = 0;
  room.endsAt = 0;
  if (room.timer) clearTimeout(room.timer);
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  room.timer = null;
  room.countdownTimer = null;
  for (const player of room.players.values()) {
    player.ready = player.id === room.hostId;
  }
}

function requireRoom(code) {
  const room = rooms.get(String(code || "").toUpperCase());
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

async function handleApi(req, res, pathname) {
  try {
    const body = await readJson(req);

    if (pathname === "/api/rooms") {
      sendJson(res, 200, { rooms: publicRoomList() });
      return;
    }

    if (pathname === "/api/room") {
      const code = makeRoomCode();
      const now = Date.now();
      const player = { id: makePlayerId(), name: cleanName(body.name), ready: true, result: "", tries: 0, finishedAt: 0, joinedAt: now, lastActive: now };
      const room = {
        code,
        hostId: player.id,
        players: new Map([[player.id, player]]),
        clients: new Set(),
        started: false,
        answer: null,
        previousWord: "",
        wordLength: 5,
        countdownUntil: 0,
        endsAt: 0,
        timer: null,
        countdownTimer: null,
        chat: []
      };
      rooms.set(code, room);
      sendJson(res, 200, { room: code, playerId: player.id, state: publicState(room) });
      return;
    }

    if (pathname === "/api/join") {
      const room = requireRoom(body.room);
      const name = cleanName(body.name);
      const existingPlayer = room.players.get(String(body.playerId || ""));
      if (existingPlayer && existingPlayer.name === name) {
        existingPlayer.lastActive = Date.now();
        sendJson(res, 200, { room: room.code, playerId: existingPlayer.id, state: publicState(room) });
        return;
      }
      const duplicateName = [...room.players.values()].some((player) => player.name === name);
      if (duplicateName) throw new Error("이미 같은 닉네임이 이 방에 있어요");
      if (room.players.size >= 5) throw new Error("방은 최대 5명까지 입장할 수 있어요");
      if (room.started || room.countdownUntil) throw new Error("이미 시작한 방입니다");
      const now = Date.now();
      const player = { id: makePlayerId(), name, ready: false, result: "", tries: 0, finishedAt: 0, joinedAt: now, lastActive: now };
      room.players.set(player.id, player);
      broadcastState(room);
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

    if (pathname === "/api/leave") {
      const room = requireRoom(body.room);
      if (room.started || room.countdownUntil) throw new Error("게임 중에는 나갈 수 없어요");
      removePlayer(room, body.playerId);
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
      removePlayer(room, targetId, "방장이 강퇴했어요");
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
      room.wordLength = Number(body.wordLength) === 6 ? 6 : 5;
      room.answer = pickAnswer(room.previousWord, room.wordLength);
      room.previousWord = room.answer.word;
      room.started = false;
      room.countdownUntil = Date.now() + COUNTDOWN_MS;
      room.endsAt = room.countdownUntil + ROUND_MS;
      for (const player of room.players.values()) {
        player.result = "";
        player.tries = 0;
        player.finishedAt = 0;
      }
      if (room.countdownTimer) clearTimeout(room.countdownTimer);
      if (room.timer) clearTimeout(room.timer);
      broadcast(room, { type: "countdown", answer: room.answer, startsAt: room.countdownUntil, state: publicState(room) });
      room.countdownTimer = setTimeout(() => {
        room.started = true;
        broadcast(room, { type: "start", answer: room.answer, endsAt: room.endsAt, state: publicState(room) });
      }, COUNTDOWN_MS);
      room.timer = setTimeout(() => {
        finishTimedOutPlayers(room);
      }, COUNTDOWN_MS + ROUND_MS);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/result") {
      const room = requireRoom(body.room);
      const player = requirePlayer(room, body.playerId);
      if (!room.started) throw new Error("아직 시작하지 않았어요");
      if (!player.result) {
        player.result = body.result === "win" ? "win" : "loss";
        player.tries = Number(body.tries) || 0;
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
    req.on("close", () => room.clients.delete(res));
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function serveFile(req, res, pathname) {
  const safePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(root, safePath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { ...securityHeaders, "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/rooms") {
    sendJson(res, 200, { rooms: publicRoomList() });
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    if (isRateLimited(req)) {
      sendJson(res, 429, { error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요" });
      return;
    }
    handleApi(req, res, url.pathname);
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
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
server.listen(port, () => {
  console.log(`단어배틀 서버: http://localhost:${port}`);
});
