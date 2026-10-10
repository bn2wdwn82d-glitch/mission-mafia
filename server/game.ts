import {
  ROLE_TABLE,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MEETING_MS,
  MISSION_META,
  CITIZEN_MISSION_IDS,
  MAFIA_MISSION_IDS,
  CODE_LENGTH,
  FORGE_LENGTH,
  SIGNAL_STAGES,
  SIGNAL_STAGE_MS,
  FORGE_HINT_MS,
  SABOTAGE_FIRST_MS,
  SABOTAGE_COOLDOWN_MS,
  SABOTAGE_PER_MISSION,
  type Role,
  type Phase,
  type CitizenMissionId,
  type MafiaMissionId,
  type MissionId,
  type ChatChannel,
  type ClientState,
  type ChatMessage,
  type CodeHint,
  type SyncWindow,
} from "../shared/types.ts";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FORGE_CHARS = "0123456789";

export interface Player {
  id: string;
  name: string;
  socketId: string | null;
  connected: boolean;
  alive: boolean;
  role: Role | null;
  missionIds: MissionId[];
  meetingsLeft: number;
  codeHints: CodeHint[];
  forgeHints: CodeHint[];
}

interface MissionRuntime {
  id: MissionId;
  done: boolean;
  contributed: Set<string>;
  receivers: Set<string>;
}

export interface Room {
  code: string;
  hostId: string;
  phase: Phase;
  players: Map<string, Player>;
  missions: Map<MissionId, MissionRuntime>;
  secretCode: string;
  forgeCode: string;
  sync: SyncWindow | null;
  syncPressed: Set<string>;
  signalStage: number;
  signalReadyAt: number;
  mafiaSpecialMission: MafiaMissionId | null;
  sabotageReadyAt: number;
  sabotageCount: Map<CitizenMissionId, number>;
  meeting: {
    calledBy: string;
    endsAt: number;
    votes: Map<string, string | "skip">;
  } | null;
  chat: ChatMessage[];
  winner: Role | null;
  winReason: string | null;
  lastEject: { name: string; role: Role } | null;
  startedAt: number | null;
  playingAt: number | null;
  meetingTimer: ReturnType<typeof setTimeout> | null;
  revealTimers: ReturnType<typeof setTimeout>[];
}

const rooms = new Map<string, Room>();
const playerRoom = new Map<string, string>();

