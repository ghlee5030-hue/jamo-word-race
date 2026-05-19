const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const rooms = new Map();
const COUNTDOWN_MS = 3000;
const ROUND_MS = 210000;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function loadAnswers() {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const block = html.match(/const ANSWERS = \[([\s\S]*?)\];/);
  if (!block) throw new Error("ANSWERS not found in index.html");
  return [...block[1].matchAll(/word: "([^"]+)", jamo: \[([^\]]+)\]/g)].map((match) => ({
    word: match[1],
    jamo: [...match[2].matchAll(/"([^"]+)"/g)].map((item) => item[1])
  }));
}

const answers = loadAnswers();

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
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

function broadcastState(room) {
  broadcast(room, { type: "state", state: publicState(room) });
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

function pickAnswer(previousWord = "") {
  if (answers.length <= 1) return answers[0];
  let answer = answers[Math.floor(Math.random() * answers.length)];
  while (answer.word === previousWord) {
    answer = answers[Math.floor(Math.random() * answers.length)];
  }
  return answer;
}

async function handleApi(req, res, pathname) {
  try {
    const body = await readJson(req);

    if (pathname === "/api/room") {
      const code = makeRoomCode();
      const player = { id: makePlayerId(), name: cleanName(body.name), ready: true, result: "", tries: 0, finishedAt: 0 };
      const room = {
        code,
        hostId: player.id,
        players: new Map([[player.id, player]]),
        clients: new Set(),
        started: false,
        answer: null,
        previousWord: "",
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
        sendJson(res, 200, { room: room.code, playerId: existingPlayer.id, state: publicState(room) });
        return;
      }
      const duplicateName = [...room.players.values()].some((player) => player.name === name);
      if (duplicateName) throw new Error("이미 같은 닉네임이 이 방에 있어요");
      if (room.players.size >= 5) throw new Error("방은 최대 5명까지 입장할 수 있어요");
      if (room.started || room.countdownUntil) throw new Error("이미 시작한 방입니다");
      const player = { id: makePlayerId(), name, ready: false, result: "", tries: 0, finishedAt: 0 };
      room.players.set(player.id, player);
      broadcastState(room);
      sendJson(res, 200, { room: room.code, playerId: player.id, state: publicState(room) });
      return;
    }

    if (pathname === "/api/ready") {
      const room = requireRoom(body.room);
      const player = requirePlayer(room, body.playerId);
      if (room.started || room.countdownUntil) throw new Error("이미 시작했어요");
      player.ready = !player.ready;
      broadcastState(room);
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
      room.answer = pickAnswer(room.previousWord);
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
      const everyoneFinished = [...room.players.values()].every((item) => item.result);
      if (everyoneFinished) {
        room.started = false;
        room.countdownUntil = 0;
        room.endsAt = 0;
        if (room.timer) clearTimeout(room.timer);
        if (room.countdownTimer) clearTimeout(room.countdownTimer);
        room.timer = null;
        room.countdownTimer = null;
        for (const item of room.players.values()) {
          item.ready = item.id === room.hostId;
        }
      }
      broadcastState(room);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/chat") {
      const room = requireRoom(body.room);
      const player = requirePlayer(room, body.playerId);
      if (room.started || room.countdownUntil) throw new Error("채팅은 시작 전에만 가능해요");
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
    requirePlayer(room, url.searchParams.get("player"));
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
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
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
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
server.listen(port, () => {
  console.log(`오늘의 낱자 서버: http://localhost:${port}`);
});
