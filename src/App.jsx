import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  AlertTriangle, AlignLeft, ArrowDown, ArrowUp, Bell, BellOff,
  Check, CheckCircle2, ChevronRight, Circle, CloudUpload, Copy,
  Download, FileArchive, FolderOpen, History, Hourglass,
  Inbox, KeyRound, Link, Loader, Lock, MessageCircleMore,
  Pen, Send, ShieldCheck, Upload, User,
  X, Zap, RotateCcw, RotateCw, Wifi,
} from "lucide-react";
import {
  fmt, fmtSpd, tsNow,
  fileIcon, isImage,
  avatarColor, avatarInitial,
  crc32, tryCompress, copyText, uid,
} from "./utils/utils.js";

/* ─────────────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────────────── */
const CHUNK = 16384;

const randomName = () => `Peer${Math.floor(10000 + Math.random() * 90000)}`;

/* ─────────────────────────────────────────────────────────────────────
   HOOKS
───────────────────────────────────────────────────────────────────── */
function useIsMobile(bp = 768) {
  const [v, setV] = useState(() => window.innerWidth <= bp);
  useEffect(() => {
    const fn = () => setV(window.innerWidth <= bp);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, [bp]);
  return v;
}

/* ─────────────────────────────────────────────────────────────────────
   SOUND
───────────────────────────────────────────────────────────────────── */
const playNotif = () => {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } catch {}
};

/* ─────────────────────────────────────────────────────────────────────
   COMPONENTS
───────────────────────────────────────────────────────────────────── */
function Avatar({ name, id, size = 34 }) {
  const color = avatarColor(id || name);
  return (
    <div className="avatar" style={{ width: size, height: size, minWidth: size, background: color, fontSize: size * 0.38 }}>
      {avatarInitial(name)}
    </div>
  );
}

function Toasts({ list }) {
  const icons = { ok: <Check size={13} />, err: <X size={13} />, warn: <AlertTriangle size={13} />, info: <ChevronRight size={13} /> };
  return (
    <div className="toast-wrap">
      {list.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>{icons[t.type]}<span>{t.msg}</span></div>
      ))}
    </div>
  );
}

function ChatBox({ messages, chatText, setChatText, onSend, typingPeer }) {
  const ref = useRef();
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [messages]);
  return (
    <div className="chat-outer">
      <div className="chat-msgs" ref={ref}>
        {messages.length === 0 && <div className="empty" style={{ padding: "1rem 0" }}>Nenhuma mensagem ainda</div>}
        {messages.map((m, i) => (
          <div key={i} className={`chat-m ${m.me ? "me" : "them"}`}>
            <div className="chat-bubble">{m.text}</div>
            <div className="chat-meta">{m.time}</div>
          </div>
        ))}
        {typingPeer && (
          <div className="chat-m them">
            <div className="chat-bubble" style={{ opacity: .6, fontFamily: "var(--mono)", fontSize: ".72rem", display: "flex", alignItems: "center", gap: ".4rem" }}>
              <MessageCircleMore size={12} /> digitando...
            </div>
          </div>
        )}
      </div>
      <div style={{ height: 8 }} />
      <div className="chat-footer">
        <input className="chat-in" placeholder="Mensagem P2P..." value={chatText}
          onChange={e => setChatText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && onSend()} />
        <button className="chat-send-btn" onClick={onSend} disabled={!chatText.trim()}>Enviar</button>
      </div>
    </div>
  );
}