function randomString(chars: string, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function code(len = 4): string {
  return randomString(CODE_CHARS, len);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function living(room: Room): Player[] {
  return [...room.players.values()].filter((p) => p.alive);
}

function livingReceivers(room: Room, missionId: MissionId): Player[] {
  const m = room.missions.get(missionId);
  if (!m) return [];
  return living(room).filter((p) => m.receivers.has(p.id));
}

function systemChat(room: Room, text: string, channel: ChatChannel = "all"): void {
  room.chat.push({
    id: code(8),
    playerId: "system",
    name: "시스템",
    text,
    at: Date.now(),
    system: true,
    channel,
  });
  if (room.chat.length > 120) room.chat.splice(0, room.chat.length - 120);
}

function newPlayer(id: string, name: string, socketId: string): Player {
  return {
    id,
    name: sanitize(name),
    socketId,
    connected: true,
    alive: true,
    role: null,
    missionIds: [],
    meetingsLeft: 1,
    codeHints: [],
    forgeHints: [],
  };
}

function clearRevealTimers(room: Room): void {
  for (const t of room.revealTimers) clearTimeout(t);
  room.revealTimers = [];
}

export function getRoomByPlayer(playerId: string): Room | undefined {
  const c = playerRoom.get(playerId);
  return c ? rooms.get(c) : undefined;
}

export function getRoom(codeKey: string): Room | undefined {
  return rooms.get(codeKey.toUpperCase());
}

export function createRoom(playerId: string, name: string, socketId: string): Room {
  let roomCode = code();
  while (rooms.has(roomCode)) roomCode = code();

  const player = newPlayer(playerId, name, socketId);

  const room: Room = {
    code: roomCode,
    hostId: playerId,
    phase: "lobby",
    players: new Map([[playerId, player]]),
    missions: new Map(),
    secretCode: "",
    forgeCode: "",
    sync: null,
    syncPressed: new Set(),
    signalStage: 0,
    signalReadyAt: 0,
    mafiaSpecialMission: null,
    sabotageReadyAt: 0,
    sabotageCount: new Map(),
    meeting: null,
    chat: [],
    winner: null,
    winReason: null,
    lastEject: null,
    startedAt: null,
    playingAt: null,
    meetingTimer: null,
    revealTimers: [],
  };
  rooms.set(roomCode, room);
  playerRoom.set(playerId, roomCode);
  systemChat(room, `${player.name} 님이 방을 열었습니다.`);
  return room;
}

export function joinRoom(
  roomCode: string,
  playerId: string,
  name: string,
  socketId: string,
): Room {
  const room = rooms.get(roomCode.toUpperCase());
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  if (room.phase !== "lobby") throw new Error("이미 시작된 방입니다.");
  if (room.players.size >= MAX_PLAYERS) throw new Error("방이 가득 찼습니다.");
  if ([...room.players.values()].some((p) => p.name === sanitize(name))) {
    throw new Error("같은 이름이 이미 있습니다.");
  }

  const player = newPlayer(playerId, name, socketId);
  room.players.set(playerId, player);
  playerRoom.set(playerId, room.code);
  systemChat(room, `${player.name} 님이 들어왔습니다.`);
  return room;
}

export function reconnect(playerId: string, socketId: string): Room | undefined {
  const room = getRoomByPlayer(playerId);
  if (!room) return undefined;
  const player = room.players.get(playerId);
  if (!player) return undefined;
  player.socketId = socketId;
  player.connected = true;
  return room;
}

/** 로비/종료 화면에서 플레이어를 방에서 완전히 제거합니다. */
function removePlayer(room: Room, player: Player): Room | undefined {
  room.players.delete(player.id);
  playerRoom.delete(player.id);
  systemChat(room, `${player.name} 님이 나갔습니다.`);
  if (room.players.size === 0) {
    clearRoom(room);
    return undefined;
  }
  if (room.hostId === player.id) {
    const all = [...room.players.values()];
    const next = all.find((p) => p.connected) ?? all[0];
    room.hostId = next.id;
    systemChat(room, `${next.name} 님이 방장이 되었습니다.`);
  }
  return room;
}

export function disconnect(socketId: string): Room | undefined {
  for (const room of rooms.values()) {
    const player = [...room.players.values()].find((p) => p.socketId === socketId);
    if (!player) continue;
    player.connected = false;
    player.socketId = null;
    if (room.phase === "lobby") return removePlayer(room, player);
    return room;
  }
  return undefined;
}

export function leaveRoom(playerId: string): Room | undefined {
  const room = getRoomByPlayer(playerId);
  if (!room) return undefined;
  if (room.phase !== "lobby" && room.phase !== "ended") {
    throw new Error("게임 중에는 나갈 수 없습니다.");
  }
  const player = room.players.get(playerId);
  if (!player) return undefined;
  player.socketId = null;
  return removePlayer(room, player);
}

function clearRoom(room: Room): void {
  if (room.meetingTimer) clearTimeout(room.meetingTimer);
  clearRevealTimers(room);
  for (const id of room.players.keys()) playerRoom.delete(id);
  rooms.delete(room.code);
}

/** 암호/서류 번호 조각을 살아있는 수령자들에게 흩뿌립니다. */
function distributeHints(room: Room, kind: "code" | "forge"): void {
  const secret = kind === "code" ? room.secretCode : room.forgeCode;
  for (const p of room.players.values()) {
    if (kind === "code") p.codeHints = [];
    else p.forgeHints = [];
  }
  const receivers = shuffle(livingReceivers(room, kind));
  if (receivers.length === 0) return;
  for (let i = 0; i < secret.length; i++) {
    const p = receivers[i % receivers.length];
    (kind === "code" ? p.codeHints : p.forgeHints).push({ index: i, char: secret[i] });
  }
}

/** 추방된 사람이 들고 있던 조각을 살아있는 사람에게 넘깁니다. */
function reassignOrphanHints(room: Room, kind: "code" | "forge"): void {
  const mission = room.missions.get(kind);
  if (!mission || mission.done) return;
  const alive = livingReceivers(room, kind);
  if (alive.length === 0) return;
  for (const p of room.players.values()) {
    if (p.alive) continue;
    const hints = kind === "code" ? p.codeHints : p.forgeHints;
    while (hints.length > 0) {
      const h = hints.pop()!;
      const target = alive[Math.floor(Math.random() * alive.length)];
      (kind === "code" ? target.codeHints : target.forgeHints).push(h);
    }
  }
}

export function startGame(room: Room, requesterId: string): void {
  if (room.hostId !== requesterId) throw new Error("방장만 시작할 수 있습니다.");
  if (room.phase !== "lobby") throw new Error("이미 시작했습니다.");
  const n = room.players.size;
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) {
    throw new Error(`인원은 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다.`);
  }

  const table = ROLE_TABLE[n];
  const ids = shuffle([...room.players.keys()]);
  const mafiaIds = new Set(ids.slice(0, table.mafia));
  // 마피아는 시민 미션 3개 중 2개만 받고, 특별 미션 2개(signal, forge)를 추가로 받는다.
  const mafiaCitizenMissions = shuffle(CITIZEN_MISSION_IDS).slice(0, 2);

  clearRevealTimers(room);
  room.secretCode = randomString(CODE_CHARS, CODE_LENGTH);
  room.forgeCode = randomString(FORGE_CHARS, FORGE_LENGTH);
  room.missions.clear();
  room.signalStage = 0;
  room.signalReadyAt = 0;
  room.sabotageReadyAt = 0;
  room.sabotageCount = new Map();
  room.sync = null;
  room.syncPressed.clear();
  room.lastEject = null;
  room.winner = null;
  room.winReason = null;
  room.startedAt = Date.now();
  room.playingAt = null;

  const allMissions: MissionId[] = [...CITIZEN_MISSION_IDS, "signal", "forge"];
  for (const id of allMissions) {
    room.missions.set(id, {
      id,
      done: false,
      contributed: new Set(),
      receivers: new Set(),
    });
  }

  for (const player of room.players.values()) {
    player.alive = true;
    player.meetingsLeft = 1;
    player.codeHints = [];
    player.forgeHints = [];
    if (mafiaIds.has(player.id)) {
      player.role = "mafia";
      player.missionIds = [...mafiaCitizenMissions, "signal", "forge"];
    } else {
      player.role = "citizen";
      player.missionIds = [...CITIZEN_MISSION_IDS];
    }
    for (const mid of player.missionIds) {
      room.missions.get(mid)!.receivers.add(player.id);
    }
  }

  distributeHints(room, "code");
  distributeHints(room, "forge");

  room.phase = "reveal";
  systemChat(room, "역할이 배정되었습니다. 미션을 확인하고 마피아를 찾으세요.");
}

export function beginPlaying(room: Room, onTick: (room: Room) => void): void {
  if (room.phase !== "reveal") return;
  const now = Date.now();
  room.phase = "playing";
  room.playingAt = now;
  room.signalReadyAt = now + SIGNAL_STAGE_MS;
  room.sabotageReadyAt = now + SABOTAGE_FIRST_MS;

  // 위조 서류 번호 조각은 시간이 지나야 서버가 내려보내므로, 공개 시점마다 화면을 갱신한다.
  clearRevealTimers(room);
  for (let i = 0; i < FORGE_LENGTH; i++) {
    room.revealTimers.push(
      setTimeout(
        () => {
          if (room.phase === "playing" || room.phase === "meeting") onTick(room);
        },
        (i + 1) * FORGE_HINT_MS + 50,
      ),
    );
  }
}

/* ───────────── 시민 미션 ───────────── */

export function contributePower(room: Room, playerId: string): void {
  requirePlaying(room, playerId, "power");
  const mission = room.missions.get("power")!;
  mission.contributed.add(playerId);
  maybeCompleteCitizen(room, "power");
}

export function contributeCode(room: Room, playerId: string, guess: string): void {
  requirePlaying(room, playerId, "code");
  const normalized = guess.replace(/\s/g, "").toUpperCase();
  if (normalized !== room.secretCode) {
    throw new Error("암호가 틀렸습니다.");
  }
  const mission = room.missions.get("code")!;
  mission.contributed.add(playerId);
  maybeCompleteCitizen(room, "code");
}

export function startSync(room: Room, playerId: string): void {
  requirePlaying(room, playerId, "sync");
  if (room.missions.get("sync")?.done) return;
  const now = Date.now();
  if (room.sync && now < room.sync.windowEndsAt) {
    throw new Error("이미 동기화가 진행 중입니다.");
  }
  room.syncPressed = new Set();
  room.sync = {
    countdownEndsAt: now + 3000,
    windowEndsAt: now + 4500,
  };
}

export function pressSync(room: Room, playerId: string): void {
  requirePlaying(room, playerId, "sync");
  const mission = room.missions.get("sync")!;
  if (mission.done) return;
  if (!room.sync) throw new Error("먼저 동기화를 시작하세요.");
  const now = Date.now();
  if (now < room.sync.countdownEndsAt) throw new Error("아직 이릅니다. 초록 불을 기다리세요.");
  if (now > room.sync.windowEndsAt) {
    room.sync = null;
    room.syncPressed.clear();
    throw new Error("타이밍을 놓쳤습니다. 다시 시작하세요.");
  }
  room.syncPressed.add(playerId);
  maybeCompleteSync(room);
}

function maybeCompleteCitizen(room: Room, id: CitizenMissionId): void {
  if (room.phase === "ended") return;
  const mission = room.missions.get(id);
  if (!mission || mission.done) return;
  const needed = livingReceivers(room, id);
  if (needed.length > 0 && needed.every((p) => mission.contributed.has(p.id))) {
    mission.done = true;
    systemChat(room, `${MISSION_META[id].title} 미션을 완료했습니다.`);
    checkMissionWin(room);
  }
}

function maybeCompleteSync(room: Room): void {
  if (room.phase === "ended") return;
  const mission = room.missions.get("sync");
  if (!mission || mission.done || !room.sync) return;
  const needed = livingReceivers(room, "sync");
  if (needed.length > 0 && needed.every((p) => room.syncPressed.has(p.id))) {
    mission.done = true;
    mission.contributed = new Set(needed.map((p) => p.id));
    room.sync = null;
    systemChat(room, "심장 동기화 미션을 완료했습니다.");
    checkMissionWin(room);
  }
}

/* ───────────── 마피아 특별 미션 ───────────── */

export function contributeSignal(room: Room, playerId: string): void {
  requirePlaying(room, playerId, "signal");
  const player = room.players.get(playerId)!;
  if (player.role !== "mafia") throw new Error("마피아만 수행할 수 있습니다.");
  const wait = room.signalReadyAt - Date.now();
  if (wait > 0) {
    throw new Error(`송신 장비가 식는 중입니다. ${Math.ceil(wait / 1000)}초 후에 시도하세요.`);
  }
  const mission = room.missions.get("signal")!;
  mission.contributed.add(playerId);
  maybeAdvanceSignal(room);
}

function maybeAdvanceSignal(room: Room): void {
  if (room.phase === "ended") return;
  const mission = room.missions.get("signal");
  if (!mission || mission.done) return;
  const needed = livingReceivers(room, "signal");
  if (needed.length === 0 || !needed.every((p) => mission.contributed.has(p.id))) return;

  room.signalStage += 1;
  mission.contributed = new Set();
  if (room.signalStage >= SIGNAL_STAGES) {
    mission.done = true;
    systemChat(room, "비밀 송신을 완료했습니다.", "mafia");
    checkMissionWin(room);
  } else {
    room.signalReadyAt = Date.now() + SIGNAL_STAGE_MS;
    systemChat(
      room,
      `송신 ${room.signalStage}/${SIGNAL_STAGES}단계 성공. 장비가 식으면 다음 단계를 진행하세요.`,
      "mafia",
    );
  }
}

export function contributeForge(room: Room, playerId: string, guess: string): void {
  requirePlaying(room, playerId, "forge");
  const player = room.players.get(playerId)!;
  if (player.role !== "mafia") throw new Error("마피아만 수행할 수 있습니다.");
  const normalized = guess.replace(/\D/g, "");
  if (normalized !== room.forgeCode) {
    throw new Error("서류 번호가 맞지 않습니다.");
  }
  const mission = room.missions.get("forge")!;
  mission.contributed.add(playerId);
  maybeCompleteForge(room);
}

function maybeCompleteForge(room: Room): void {
  if (room.phase === "ended") return;
  const mission = room.missions.get("forge");
  if (!mission || mission.done) return;
  const needed = livingReceivers(room, "forge");
  if (needed.length > 0 && needed.every((p) => mission.contributed.has(p.id))) {
    mission.done = true;
    systemChat(room, "위조 서류를 완성했습니다.", "mafia");
    checkMissionWin(room);
  }
}

/** 마피아의 방해 공작: 시민 미션 하나의 진행을 몰래 되돌린다. */
export function sabotage(room: Room, playerId: string, missionId: CitizenMissionId): void {
  requireAlive(room, playerId);
  if (room.phase !== "playing") throw new Error("지금은 방해 공작을 할 수 없습니다.");
  const player = room.players.get(playerId)!;
  if (player.role !== "mafia") throw new Error("마피아만 사용할 수 있습니다.");
  if (!CITIZEN_MISSION_IDS.includes(missionId)) throw new Error("시민 미션만 방해할 수 있습니다.");

  const now = Date.now();
  if (now < room.sabotageReadyAt) {
    throw new Error(
      `아직 방해 공작을 쓸 수 없습니다. ${Math.ceil((room.sabotageReadyAt - now) / 1000)}초 남았습니다.`,
    );
  }
  const mission = room.missions.get(missionId)!;
  if (mission.done) throw new Error("이미 완료된 미션입니다.");
  const used = room.sabotageCount.get(missionId) ?? 0;
  if (used >= SABOTAGE_PER_MISSION) throw new Error("이 미션은 더 이상 방해할 수 없습니다.");

  const title = MISSION_META[missionId].title;
  let publicText: string;

  if (missionId === "power") {
    if (mission.contributed.size === 0) throw new Error("방해할 진행 상황이 없습니다.");
    mission.contributed = new Set();
    publicText = "전원 공급: 누군가 차단기를 내렸습니다. 진행도가 초기화되었습니다.";
  } else if (missionId === "code") {
    room.secretCode = randomString(CODE_CHARS, CODE_LENGTH);
    mission.contributed = new Set();
    distributeHints(room, "code");
    publicText = "암호 조합: 암호가 바뀌었습니다. 조각을 다시 확인하세요.";
  } else {
    if (!room.sync && room.syncPressed.size === 0) throw new Error("방해할 진행 상황이 없습니다.");
    room.sync = null;
    room.syncPressed.clear();
    publicText = "심장 동기화: 신호가 끊겼습니다. 다시 시작해야 합니다.";
  }

  room.sabotageCount.set(missionId, used + 1);
  room.sabotageReadyAt = now + SABOTAGE_COOLDOWN_MS;
  // 시민에게는 누가 했는지 알리지 않는다.
  systemChat(room, publicText);
  systemChat(room, `${player.name} 님이 ${title} 미션을 방해했습니다.`, "mafia");
}

/* ───────────── 채팅 / 회의 ───────────── */

export function chat(
  room: Room,
  playerId: string,
  text: string,
  channel: ChatChannel = "all",
): void {
  const player = room.players.get(playerId);
  if (!player) throw new Error("플레이어가 아닙니다.");
  if (!player.alive && room.phase !== "lobby") throw new Error("탈락한 뒤에는 말할 수 없습니다.");
  if (channel === "mafia") {
    if (player.role !== "mafia" || room.phase === "lobby") {
      throw new Error("마피아 대화는 마피아만 사용할 수 있습니다.");
    }
  }
  const trimmed = text.trim().slice(0, 140);
  if (!trimmed) return;
  room.chat.push({
    id: code(8),
    playerId,
    name: player.name,
    text: trimmed,
    at: Date.now(),
    channel,
  });
  if (room.chat.length > 120) room.chat.splice(0, room.chat.length - 120);
}

export function callMeeting(room: Room, playerId: string, onEnd: (room: Room) => void): void {
  requireAlive(room, playerId);
  if (room.phase !== "playing") throw new Error("지금은 회의를 열 수 없습니다.");
  const player = room.players.get(playerId)!;
  if (player.meetingsLeft <= 0) throw new Error("회의 소집 횟수를 모두 썼습니다.");
  player.meetingsLeft -= 1;
  room.phase = "meeting";
  room.sync = null;
  room.syncPressed.clear();
  room.meeting = {
    calledBy: playerId,
    endsAt: Date.now() + MEETING_MS,
    votes: new Map(),
  };
  systemChat(room, `${player.name} 님이 긴급 회의를 소집했습니다. 마피아를 지목하세요.`);
  if (room.meetingTimer) clearTimeout(room.meetingTimer);
  room.meetingTimer = setTimeout(() => {
    if (room.phase === "meeting") {
      resolveMeeting(room);
      onEnd(room);
    }
  }, MEETING_MS + 50);
}

export function vote(room: Room, playerId: string, target: string | "skip"): void {
  requireAlive(room, playerId);
  if (room.phase !== "meeting" || !room.meeting) throw new Error("회의 중이 아닙니다.");
  if (target !== "skip") {
    const t = room.players.get(target);
    if (!t || !t.alive) throw new Error("투표 대상이 올바르지 않습니다.");
  }
  room.meeting.votes.set(playerId, target);
  const livingCount = living(room).length;
  if (room.meeting.votes.size >= livingCount) {
    resolveMeeting(room);
  }
}

function resolveMeeting(room: Room): void {
  if (room.phase !== "meeting" || !room.meeting) return;
  if (room.meetingTimer) {
    clearTimeout(room.meetingTimer);
    room.meetingTimer = null;
  }
  const counts = new Map<string, number>();
  for (const v of room.meeting.votes.values()) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  let tie = false;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
      tie = false;
    } else if (n === bestN) {
      tie = true;
    }
  }
  room.meeting = null;
  if (!best || best === "skip" || tie || bestN === 0) {
    systemChat(room, "투표가 부결되었습니다. 아무도 추방되지 않았습니다.");
    room.phase = "playing";
    return;
  }
  const ejected = room.players.get(best);
  if (!ejected) {
    room.phase = "playing";
    return;
  }
  ejected.alive = false;
  room.lastEject = { name: ejected.name, role: ejected.role ?? "citizen" };
  systemChat(
    room,
    `${ejected.name} 님이 추방되었습니다. 정체: ${ejected.role === "mafia" ? "마피아" : "시민"}`,
  );
  // 마피아가 모두 사라졌다면 미션 정산보다 먼저 시민 승리 처리
  if (checkWin(room)) return;
  pruneDeadFromMissions(room);
  // 미션 정산으로 게임이 끝났을 수 있으므로 현재 phase를 다시 읽는다.
  if (!isEnded(room)) room.phase = "playing";
}

