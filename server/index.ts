import express from "express";
import { createServer } from "node:http";
import cors from "cors";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import {
  beginPlaying,
  callMeeting,
  chat,
  contributePower,
  contributeSignal,
  contributeCode,
  contributeForge,
  pressSync,
  createRoom,
  disconnect,
  getRoomByPlayer,
  getRoom,
  joinRoom,
  leaveRoom,
  reconnect,
  replay,
  sabotage,
  killPlayer,
  serialize,
  startGame,
  startSync,
  vote,
  type Room,
  rooms,
} from "./game.ts";
import type { ChatChannel, CitizenMissionId } from "../shared/types.ts";

const app = express();
app.use(cors());
app.use(express.json());

// 서버가 직접 조종하는 AI 봇 ID 목록
const botIds = new Set<string>();
const botNames = ["검은장미", "밤의그림자", "붉은여우", "달빛추적자", "유령신사", "까마귀", "안개속발자국", "은빛단서", "마지막목격자", "푸른장막", "검은우산"];
const botLastChat = new Map<string, number>();
const botLastSyncStart = new Map<string, number>();

function randomBotName(room: Room): string {
  const used = new Set([...room.players.values()].map(p => p.name));
  const available = botNames.filter(n => !used.has(n));
  return available[0] ?? `의문의인물${Math.floor(Math.random() * 900 + 100)}`;
}

function botChat(room: Room, playerId: string, text: string, channel: "all" | "mafia" = "all") {
  try { chat(room, playerId, text, channel); } catch { /* 현재 단계에서 말할 수 없으면 건너뜀 */ }
}

function actBots(room: Room): void {
  const bots = [...room.players.values()].filter(p => botIds.has(p.id));
  if (!bots.length || room.phase === "lobby" || room.phase === "ended" || room.phase === "reveal") return;
  const now = Date.now();

  if (room.phase === "meeting" && room.meeting) {
    for (const bot of bots) {
      if (!bot.alive || room.meeting.votes.has(bot.id)) continue;
      const living = [...room.players.values()].filter(p => p.alive && p.id !== bot.id);
      if (!living.length) { try { vote(room, bot.id, "skip"); } catch {} continue; }
      // 시민은 생존 마피아 중 하나를 의심하고, 마피아는 시민에게 표를 분산한다.
      const candidates = bot.role === "mafia" ? living.filter(p => p.role !== "mafia") : living.filter(p => p.role === "mafia");
      const pool = candidates.length ? candidates : living;
      const target = pool[Math.floor(Math.random() * pool.length)];
      try { vote(room, bot.id, target.id); } catch {}
    }
    emitRoom(room);
    return;
  }

  if (room.phase !== "playing") return;
  for (const bot of bots) {
    if (!bot.alive) continue;
    // 봇은 서버의 게임 상태를 이용해 자신에게 배정된 미션을 실제 게임 함수로 수행한다.
    for (const missionId of bot.missionIds) {
      const mission = room.missions.get(missionId);
      if (!mission || mission.done) continue;
      try {
        if (missionId === "power" && !mission.contributed.has(bot.id)) contributePower(room, bot.id);
        if (missionId === "code" && !mission.contributed.has(bot.id)) contributeCode(room, bot.id, room.secretCode);
        if (missionId === "forge" && !mission.contributed.has(bot.id)) contributeForge(room, bot.id, room.forgeCode);
        if (missionId === "signal" && !mission.contributed.has(bot.id)) contributeSignal(room, bot.id);
        if (missionId === "sync" && !room.sync && !mission.done && now - (botLastSyncStart.get(room.code) ?? 0) > 6000) {
          startSync(room, bot.id);
          botLastSyncStart.set(room.code, now);
        }
      } catch { /* 쿨다운 또는 다른 플레이어가 먼저 진행 중인 경우 다음 틱에 재시도 */ }
    }
  }
  // 동기화 창이 열리면 해당 미션을 가진 봇들이 창 안에서 누른다.
  if (room.sync && now >= room.sync.countdownEndsAt && now <= room.sync.windowEndsAt) {
    for (const bot of bots) {
      if (bot.alive && bot.missionIds.includes("sync") && !room.syncPressed.has(bot.id)) {
        try { pressSync(room, bot.id); } catch {}
      }
    }
  }
  // 마피아는 가능한 경우 시민 미션을 방해한다.
  for (const bot of bots.filter(p => p.alive && p.role === "mafia")) {
    if (now < room.sabotageReadyAt) continue;
    const targets = ["power", "code", "sync"] as const;
    const targetId = targets.find(id => { const m = room.missions.get(id); return !!m && !m.done && (m.contributed.size > 0 || (id === "sync" && !!room.sync)); });
    if (targetId) { try { sabotage(room, bot.id, targetId as CitizenMissionId); } catch {} }
  }
  // 간헐적으로 자연스러운 짧은 대화를 한다.
  const lines = ["지금 미션 진행 상황 어때?", "수상한 행동 있으면 공유해 줘.", "일단 미션부터 같이 진행하자.", "누가 방해하는 것 같은데?", "투표 전에 단서 좀 모아보자."];
  for (const bot of bots) {
    if (!bot.alive || now - (botLastChat.get(bot.id) ?? 0) < 18000 || Math.random() > 0.12) continue;
    botChat(room, bot.id, lines[Math.floor(Math.random() * lines.length)], bot.role === "mafia" ? "mafia" : "all");
    botLastChat.set(bot.id, now);
  }
  emitRoom(room);
}

