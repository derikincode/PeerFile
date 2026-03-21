import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import {
  AlertTriangle, AlignLeft, ArrowDown, ArrowUp, Bell, BellOff,
  Check, CheckCircle2, ChevronRight, Circle, CloudUpload, Copy,
  Download, FileArchive, FolderOpen, History, Hourglass,
  Inbox, KeyRound, Link, Loader, Lock, MessageCircleMore,
  Pen, Plug, QrCode, RotateCcw, RotateCw, Send, ShieldCheck,
  Sparkles, Upload, User, Wand2, X, Zap,
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
const CHUNK = 16384; // 16KB chunks — mais seguro para NAT/WebRTC
const MAX_BUFFERED = CHUNK * 8; // 128KB buffer máximo
const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 10,
};

/* ─────────────────────────────────────────────────────────────────────
   SDP COMPRESSION
───────────────────────────────────────────────────────────────────── */
const compressSDP = async (sdp) => {
  try {
    const text = JSON.stringify(sdp);
    const stream = new CompressionStream("gzip");
    const writer = stream.writable.getWriter();
    writer.write(new TextEncoder().encode(text));
    writer.close();
    const chunks = [];
    const reader = stream.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
    return btoa(String.fromCharCode(...bytes));
  } catch { return JSON.stringify(sdp); }
};

const decompressSDP = async (encoded) => {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const stream = new DecompressionStream("gzip");
    const writer = stream.writable.getWriter();
    writer.write(bytes); writer.close();
    const chunks = [];
    const reader = stream.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let off2 = 0;
    for (const c of chunks) { out.set(c, off2); off2 += c.length; }
    return JSON.parse(new TextDecoder().decode(out));
  } catch {
    try { return JSON.parse(encoded); } catch { return null; }
  }
};

/* ─────────────────────────────────────────────────────────────────────
   SOUND
───────────────────────────────────────────────────────────────────── */
const playNotif = () => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
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
   HELPERS
───────────────────────────────────────────────────────────────────── */
const randomName = () => `Peer${String(Math.floor(10000 + Math.random() * 90000))}`;

const IC = ({ icon: Icon, size = 15, style = {}, className = "" }) => (
  <Icon size={size} style={{ flexShrink: 0, ...style }} className={className} />
);