function isEnded(room: Room): boolean {
  return room.phase === "ended";
}

/** 추방된 사람을 미션 계산에서 빼고, 이미 조건이 충족된 미션이 있으면 완료 처리한다. */
function pruneDeadFromMissions(room: Room): void {
  const alive = new Set(living(room).map((p) => p.id));
  for (const id of [...room.syncPressed]) {
    if (!alive.has(id)) room.syncPressed.delete(id);
  }
  for (const mission of room.missions.values()) {
    if (mission.done) continue;
    for (const id of [...mission.contributed]) {
      if (!alive.has(id)) mission.contributed.delete(id);
    }
  }
  reassignOrphanHints(room, "code");
  reassignOrphanHints(room, "forge");

  maybeCompleteCitizen(room, "power");
  maybeCompleteCitizen(room, "code");
  maybeCompleteSync(room);
  maybeAdvanceSignal(room);
  maybeCompleteForge(room);
}

/* ───────────── 승리 판정 ───────────── */

/** 미션 기준 승리: 시민 미션 3개 완료 → 시민, 마피아 특별 미션 2개 완료 → 마피아 */
function checkMissionWin(room: Room): boolean {
  if (room.phase === "ended") return true;
  const citizensDone = CITIZEN_MISSION_IDS.every((id) => room.missions.get(id)?.done);
  if (citizensDone) {
    finish(room, "citizen", "시민이 세 개의 협동 미션을 모두 완료했습니다.");
    return true;
  }
  const mafiaDone = room.missions.get("signal")?.done && room.missions.get("forge")?.done;
  if (mafiaDone) {
    finish(room, "mafia", "마피아가 두 개의 특별 미션을 먼저 완료했습니다.");
    return true;
  }
  return false;
}

