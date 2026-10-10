import path from "node:path";
import express from "express";
import { createServer } from "node:http";
import cors from "cors";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import {
  beginPlaying,
  callMeeting,
  chat,
  contributeCode,
  contributeForge,
  contributePower,
  contributeSignal,
  createRoom,
  disconnect,
  getRoomByPlayer,
  joinRoom,
  leaveRoom,
  pressSync,
  reconnect,
  replay,
  sabotage,
  serialize,
  startGame,
  startSync,
  vote,
  type Room,
} from "./game.ts";
import type { ChatChannel, CitizenMissionId } from "../shared/types.ts";

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

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
        chat(room, playerId, text, channel === "mafia" ? "mafia" : "all");
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
app.use(express.static(path.resolve("dist")));

app.get(/.*/, (_req, res) => {
  res.sendFile(path.resolve("dist/index.html"));
});
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`미션 마피아 서버 포트: ${PORT}`);
});
