import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ChatChannel, ClientState, MissionId } from "../shared/types";
import {
  CODE_LENGTH,
  FORGE_HINT_MS,
  FORGE_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROLE_TABLE,
  SABOTAGE_PER_MISSION,
} from "../shared/types";
import { socket } from "./socket";

const PID_KEY = "mission-mafia-id";

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function App() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [playerId, setPlayerId] = useState(() => localStorage.getItem(PID_KEY) || "");
  const [state, setState] = useState<ClientState | null>(null);

  useEffect(() => {
    const onState = (next: ClientState) => setState(next);
    const onJoined = ({ playerId: id }: { playerId: string }) => {
      setPlayerId(id);
      localStorage.setItem(PID_KEY, id);
    };
    const onErr = (msg: string) => setError(msg);
    const onLeft = () => setState(null);
    // 새로고침하거나 연결이 끊겼다 돌아오면 저장된 ID로 방에 다시 들어간다.
    const tryRejoin = () => {
      const id = localStorage.getItem(PID_KEY);
      if (id) socket.emit("rejoin", { playerId: id });
    };
    socket.on("state", onState);
    socket.on("joined", onJoined);
    socket.on("errorMsg", onErr);
    socket.on("left", onLeft);
    socket.on("connect", tryRejoin);
    if (socket.connected) tryRejoin();
    return () => {
      socket.off("state", onState);
      socket.off("joined", onJoined);
      socket.off("errorMsg", onErr);
      socket.off("left", onLeft);
      socket.off("connect", tryRejoin);
    };
  }, []);

  // 오류 문구는 잠깐 보여주고 지운다.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 3500);
    return () => clearTimeout(t);
  }, [error]);

  const create = () => {
    setError("");
    socket.emit("createRoom", { name, playerId: playerId || undefined });
  };
  const join = () => {
    setError("");
    socket.emit("joinRoom", { name, roomCode: code, playerId: playerId || undefined });
  };

  if (!state) {
    return (
      <div className="home">
        <div className="home-card">
          <div className="kicker">CO-OP DECEPTION</div>
          <h1>미션 마피아</h1>
          <p className="lede">
            시민은 세 개의 협동 미션을 깨며 마피아를 찾고, 마피아는 시민 미션 두 개로 위장한 채 특별 미션 두 개를
            먼저 끝냅니다.
          </p>
          <label htmlFor="nick">닉네임</label>
          <input id="nick" value={name} maxLength={12} onChange={(e) => setName(e.target.value)} placeholder="이름" />
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn btn-blood" disabled={!name.trim()} onClick={create}>
              방 만들기
            </button>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="방 코드"
              maxLength={8}
            />
            <button className="btn btn-ghost" disabled={!name.trim() || !code.trim()} onClick={join}>
              입장
            </button>
          </div>
          <p className="error">{error}</p>
          <div className="rules">
            {MIN_PLAYERS}~{MAX_PLAYERS}명. 방장이 시작. 역할은 시민/마피아뿐.
            <br />
            시민은 협동 미션 3개를 모두 완료하면 승리.
            <br />
            마피아는 시민 미션 2개로 위장하면서 특별 미션 2개를 먼저 완료하면 승리.
            <br />
            미션은 받은 사람 전원이 빠짐없이 협동해야 완료됩니다.
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === "reveal") return <Reveal state={state} />;
  if (state.phase === "ended") return <Ended state={state} playerId={playerId} />;

  return <Table state={state} playerId={playerId} error={error} />;
}