/** 생존자 기준 승리 */
function checkWin(room: Room): boolean {
  const alive = living(room);
  const mafiaAlive = alive.filter((p) => p.role === "mafia");
  const citizenAlive = alive.filter((p) => p.role === "citizen");
  if (mafiaAlive.length === 0) {
    finish(room, "citizen", "마피아를 모두 추방했습니다.");
    return true;
  }
  if (citizenAlive.length === 0) {
    finish(room, "mafia", "시민이 모두 추방되었습니다.");
    return true;
  }
  return false;
}

function finish(room: Room, winner: Role, reason: string): void {
  room.phase = "ended";
  room.winner = winner;
  room.winReason = reason;
  room.meeting = null;
  room.sync = null;
  if (room.meetingTimer) {
    clearTimeout(room.meetingTimer);
    room.meetingTimer = null;
  }
  clearRevealTimers(room);
}

export function replay(room: Room): void {
  if (room.meetingTimer) clearTimeout(room.meetingTimer);
  clearRevealTimers(room);

  // 연결이 끊긴 사람은 다음 판에서 제외 (미션이 전원 협동이라 남겨두면 멈춘다)
  for (const p of [...room.players.values()]) {
    if (!p.connected) {
      room.players.delete(p.id);
      playerRoom.delete(p.id);
    }
  }
  if (!room.players.has(room.hostId)) {
    const next = room.players.values().next().value as Player | undefined;
    if (next) room.hostId = next.id;
  }

  room.phase = "lobby";
  room.missions.clear();
  room.secretCode = "";
  room.forgeCode = "";
  room.sync = null;
  room.syncPressed.clear();
  room.signalStage = 0;
  room.signalReadyAt = 0;
  room.sabotageReadyAt = 0;
  room.sabotageCount = new Map();
  room.meeting = null;
  room.winner = null;
  room.winReason = null;
  room.lastEject = null;
  room.startedAt = null;
  room.playingAt = null;
  room.meetingTimer = null;
  for (const p of room.players.values()) {
    p.alive = true;
    p.role = null;
    p.missionIds = [];
    p.meetingsLeft = 1;
    p.codeHints = [];
    p.forgeHints = [];
  }
  systemChat(room, "로비로 돌아왔습니다. 방장이 다시 시작할 수 있습니다.");
}