/* ─────────────────────────────────────────────────────────────────────
   SMALL COMPONENTS
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
  const icons = {
    ok: <Check size={13} />,
    err: <X size={13} />,
    warn: <AlertTriangle size={13} />,
    info: <ChevronRight size={13} />,
  };
  return (
    <div className="toast-wrap">
      {list.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>
          {icons[t.type]}
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

function Steps({ current, labels }) {
  return (
    <div className="steps">
      {labels.map((lbl, i) => {
        const n = i + 1;
        const cls = n < current ? "step done" : n === current ? "step active" : "step";
        return (
          <div key={i} className={cls}>
            <div className="step-num">
              {n < current ? <Check size={14} /> : n}
            </div>
            <div className="step-line" />
            <div className="step-label">{lbl}</div>
          </div>
        );
      })}
    </div>
  );
}

function SdpBox({ label, value, readOnly, onChange, onCopy, placeholder, hint }) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: "var(--mono)", fontSize: ".62rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: ".5rem" }}>
        <span>{label}</span>
        {value?.length > 0 && (
          <span style={{ color: value.length < 500 ? "var(--green)" : "var(--muted)" }}>{value.length} chars</span>
        )}
      </div>
      <div style={{ position: "relative" }}>
        <textarea
          style={{ width: "100%", background: "var(--s2)", border: "1px solid var(--border2)", borderRadius: "var(--r-sm)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: ".76rem", lineHeight: 1.6, padding: "1rem 1.1rem", outline: "none", resize: "none", height: 90 }}
          value={value} readOnly={readOnly} onChange={onChange}
          placeholder={placeholder}
          onClick={readOnly ? e => e.target.select() : undefined}
        />
        {readOnly && value && (
          <button onClick={onCopy} style={{ position: "absolute", top: ".6rem", right: ".6rem", display: "flex", alignItems: "center", gap: ".3rem", fontFamily: "var(--mono)", fontSize: ".62rem", padding: ".25rem .65rem", background: "var(--s1)", border: "1px solid var(--border2)", color: "var(--muted)", borderRadius: 5, cursor: "pointer" }}>
            <Copy size={11} /> Copiar
          </button>
        )}
      </div>
      {hint && <div style={{ fontFamily: "var(--mono)", fontSize: ".6rem", color: "var(--dim)", marginTop: ".4rem" }}>{hint}</div>}
    </div>
  );
}

function ConnStatus({ connected, step, role }) {
  const label = connected ? "P2P conectado"
    : step === 1 ? (role === "send" ? "gerando código..." : "aguardando código")
    : step === 2 ? (role === "send" ? "aguardando resposta" : "estabelecendo P2P...")
    : "estabelecendo P2P...";
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: ".73rem", color: "var(--muted)", display: "flex", alignItems: "center", gap: ".5rem" }}>
      <div className={`ws-dot ${connected ? "on" : step >= 2 ? "warn" : "off"}`} />
      <span>{label}</span>
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

function TransferHistory({ history, onClear }) {
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
              {h.checksumOk === true && <span className="badge badge-green"><Check size={9} style={{ marginRight: 2 }} />íntegro</span>}
              {h.checksumOk === false && <span className="badge badge-err"><X size={9} style={{ marginRight: 2 }} />corrompido</span>}
            </div>
          </div>
          {h.url && <a className="btn btn-p btn-sm" href={h.url} download={h.name} style={{ display: "flex", alignItems: "center", gap: ".3rem" }}><Download size={13} />Baixar</a>}
        </div>
      ))}
    </div>
  );
}

function PinModal({ onConfirm, onCancel, mode }) {
  const [pin, setPin] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "2rem", width: 340, position: "relative" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg,var(--accent),var(--purple))", borderRadius: "var(--r) var(--r) 0 0" }} />
        <div style={{ fontWeight: 800, fontSize: "1.05rem", marginBottom: ".5rem", display: "flex", alignItems: "center", gap: ".5rem" }}>
          <Lock size={16} style={{ color: "var(--accent)" }} />
          {mode === "set" ? "Definir PIN" : "Verificar PIN"}
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: ".72rem", color: "var(--muted)", marginBottom: "1.25rem", lineHeight: 1.6 }}>
          {mode === "set" ? "O receptor precisará digitar este PIN para conectar." : "Digite o PIN definido pelo remetente."}
        </div>
        <input type="password" maxLength={8} autoFocus
          style={{ width: "100%", background: "var(--s2)", border: "1px solid var(--border2)", borderRadius: "var(--r-sm)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: "1.2rem", padding: ".75rem 1rem", outline: "none", letterSpacing: ".2em", textAlign: "center", marginBottom: "1rem" }}
          placeholder="••••" value={pin}
          onChange={e => setPin(e.target.value)}
          onKeyDown={e => e.key === "Enter" && pin && onConfirm(pin)}
        />
        <div style={{ display: "flex", gap: ".75rem" }}>
          <button className="btn btn-s btn-full" onClick={onCancel}>Cancelar</button>
          <button className="btn btn-p btn-full" onClick={() => onConfirm(pin)} disabled={!pin}>
            {mode === "set" ? "Definir" : "Verificar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function QRCodeWidget({ value, size = 160 }) {
  const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const appUrl = `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(value)}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(appUrl)}&bgcolor=0d0f1a&color=00ffea&margin=8`;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  if (!value) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: ".4rem", flexShrink: 0 }}>
      <div style={{ width: size, height: size, borderRadius: "var(--r-sm)", overflow: "hidden", background: "var(--s2)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {isLocalhost ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: ".4rem", padding: "1rem", textAlign: "center" }}>
            <QrCode size={28} style={{ color: "var(--amber)" }} />
            <div style={{ fontFamily: "var(--mono)", fontSize: ".58rem", color: "var(--amber)", lineHeight: 1.5 }}>QR ativo<br />em produção</div>
          </div>
        ) : (
          <>
            {!loaded && !error && <Loader size={20} style={{ color: "var(--muted)", animation: "spin 1s linear infinite" }} />}
            {!error && <img src={qrUrl} alt="QR" width={size} height={size} onLoad={() => setLoaded(true)} onError={() => setError(true)} style={{ display: loaded ? "block" : "none" }} />}
            {error && <div style={{ fontFamily: "var(--mono)", fontSize: ".6rem", color: "var(--muted)", textAlign: "center", padding: ".75rem" }}>QR indisponível</div>}
          </>
        )}
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: ".58rem", color: isLocalhost ? "var(--amber)" : "var(--muted)", textAlign: "center" }}>
        {isLocalhost ? "Publique para ativar" : "Escaneie com celular"}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   LOBBY
───────────────────────────────────────────────────────────────────── */
function Lobby({ onSend, onReceive }) {
  const [name] = useState(() => localStorage.getItem("fb-name") || randomName());
  useEffect(() => { localStorage.setItem("fb-name", name); }, [name]);

  const features = [
    [Zap, "P2P direto"],
    [Lock, "PIN opcional"],
    ["∞", "Sem limite"],
    [MessageCircleMore, "Chat P2P"],
    [ShieldCheck, "Verificação CRC32"],
  ];

  const tips = [
    [FileArchive, "Código comprimido", "SDP comprimido com gzip+base64 — ~400 chars em vez de 2000."],
    [Lock, "PIN opcional", "Proteja a conexão com senha — o receptor precisa digitar para conectar."],
    [Bell, "Notificação sonora", "Toca um som quando um arquivo é recebido."],
    [History, "Histórico", "Todas as transferências da sessão ficam registradas."],
  ];

  const NameDisplay = (
    <div style={{ marginBottom: "1.1rem" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: ".62rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: ".55rem" }}>Seu nome</div>
      <div style={{ width: "100%", background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", color: "var(--accent)", fontFamily: "var(--mono)", fontSize: "1rem", fontWeight: 700, padding: ".82rem 1rem", display: "flex", alignItems: "center", gap: ".6rem" }}>
        <User size={14} style={{ opacity: .5 }} />{name}
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: ".6rem", color: "var(--dim)", marginTop: ".4rem" }}>Identificador gerado automaticamente</div>
    </div>
  );

  return (
    <div className="lobby">
      <div className="fade-in" style={{ width: "100%", maxWidth: 900 }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "2rem", justifyContent: "center" }}>
          <div style={{ width: 52, height: 52, background: "var(--accent)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 30px rgba(0,255,234,.45)", flexShrink: 0 }}>
            <Zap size={26} style={{ color: "#000" }} />
          </div>
          <div>
            <div style={{ fontSize: "2rem", fontWeight: 800, letterSpacing: "-.04em", lineHeight: 1 }}>Peer<span style={{ color: "var(--accent)" }}>File</span></div>
            <div style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color: "var(--muted)", letterSpacing: ".1em", textTransform: "uppercase", marginTop: 4 }}>Compartilhamento P2P direto · v4</div>
          </div>
        </div>

        {/* Cards */}
        <div className="lobby-cards-grid">

          {/* Enviar */}
          <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "1.75rem", position: "relative", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg,var(--accent),#00ccff)" }} />
            <div style={{ display: "flex", alignItems: "center", gap: ".65rem", marginBottom: "1.35rem" }}>
              <div style={{ width: 38, height: 38, background: "rgba(0,255,234,.1)", border: "1px solid rgba(0,255,234,.2)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Upload size={18} style={{ color: "var(--accent)" }} />
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: ".97rem" }}>Enviar arquivos</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: ".61rem", color: "var(--muted)", marginTop: 2 }}>Gera um código compacto para o receptor</div>
              </div>
            </div>
            {NameDisplay}
            <div style={{ background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: ".85rem 1rem", marginBottom: "1.1rem", fontFamily: "var(--mono)", fontSize: ".72rem", color: "var(--muted)", lineHeight: 1.7 }}>
              Gera um código comprimido (~400 chars). Envie ao receptor pelo WhatsApp, email ou qualquer canal.
            </div>
            <button className="btn btn-p btn-full" style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "center", gap: ".4rem" }} onClick={() => onSend(name)}>
              <Upload size={16} /> Quero enviar arquivos
            </button>
          </div>

          {/* Receber */}
          <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "1.75rem", position: "relative", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg,var(--purple),#a78bfa)" }} />
            <div style={{ display: "flex", alignItems: "center", gap: ".65rem", marginBottom: "1.35rem" }}>
              <div style={{ width: 38, height: 38, background: "rgba(157,78,255,.1)", border: "1px solid rgba(157,78,255,.25)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Download size={18} style={{ color: "#a78bfa" }} />
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: ".97rem" }}>Receber arquivos</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: ".61rem", color: "var(--muted)", marginTop: 2 }}>Cole o código do remetente</div>
              </div>
            </div>
            {NameDisplay}
            <div style={{ fontFamily: "var(--mono)", fontSize: ".72rem", color: "var(--muted)", lineHeight: 1.7, background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: ".85rem 1rem", marginBottom: "1rem" }}>
              Cole o código recebido do remetente para gerar uma resposta e conectar diretamente.
            </div>
            <button className="btn btn-full" style={{ marginTop: "auto", background: "var(--purple)", color: "#fff", fontWeight: 700, borderRadius: "var(--r-sm)", padding: ".82rem 1.6rem", fontSize: ".9rem", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: ".4rem" }} onClick={() => onReceive(name)}>
              <Download size={16} /> Quero receber arquivos
            </button>
          </div>
        </div>

        {/* Features strip */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: ".65rem", marginTop: "1rem" }}>
          {features.map(([Icon, tx]) => (
            <div key={tx} style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: ".75rem .85rem", display: "flex", alignItems: "center", gap: ".5rem" }}>
              {typeof Icon === "string"
                ? <span style={{ fontSize: ".95rem", color: "var(--accent)", flexShrink: 0, fontWeight: 700 }}>{Icon}</span>
                : <Icon size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
              }
              <span style={{ fontFamily: "var(--mono)", fontSize: ".62rem", color: "var(--muted)", lineHeight: 1.4 }}>{tx}</span>
            </div>
          ))}
        </div>

        {/* Tutorial */}
        <div style={{ marginTop: "1.75rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: ".75rem", marginBottom: "1.1rem" }}>
            <div style={{ height: 1, flex: 1, background: "var(--border2)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".12em", flexShrink: 0 }}>Como usar</span>
            <div style={{ height: 1, flex: 1, background: "var(--border2)" }} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
            {[
              { color: "var(--accent)", bg: "rgba(0,255,234,.1)", border: "rgba(0,255,234,.2)", Icon: Upload, title: "Enviando", steps: [["1","Clique em Enviar arquivos","Código comprimido é gerado (~400 chars)"],["2","Copie e envie","WhatsApp, email, qualquer canal"],["3","Cole a resposta","O receptor gera e te envia"],["4","Envie os arquivos","P2P direto, sem servidor"]] },
              { color: "#a78bfa", bg: "rgba(157,78,255,.1)", border: "rgba(157,78,255,.25)", Icon: Download, title: "Recebendo", steps: [["1","Clique em Receber arquivos","Tela de conexão abre"],["2","Cole o código","O que o remetente te enviou"],["3","Copie sua resposta","Envie de volta para ele"],["4","Aguarde e baixe","Arquivos chegam automaticamente"]] },
            ].map(({ color, bg, border, Icon, title, steps }) => (
              <div key={title} style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "1.25rem", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg,${color},transparent)` }} />
                <div style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: "1rem", display: "flex", alignItems: "center", gap: ".4rem" }}>
                  <Icon size={13} style={{ opacity: .8 }} />{title}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: ".65rem" }}>
                  {steps.map(([n, t, d]) => (
                    <div key={n} style={{ display: "flex", gap: ".75rem", alignItems: "flex-start" }}>
                      <div style={{ width: 22, height: 22, borderRadius: 6, background: bg, border: `1px solid ${border}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontSize: ".65rem", fontWeight: 700, color, flexShrink: 0, marginTop: 1 }}>{n}</div>
                      <div>
                        <div style={{ fontSize: ".83rem", fontWeight: 700, color: "var(--text)", marginBottom: ".12rem" }}>{t}</div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: ".62rem", color: "var(--muted)", lineHeight: 1.5 }}>{d}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: ".75rem" }}>
            {tips.map(([Icon, t, d]) => (
              <div key={t} style={{ background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "1rem 1.1rem", display: "flex", gap: ".75rem" }}>
                <Icon size={18} style={{ flexShrink: 0, marginTop: 2, color: "var(--accent)" }} />
                <div>
                  <div style={{ fontSize: ".82rem", fontWeight: 700, color: "var(--text)", marginBottom: ".3rem" }}>{t}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: ".61rem", color: "var(--muted)", lineHeight: 1.55 }}>{d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <footer style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid var(--border2)", display: "flex", flexDirection: "column", alignItems: "center", gap: ".75rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: ".5rem" }}>
            <div style={{ width: 22, height: 22, background: "var(--accent)", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 12px rgba(0,255,234,.45)" }}>
              <Zap size={13} style={{ color: "#000" }} />
            </div>
            <span style={{ fontWeight: 800, fontSize: ".9rem", color: "var(--text)" }}>Peer<span style={{ color: "var(--accent)" }}>File</span></span>
            <span style={{ fontFamily: "var(--mono)", fontSize: ".6rem", color: "var(--accent)", background: "rgba(0,255,234,.08)", border: "1px solid rgba(0,255,234,.2)", padding: ".1rem .45rem", borderRadius: 4 }}>v4.0</span>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: ".58rem", color: "var(--muted)", textAlign: "center", opacity: .8 }}>
            © {new Date().getFullYear()} PeerFile · Arquivos transferidos diretamente entre dispositivos — sem servidor intermediário
          </div>
        </footer>

      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   SENDER SCREEN