setInterval(() => {
  for (const room of rooms.values()) {
    try { actBots(room); } catch (err) { console.error("AI bot tick error", err); }
  }
}, 700);
app.get("/health", (_req, res) => res.json({ ok: true }));

// 디버깅: 현재 활성화된 방 목록
app.get("/rooms", (_req, res) => {
  try {
    const roomList = [];
    for (const [code, room] of rooms.entries()) {
      roomList.push({
        code,
        phase: room.phase,
        playerCount: room.players.size,
        players: [...room.players.values()].map(p => ({ name: p.name, connected: p.connected }))
      });
    }
    res.json({ rooms: roomList });
  } catch (err) {
    const message = err instanceof Error ? err.message : "오류가 발생했습니다.";
    res.status(500).json({ error: message });
  }
});

// 방 코드로 AI 봇 9명을 추가하는 엔드포인트 (게임 시작 전 로비에서만 가능)
app.post("/add-bots", (req, res) => {
  try {
    const roomCode = typeof req.body?.roomCode === "string" ? req.body.roomCode.trim().toUpperCase() : "";
    const requested = Number(req.body?.count ?? 9);
    const count = Number.isFinite(requested) ? Math.max(0, Math.min(9, Math.floor(requested))) : 9;
    const room = getRoom(roomCode);
    if (!room) return res.status(404).json({ error: "방을 찾을 수 없습니다." });
    if (room.phase !== "lobby") return res.status(400).json({ error: "로비 상태에서만 봇을 추가할 수 있습니다." });
    let addedCount = 0;
    for (let i = 0; i < count && room.players.size < 10; i++) {
      const botId = `bot-${randomUUID()}`;
      const name = randomBotName(room);
      room.players.set(botId, {
        id: botId, name, socketId: null, connected: true, alive: true, role: null,
        missionIds: [], meetingsLeft: 1, codeHints: [], forgeHints: [], killCount: 0, killReadyAt: 0,
      });
      botIds.add(botId);
      addedCount++;
    }
    emitRoom(room);
    return res.json({ success: true, addedCount, totalPlayers: room.players.size, names: [...room.players.values()].filter(p => botIds.has(p.id)).map(p => p.name) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "오류가 발생했습니다.";
    return res.status(500).json({ error: message });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
  },
});

function emitRoom(room: Room): void {
  for (const player of room.players.values()) {
    if (!player.socketId) continue;
    try {
      io.to(player.socketId).emit("state", serialize(room, player.id));
    } catch {
      /* ignore */
    }
  }
}

function wrap(fn: () => void, socket: { emit: (ev: string, data: unknown) => void }): void {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : "오류가 발생했습니다.";
    socket.emit("errorMsg", message);
  }
}

function roomOf(playerId: string): Room {
  const room = getRoomByPlayer(playerId);
  if (!room) throw new Error("방에 들어가 있지 않습니다.");
  return room;
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name, playerId }: { name: string; playerId?: string }) => {
    wrap(() => {
      const id = playerId || randomUUID();
      const room = createRoom(id, name, socket.id);
      socket.join(room.code);
      socket.emit("joined", { playerId: id, roomCode: room.code });
      emitRoom(room);
    }, socket);
  });

  socket.on(
    "joinRoom",
    ({ name, roomCode, playerId }: { name: string; roomCode: string; playerId?: string }) => {
      wrap(() => {
        const id = playerId || randomUUID();
        const room = joinRoom(roomCode, id, name, socket.id);
        socket.join(room.code);
        socket.emit("joined", { playerId: id, roomCode: room.code });
        emitRoom(room);
      }, socket);
    },
  );

  socket.on("rejoin", ({ playerId }: { playerId: string }) => {
    wrap(() => {
      const room = reconnect(playerId, socket.id);
      if (!room) {
        // 저장된 ID가 낡았을 뿐이므로 오류 문구 없이 홈 화면을 유지한다.
        socket.emit("rejoinFailed");
        return;
      }
      socket.join(room.code);
      socket.emit("joined", { playerId, roomCode: room.code });
      emitRoom(room);
    }, socket);
  });

  socket.on("leave", ({ playerId }: { playerId: string }) => {
    wrap(() => {
      const before = getRoomByPlayer(playerId);
      const room = leaveRoom(playerId);
      if (before) socket.leave(before.code);
      socket.emit("left");
      if (room) emitRoom(room);
    }, socket);
  });

  socket.on("startGame", ({ playerId }: { playerId: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      startGame(room, playerId);
      emitRoom(room);
      setTimeout(() => {
        beginPlaying(room, emitRoom);
        emitRoom(room);
      }, 5000);
    }, socket);
  });

  socket.on(
    "chat",
    ({ playerId, text, channel }: { playerId: string; text: string; channel?: ChatChannel }) => {
      wrap(() => {
        const room = roomOf(playerId);
        chat(room, playerId, text, channel === "mafia" ? "mafia" : channel === "dead" ? "dead" : "all");
        emitRoom(room);
      }, socket);
    },
  );

  socket.on("power", ({ playerId }: { playerId: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      contributePower(room, playerId);
      emitRoom(room);
    }, socket);
  });

  socket.on("code", ({ playerId, guess }: { playerId: string; guess: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      contributeCode(room, playerId, guess);
      emitRoom(room);
    }, socket);
  });

  socket.on("startSync", ({ playerId }: { playerId: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      startSync(room, playerId);
      emitRoom(room);
    }, socket);
  });

  socket.on("pressSync", ({ playerId }: { playerId: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      pressSync(room, playerId);
      emitRoom(room);
    }, socket);
  });

  socket.on("signal", ({ playerId }: { playerId: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      contributeSignal(room, playerId);
      emitRoom(room);
    }, socket);
  });

  socket.on("forge", ({ playerId, guess }: { playerId: string; guess: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      contributeForge(room, playerId, guess);
      emitRoom(room);
    }, socket);
  });

  socket.on(
    "sabotage",
    ({ playerId, mission }: { playerId: string; mission: CitizenMissionId }) => {
      wrap(() => {
        const room = roomOf(playerId);
        sabotage(room, playerId, mission);
        emitRoom(room);
      }, socket);
    },
  );


  socket.on("kill", ({ playerId, targetId }: { playerId: string; targetId: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      killPlayer(room, playerId, targetId);
      emitRoom(room);
    }, socket);
  });

  socket.on("callMeeting", ({ playerId }: { playerId: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      callMeeting(room, playerId, emitRoom);
      emitRoom(room);
    }, socket);
  });

  socket.on("vote", ({ playerId, target }: { playerId: string; target: string | "skip" }) => {
    wrap(() => {
      const room = roomOf(playerId);
      vote(room, playerId, target);
      emitRoom(room);
    }, socket);
  });

  socket.on("replay", ({ playerId }: { playerId: string }) => {
    wrap(() => {
      const room = roomOf(playerId);
      if (room.hostId !== playerId) throw new Error("방장만 다시 시작할 수 있습니다.");
      replay(room);
      emitRoom(room);
    }, socket);
  });

  socket.on("disconnect", () => {
    const room = disconnect(socket.id);
    if (room) emitRoom(room);
  });
});

const PORT = Number(process.env.PORT) || 3001;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`미션 마피아 서버 포트: ${PORT}`);
});