function requirePlaying(room: Room, playerId: string, mission: MissionId): void {
  requireAlive(room, playerId);
  if (room.phase !== "playing") throw new Error("지금은 미션을 진행할 수 없습니다.");
  const player = room.players.get(playerId)!;
  if (!player.missionIds.includes(mission)) throw new Error("이 미션을 받지 않았습니다.");
}

function requireAlive(room: Room, playerId: string): void {
  const player = room.players.get(playerId);
  if (!player) throw new Error("플레이어가 아닙니다.");
  if (!player.alive) throw new Error("이미 추방된 상태입니다.");
}

function sanitize(name: string): string {
  const n = name.trim().slice(0, 12);
  if (!n) throw new Error("닉네임을 입력하세요.");
  return n;
}

/* ───────────── 클라이언트로 내려보낼 상태 ───────────── */

export function serialize(room: Room, viewerId: string): ClientState {
  const you = room.players.get(viewerId);
  if (!you) throw new Error("방에 없습니다.");
  const now = Date.now();
  const showRoles = room.phase === "ended";
  const isMafia = you.role === "mafia" && room.phase !== "lobby";
  const mafiaAllies = isMafia
    ? [...room.players.values()]
        .filter((p) => p.role === "mafia" && p.id !== you.id)
        .map((p) => p.name)
    : [];

  const missions: ClientState["missions"] = you.missionIds.map((id) => {
    const m = room.missions.get(id)!;
    const needed = livingReceivers(room, id);
    const contributedNames =
      id === "sync" && !m.done
        ? needed.filter((p) => room.syncPressed.has(p.id)).map((p) => p.name)
        : needed.filter((p) => m.contributed.has(p.id)).map((p) => p.name);
    const isSignal = id === "signal";
    const contributed = isSignal
      ? m.done
        ? SIGNAL_STAGES
        : room.signalStage
      : id === "sync" && !m.done
        ? room.syncPressed.size
        : m.contributed.size;
    return {
      id,
      title: MISSION_META[id].title,
      blurb: MISSION_META[id].blurb,
      special: id === "signal" || id === "forge",
      done: m.done,
      needed: isSignal ? SIGNAL_STAGES : needed.length,
      contributed,
      contributedNames,
    };
  });

  // 위조 서류 번호 조각은 공개 시점이 지난 것만 내려보낸다.
  const playingAt = room.playingAt;
  const forgeHints =
    playingAt === null || !you.missionIds.includes("forge")
      ? []
      : you.forgeHints.filter((h) => now >= playingAt + (h.index + 1) * FORGE_HINT_MS);

  const sabotageTargets = isMafia
    ? CITIZEN_MISSION_IDS.map((id) => ({
        id,
        title: MISSION_META[id].title,
        done: room.missions.get(id)?.done ?? false,
        left: Math.max(0, SABOTAGE_PER_MISSION - (room.sabotageCount.get(id) ?? 0)),
      }))
    : [];

  return {
    roomCode: room.code,
    phase: room.phase,
    you: {
      id: you.id,
      name: you.name,
      isHost: room.hostId === you.id,
      alive: you.alive,
      role: room.phase === "lobby" ? null : you.role,
      missionIds: you.missionIds,
      meetingsLeft: you.meetingsLeft,
      codeHints: you.missionIds.includes("code") ? you.codeHints : [],
      forgeHints,
      mafiaAllies,
      sabotageReadyAt: isMafia ? room.sabotageReadyAt : null,
      sabotageTargets,
      signalReadyAt: isMafia ? room.signalReadyAt : null,
    },
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      alive: p.alive,
      connected: p.connected,
      role: showRoles ? p.role : null,
    })),
    missions,
    sync: you.missionIds.includes("sync") ? room.sync : null,
    meeting: room.meeting
      ? {
          calledBy: room.meeting.calledBy,
          calledByName: room.players.get(room.meeting.calledBy)?.name ?? "알 수 없음",
          endsAt: room.meeting.endsAt,
          votes: Object.fromEntries(room.meeting.votes),
          votedCount: room.meeting.votes.size,
          livingCount: living(room).length,
        }
      : null,
    // 마피아 전용 대화는 마피아에게만 보인다.
    chat: room.chat.filter((m) => (m.channel ?? "all") === "all" || isMafia),
    winner: room.winner,
    winReason: room.winReason,
    lastEject: room.lastEject,
    startedAt: room.startedAt,
    playingAt: room.playingAt,
  };
}