function Reveal({ state }: { state: ClientState }) {
  const mafia = state.you.role === "mafia";
  return (
    <div className={`role-card ${mafia ? "mafia" : "citizen"}`}>
      <div>
        <div className="kicker">{mafia ? "KEEP YOUR COVER" : "FIND THE SHADOW"}</div>
        <h1>{mafia ? "마피아" : "시민"}</h1>
        <p className="lede" style={{ maxWidth: 460, marginInline: "auto" }}>
          {mafia
            ? `동료: ${state.you.mafiaAllies.length ? state.you.mafiaAllies.join(", ") : "없음 (단독)"}. 시민 미션으로 위장하면서 특별 미션 두 개를 먼저 끝내세요.`
            : "세 개의 협동 미션을 모두 끝내거나, 마피아가 특별 미션을 끝내기 전에 회의로 추방하세요."}
        </p>
        <ul className="reveal-missions">
          {state.missions.map((m) => (
            <li key={m.id} className={m.special ? "special" : ""}>
              <strong>{m.title}</strong>
              {m.special ? <span className="tag">마피아 전용</span> : null}
              <span>{m.blurb}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Ended({ state, playerId }: { state: ClientState; playerId: string }) {
  const citizenWin = state.winner === "citizen";
  return (
    <div className="shell">
      <div className="role-card" style={{ minHeight: "auto", padding: "48px 0" }}>
        <div>
          <div className="kicker">GAME OVER</div>
          <h1>{citizenWin ? "시민 승리" : "마피아 승리"}</h1>
          {state.winReason && <p className="lede win-reason">{state.winReason}</p>}
          <div className="result-list">
            {state.players.map((p) => (
              <div className="player" key={p.id}>
                <span>
                  {p.name}
                  {p.isHost ? " ★" : ""}
                </span>
                <span>
                  <span className={`tag ${p.role === "mafia" ? "tag-mafia" : ""}`}>
                    {p.role === "mafia" ? "마피아" : "시민"}
                  </span>{" "}
                  <span className={`tag ${p.alive ? "" : "dead"}`}>{p.alive ? "생존" : "추방"}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "center", marginTop: 20 }}>
            {state.you.isHost && (
              <button className="btn btn-blood" onClick={() => socket.emit("replay", { playerId })}>
                로비로
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => socket.emit("leave", { playerId })}>
              나가기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Table({
  state,
  playerId,
  error,
}: {
  state: ClientState;
  playerId: string;
  error: string;
}) {
  const n = state.players.length;
  const table = ROLE_TABLE[n];
  const canStart = state.you.isHost && n >= MIN_PLAYERS && n <= MAX_PLAYERS && state.phase === "lobby";
  const isMafia = state.you.role === "mafia";

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <div className="kicker">ROOM</div>
          <div className="stamp room-code">{state.roomCode}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          {state.you.role && (
            <div style={{ color: isMafia ? "var(--blood)" : "var(--citizen)", fontWeight: 700 }}>
              {isMafia ? "마피아" : "시민"}
              {state.you.mafiaAllies.length ? ` · 동료 ${state.you.mafiaAllies.join(", ")}` : ""}
            </div>
          )}
          <div style={{ color: "#8a7b6d", fontSize: 13 }}>
            {n}명{table ? ` · 시민 ${table.citizens} / 마피아 ${table.mafia}` : ` · ${MIN_PLAYERS}명부터 시작`}
          </div>
        </div>
      </header>

      <div className={`grid ${state.phase === "lobby" ? "lobby-grid" : "playing-grid"}`}>
        <section className="panel player-panel">
          <h2>플레이어 <span className="panel-count">{n}/{MAX_PLAYERS}</span></h2>
          {state.players.map((p) => (
            <div className="player" key={p.id}>
              <span>
                {p.name}
                {p.isHost ? " ★" : ""}
                {!p.connected ? " (접속 끊김)" : ""}
              </span>
              <span className={`tag ${state.phase === "lobby" ? "waiting" : p.alive ? "" : "dead"}`}>
                {state.phase === "lobby" ? (p.isHost ? "방장" : "대기 중") : p.alive ? "생존" : "추방"}
              </span>
            </div>
          ))}
          {state.phase === "lobby" && (
            <div className="lobby-player-note">
              <span className="status-dot" /> {n >= MIN_PLAYERS ? "게임을 시작할 수 있어요" : `${MIN_PLAYERS - n}명 더 모이면 시작 가능`}
            </div>
          )}
          {state.phase !== "lobby" && null}
        </section>

        <section className={`panel main-panel ${state.phase === "lobby" ? "lobby-center" : "mission-panel"}`}>
          {state.phase === "lobby" ? (
            <>
              <div className="lobby-room-art">
                <div className="kicker">WAITING ROOM</div>
                <div className="lobby-room-code">{state.roomCode}</div>
                <p>모든 플레이어가 준비되면 게임을 시작하세요.</p>
                <div className="lobby-count"><strong>{n} / {MAX_PLAYERS}</strong><span>최소 {MIN_PLAYERS}명 · 최대 {MAX_PLAYERS}명</span></div>
              </div>
              <div className="lobby-actions">
                <button className="btn btn-blood start-btn" disabled={!canStart} onClick={() => socket.emit("startGame", { playerId })}>
                  ▶　게임 시작
                </button>
                <button className="btn btn-ghost" onClick={() => socket.emit("leave", { playerId })}>방 나가기</button>
              </div>
              <div className="lobby-rules"><LobbyHelp /></div>
            </>
          ) : <Missions state={state} playerId={playerId} />}
          {state.lastEject && state.phase === "playing" && (
            <p style={{ color: "var(--gold)", fontSize: 13 }}>
              직전 추방: {state.lastEject.name} · {state.lastEject.role === "mafia" ? "마피아" : "시민"}
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </section>

        <section className={`panel chat-panel ${state.phase === "lobby" ? "lobby-chat-panel" : "playing-chat-panel"}`}>
          <h2>{state.phase === "lobby" ? "방 대화" : "게임 대화"}</h2>
          <ChatBox state={state} playerId={playerId} />
        </section>
      </div>

      {state.phase === "meeting" && state.meeting && <Meeting state={state} playerId={playerId} error={error} />}
    </div>
  );
}

function LobbyHelp() {
  return (
    <>
      <h2>규칙</h2>
      <p className="lede" style={{ marginBottom: 12 }}>
        받은 미션은 한 명도 빠짐없이 같이 깨야 합니다. 시민은 협동 미션 3개를 모두 완료하면 이깁니다.
      </p>
      <p className="lede" style={{ marginBottom: 12 }}>
        마피아는 시민 미션 중 2개를 받아 함께 깨며 연기하고, 특별 미션 2개(비밀 송신·위조 서류)를 시민보다 먼저 끝내면
        이깁니다. 마피아끼리는 비밀 대화를 쓸 수 있고, 일정 간격으로 시민 미션을 몰래 방해할 수 있습니다.
      </p>
      <p className="lede" style={{ marginBottom: 0 }}>
        긴급 회의에서 마피아를 모두 추방해도 시민이 이깁니다. 회의는 한 사람당 1번만 열 수 있습니다.
      </p>
    </>
  );
}

function Missions({ state, playerId }: { state: ClientState; playerId: string }) {
  const [active, setActive] = useState<MissionId | null>(state.missions[0]?.id ?? null);
  const current = state.missions.find((m) => m.id === (active ?? state.missions[0]?.id));
  const isMafia = state.you.role === "mafia";

  if (!state.you.alive) {
    return <p className="lede">추방되었습니다. 관전만 가능합니다.</p>;
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>미션</h2>
        {state.phase === "playing" && (
          <button
            className="btn btn-ghost"
            disabled={state.you.meetingsLeft <= 0}
            onClick={() => socket.emit("callMeeting", { playerId })}
          >
            회의 {state.you.meetingsLeft}/1
          </button>
        )}
      </div>
      {state.missions.map((m) => (
        <button
          key={m.id}
          className={`mission ${m.done ? "done" : ""} ${m.special ? "special" : ""} ${current?.id === m.id ? "selected" : ""}`}
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => setActive(m.id)}
        >
          <h3>
            {m.title}
            {m.special ? <span className="tag tag-mafia">마피아 전용</span> : null}
            {m.done ? " · 완료" : ""}
          </h3>
          <div className="bar">
            <span style={{ width: `${Math.min(100, (m.contributed / Math.max(1, m.needed)) * 100)}%` }} />
          </div>
          <small>
            {m.id === "signal" ? `단계 ${m.contributed}/${m.needed}` : `${m.contributed}/${m.needed}`}
            {m.contributedNames.length ? ` · ${m.contributedNames.join(", ")}` : ""}
          </small>
        </button>
      ))}
      {current && !current.done && <MissionPlay missionId={current.id} state={state} playerId={playerId} />}
      {isMafia && state.phase === "playing" && <SabotagePanel state={state} playerId={playerId} />}
    </>
  );
}

function MissionPlay({
  missionId,
  state,
  playerId,
}: {
  missionId: MissionId;
  state: ClientState;
  playerId: string;
}) {
  if (missionId === "power") {
    const mine = state.missions.find((m) => m.id === "power");
    const already = mine?.contributedNames.includes(state.you.name);
    return (
      <div className="mission">
        <p>{mine?.blurb}</p>
        <button className="btn btn-blood" disabled={already} onClick={() => socket.emit("power", { playerId })}>
          {already ? "차단기 올림" : "내 차단기 올리기"}
        </button>
      </div>
    );
  }
  if (missionId === "code") return <CodePlay kind="code" state={state} playerId={playerId} />;
  if (missionId === "forge") return <CodePlay kind="forge" state={state} playerId={playerId} />;
  if (missionId === "sync") return <SyncPlay state={state} playerId={playerId} />;
  return <SignalPlay state={state} playerId={playerId} />;
}

function SignalPlay({ state, playerId }: { state: ClientState; playerId: string }) {
  const now = useNow(500);
  const mine = state.missions.find((m) => m.id === "signal");
  const wait = Math.max(0, Math.ceil(((state.you.signalReadyAt ?? 0) - now) / 1000));
  const pressed = !!mine?.contributedNames.includes(state.you.name);
  return (
    <div className="mission special">
      <p>{mine?.blurb}</p>
      <button
        className="btn btn-blood"
        disabled={wait > 0 || pressed}
        onClick={() => socket.emit("signal", { playerId })}
      >
        {wait > 0 ? `장비 준비 중 ${wait}초` : pressed ? "송신 완료 · 동료 대기 중" : "송신하기"}
      </button>
    </div>
  );
}

function CodePlay({
  kind,
  state,
  playerId,
}: {
  kind: "code" | "forge";
  state: ClientState;
  playerId: string;
}) {
  const now = useNow(1000);
  const [guess, setGuess] = useState("");
  const len = kind === "code" ? CODE_LENGTH : FORGE_LENGTH;
  const hints = kind === "code" ? state.you.codeHints : state.you.forgeHints;
  const mine = state.missions.find((m) => m.id === kind);
  const submitted = !!mine?.contributedNames.includes(state.you.name);

  const slots = useMemo(() => {
    const arr = Array(len).fill("?") as string[];
    for (const h of hints) arr[h.index] = h.char;
    return arr;
  }, [hints, len]);

  let revealInfo = "";
  if (kind === "forge" && state.playingAt) {
    const revealed = Math.min(FORGE_LENGTH, Math.max(0, Math.floor((now - state.playingAt) / FORGE_HINT_MS)));
    revealInfo =
      revealed >= FORGE_LENGTH
        ? "모든 번호 조각이 공개되었습니다."
        : `번호 조각 공개 ${revealed}/${FORGE_LENGTH} · 다음 조각까지 ${Math.max(
            0,
            Math.ceil((state.playingAt + (revealed + 1) * FORGE_HINT_MS - now) / 1000),
          )}초`;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    socket.emit(kind, { playerId, guess });
  };

  return (
    <div className={`mission ${kind === "forge" ? "special" : ""}`}>
      <p>
        {kind === "code"
          ? `당신이 가진 조각만 보입니다. 채팅으로 맞춰 전원이 같은 ${len}자리를 내세요.`
          : `당신이 가진 번호 조각만 보입니다. 마피아 대화로 맞춰 전원이 같은 ${len}자리를 내세요.`}
      </p>
      <div style={{ margin: "10px 0" }}>
        {slots.map((c, i) => (
          <span className="hint" key={i}>
            {c}
          </span>
        ))}
      </div>
      {revealInfo && <p className="small">{revealInfo}</p>}
      <form className="row" onSubmit={submit}>
        <input
          value={guess}
          disabled={submitted}
          inputMode={kind === "forge" ? "numeric" : undefined}
          onChange={(e) =>
            setGuess(kind === "forge" ? e.target.value.replace(/\D/g, "") : e.target.value.toUpperCase())
          }
          maxLength={len}
          placeholder={`${len}자리`}
        />
        <button className="btn btn-blood" disabled={submitted}>
          {submitted ? "제출됨" : "제출"}
        </button>
      </form>
    </div>
  );
}

function SyncPlay({ state, playerId }: { state: ClientState; playerId: string }) {
  const now = useNow(80);
  const sync = state.sync;
  const inWindow = !!sync && now >= sync.countdownEndsAt && now <= sync.windowEndsAt;
  const counting = !!sync && now < sync.countdownEndsAt;
  return (
    <div className="mission" style={{ textAlign: "center" }}>
      <p>한 명이 시작하면 카운트 후 초록 순간에 전원이 눌러야 합니다.</p>
      <button
        className={`sync-btn ${inWindow ? "go" : ""}`}
        onClick={() => {
          if (!sync || now > sync.windowEndsAt) socket.emit("startSync", { playerId });
          else socket.emit("pressSync", { playerId });
        }}
      >
        {counting ? Math.ceil((sync!.countdownEndsAt - now) / 1000) : inWindow ? "지금!" : "시작"}
      </button>
    </div>
  );
}

function SabotagePanel({ state, playerId }: { state: ClientState; playerId: string }) {
  const now = useNow(500);
  const wait = Math.max(0, Math.ceil(((state.you.sabotageReadyAt ?? 0) - now) / 1000));
  return (
    <div className="mission sabotage">
      <h3>방해 공작</h3>
      <p className="small">
        시민 미션 하나를 몰래 되돌립니다. 시민에게는 누가 했는지 보이지 않습니다. 미션마다 최대{" "}
        {SABOTAGE_PER_MISSION}번, 마피아 팀 전체가 공유하는 대기시간이 있습니다.
      </p>
      <div className="row sabotage-row">
        {state.you.sabotageTargets.map((t) => (
          <button
            key={t.id}
            className="btn btn-ghost"
            disabled={wait > 0 || t.done || t.left <= 0}
            onClick={() => socket.emit("sabotage", { playerId, mission: t.id })}
          >
            {t.title}
            {t.done ? " · 완료" : ` (${t.left}회)`}
          </button>
        ))}
      </div>
      <small>{wait > 0 ? `다음 방해까지 ${wait}초` : "지금 사용할 수 있습니다"}</small>
    </div>
  );
}

function ChatBox({
  state,
  playerId,
  compact,
}: {
  state: ClientState;
  playerId: string;
  compact?: boolean;
}) {
  const canMafiaChat = state.you.role === "mafia" && state.phase !== "lobby";
  const [channel, setChannel] = useState<ChatChannel>("all");
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const disabled = !state.you.alive && state.phase !== "lobby";
  const activeChannel: ChatChannel = canMafiaChat ? channel : "all";

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.chat.length]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    socket.emit("chat", { playerId, text, channel: activeChannel });
    setText("");
  };

  return (
    <div className={`chat ${compact ? "compact" : ""}`}>
      {canMafiaChat && (
        <div className="chat-tabs">
          <button
            type="button"
            className={activeChannel === "all" ? "on" : ""}
            onClick={() => setChannel("all")}
          >
            전체
          </button>
          <button
            type="button"
            className={activeChannel === "mafia" ? "on mafia" : "mafia"}
            onClick={() => setChannel("mafia")}
          >
            마피아 비밀
          </button>
        </div>
      )}
      <div className="chat-log" ref={logRef}>
        {state.chat.map((m) => (
          <div
            key={m.id}
            className={`${m.system ? "sys" : ""} ${m.channel === "mafia" ? "mafia-msg" : ""}`}
          >
            {m.channel === "mafia" ? "[마피아] " : ""}
            {m.system ? m.text : `${m.name}: ${m.text}`}
          </div>
        ))}
      </div>
      <form className="chat-form" onSubmit={send}>
        <input
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          placeholder={activeChannel === "mafia" ? "마피아에게만 보입니다" : "메시지"}
        />
        <button className="btn btn-ghost" disabled={disabled}>
          전송
        </button>
      </form>
    </div>
  );
}

function Meeting({
  state,
  playerId,
  error,
}: {
  state: ClientState;
  playerId: string;
  error: string;
}) {
  const now = useNow(250);
  const left = Math.max(0, Math.ceil(((state.meeting?.endsAt ?? 0) - now) / 1000));
  const myVote = state.meeting?.votes[playerId];
  return (
    <div className="overlay">
      <div className="modal">
        <div className="kicker">EMERGENCY MEETING</div>
        <h1 style={{ fontSize: 36 }}>긴급 회의</h1>
        <p className="lede">
          {state.meeting?.calledByName} 님이 소집 · 남은 {left}초 · 투표 {state.meeting?.votedCount}/
          {state.meeting?.livingCount}
        </p>
        <div className="vote-grid">
          {state.players
            .filter((p) => p.alive)
            .map((p) => (
              <button
                key={p.id}
                className="btn btn-ghost"
                disabled={!state.you.alive}
                style={myVote === p.id ? { borderColor: "var(--blood)", color: "#f3e6d4" } : undefined}
                onClick={() => socket.emit("vote", { playerId, target: p.id })}
              >
                {p.name}
              </button>
            ))}
          <button
            className="btn btn-ghost"
            disabled={!state.you.alive}
            style={myVote === "skip" ? { borderColor: "var(--gold)" } : undefined}
            onClick={() => socket.emit("vote", { playerId, target: "skip" })}
          >
            기권
          </button>
        </div>
        <ChatBox state={state} playerId={playerId} compact />
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