───────────────────────────────────────────────────────────────────── */
function SenderScreen({ myName, onBack, addToast }) {
  const [step, setStep] = useState(1);
  const [offerSDP, setOfferSDP] = useState("");
  const [offerRaw, setOfferRaw] = useState("");
  const [answerIn, setAnswerIn] = useState("");
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState([]);
  const [drag, setDrag] = useState(false);
  const [sending, setSending] = useState(false);
  const [allSent, setAllSent] = useState(false);
  const [progresses, setProgresses] = useState({});
  const [overallPct, setOverallPct] = useState(0);
  const [speed, setSpeed] = useState("—");
  const [tab, setTab] = useState("files");
  const [unreadRecv, setUnreadRecv] = useState(0);
  const [unreadChat, setUnreadChat] = useState(0);
  const [previews, setPreviews] = useState({});
  const [checksums, setChecksums] = useState({});
  const [compressedBlobs, setCompressedBlobs] = useState({});
  const [compressedSizes, setCompressedSizes] = useState({});
  const [messages, setMessages] = useState([]);
  const [chatText, setChatText] = useState("");
  const [typingPeer, setTypingPeer] = useState(false);
  const [history, setHistory] = useState([]);
  const [imagePreview, setImagePreview] = useState(null);
  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState("");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [textToSend, setTextToSend] = useState("");
  const [downloadedFiles, setDownloadedFiles] = useState(new Set());

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const chatDC = useRef(null);
  const sentRef = useRef(0);
  const startRef = useRef(null);
  const spTimer = useRef(null);
  const rcvBuf = useRef([]);
  const rcvInfo = useRef(null);
  const typingTimer = useRef(null);
  const pendingPin = useRef("");

  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);

  useEffect(() => {
    if (sending && overallPct < 100) document.title = `${overallPct}% enviando — PeerFile`;
    else if (connected) document.title = "Conectado — PeerFile";
    else document.title = "PeerFile";
  }, [sending, overallPct, connected]);

  useEffect(() => {
    createOffer();
    return () => {
      if (pcRef.current) {
        if (pcRef.current._heartbeat) clearInterval(pcRef.current._heartbeat);
        pcRef.current.close();
      }
      clearInterval(spTimer.current);
      document.title = "PeerFile";
    };
  }, []);

  const createOffer = async () => {
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    const dc = pc.createDataChannel("files", { ordered: true });
    dcRef.current = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => { setConnected(true); setStep(4); addToast("Conectado!", "ok"); };
    dc.onclose = () => setConnected(false);
    dc.onmessage = handleReceive;

    const chat = pc.createDataChannel("chat", { ordered: true });
    chatDC.current = chat;
    chat.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "ping") return; // heartbeat
      if (msg.type === "typing") { setTypingPeer(msg.typing); return; }
      if (msg.type === "download-confirm") {
        setDownloadedFiles(s => new Set([...s, msg.filename]));
        addToast(`${msg.filename} baixado pelo receptor`, "ok");
        return;
      }
      if (msg.type === "pin-verify") {
        const ok = msg.pin === pendingPin.current;
        chat.send(JSON.stringify({ type: "pin-result", ok }));
        if (!ok) addToast("PIN incorreto", "err");
        return;
      }
      setMessages(m => [...m, { text: msg.text, me: false, time: tsNow() }]);
      setUnreadChat(u => u + 1);
    };

    let iceDone = false;
    const finishOffer = async () => {
      if (iceDone) return;
      iceDone = true;
      const compressed = await compressSDP(pc.localDescription);
      setOfferSDP(compressed);
      setOfferRaw(JSON.stringify(pc.localDescription));
      setStep(2);
      addToast("Código gerado! Envie ao receptor.", "ok");
    };

    pc.onicecandidate = (e) => { if (!e.candidate) finishOffer(); };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") finishOffer(); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        // Try ICE restart before giving up
        addToast("Tentando reconectar...", "warn");
        pc.restartIce();
        setTimeout(() => {
          if (pc.connectionState !== "connected") {
            setConnected(false); addToast("Conexão perdida", "err");
          }
        }, 5000);
      }
      if (pc.connectionState === "disconnected") {
        // Short grace period — might reconnect on its own
        setTimeout(() => {
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            setConnected(false); addToast("Conexão perdida", "err");
          }
        }, 3000);
      }
    };

    // Heartbeat — mantém a conexão viva durante transferências longas
    const heartbeatInterval = setInterval(() => {
      if (pc.connectionState === "connected" && chatDC.current?.readyState === "open") {
        try { chatDC.current.send(JSON.stringify({ type: "ping" })); } catch {}
      }
    }, 10000);
    pc._heartbeat = heartbeatInterval;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    setTimeout(finishOffer, 3000);
  };

  const applyAnswer = async () => {
    const raw = answerIn.trim();
    if (!raw) { addToast("Cole o código de resposta", "err"); return; }
    try {
      const parsed = await decompressSDP(raw);
      if (!parsed) { addToast("Código inválido", "err"); return; }
      if (parsed.type === "offer") { addToast("Você colou seu próprio código! Cole a RESPOSTA do receptor.", "err"); return; }
      if (parsed.type !== "answer") { addToast("Código inválido — não é uma resposta WebRTC.", "err"); return; }
      if (raw === offerSDP || raw === offerRaw) { addToast("Código idêntico ao seu! Cole a resposta do receptor.", "err"); return; }
      await pcRef.current.setRemoteDescription(parsed);
      setStep(3); addToast("Aguardando conexão P2P...", "info");
    } catch { addToast("Código inválido. Verifique e tente novamente.", "err"); }
  };

  const handleReceive = async (e) => {
    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data);
      if (msg.type === "start") { rcvInfo.current = msg; rcvBuf.current = []; }
      if (msg.type === "end") {
        if (!rcvInfo.current) return;
        const info = { ...rcvInfo.current };
        const buf = [...rcvBuf.current];
        rcvBuf.current = [];
        rcvInfo.current = null;

        let finalBlob;
        if (info.compressed) {
          try {
            const ds = new DecompressionStream("gzip");
            const writer = ds.writable.getWriter();
            writer.write(await new Blob(buf).arrayBuffer());
            writer.close();
            const chunks = [];
            const reader = ds.readable.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            finalBlob = new Blob(chunks, { type: info.ftype || "application/octet-stream" });
          } catch { finalBlob = new Blob(buf, { type: info.ftype || "application/octet-stream" }); }
        } else {
          finalBlob = new Blob(buf, { type: info.ftype || "application/octet-stream" });
        }
        const url = URL.createObjectURL(finalBlob);
        if (soundEnabled) playNotif();
        if (tab !== "received") setUnreadRecv(u => u + 1);
        if (isImage(info.name)) setImagePreview(url);
        setHistory(h => [...h, { name: info.name, size: info.origSize || finalBlob.size, url, direction: "received", ts: tsNow() }]);
        addToast(`${info.name} recebido!`, "ok");
      }
    } else { rcvBuf.current.push(e.data); }
  };

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
    if (!dcRef.current || dcRef.current.readyState !== "open") { addToast("Sem conexão ativa", "err"); return; }
    setSending(true); sentRef.current = 0; startRef.current = Date.now(); setOverallPct(0); setAllSent(false);
    dcRef.current.send(JSON.stringify({ type: "list", files: files.map(f => ({ name: f.name, size: f.size, ftype: f.type })) }));
    spTimer.current = setInterval(() => {
      const el = (Date.now() - startRef.current) / 1000;
      if (el > 0) setSpeed(fmtSpd(sentRef.current / el));
    }, 600);

    let aborted = false;
    for (let i = 0; i < files.length; i++) {
      if (aborted) break;
      let success = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        // Stop retrying if connection dropped
        if (!dcRef.current || dcRef.current.readyState !== "open") {
          addToast("Conexão perdida durante o envio", "err");
          aborted = true; break;
        }
        try {
          await sendFile(files[i], compressedBlobs[i] || null, checksums[i] || null, i);
          success = true; break;
        } catch (err) {
          const isDisconnect = err.message === "disconnected";
          if (isDisconnect) {
            addToast("Conexão perdida durante o envio", "err");
            aborted = true; break;
          }
          if (attempt < 2) {
            addToast(`Retentando ${files[i].name}...`, "warn");
            await new Promise(r => setTimeout(r, 1500));
          } else {
            addToast(`Falha ao enviar ${files[i].name}`, "err");
          }
        }
      }
      if (success) {
        setHistory(h => [...h, { name: files[i].name, size: files[i].size, direction: "sent", ts: tsNow() }]);
      }
    }

    clearInterval(spTimer.current);
    setSending(false);

    if (!aborted) {
      setOverallPct(100);
      setAllSent(true);
      addToast("Todos os arquivos enviados!", "ok");
    } else {
      setOverallPct(0);
      setProgresses({});
    }
  };

  const sendFile = (file, cBlob, ck, idx) => new Promise((resolve, reject) => {
    if (!dcRef.current || dcRef.current.readyState !== "open") { reject(new Error("disconnected")); return; }
    const blob = cBlob || file; const size = blob.size;
    try { dcRef.current.send(JSON.stringify({ type: "start", name: file.name, size, origSize: file.size, ftype: file.type, checksum: ck, compressed: !!cBlob, idx })); }
    catch { reject(new Error("disconnected")); return; }
    const reader = new FileReader(); let offset = 0;
    const next = () => {
      if (offset >= size) {
        try { dcRef.current.send(JSON.stringify({ type: "end", idx })); resolve(); }
        catch { reject(new Error("disconnected")); }
        return;
      }
      if (dcRef.current.readyState !== "open") { reject(new Error("disconnected")); return; }
      if (dcRef.current.bufferedAmount > MAX_BUFFERED) { setTimeout(next, 50); return; }
      reader.readAsArrayBuffer(blob.slice(offset, offset + CHUNK));
    };
    reader.onload = (e) => {
      if (!dcRef.current || dcRef.current.readyState !== "open") {
        reject(new Error("disconnected")); return;
      }
      dcRef.current.send(e.target.result);
      offset += e.target.result.byteLength; sentRef.current += e.target.result.byteLength;
      const pct = Math.round((offset / size) * 100);
      setProgresses(p => ({ ...p, [idx]: pct }));
      setOverallPct(Math.round(((idx * 100) + pct) / files.length));
      next();
    };
    reader.onerror = () => reject(new Error("read error"));
    next();
  });

  const sendText = () => {
    if (!textToSend.trim() || !dcRef.current || dcRef.current.readyState !== "open") return;
    dcRef.current.send(JSON.stringify({ type: "text", text: textToSend }));
    addToast("Texto enviado!", "ok");
    setTextToSend("");
  };

  const sendChat = () => {
    if (!chatText.trim()) return;
    if (chatDC.current?.readyState === "open") chatDC.current.send(JSON.stringify({ type: "msg", text: chatText }));
    setMessages(m => [...m, { text: chatText, me: true, time: tsNow() }]);
    setChatText("");
  };

  const handleChatChange = (val) => {
    setChatText(val);
    if (chatDC.current?.readyState === "open") {
      chatDC.current.send(JSON.stringify({ type: "typing", typing: true }));
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => { chatDC.current?.send(JSON.stringify({ type: "typing", typing: false })); }, 1500);
    }
  };

  const switchTab = (t) => { setTab(t); if (t === "received") setUnreadRecv(0); if (t === "chat") setUnreadChat(0); };

  const flowItems = ["Copie o código gerado", "Envie ao receptor", "Cole a resposta dele", "Conexão P2P estabelecida", "Envie os arquivos"];

  return (
    <>
      {showPin && <PinModal mode="set" onConfirm={(p) => { pendingPin.current = p; setPin(p); setShowPin(false); addToast("PIN definido", "ok"); }} onCancel={() => setShowPin(false)} />}
      {imagePreview && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setImagePreview(null)}>
          <img src={imagePreview} alt="" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: "var(--r)" }} />
          <div style={{ position: "absolute", top: "1.5rem", right: "1.5rem", cursor: "pointer", color: "#fff" }} onClick={() => setImagePreview(null)}>
            <X size={24} />
          </div>
        </div>
      )}
      <div className="app fade-in">
        <header className="header">
          <div className="logo">
            <div className="logo-ico"><Zap size={20} style={{ color: "#000" }} /></div>
            <div className="logo-text">Peer<span>File</span></div>
          </div>
          <div className="header-mid"><ConnStatus connected={connected} step={step} role="send" /></div>
          <div className="header-right">
            <button className="btn btn-s btn-sm" onClick={() => setSoundEnabled(s => !s)} style={{ padding: ".45rem .7rem" }}>
              {soundEnabled ? <Bell size={14} /> : <BellOff size={14} />}
            </button>
            {!pin && step >= 2 && (
              <button className="btn btn-s btn-sm" onClick={() => setShowPin(true)} style={{ display: "flex", alignItems: "center", gap: ".3rem" }}>
                <Lock size={13} /> PIN
              </button>
            )}
            {pin && (
              <span style={{ fontFamily: "var(--mono)", fontSize: ".7rem", color: "var(--amber)", background: "rgba(255,184,0,.1)", border: "1px solid rgba(255,184,0,.2)", padding: ".3rem .7rem", borderRadius: 6, display: "flex", alignItems: "center", gap: ".3rem" }}>
                <Lock size={12} /> PIN ativo
              </span>
            )}
            <button className="btn btn-d btn-sm" onClick={() => { if (pcRef.current) pcRef.current.close(); document.title = "PeerFile"; onBack(); }} style={{ display: "flex", alignItems: "center", gap: ".3rem" }}>
              <RotateCcw size={13} /> Voltar
            </button>
          </div>
        </header>

        <Steps current={step} labels={["Gerando", "Compartilhar", "Aguardar", "Conectado"]} />

        <div className="room-layout">
          <div className="main-col">

            {step === 1 && (
              <div className="card">
                <div style={{ textAlign: "center", padding: "2rem 0", fontFamily: "var(--mono)", fontSize: ".82rem", color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center", gap: ".5rem" }}>
                  <Loader size={16} style={{ animation: "spin 1s linear infinite" }} /> Gerando código de conexão...
                </div>
              </div>
            )}

            {step >= 2 && !connected && (
              <div className="card">
                {/* Etapa 1 e 2 unificadas num card compacto */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "1rem", alignItems: "start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Etapa 1 */}
                    <div style={{ marginBottom: ".85rem" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: ".5rem" }}>
                        <div className="card-title" style={{ marginBottom: 0 }}><KeyRound size={12} style={{ marginRight: ".35rem", color: "var(--accent)" }} />1 — Seu código</div>
                        <span style={{ fontFamily: "var(--mono)", fontSize: ".6rem", color: value => value?.length < 500 ? "var(--green)" : "var(--muted)" }}>{offerSDP.length} chars</span>
                      </div>
                      <textarea
                        style={{ width: "100%", background: "var(--s2)", border: "1px solid var(--border2)", borderRadius: "var(--r-sm)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: ".74rem", lineHeight: 1.5, padding: ".7rem .9rem", outline: "none", resize: "none", height: 70 }}
                        value={offerSDP} readOnly onClick={e => e.target.select()}
                      />
                      <button className="btn btn-p btn-sm" style={{ display: "flex", alignItems: "center", gap: ".3rem", marginTop: ".4rem" }} onClick={() => { copyText(offerSDP); addToast("Código copiado!", "ok"); }}>
                        <Copy size={12} /> Copiar e enviar
                      </button>
                    </div>
                    {/* Divider */}
                    <div style={{ height: 1, background: "var(--border)", margin: ".75rem 0" }} />
                    {/* Etapa 2 */}
                    <div>
                      <div className="card-title" style={{ marginBottom: ".5rem" }}><Link size={12} style={{ marginRight: ".35rem", color: "var(--accent)" }} />2 — Cole a resposta</div>
                      <textarea
                        style={{ width: "100%", background: "var(--s2)", border: "1px solid var(--border2)", borderRadius: "var(--r-sm)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: ".74rem", lineHeight: 1.5, padding: ".7rem .9rem", outline: "none", resize: "none", height: 70 }}
                        placeholder="Cole aqui o código do receptor..."
                        value={answerIn} onChange={e => setAnswerIn(e.target.value)}
                      />
                      <button className="btn btn-s btn-full" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: ".35rem", marginTop: ".4rem" }} onClick={applyAnswer} disabled={!answerIn.trim()}>
                        <Plug size={14} /> Conectar
                      </button>
                    </div>
                  </div>
                  {/* QR compacto */}
                  <QRCodeWidget value={offerSDP} size={120} />
                </div>
              </div>
            )}

            {connected && (
              <>
                <div className="tabs">
                  {[
                    ["files", FolderOpen, "Arquivos", 0],
                    ["text", Pen, "Texto", 0],
                    ["received", Download, "Recebidos", unreadRecv],
                    ["chat", MessageCircleMore, "Chat", unreadChat],
                    ["history", History, "Histórico", 0],
                  ].map(([k, Icon, lb, badge]) => (
                    <button key={k} className={`tab-btn ${tab === k ? "active" : ""}`} onClick={() => switchTab(k)}>
                      <Icon size={14} />{lb}
                      {badge > 0 && <span className="tab-badge">{badge}</span>}
                    </button>
                  ))}
                </div>

                {tab === "files" && (
                  <div className="card">
                    <div className="card-hdr">
                      <div className="card-title"><FolderOpen size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Arquivos para enviar</div>
                    </div>
                    <div className={`drop ${drag ? "over" : ""}`}
                      onDragOver={e => { e.preventDefault(); setDrag(true); }}
                      onDragLeave={() => setDrag(false)}
                      onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
                      onClick={() => document.getElementById("fb-fi").click()}>
                      {drag ? <ArrowDown size={36} className="drop-ico" style={{ margin: "0 auto .75rem", display: "block", color: "var(--accent)" }} /> : <CloudUpload size={36} className="drop-ico" style={{ margin: "0 auto .75rem", display: "block", color: "var(--muted)" }} />}
                      <div className="drop-title">Arraste ou clique para selecionar</div>
                      <div className="drop-sub">Qualquer tipo · qualquer tamanho · compressão automática</div>
                    </div>
                    <input id="fb-fi" type="file" multiple style={{ display: "none" }} onChange={e => addFiles(e.target.files)} />

                    {files.length > 0 && (
                      <>
                        <div className="mini-stats" style={{ marginTop: ".85rem" }}>
                          <div className="mini-stat"><div className="mini-val">{files.length}</div><div className="mini-lbl">Arquivos</div></div>
                          <div className="mini-stat"><div className="mini-val">{fmt(totalSize)}</div><div className="mini-lbl">Total</div></div>
                          <div className="mini-stat"><div className="mini-val">{speed}</div><div className="mini-lbl">Velocidade</div></div>
                        </div>

                        <div className="file-list-scroll">
                          <div className="file-list">
                            {files.map((f, i) => (
                              <div key={i} className="file-card">
                                <div className="file-row">
                                  <div className="file-thumb" style={{ cursor: previews[i] ? "pointer" : "default" }} onClick={() => previews[i] && setImagePreview(previews[i])}>
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
                                      <>
                                        <div className="pbar" style={{ marginTop: ".4rem" }}><div className="pfill" style={{ width: progresses[i] + "%" }} /></div>
                                        <div style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color: "var(--muted)" }}>{progresses[i]}%</div>
                                      </>
                                    )}
                                  </div>
                                  {!sending && (
                                    <button className="file-rm" onClick={() => setFiles(fl => fl.filter((_, j) => j !== i))}>
                                      <X size={13} />
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {sending && (
                          <div className="send-progress">
                            <div className="send-progress-hdr"><span>Enviando {files.length} arquivo(s)...</span><span>{overallPct}%</span></div>
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
                                  {downloadedFiles.size > 0 ? `${downloadedFiles.size} de ${files.length} confirmado(s) como baixado(s)` : "Aguardando confirmação de download..."}
                                </div>
                              </div>
                            </div>
                            <button className="btn btn-s btn-full" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: ".35rem" }} onClick={() => { setAllSent(false); setProgresses({}); setOverallPct(0); setDownloadedFiles(new Set()); }}>
                              <RotateCw size={13} /> Enviar novamente
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-p btn-full" style={{ marginTop: ".85rem", display: "flex", alignItems: "center", justifyContent: "center", gap: ".4rem" }} onClick={sendFiles} disabled={sending}>
                            {sending ? <><Loader size={14} style={{ animation: "spin 1s linear infinite" }} /> Enviando... {overallPct}%</> : <><Send size={14} /> Enviar todos os arquivos</>}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}

                {tab === "text" && (
                  <div className="card">
                    <div className="card-hdr">
                      <div className="card-title"><Pen size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Enviar texto ou link</div>
                    </div>
                    <textarea style={{ width: "100%", background: "var(--s2)", border: "1px solid var(--border2)", borderRadius: "var(--r-sm)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: ".82rem", lineHeight: 1.65, padding: "1rem 1.1rem", outline: "none", resize: "none", height: 120 }} placeholder="Cole um link, texto, senha, código..." value={textToSend} onChange={e => setTextToSend(e.target.value)} />
                    <button className="btn btn-p btn-full" style={{ marginTop: ".75rem", display: "flex", alignItems: "center", justifyContent: "center", gap: ".35rem" }} onClick={sendText} disabled={!textToSend.trim()}>
                      <Send size={14} /> Enviar texto
                    </button>
                  </div>
                )}

                {tab === "received" && (
                  <div className="card">
                    <div className="card-hdr">
                      <div className="card-title"><Download size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Arquivos recebidos</div>
                    </div>
                    {history.filter(h => h.direction === "received" && h.url).length === 0
                      ? <div className="empty">Nenhum arquivo recebido ainda</div>
                      : (
                        <div className="file-list-scroll">
                          <div className="file-list">
                            {history.filter(h => h.direction === "received" && h.url).map((f, i) => (
                              <div key={i} className="recv-card" onClick={() => f.url && isImage(f.name) && setImagePreview(f.url)} style={{ cursor: isImage(f.name) ? "pointer" : "default" }}>
                                <div className="file-thumb">{f.url && isImage(f.name) ? <img src={f.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 9 }} /> : fileIcon(f.name)}</div>
                                <div className="file-inf">
                                  <div className="file-nm">{f.name}</div>
                                  <div className="recv-from"><span>{fmt(f.size)}</span><span>·</span><span>{f.ts}</span></div>
                                </div>
                                {f.url && <a className="btn btn-p btn-sm" href={f.url} download={f.name} style={{ display: "flex", alignItems: "center", gap: ".3rem" }} onClick={e => e.stopPropagation()}>
                                  <Download size={13} />
                                </a>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    }
                  </div>
                )}

                {tab === "chat" && (
                  <div className="card">
                    <div className="card-hdr">
                      <div className="card-title"><MessageCircleMore size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Chat P2P</div>
                    </div>
                    <ChatBox messages={messages} chatText={chatText} setChatText={handleChatChange} onSend={sendChat} typingPeer={typingPeer} />
                  </div>
                )}

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
              <div className="card-hdr">
                <div className="card-title"><User size={13} style={{ marginRight: ".4rem" }} />Sessão</div>
              </div>
              <div className="member-row me-row">
                <Avatar name={myName} id={myName} size={34} />
                <div className="mem-inf"><div className="mem-name">{myName}</div><div className="mem-sub">remetente</div></div>
                <div className={`peer-state-dot ${connected ? "connected" : step >= 3 ? "connecting" : "disconnected"}`} />
              </div>
              {connected && (
                <div style={{ marginTop: ".75rem", padding: ".65rem .85rem", background: "rgba(0,255,234,.06)", border: "1px solid rgba(0,255,234,.15)", borderRadius: "var(--r-sm)", fontFamily: "var(--mono)", fontSize: ".68rem", color: "var(--accent)", display: "flex", alignItems: "center", gap: ".35rem" }}>
                  <CheckCircle2 size={13} /> P2P conectado
                </div>
              )}
              <div style={{ marginTop: "1rem", fontFamily: "var(--mono)", fontSize: ".63rem", color: "var(--muted)", lineHeight: 1.7, background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: ".75rem .85rem" }}>
                <div style={{ marginBottom: ".35rem", color: "var(--text)", fontWeight: 700 }}>Fluxo</div>
                {flowItems.map((s, i) => {
                  const done = connected ? i <= 3 : (i === 0 && step >= 2) || (i === 1 && step >= 2) || (i === 2 && step >= 3);
                  const active = !done && ((i === 0 && step === 1) || (i === 1 && step === 2) || (i === 2 && step === 2) || (i === 3 && step === 3 && !connected) || (i === 4 && connected));
                  return (
                    <div key={i} style={{ display: "flex", gap: ".5rem", alignItems: "center", marginBottom: ".2rem" }}>
                      {done ? <Check size={11} style={{ color: "var(--accent)", flexShrink: 0 }} /> : active ? <ChevronRight size={11} style={{ color: "var(--amber)", flexShrink: 0 }} /> : <Circle size={10} style={{ color: "var(--dim)", flexShrink: 0 }} />}
                      <span style={{ color: done ? "var(--accent)" : active ? "var(--text)" : "var(--dim)" }}>{s}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   RECEIVER SCREEN
───────────────────────────────────────────────────────────────────── */
function ReceiverScreen({ myName, onBack, addToast, autoCode = "" }) {
  const [step, setStep] = useState(1);
  const [remoteOffer, setRemoteOffer] = useState(autoCode);
  const [localAnswer, setLocalAnswer] = useState("");
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState("received");
  const [unreadChat, setUnreadChat] = useState(0);
  const [messages, setMessages] = useState([]);
  const [chatText, setChatText] = useState("");
  const [typingPeer, setTypingPeer] = useState(false);
  const [history, setHistory] = useState([]);
  const [imagePreview, setImagePreview] = useState(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showPin, setShowPin] = useState(false);
  const [rcvProgress, setRcvProgress] = useState(null);
  const [textReceived, setTextReceived] = useState([]);
  const [waitingTooLong, setWaitingTooLong] = useState(false);

  const pcRef = useRef(null);
  const chatDC = useRef(null);
  const rcvBuf = useRef([]);
  const rcvInfo = useRef(null);
  const typingTimer = useRef(null);

  useEffect(() => {
    if (autoCode) setTimeout(() => createAnswer(), 500);
    return () => { if (pcRef.current) pcRef.current.close(); document.title = "PeerFile"; };
  }, []);

  useEffect(() => {
    if (step !== 2 || connected) return;
    const t = setTimeout(() => setWaitingTooLong(true), 3 * 60 * 1000);
    return () => clearTimeout(t);
  }, [step, connected]);

  useEffect(() => {
    if (connected) document.title = "Conectado — PeerFile";
    else document.title = "PeerFile";
  }, [connected]);

  const createAnswer = async () => {
    if (!remoteOffer.trim()) { addToast("Cole o código do remetente", "err"); return; }
    const parsed = await decompressSDP(remoteOffer.trim());
    if (!parsed) { addToast("Código inválido", "err"); return; }
    if (parsed.type === "answer") { addToast("Isso é uma resposta, não um código de oferta!", "err"); return; }
    if (parsed.type !== "offer") { addToast("Código inválido — não é um código WebRTC.", "err"); return; }

    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    pc.ondatachannel = (e) => {
      if (e.channel.label === "chat") {
        chatDC.current = e.channel;
        e.channel.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === "typing") { setTypingPeer(msg.typing); return; }
          if (msg.type === "ping") return; // heartbeat
          if (msg.type === "pin-result") { if (!msg.ok) addToast("PIN incorreto", "err"); else addToast("PIN verificado", "ok"); return; }
          setMessages(m => [...m, { text: msg.text, me: false, time: tsNow() }]);
          setUnreadChat(u => u + 1);
        };
        return;
      }
      const ch = e.channel;
      ch.binaryType = "arraybuffer";
      ch.onopen = () => { setConnected(true); setStep(3); addToast("Conectado! Aguardando arquivos...", "ok"); };
      ch.onmessage = handleReceive;
    };

    pc.onicecandidate = async (e) => {
      if (!e.candidate) {
        const compressed = await compressSDP(pc.localDescription);
        setLocalAnswer(compressed);
        setStep(2); addToast("Resposta gerada! Envie ao remetente.", "ok");
      }
    };

    try {
      await pc.setRemoteDescription(parsed);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      setTimeout(async () => {
        if (!localAnswer) {
          const compressed = await compressSDP(pc.localDescription);
          setLocalAnswer(compressed); setStep(2);
        }
      }, 3000);
    } catch { addToast("Código inválido. Verifique e tente novamente.", "err"); }
  };

  const handleReceive = async (e) => {
    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data);
      if (msg.type === "start") {
        rcvInfo.current = msg; rcvBuf.current = [];
        setRcvProgress({ name: msg.name, size: msg.origSize || msg.size, pct: 0 });
        setTab("received");
      }
      if (msg.type === "text") {
        setTextReceived(t => [...t, { text: msg.text, ts: tsNow() }]);
        addToast("Texto recebido!", "ok");
        if (soundEnabled) playNotif();
        return;
      }
      if (msg.type === "end") {
        // Capture info locally BEFORE any await — rcvInfo.current may change
        if (!rcvInfo.current) return;
        const info = { ...rcvInfo.current };
        const buf = [...rcvBuf.current];

        // Clear refs immediately
        rcvBuf.current = [];
        rcvInfo.current = null;
        setRcvProgress(null);

        const rawBlob = new Blob(buf);
        let finalBlob = rawBlob;

        // Decompress if file was gzip compressed
        if (info.compressed) {
          try {
            const ds = new DecompressionStream("gzip");
            const writer = ds.writable.getWriter();
            writer.write(await rawBlob.arrayBuffer());
            writer.close();
            const chunks = [];
            const reader = ds.readable.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            finalBlob = new Blob(chunks, { type: info.ftype || "application/octet-stream" });
          } catch { finalBlob = new Blob(buf, { type: info.ftype || "application/octet-stream" }); }
        } else {
          finalBlob = new Blob(buf, { type: info.ftype || "application/octet-stream" });
        }

        const url = URL.createObjectURL(finalBlob);
        if (soundEnabled) playNotif();
        document.title = `Arquivo recebido — PeerFile`;
        setTimeout(() => { document.title = "Conectado — PeerFile"; }, 3000);

        // Verify checksum against decompressed content
        let checksumOk = null;
        if (info.checksum) {
          try {
            const abuf = await finalBlob.arrayBuffer();
            checksumOk = crc32(abuf) === info.checksum;
          } catch { checksumOk = null; }
        }

        if (isImage(info.name)) setImagePreview(url);
        setHistory(h => [...h, { name: info.name, size: info.origSize || finalBlob.size, url, checksumOk, direction: "received", ts: tsNow() }]);
        addToast(`${info.name} recebido!`, "ok");
      }
    } else {
      rcvBuf.current.push(e.data);
      if (rcvInfo.current) {
        const received = rcvBuf.current.reduce((s, c) => s + (c.byteLength || 0), 0);
        const pct = Math.min(99, Math.round((received / rcvInfo.current.size) * 100));
        setRcvProgress(p => p ? { ...p, pct } : null);
        document.title = `${pct}% recebendo — PeerFile`;
      }
    }
  };

  const sendChat = () => {
    if (!chatText.trim()) return;
    if (chatDC.current?.readyState === "open") chatDC.current.send(JSON.stringify({ type: "msg", text: chatText }));
    setMessages(m => [...m, { text: chatText, me: true, time: tsNow() }]);
    setChatText("");
  };

  const handleChatChange = (val) => {
    setChatText(val);
    if (chatDC.current?.readyState === "open") {
      chatDC.current.send(JSON.stringify({ type: "typing", typing: true }));
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => { chatDC.current?.send(JSON.stringify({ type: "typing", typing: false })); }, 1500);
    }
  };

  const switchTab = (t) => { setTab(t); if (t === "chat") setUnreadChat(0); };

  const verifyPin = (p) => {
    setShowPin(false);
    if (chatDC.current?.readyState === "open") {
      chatDC.current.send(JSON.stringify({ type: "pin-verify", pin: p }));
      addToast("PIN enviado para verificação...", "info");
    }
  };

  const flowItems = ["Cole o código do remetente", "Copie sua resposta", "Envie ao remetente", "Aguarde a conexão P2P", "Receba os arquivos"];

  return (
    <>
      {showPin && <PinModal mode="verify" onConfirm={verifyPin} onCancel={() => setShowPin(false)} />}
      {imagePreview && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setImagePreview(null)}>
          <img src={imagePreview} alt="" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: "var(--r)" }} />
          <div style={{ position: "absolute", top: "1.5rem", right: "1.5rem", cursor: "pointer", color: "#fff" }} onClick={() => setImagePreview(null)}>
            <X size={24} />
          </div>
        </div>
      )}
      <div className="app fade-in">
        <header className="header">
          <div className="logo">
            <div className="logo-ico"><Zap size={20} style={{ color: "#000" }} /></div>
            <div className="logo-text">Peer<span>File</span></div>
          </div>
          <div className="header-mid"><ConnStatus connected={connected} step={step} role="receive" /></div>
          <div className="header-right">
            <button className="btn btn-s btn-sm" onClick={() => setSoundEnabled(s => !s)} style={{ padding: ".45rem .7rem" }}>
              {soundEnabled ? <Bell size={14} /> : <BellOff size={14} />}
            </button>
            {connected && (
              <button className="btn btn-s btn-sm" onClick={() => setShowPin(true)} style={{ display: "flex", alignItems: "center", gap: ".3rem" }}>
                <Lock size={13} /> PIN
              </button>
            )}
            <button className="btn btn-d btn-sm" onClick={() => { if (pcRef.current) pcRef.current.close(); document.title = "PeerFile"; onBack(); }} style={{ display: "flex", alignItems: "center", gap: ".3rem" }}>
              <RotateCcw size={13} /> Voltar
            </button>
          </div>
        </header>

        <Steps current={step} labels={["Colar código", "Enviar resposta", "Recebendo"]} />

        <div className="room-layout">
          <div className="main-col">

            {waitingTooLong && !connected && (
              <div style={{ background: "rgba(255,184,0,.08)", border: "1px solid rgba(255,184,0,.3)", borderRadius: "var(--r-sm)", padding: "1rem 1.1rem", display: "flex", gap: ".75rem", alignItems: "flex-start", marginBottom: ".75rem" }}>
                <Hourglass size={18} style={{ color: "var(--amber)", flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: ".88rem", color: "var(--amber)", marginBottom: ".25rem" }}>Aguardando há mais de 3 minutos</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: ".68rem", color: "var(--muted)", lineHeight: 1.6 }}>Confirme se o remetente recebeu o código correto.</div>
                  <button className="btn btn-s btn-sm" style={{ marginTop: ".6rem", display: "flex", alignItems: "center", gap: ".3rem" }} onClick={() => { if (pcRef.current) pcRef.current.close(); onBack(); }}>
                    <RotateCcw size={12} /> Voltar e tentar novamente
                  </button>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="card">
                <div className="card-hdr">
                  <div className="card-title"><Download size={13} style={{ marginRight: ".4rem", color: "#a78bfa" }} />Etapa 1 — Cole o código do remetente</div>
                </div>
                <SdpBox label="Código recebido do remetente:" value={remoteOffer} readOnly={false} onChange={e => setRemoteOffer(e.target.value)} placeholder="Cole aqui o código enviado pelo remetente..." hint="" />
                <button className="btn btn-p btn-full" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: ".35rem" }} onClick={createAnswer} disabled={!remoteOffer.trim()}>
                  <Sparkles size={14} /> Gerar resposta
                </button>
              </div>
            )}

            {step >= 2 && (
              <div className="card">
                <div className="card-hdr">
                  <div className="card-title"><Upload size={13} style={{ marginRight: ".4rem", color: "var(--purple)" }} />{connected ? "Resposta enviada" : "Envie esta resposta ao remetente"}</div>
                  {connected && <span style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color: "var(--green)", display: "flex", alignItems: "center", gap: ".3rem" }}><CheckCircle2 size={13} />conectado</span>}
                </div>
                {!connected && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "1rem", alignItems: "start" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <textarea
                        style={{ width: "100%", background: "var(--s2)", border: "1px solid var(--border2)", borderRadius: "var(--r-sm)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: ".74rem", lineHeight: 1.5, padding: ".7rem .9rem", outline: "none", resize: "none", height: 70 }}
                        value={localAnswer} readOnly onClick={e => e.target.select()}
                      />
                      <div style={{ display: "flex", gap: ".5rem", marginTop: ".4rem", alignItems: "center", flexWrap: "wrap" }}>
                        <button className="btn btn-p btn-sm" style={{ display: "flex", alignItems: "center", gap: ".3rem" }} onClick={() => { copyText(localAnswer); addToast("Resposta copiada!", "ok"); }}>
                          <Copy size={12} /> Copiar e enviar
                        </button>
                        <div style={{ fontFamily: "var(--mono)", fontSize: ".6rem", color: "var(--muted)", display: "flex", alignItems: "center", gap: ".3rem" }}>
                          <Hourglass size={11} style={{ color: "var(--amber)" }} />Aguardando remetente...
                        </div>
                      </div>
                    </div>
                    <QRCodeWidget value={localAnswer} size={120} />
                  </div>
                )}
              </div>
            )}

            {connected && (
              <>
                <div className="tabs">
                  {[
                    ["received", Inbox, "Recebidos", 0],
                    ["chat", MessageCircleMore, "Chat", unreadChat],
                    ["history", History, "Histórico", 0],
                  ].map(([k, Icon, lb, badge]) => (
                    <button key={k} className={`tab-btn ${tab === k ? "active" : ""}`} onClick={() => switchTab(k)}>
                      <Icon size={14} />{lb}
                      {badge > 0 && <span className="tab-badge">{badge}</span>}
                    </button>
                  ))}
                </div>

                {tab === "received" && (
                  <div className="card">
                    <div className="card-hdr">
                      <div className="card-title">
                        <CheckCircle2 size={13} style={{ marginRight: ".4rem", color: "var(--green)" }} />Arquivos recebidos
                      </div>
                      {history.filter(h => h.direction === "received" && h.url).length > 0 && (
                        <span style={{ fontFamily: "var(--mono)", fontSize: ".65rem", color: "var(--muted)" }}>{history.filter(h => h.direction === "received" && h.url).length} arquivo(s)</span>
                      )}
                    </div>

                    {/* Textos recebidos */}
                    {textReceived.length > 0 && (
                      <div style={{ marginBottom: ".85rem", paddingBottom: ".85rem", borderBottom: "1px solid var(--border)" }}>
                        <div style={{ fontFamily: "var(--mono)", fontSize: ".6rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: ".5rem", display: "flex", alignItems: "center", gap: ".35rem" }}>
                          <AlignLeft size={11} /> Textos recebidos ({textReceived.length})
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: ".5rem", maxHeight: 260, overflowY: "auto", paddingRight: ".25rem" }}>
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

                    {/* Progresso em andamento */}
                    {rcvProgress && (
                      <div style={{ background: "rgba(0,255,234,.04)", border: "1px solid rgba(0,255,234,.2)", borderRadius: "var(--r-sm)", padding: ".85rem 1rem", marginBottom: ".75rem" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: ".72rem", marginBottom: ".4rem", color: "var(--accent)", alignItems: "center" }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontWeight: 700, display: "flex", alignItems: "center", gap: ".4rem" }}>
                            <Download size={13} /> {rcvProgress.name}
                          </span>
                          <span style={{ marginLeft: ".75rem", fontWeight: 700 }}>{rcvProgress.pct}%</span>
                        </div>
                        <div className="pbar"><div className="pfill" style={{ width: rcvProgress.pct + "%" }} /></div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: ".62rem", color: "var(--muted)", marginTop: ".3rem" }}>{fmt(rcvProgress.size)}</div>
                      </div>
                    )}

                    {history.filter(h => h.direction === "received" && h.url).length === 0 && !rcvProgress
                      ? <div className="empty">Aguardando o remetente enviar arquivos...</div>
                      : (
                        <div className="file-list-scroll">
                          <div className="file-list">
                            {history.filter(h => h.direction === "received" && h.url).map((f, i) => (
                              <div key={i} className="recv-card" onClick={() => f.url && isImage(f.name) && setImagePreview(f.url)} style={{ cursor: isImage(f.name) ? "pointer" : "default" }}>
                                <div className="file-thumb">{f.url && isImage(f.name) ? <img src={f.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 9 }} /> : fileIcon(f.name)}</div>
                                <div className="file-inf">
                                  <div className="file-nm">{f.name}</div>
                                  <div className="recv-from">
                                    <span>{fmt(f.size)}</span><span>·</span><span>{f.ts}</span>
                                    {f.checksumOk === true && <span className="badge badge-green" style={{ display: "flex", alignItems: "center", gap: 2 }}><Check size={9} />íntegro</span>}
                                    {f.checksumOk === false && <span className="badge badge-err" style={{ display: "flex", alignItems: "center", gap: 2 }}><X size={9} />corrompido</span>}
                                  </div>
                                </div>
                                {f.url && (
                                  <a className="btn btn-p btn-sm" href={f.url} download={f.name}
                                    style={{ display: "flex", alignItems: "center", gap: ".3rem" }}
                                    onClick={e => { e.stopPropagation(); if (chatDC.current?.readyState === "open") chatDC.current.send(JSON.stringify({ type: "download-confirm", filename: f.name })); }}>
                                    <Download size={13} /> Baixar
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    }
                  </div>
                )}

                {tab === "chat" && (
                  <div className="card">
                    <div className="card-hdr">
                      <div className="card-title"><MessageCircleMore size={13} style={{ marginRight: ".4rem", color: "var(--accent)" }} />Chat P2P</div>
                    </div>
                    <ChatBox messages={messages} chatText={chatText} setChatText={handleChatChange} onSend={sendChat} typingPeer={typingPeer} />
                  </div>
                )}

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
              <div className="card-hdr">
                <div className="card-title"><User size={13} style={{ marginRight: ".4rem" }} />Sessão</div>
              </div>
              <div className="member-row me-row">
                <Avatar name={myName} id={myName} size={34} />
                <div className="mem-inf"><div className="mem-name">{myName}</div><div className="mem-sub">receptor</div></div>
                <div className={`peer-state-dot ${connected ? "connected" : step >= 2 ? "connecting" : "disconnected"}`} />
              </div>
              {connected && (
                <div style={{ marginTop: ".75rem", padding: ".65rem .85rem", background: "rgba(0,255,234,.06)", border: "1px solid rgba(0,255,234,.15)", borderRadius: "var(--r-sm)", fontFamily: "var(--mono)", fontSize: ".68rem", color: "var(--accent)", display: "flex", alignItems: "center", gap: ".35rem" }}>
                  <CheckCircle2 size={13} /> P2P conectado — pronto para receber
                </div>
              )}
              <div style={{ marginTop: "1rem", fontFamily: "var(--mono)", fontSize: ".63rem", color: "var(--muted)", lineHeight: 1.7, background: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: ".75rem .85rem" }}>
                <div style={{ marginBottom: ".35rem", color: "var(--text)", fontWeight: 700 }}>Fluxo</div>
                {flowItems.map((s, i) => {
                  const done = connected ? true : (i === 0 && step >= 2) || (i === 1 && step >= 2) || (i === 2 && step >= 3);
                  const active = !done && ((i === 0 && step === 1) || (i === 2 && step === 2) || (i === 3 && step === 3 && !connected));
                  return (
                    <div key={i} style={{ display: "flex", gap: ".5rem", alignItems: "center", marginBottom: ".2rem" }}>
                      {done ? <Check size={11} style={{ color: "var(--accent)", flexShrink: 0 }} /> : active ? <ChevronRight size={11} style={{ color: "var(--amber)", flexShrink: 0 }} /> : <Circle size={10} style={{ color: "var(--dim)", flexShrink: 0 }} />}
                      <span style={{ color: done ? "var(--accent)" : active ? "var(--text)" : "var(--dim)" }}>{s}</span>
                    </div>
                  );
                })}
              </div>
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
  const urlCode = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("code") || "";
  }, []);

  const [screen, setScreen] = useState(() => urlCode ? "receive" : "lobby");
  const [myName, setMyName] = useState(() => localStorage.getItem("fb-name") || randomName());
  const [toasts, setToasts] = useState([]);
  const [autoCode] = useState(urlCode);

  const addToast = useCallback((msg, type = "info") => {
    const id = uid();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);

  const goSend = (name) => { setMyName(name); localStorage.setItem("fb-name", name); setScreen("send"); };
  const goReceive = (name) => { setMyName(name); localStorage.setItem("fb-name", name); setScreen("receive"); };
  const goBack = () => {
    setScreen("lobby");
    window.history.replaceState({}, "", window.location.pathname);
  };

  return (
    <>
      {screen === "lobby" && <Lobby onSend={goSend} onReceive={goReceive} />}
      {screen === "send" && <SenderScreen myName={myName} onBack={goBack} addToast={addToast} />}
      {screen === "receive" && <ReceiverScreen myName={myName} onBack={goBack} addToast={addToast} autoCode={autoCode} />}
      <Toasts list={toasts} />
    </>
  );
}