function TransferHistory({ history }) {
  if (!history.length) return <div className="empty">Nenhuma transferência ainda</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: ".55rem" }}>
      {history.map((h, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: ".85rem", padding: ".75rem .9rem", background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)" }}>
          <div className="file-thumb">{fileIcon(h.name)}</div>
          <div className="file-inf">
            <div className="file-nm">{h.name}</div>
            <div className="file-meta">
              <span style={{ color: h.direction === "sent" ? "var(--accent)" : "var(--green)", display: "flex", alignItems: "center", gap: ".2rem" }}>
                {h.direction === "sent" ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
                {h.direction === "sent" ? "enviado" : "recebido"}
              </span>
              <span>{fmt(h.size)}</span>
              <span>{h.ts}</span>
              {h.checksumOk === true  && <span className="badge badge-green"><Check size={9} style={{ marginRight: 2 }} />íntegro</span>}
              {h.checksumOk === false && <span className="badge badge-err"><X size={9} style={{ marginRight: 2 }} />corrompido</span>}
            </div>
          </div>
          {h.url && <a className="btn btn-p btn-sm" href={h.url} download={h.name} style={{ display: "flex", alignItems: "center", gap: ".3rem" }}><Download size={13} />Baixar</a>}
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   LOBBY
───────────────────────────────────────────────────────────────────── */
function Lobby({ onSend, onReceive }) {
  const [name] = useState(() => {
    const cached = localStorage.getItem("pf-name");
    if (!cached || /^[a-z]+-[a-z]+-\d+$/.test(cached)) {
      const fresh = randomName();
      localStorage.setItem("pf-name", fresh);
      return fresh;
    }
    return cached;
  });
  const [peerId, setPeerId] = useState("");
  const [mode, setMode]     = useState(null); // null | "send" | "receive"
  const isMobile = useIsMobile(768);

  const steps = [
    [Zap,      "Gera ID",      "Um ID único é criado automaticamente"],
    [Send,     "Compartilha",  "Envie o ID pelo WhatsApp ou qualquer canal"],
    [Plug,     "Conecta",      "O receptor digita o ID e a conexão é automática"],
  ];

  return (
    <div className="lobby">
      <div className="fade-in" style={{ width: "100%", maxWidth: 520 }}>

        {/* Hero */}
        <div style={{ textAlign: "center", marginBottom: "2.5rem" }}>
          <div style={{ width: 68, height: 68, background: "var(--accent)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 40px rgba(0,255,234,.4)", margin: "0 auto 1.25rem" }}>
            <Zap size={34} style={{ color: "#000" }} />
          </div>
          <div style={{ fontSize: "2.4rem", fontWeight: 800, letterSpacing: "-.05em", lineHeight: 1, marginBottom: ".5rem" }}>
            Peer<span style={{ color: "var(--accent)" }}>File</span>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: ".7rem", color: "var(--muted)", letterSpacing: ".1em", textTransform: "uppercase" }}>
            Compartilhe arquivos · P2P · Sem servidor
          </div>
        </div>

        {/* Action card */}
        <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "1.75rem", position: "relative", overflow: "hidden", marginBottom: "1.25rem" }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: mode === "receive" ? "linear-gradient(90deg,var(--purple),#a78bfa)" : "linear-gradient(90deg,var(--accent),#00ccff)", transition: "background .3s" }} />

          {/* Seu nome */}
          <div style={{ display: "flex", alignItems: "center", gap: ".75rem", marginBottom: "1.5rem", padding: ".75rem 1rem", background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)" }}>
            <User size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: ".58rem", color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: ".15rem" }}>Seu nome</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: ".9rem", fontWeight: 700, color: "var(--text)" }}>{name}</div>
            </div>
          </div>

          {/* Botões principais */}
          {!mode && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".85rem" }}>
              <button className="btn btn-p btn-full" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: ".4rem", padding: "1.1rem", height: "auto" }}
                onClick={() => setMode("send")}>
                <Upload size={22} />
                <span style={{ fontSize: ".88rem" }}>Enviar</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: ".6rem", opacity: .7, fontWeight: 400 }}>Gera um ID</span>
              </button>
              <button className="btn btn-full" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: ".4rem", padding: "1.1rem", height: "auto", background: "var(--purple)", color: "#fff", border: "none", borderRadius: "var(--r-sm)", cursor: "pointer" }}
                onClick={() => setMode("receive")}>
                <Download size={22} />
                <span style={{ fontSize: ".88rem" }}>Receber</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: ".6rem", opacity: .7, fontWeight: 400 }}>Cola o ID</span>
              </button>
            </div>
          )}

          {/* Modo enviar */}
          {mode === "send" && (
            <div style={{ display: "flex", flexDirection: "column", gap: ".75rem" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: ".72rem", color: "var(--muted)", lineHeight: 1.6, textAlign: "center" }}>
                Um ID será gerado ao entrar. Compartilhe com o receptor para conectar.
              </div>
              <button className="btn btn-p btn-full" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: ".4rem" }}
                onClick={() => onSend(name)}>
                <Upload size={16} /> Entrar como remetente
              </button>
              <button className="btn btn-s btn-full" style={{ fontSize: ".8rem" }} onClick={() => setMode(null)}>
                Voltar
              </button>
            </div>
          )}

          {/* Modo receber */}
          {mode === "receive" && (
            <div style={{ display: "flex", flexDirection: "column", gap: ".75rem" }}>
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: ".62rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: ".5rem" }}>ID do remetente</div>
                <input
                  autoFocus
                  style={{ width: "100%", background: "var(--s2)", border: `1px solid ${peerId ? "rgba(157,78,255,.5)" : "var(--border2)"}`, borderRadius: "var(--r-sm)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: "1rem", fontWeight: 700, padding: ".8rem 1rem", outline: "none", letterSpacing: ".03em", transition: "border-color .2s" }}
                  placeholder="Cole o ID aqui..."
                  value={peerId}
                  onChange={e => setPeerId(e.target.value.trim())}
                  onKeyDown={e => e.key === "Enter" && peerId && onReceive(name, peerId)}
                />
              </div>
              <button
                className="btn btn-full"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: ".4rem", background: "var(--purple)", color: "#fff", border: "none", borderRadius: "var(--r-sm)", padding: ".82rem", fontSize: ".9rem", fontWeight: 700, cursor: peerId ? "pointer" : "not-allowed", opacity: peerId ? 1 : .45, transition: "opacity .2s" }}
                onClick={() => peerId && onReceive(name, peerId)}>
                <Download size={16} /> Conectar e receber
              </button>
              <button className="btn btn-s btn-full" style={{ fontSize: ".8rem" }} onClick={() => setMode(null)}>
                Voltar
              </button>
            </div>
          )}
        </div>

        {/* 3 passos */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: ".75rem", marginBottom: "1.5rem" }}>
          {steps.map(([Icon, title, desc], i) => (
            <div key={i} style={{ textAlign: "center", padding: ".85rem .5rem", background: "var(--s1)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", position: "relative" }}>
              {i < 2 && (
                <div style={{ position: "absolute", top: "1.4rem", right: "-.5rem", zIndex: 1, color: "var(--border3)", fontSize: ".8rem" }}>›</div>
              )}
              <div style={{ width: 34, height: 34, background: "rgba(0,255,234,.08)", border: "1px solid rgba(0,255,234,.15)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto .6rem" }}>
                <Icon size={16} style={{ color: "var(--accent)" }} />
              </div>
              <div style={{ fontSize: ".78rem", fontWeight: 700, color: "var(--text)", marginBottom: ".25rem" }}>{title}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: ".58rem", color: "var(--muted)", lineHeight: 1.5 }}>{desc}</div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <footer style={{ textAlign: "center", paddingTop: "1rem", borderTop: "1px solid var(--border2)", display: "flex", flexDirection: "column", alignItems: "center", gap: ".4rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: ".5rem" }}>
            <div style={{ width: 20, height: 20, background: "var(--accent)", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Zap size={11} style={{ color: "#000" }} />
            </div>
            <span style={{ fontWeight: 800, fontSize: ".88rem" }}>Peer<span style={{ color: "var(--accent)" }}>File</span></span>
            <span style={{ fontFamily: "var(--mono)", fontSize: ".58rem", color: "var(--accent)", background: "rgba(0,255,234,.08)", border: "1px solid rgba(0,255,234,.2)", padding: ".1rem .4rem", borderRadius: 4 }}>v5.0</span>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: ".57rem", color: "var(--muted)", opacity: .7 }}>
            © {new Date().getFullYear()} PeerFile · P2P direto — sem servidor intermediário
          </div>
        </footer>

      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   SESSION (Sender + Receiver unified with PeerJS)
───────────────────────────────────────────────────────────────────── */
function Session({ myName, role, targetId, onBack, addToast }) {
  const isSender  = role === "send";
  const isMobile  = useIsMobile(768);

  const [myId, setMyId]           = useState("");
  const [connected, setConnected] = useState(false);
  const [status, setStatus]       = useState("connecting");
  const [tab, setTab]             = useState(isSender ? "files" : "received");
  const [files, setFiles]         = useState([]);
  const [drag, setDrag]           = useState(false);
  const [sending, setSending]     = useState(false);
  const [allSent, setAllSent]     = useState(false);
  const [progresses, setProgresses] = useState({});
  const [overallPct, setOverallPct] = useState(0);
  const [speed, setSpeed]         = useState("—");
  const [unreadChat, setUnreadChat] = useState(0);
  const [unreadRecv, setUnreadRecv] = useState(0);
  const [messages, setMessages]   = useState([]);
  const [chatText, setChatText]   = useState("");
  const [typingPeer, setTypingPeer] = useState(false);
  const [history, setHistory]     = useState([]);
  const [imagePreview, setImagePreview] = useState(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [textToSend, setTextToSend] = useState("");
  const [textReceived, setTextReceived] = useState([]);
  const [rcvProgress, setRcvProgress] = useState(null);
  const [checksums, setChecksums] = useState({});
  const [compressedBlobs, setCompressedBlobs] = useState({});
  const [compressedSizes, setCompressedSizes] = useState({});
  const [previews, setPreviews]   = useState({});
  const [downloadedFiles, setDownloadedFiles] = useState(new Set());
  const [copied, setCopied]       = useState(false);

  const peerRef  = useRef(null);
  const connRef  = useRef(null);
  const sentRef  = useRef(0);
  const startRef = useRef(null);
  const spTimer  = useRef(null);
  const rcvBuf   = useRef([]);
  const rcvInfo  = useRef(null);
  const typingT  = useRef(null);
  const soundRef = useRef(soundEnabled);
  useEffect(() => { soundRef.current = soundEnabled; }, [soundEnabled]);

  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);

  /* ── PeerJS init ── */
  useEffect(() => {
    let peer;
    import("peerjs").then(({ Peer }) => {
      peer = new Peer({ debug: 0 });
      peerRef.current = peer;

      peer.on("open", (id) => {
        setMyId(id);
        setStatus("ready");
        if (!isSender && targetId) {
          const conn = peer.connect(targetId, { reliable: true, serialization: "binary" });
          connRef.current = conn;
          setupConn(conn);
        }
      });

      peer.on("connection", (conn) => {
        connRef.current = conn;
        setupConn(conn);
      });

      peer.on("error", (err) => {
        if (err.type === "peer-unavailable") addToast("ID não encontrado. Verifique e tente novamente.", "err");
        else addToast("Erro: " + err.type, "err");
        setStatus("error");
      });
    }).catch(() => addToast("Erro ao carregar PeerJS", "err"));

    return () => {
      clearInterval(spTimer.current);
      if (peerRef.current) peerRef.current.destroy();
      document.title = "PeerFile";
    };
  }, []);

  const setupConn = (conn) => {
    conn.on("open", () => {
      setConnected(true);
      setStatus("connected");
      addToast("Conectado!", "ok");
      document.title = "Conectado — PeerFile";
    });
    conn.on("data", handleData);
    conn.on("close", () => {
      setConnected(false);
      setStatus("error");
      addToast("Conexão encerrada", "warn");
      document.title = "PeerFile";
    });
    conn.on("error", () => { addToast("Erro na conexão", "err"); setStatus("error"); });
  };

  /* ── Receive data ── */
  const handleData = async (data) => {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const ab = data instanceof ArrayBuffer ? data : data.buffer;
      rcvBuf.current.push(ab);
      if (rcvInfo.current) {
        const received = rcvBuf.current.reduce((s, c) => s + c.byteLength, 0);
        const pct = Math.min(99, Math.round((received / rcvInfo.current.size) * 100));
        setRcvProgress(p => p ? { ...p, pct } : null);
        document.title = `${pct}% recebendo — PeerFile`;
      }
      return;
    }

    const msg = typeof data === "string" ? JSON.parse(data) : data;
    if (!msg || !msg.type) return;

    if (msg.type === "typing") { setTypingPeer(msg.typing); return; }
    if (msg.type === "chat") {
      setMessages(m => [...m, { text: msg.text, me: false, time: tsNow() }]);
      setUnreadChat(u => u + 1); return;
    }
    if (msg.type === "text") {
      setTextReceived(t => [...t, { text: msg.text, ts: tsNow() }]);
      addToast("Texto recebido!", "ok");
      if (soundRef.current) playNotif(); return;
    }
    if (msg.type === "download-confirm") {
      setDownloadedFiles(s => new Set([...s, msg.filename]));
      addToast(`${msg.filename} baixado pelo receptor`, "ok"); return;
    }
    if (msg.type === "start") {
      rcvInfo.current = msg; rcvBuf.current = [];
      setRcvProgress({ name: msg.name, size: msg.origSize || msg.size, pct: 0 });
      setTab("received"); return;
    }
    if (msg.type === "end") {
      if (!rcvInfo.current) return;
      const info = { ...rcvInfo.current };
      const buf  = [...rcvBuf.current];
      rcvBuf.current = []; rcvInfo.current = null;
      setRcvProgress(null);

      let finalBlob;
      if (info.compressed) {
        try {
          const ds = new DecompressionStream("gzip");
          const w  = ds.writable.getWriter();
          w.write(await new Blob(buf).arrayBuffer()); w.close();
          const chunks = []; const r = ds.readable.getReader();
          while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
          finalBlob = new Blob(chunks, { type: info.ftype || "application/octet-stream" });
        } catch { finalBlob = new Blob(buf, { type: info.ftype || "application/octet-stream" }); }
      } else {
        finalBlob = new Blob(buf, { type: info.ftype || "application/octet-stream" });
      }

      const url = URL.createObjectURL(finalBlob);
      if (soundRef.current) playNotif();
      document.title = "Arquivo recebido — PeerFile";
      setTimeout(() => { document.title = "Conectado — PeerFile"; }, 3000);

      let checksumOk = null;
      if (info.checksum) {
        try { checksumOk = crc32(await finalBlob.arrayBuffer()) === info.checksum; } catch {}
      }
      if (isImage(info.name)) setImagePreview(url);
      setHistory(h => [...h, { name: info.name, size: info.origSize || finalBlob.size, url, checksumOk, direction: "received", ts: tsNow() }]);
      addToast(`${info.name} recebido!`, "ok");
      setUnreadRecv(u => u + 1);
    }
  };

  /* ── Send ── */
  const addFiles = async (flist) => {
    const arr = Array.from(flist);
    const startIdx = files.length;
    setFiles(prev => [...prev, ...arr.filter(f => !prev.find(x => x.name === f.name && x.size === f.size))]);
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i]; const idx = startIdx + i;
      if (isImage(f.name)) { const r = new FileReader(); r.onload = e => setPreviews(p => ({ ...p, [idx]: e.target.result })); r.readAsDataURL(f); }
      f.arrayBuffer().then(buf => setChecksums(c => ({ ...c, [idx]: crc32(buf) }))).catch(() => {});
      tryCompress(f).then(blob => { if (blob) { setCompressedBlobs(b => ({ ...b, [idx]: blob })); setCompressedSizes(s => ({ ...s, [idx]: blob.size })); } }).catch(() => {});
    }
  };

  const sendFiles = async () => {
    if (!files.length) { addToast("Adicione arquivos primeiro", "err"); return; }
    if (!connRef.current || !connected) { addToast("Sem conexão ativa", "err"); return; }
    setSending(true); sentRef.current = 0; startRef.current = Date.now(); setOverallPct(0); setAllSent(false);
    spTimer.current = setInterval(() => {
      const el = (Date.now() - startRef.current) / 1000;
      if (el > 0) setSpeed(fmtSpd(sentRef.current / el));
    }, 600);
    for (let i = 0; i < files.length; i++) {
      try { await sendFile(files[i], compressedBlobs[i] || null, checksums[i] || null, i); }
      catch { addToast(`Falha ao enviar ${files[i].name}`, "err"); break; }
      setHistory(h => [...h, { name: files[i].name, size: files[i].size, direction: "sent", ts: tsNow() }]);
    }
    clearInterval(spTimer.current);
    setSending(false); setOverallPct(100); setAllSent(true);
    addToast("Todos os arquivos enviados!", "ok");
  };

  const sendFile = (file, cBlob, ck, idx) => new Promise((resolve, reject) => {
    const blob = cBlob || file; const size = blob.size;
    const conn = connRef.current;
    if (!conn) { reject(new Error("no connection")); return; }
    conn.send(JSON.stringify({ type: "start", name: file.name, size, origSize: file.size, ftype: file.type, checksum: ck, compressed: !!cBlob, idx }));
    const reader = new FileReader(); let offset = 0;
    const next = () => {
      if (offset >= size) { conn.send(JSON.stringify({ type: "end", idx })); resolve(); return; }
      reader.readAsArrayBuffer(blob.slice(offset, offset + CHUNK));
    };
    reader.onload = (e) => {
      conn.send(e.target.result);
      offset += e.target.result.byteLength; sentRef.current += e.target.result.byteLength;
      setProgresses(p => ({ ...p, [idx]: Math.round((offset / size) * 100) }));
      setOverallPct(Math.round(((idx * 100) + Math.round((offset / size) * 100)) / files.length));
      next();
    };
    reader.onerror = () => reject(new Error("read error"));
    next();
  });

  const sendChat = () => {
    if (!chatText.trim() || !connRef.current) return;
    connRef.current.send(JSON.stringify({ type: "chat", text: chatText }));
    setMessages(m => [...m, { text: chatText, me: true, time: tsNow() }]);
    setChatText("");
  };

  const handleChatChange = (val) => {
    setChatText(val);
    if (connRef.current) {
      connRef.current.send(JSON.stringify({ type: "typing", typing: true }));
      clearTimeout(typingT.current);
      typingT.current = setTimeout(() => connRef.current?.send(JSON.stringify({ type: "typing", typing: false })), 1500);
    }
  };

  const sendText = () => {
    if (!textToSend.trim() || !connRef.current) return;
    connRef.current.send(JSON.stringify({ type: "text", text: textToSend }));
    addToast("Texto enviado!", "ok"); setTextToSend("");
  };

  const switchTab = (t) => {
    setTab(t);
    if (t === "received") setUnreadRecv(0);
    if (t === "chat") setUnreadChat(0);
  };

  const copyId = () => { copyText(myId); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  const statusLabel = { connecting: "Conectando...", ready: isSender ? "Aguardando receptor..." : "Conectando ao remetente...", connected: "P2P conectado", error: "Erro de conexão" }[status];
  const statusDot   = { connecting: "warn", ready: "warn", connected: "on", error: "err" }[status];

  const tabs = isSender
    ? [["files", FolderOpen, "Arquivos", 0], ["text", Pen, "Texto", 0], ["received", Download, "Recebidos", unreadRecv], ["chat", MessageCircleMore, "Chat", unreadChat], ["history", History, "Histórico", 0]]
    : [["received", Download, "Recebidos", unreadRecv], ["chat", MessageCircleMore, "Chat", unreadChat], ["history", History, "Histórico", 0]];

  return (
    <>
      {imagePreview && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setImagePreview(null)}>
          <img src={imagePreview} alt="" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: "var(--r)" }} />
          <div style={{ position: "absolute", top: "1.5rem", right: "1.5rem", cursor: "pointer", color: "#fff" }}><X size={24} /></div>
        </div>
      )}

      <div className="app fade-in">
        <header className="header">
          <div className="logo">
            <div className="logo-ico"><Zap size={20} style={{ color: "#000" }} /></div>
            <div className="logo-text">Peer<span>File</span></div>
          </div>
          <div className="header-mid">
            <div style={{ display: "flex", alignItems: "center", gap: ".5rem", fontFamily: "var(--mono)", fontSize: ".72rem", color: "var(--muted)" }}>
              <div className={`ws-dot ${statusDot}`} />{statusLabel}
            </div>
          </div>
          <div className="header-right">
            <button className="btn btn-s btn-sm" onClick={() => setSoundEnabled(s => !s)} style={{ padding: ".45rem .7rem" }}>
              {soundEnabled ? <Bell size={14} /> : <BellOff size={14} />}
            </button>
            <button className="btn btn-d btn-sm" onClick={() => { if (peerRef.current) peerRef.current.destroy(); document.title = "PeerFile"; onBack(); }} style={{ display: "flex", alignItems: "center", gap: ".3rem" }}>
              <RotateCcw size={13} /><span className="btn-label"> Voltar</span>
            </button>
          </div>
        </header>

        <div className="room-layout">
          <div className="main-col">

            {/* Sender ID card */}
            {isSender && myId && (
              <div className="card">
                <div className="card-hdr">
                  <div className="card-title"><Wifi size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Seu ID de conexão</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: ".75rem", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, background: "var(--s2)", border: "1px solid rgba(0,255,234,.25)", borderRadius: "var(--r-sm)", padding: ".85rem 1.1rem", fontFamily: "var(--mono)", fontSize: "1.05rem", fontWeight: 700, color: "var(--accent)", letterSpacing: ".04em", wordBreak: "break-all", minWidth: 0 }}>
                    {myId}
                  </div>
                  <button className="btn btn-p" onClick={copyId} style={{ display: "flex", alignItems: "center", gap: ".4rem", flexShrink: 0 }}>
                    {copied ? <><Check size={14} /> Copiado!</> : <><Copy size={14} /> Copiar ID</>}
                  </button>
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color: "var(--muted)", marginTop: ".65rem", display: "flex", alignItems: "center", gap: ".4rem" }}>
                  {connected
                    ? <><CheckCircle2 size={12} style={{ color: "var(--green)" }} /> Receptor conectado — pode enviar os arquivos!</>
                    : <><Hourglass size={12} style={{ color: "var(--amber)" }} /> Compartilhe este ID com o receptor</>}
                </div>
              </div>
            )}

            {/* Receiver connecting */}
            {!isSender && !connected && status !== "error" && (
              <div className="card">
                <div style={{ display: "flex", alignItems: "center", gap: ".85rem", padding: ".25rem 0" }}>
                  <Loader size={22} style={{ color: "var(--purple)", animation: "spin 1s linear infinite", flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: ".9rem", marginBottom: ".2rem" }}>Conectando a <span style={{ color: "var(--purple)", fontFamily: "var(--mono)" }}>{targetId}</span></div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: ".68rem", color: "var(--muted)" }}>Estabelecendo conexão P2P direta...</div>
                  </div>
                </div>
              </div>
            )}

            {/* Error state */}
            {status === "error" && (
              <div style={{ background: "rgba(255,45,85,.08)", border: "1px solid rgba(255,45,85,.25)", borderRadius: "var(--r-sm)", padding: "1rem 1.1rem", display: "flex", gap: ".75rem", alignItems: "center" }}>
                <X size={18} style={{ color: "var(--red)", flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: ".88rem", color: "var(--red)", marginBottom: ".2rem" }}>Falha na conexão</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: ".68rem", color: "var(--muted)" }}>Verifique se o ID está correto e tente novamente.</div>
                </div>
                <button className="btn btn-s btn-sm" style={{ marginLeft: "auto", flexShrink: 0 }} onClick={onBack}>Voltar</button>
              </div>
            )}

            {/* Tabs */}
            {(connected || !isSender) && status !== "error" && (
              <>
                <div className="tabs">
                  {tabs.map(([k, Icon, lb, badge]) => (
                    <button key={k} className={`tab-btn ${tab === k ? "active" : ""}`} onClick={() => switchTab(k)}>
                      <Icon size={14} />{lb}
                      {badge > 0 && <span className="tab-badge">{badge}</span>}
                    </button>
                  ))}
                </div>

                {/* FILES */}
                {tab === "files" && isSender && (
                  <div className="card">
                    <div className="card-hdr">
                      <div className="card-title"><FolderOpen size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Arquivos para enviar</div>
                    </div>
                    <div className={`drop ${drag ? "over" : ""}`}
                      onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                      onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
                      onClick={() => document.getElementById("pf-fi").click()}>
                      {drag
                        ? <ArrowDown size={36} style={{ margin: "0 auto .75rem", display: "block", color: "var(--accent)" }} />
                        : <CloudUpload size={36} style={{ margin: "0 auto .75rem", display: "block", color: "var(--muted)" }} />}
                      <div className="drop-title">Arraste ou clique para selecionar</div>
                      <div className="drop-sub">Qualquer tipo · qualquer tamanho · compressão automática</div>
                    </div>
                    <input id="pf-fi" type="file" multiple style={{ display: "none" }} onChange={e => addFiles(e.target.files)} />

                    {files.length > 0 && (
                      <>
                        <div className="mini-stats" style={{ marginTop: ".85rem" }}>
                          <div className="mini-stat"><div className="mini-val">{files.length}</div><div className="mini-lbl">Arquivos</div></div>
                          <div className="mini-stat"><div className="mini-val">{fmt(totalSize)}</div><div className="mini-lbl">Total</div></div>
                          <div className="mini-stat"><div className="mini-val">{speed}</div><div className="mini-lbl">Velocidade</div></div>
                        </div>
                        <div className="file-list-scroll"><div className="file-list">
                          {files.map((f, i) => (
                            <div key={i} className="file-card">
                              <div className="file-row">
                                <div className="file-thumb" onClick={() => previews[i] && setImagePreview(previews[i])} style={{ cursor: previews[i] ? "pointer" : "default" }}>
                                  {previews[i] ? <img src={previews[i]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8 }} /> : fileIcon(f.name)}
                                </div>
                                <div className="file-inf">
                                  <div className="file-nm" title={f.name}>{f.name}</div>
                                  <div className="file-meta">
                                    <span>{fmt(f.size)}</span>
                                    {compressedSizes[i] && <span className="badge badge-green">gzip -{Math.round((1 - compressedSizes[i] / f.size) * 100)}%</span>}
                                    {checksums[i] && <span className="badge badge-c">crc:{checksums[i].slice(0, 6)}</span>}
                                  </div>
                                  {progresses[i] != null && (
                                    <><div className="pbar" style={{ marginTop: ".4rem" }}><div className="pfill" style={{ width: progresses[i] + "%" }} /></div>
                                    <div style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color: "var(--muted)" }}>{progresses[i]}%</div></>
                                  )}
                                </div>
                                {!sending && <button className="file-rm" onClick={() => setFiles(fl => fl.filter((_, j) => j !== i))}><X size={13} /></button>}
                              </div>
                            </div>
                          ))}
                        </div></div>
                        {sending && (
                          <div className="send-progress">
                            <div className="send-progress-hdr"><span>Enviando...</span><span>{overallPct}%</span></div>
                            <div className="overall-bar"><div className="overall-fill" style={{ width: overallPct + "%" }} /></div>
                          </div>
                        )}
                        {allSent ? (
                          <div style={{ marginTop: ".85rem", display: "flex", flexDirection: "column", gap: ".6rem" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: ".75rem", padding: "1rem", background: "rgba(0,255,234,.06)", border: "1px solid rgba(0,255,234,.2)", borderRadius: "var(--r-sm)" }}>
                              <CheckCircle2 size={22} style={{ color: "var(--green)", flexShrink: 0 }} />
                              <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 700, fontSize: ".88rem", color: "var(--accent)" }}>Todos os arquivos enviados!</div>
                                <div style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color: "var(--muted)", marginTop: ".2rem" }}>
                                  {downloadedFiles.size > 0 ? `${downloadedFiles.size} de ${files.length} baixado(s)` : "Aguardando confirmação de download..."}
                                </div>
                              </div>
                            </div>
                            <button className="btn btn-s btn-full" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: ".35rem" }} onClick={() => { setAllSent(false); setProgresses({}); setOverallPct(0); setDownloadedFiles(new Set()); }}>
                              <RotateCw size={13} /> Enviar novamente
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-p btn-full" style={{ marginTop: ".85rem", display: "flex", alignItems: "center", justifyContent: "center", gap: ".4rem" }} onClick={sendFiles} disabled={sending || !connected}>
                            {sending ? <><Loader size={14} style={{ animation: "spin 1s linear infinite" }} /> Enviando... {overallPct}%</> : <><Send size={14} /> Enviar todos os arquivos</>}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* TEXT */}
                {tab === "text" && isSender && (
                  <div className="card">
                    <div className="card-hdr"><div className="card-title"><Pen size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Enviar texto ou link</div></div>
                    <textarea style={{ width: "100%", background: "var(--s2)", border: "1px solid var(--border2)", borderRadius: "var(--r-sm)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: ".82rem", lineHeight: 1.65, padding: "1rem 1.1rem", outline: "none", resize: "none", height: 120 }}
                      placeholder="Cole um link, texto, senha..." value={textToSend} onChange={e => setTextToSend(e.target.value)} />
                    <button className="btn btn-p btn-full" style={{ marginTop: ".75rem", display: "flex", alignItems: "center", justifyContent: "center", gap: ".35rem" }} onClick={sendText} disabled={!textToSend.trim() || !connected}>
                      <Send size={14} /> Enviar texto
                    </button>
                  </div>
                )}

                {/* RECEIVED */}
                {tab === "received" && (
                  <div className="card">
                    <div className="card-hdr">
                      <div className="card-title"><CheckCircle2 size={13} style={{ marginRight: ".4rem", color: "var(--green)" }} />Arquivos recebidos</div>
                      {history.filter(h => h.direction === "received" && h.url).length > 0 && (
                        <span style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color: "var(--muted)" }}>{history.filter(h => h.direction === "received" && h.url).length} arquivo(s)</span>
                      )}
                    </div>

                    {textReceived.length > 0 && (
                      <div style={{ marginBottom: ".85rem", paddingBottom: ".85rem", borderBottom: "1px solid var(--border)" }}>
                        <div style={{ fontFamily: "var(--mono)", fontSize: ".6rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: ".5rem", display: "flex", alignItems: "center", gap: ".35rem" }}>
                          <AlignLeft size={11} /> Textos ({textReceived.length})
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: ".5rem", maxHeight: 220, overflowY: "auto" }}>
                          {textReceived.map((t, i) => (
                            <div key={i} style={{ background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: ".7rem .9rem" }}>
                              <div style={{ fontFamily: "var(--mono)", fontSize: ".78rem", color: "var(--text)", lineHeight: 1.6, wordBreak: "break-all", marginBottom: ".3rem" }}>{t.text}</div>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <span style={{ fontFamily: "var(--mono)", fontSize: ".58rem", color: "var(--dim)" }}>{t.ts}</span>
                                <button className="btn btn-s btn-sm" style={{ padding: ".3rem .6rem", fontSize: ".65rem", display: "flex", alignItems: "center", gap: ".25rem" }} onClick={() => { copyText(t.text); addToast("Copiado!", "ok"); }}>
                                  <Copy size={11} /> Copiar
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {rcvProgress && (
                      <div style={{ background: "rgba(0,255,234,.04)", border: "1px solid rgba(0,255,234,.2)", borderRadius: "var(--r-sm)", padding: ".85rem 1rem", marginBottom: ".75rem" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: ".72rem", marginBottom: ".4rem", color: "var(--accent)", alignItems: "center" }}>
                          <span style={{ display: "flex", alignItems: "center", gap: ".4rem", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700 }}>
                            <Download size={13} /> {rcvProgress.name}
                          </span>
                          <span style={{ fontWeight: 700, marginLeft: ".75rem" }}>{rcvProgress.pct}%</span>
                        </div>
                        <div className="pbar"><div className="pfill" style={{ width: rcvProgress.pct + "%" }} /></div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: ".62rem", color: "var(--muted)", marginTop: ".3rem" }}>{fmt(rcvProgress.size)}</div>
                      </div>
                    )}

                    {history.filter(h => h.direction === "received" && h.url).length === 0 && !rcvProgress
                      ? <div className="empty">Aguardando o remetente enviar arquivos...</div>
                      : (
                        <div className="file-list-scroll"><div className="file-list">
                          {history.filter(h => h.direction === "received" && h.url).map((f, i) => (
                            <div key={i} className="recv-card" onClick={() => f.url && isImage(f.name) && setImagePreview(f.url)} style={{ cursor: isImage(f.name) ? "pointer" : "default" }}>
                              <div className="file-thumb">{f.url && isImage(f.name) ? <img src={f.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 9 }} /> : fileIcon(f.name)}</div>
                              <div className="file-inf">
                                <div className="file-nm">{f.name}</div>
                                <div className="recv-from">
                                  <span>{fmt(f.size)}</span><span>·</span><span>{f.ts}</span>
                                  {f.checksumOk === true  && <span className="badge badge-green" style={{ display: "flex", alignItems: "center", gap: 2 }}><Check size={9} />íntegro</span>}
                                  {f.checksumOk === false && <span className="badge badge-err"   style={{ display: "flex", alignItems: "center", gap: 2 }}><X size={9} />corrompido</span>}
                                </div>
                              </div>
                              {f.url && (
                                <a className="btn btn-p btn-sm" href={f.url} download={f.name}
                                  style={{ display: "flex", alignItems: "center", gap: ".3rem" }}
                                  onClick={e => { e.stopPropagation(); connRef.current?.send(JSON.stringify({ type: "download-confirm", filename: f.name })); }}>
                                  <Download size={13} /> Baixar
                                </a>
                              )}
                            </div>
                          ))}
                        </div></div>
                      )
                    }
                  </div>
                )}

                {/* CHAT */}
                {tab === "chat" && (
                  <div className="card">
                    <div className="card-hdr"><div className="card-title"><MessageCircleMore size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Chat P2P</div></div>
                    <ChatBox messages={messages} chatText={chatText} setChatText={handleChatChange} onSend={sendChat} typingPeer={typingPeer} />
                  </div>
                )}

                {/* HISTORY */}
                {tab === "history" && (
                  <div className="card">
                    <div className="card-hdr">
                      <div className="card-title"><History size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Histórico da sessão</div>
                      <button className="btn btn-d btn-sm" style={{ padding: ".35rem .7rem", fontSize: ".72rem" }} onClick={() => setHistory([])}>Limpar</button>
                    </div>
                    <TransferHistory history={history} />
                  </div>
                )}
              </>
            )}
          </div>

          {/* Sidebar */}
          <div className="side-col">
            <div className="card">
              <div className="card-hdr"><div className="card-title"><User size={13} style={{ marginRight: ".4rem" }} />Sessão</div></div>
              <div className="member-row me-row">
                <Avatar name={myName} id={myName} size={34} />
                <div className="mem-inf">
                  <div className="mem-name">{myName}</div>
                  <div className="mem-sub">{isSender ? "remetente" : "receptor"}</div>
                </div>
                <div className={`peer-state-dot ${connected ? "connected" : status === "error" ? "disconnected" : "connecting"}`} />
              </div>
              {connected && (
                <div style={{ marginTop: ".75rem", padding: ".65rem .85rem", background: "rgba(0,255,234,.06)", border: "1px solid rgba(0,255,234,.15)", borderRadius: "var(--r-sm)", fontFamily: "var(--mono)", fontSize: ".68rem", color: "var(--accent)", display: "flex", alignItems: "center", gap: ".35rem" }}>
                  <CheckCircle2 size={13} /> P2P conectado
                </div>
              )}
              {myId && (
                <div style={{ marginTop: ".85rem", background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: ".75rem .85rem" }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: ".6rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: ".35rem" }}>Meu ID</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: ".75rem", color: "var(--accent)", fontWeight: 700, wordBreak: "break-all" }}>{myId}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   MAIN APP
───────────────────────────────────────────────────────────────────── */
export default function App() {
  const [screen, setScreen]     = useState("lobby");
  const [myName, setMyName]     = useState(() => {
    const cached = localStorage.getItem("pf-name");
    if (!cached || /^[a-z]+-[a-z]+-\d+$/.test(cached)) {
      const fresh = randomName();
      localStorage.setItem("pf-name", fresh);
      return fresh;
    }
    return cached;
  });
  const [role, setRole]         = useState("send");
  const [targetId, setTargetId] = useState("");
  const [toasts, setToasts]     = useState([]);

  const addToast = useCallback((msg, type = "info") => {
    const id = uid();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);

  const goSend    = (name)          => { setMyName(name); localStorage.setItem("pf-name", name); setRole("send");    setScreen("session"); };
  const goReceive = (name, peerId)  => { setMyName(name); localStorage.setItem("pf-name", name); setRole("receive"); setTargetId(peerId); setScreen("session"); };
  const goBack    = ()              => setScreen("lobby");

  return (
    <>
      {screen === "lobby"   && <Lobby onSend={goSend} onReceive={goReceive} />}
      {screen === "session" && <Session myName={myName} role={role} targetId={targetId} onBack={goBack} addToast={addToast} />}
      <Toasts list={toasts} />
    </>
  );
}