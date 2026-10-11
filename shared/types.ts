export type Role = "citizen" | "mafia";
export type Phase = "lobby" | "reveal" | "playing" | "meeting" | "ended";
export type CitizenMissionId = "power" | "code" | "sync";
export type MafiaMissionId = "signal" | "forge";
export type MissionId = CitizenMissionId | MafiaMissionId;
export type ChatChannel = "all" | "mafia" | "dead";

export const CITIZEN_MISSION_IDS: CitizenMissionId[] = ["power", "code", "sync"];
export const MAFIA_MISSION_IDS: MafiaMissionId[] = ["signal", "forge"];

export const ROLE_TABLE: Record<number, { citizens: number; mafia: number }> = {
  5: { citizens: 4, mafia: 1 },
  6: { citizens: 5, mafia: 1 },
  7: { citizens: 5, mafia: 2 },
  8: { citizens: 5, mafia: 3 },
  9: { citizens: 6, mafia: 3 },
  10: { citizens: 6, mafia: 4 },
};

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;
export const MEETING_MS = 50_000;

/* ───── 밸런스 조절용 상수 (숫자만 바꿔서 난이도 조절) ───── */
export const CODE_LENGTH = 4; // 시민 미션: 암호 조합 자릿수 (6 → 4)
export const FORGE_LENGTH = 3; // 마피아 미션: 위조 서류 번호 자릿수 (4 → 3)
export const SIGNAL_STAGES = 2; // 마피아 미션: 비밀 송신 단계 수 (3 → 2)
export const SIGNAL_STAGE_MS = 40_000; // 송신 장비가 다음 단계를 준비하는 시간 (50초 → 40초)
export const FORGE_HINT_MS = 30_000; // 위조 서류 번호 조각이 하나씩 공개되는 간격 (40초 → 30초)
export const SABOTAGE_FIRST_MS = 30_000; // 게임 시작 후 첫 방해 공작까지 대기
export const SABOTAGE_COOLDOWN_MS = 45_000; // 마피아 팀 전체 방해 공작 쿨다운
export const SABOTAGE_PER_MISSION = 2; // 시민 미션 하나당 방해 가능 횟수
export const KILL_COOLDOWN_MS = 60_000; // 마피아 죽이기 쿨다운 (1분)
export const MAX_KILLS_PER_MAFIA = 2; // 마피아 1인당 최대 죽일 수 있는 횟수

export const MISSION_META: Record<MissionId, { title: string; blurb: string }> = {
  power: {
    title: "전원 공급",
    blurb: "이 미션을 받은 사람 전원이 차단기를 올리면 완료됩니다.",
  },
  code: {
    title: "암호 조합",
    blurb: "각자가 가진 조각을 모아 4자리 코드를 맞춰 제출하세요.",
  },
  sync: {
    title: "심장 동기화",
    blurb: "한 명이 시작하면 초록 불이 켜질 때 전원이 함께 버튼을 누르세요.",
  },
  signal: {
    title: "비밀 송신",
    blurb: "마피아 전원이 송신 버튼을 누르면 완료됩니다. 장비가 식으면 기다렸다 누르세요.",
  },
  forge: {
    title: "위조 서류",
    blurb: "시간이 지나면 번호 조각이 공개됩니다. 3자리 번호를 맞춰 제출하세요.",
  },
};

export interface PlayerPublic {
  id: string;
  name: string;
  isHost: boolean;
  alive: boolean;
  connected: boolean;
  role?: Role | null;
}

export interface MissionProgress {
  id: MissionId;
  title: string;
  blurb: string;
  special: boolean;
  done: boolean;
  needed: number;
  contributed: number;
  contributedNames: string[];
  showNames: boolean;
}

export interface CodeHint {
  index: number;
  char: string;
}

export interface SabotageTarget {
  id: CitizenMissionId;
  title: string;
  done: boolean;
  left: number;
}

export interface SyncWindow {
  countdownEndsAt: number;
  windowEndsAt: number;
}

export interface MeetingState {
  calledBy: string;
  calledByName: string;
  endsAt: number;
  votes: Record<string, string | "skip">;
  votedCount: number;
  livingCount: number;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  name: string;
  text: string;
  at: number;
  system?: boolean;
  channel?: ChatChannel;
}

export interface ClientState {
  roomCode: string;
  phase: Phase;
  you: {
    id: string;
    name: string;
    isHost: boolean;
    alive: boolean;
    role: Role | null;
    missionIds: MissionId[];
    meetingsLeft: number;
    codeHints: CodeHint[];
    forgeHints: CodeHint[];
    mafiaAllies: string[];
    sabotageReadyAt: number | null;
    sabotageTargets: SabotageTarget[];
    signalReadyAt: number | null;
    killReadyAt: number | null;
    killCount: number;
  };
  players: PlayerPublic[];
  missions: MissionProgress[];
  sync: SyncWindow | null;
  meeting: MeetingState | null;
  chat: ChatMessage[];
  winner: Role | null;
  winReason: string | null;
  lastEject: { name: string; role: Role } | null;
  lastKill: { name: string; role: Role; killer: string } | null;
  startedAt: number | null;
  playingAt: number | null;
}
