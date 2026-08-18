window.__ModuleLoader__.load({
  id: "dsh-chat",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const inject = ["slots", "connection", "conversationEvents"];

    function result(value) {
      if (!value?.ok) throw new Error(value?.error?.message ?? "DSH Chat request failed");
      return value.value;
    }

    function roomNode(owner) {
      const nodes = owner.session?.chat?.nodes?.values?.() ?? [];
      return nodes.find((node) => node.kind === "dsh-chat-room") ?? null;
    }

    function initials(value) {
      const words = String(value).replace(/^session-/, "").split(/[-_\s]+/).filter(Boolean);
      const letters = words.map((word) => word.match(/[a-z]/i)?.[0]).filter(Boolean);
      return (letters.length > 1 ? `${letters[0]}${letters[1]}` : words[0]?.slice(0, 2) ?? "?").toUpperCase();
    }

    function displayName(value) {
      const id = String(value);
      if (id.startsWith("dsh-chat-room-")) return "You";
      if (id.startsWith("session-")) return `Session ${id.slice(8, 12)}`;
      return id;
    }

    function identityColor(value) {
      let hash = 0;
      for (const character of String(value)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
      const hue = Math.abs(hash) % 360;
      return { background: `hsl(${hue} 58% 92%)`, color: `hsl(${hue} 46% 32%)` };
    }

    function Avatar({ id, label, size = 34, remote = false, title }) {
      return h("span", {
        title: title ?? id,
        "aria-label": title ?? id,
        style: {
          ...identityColor(id), width: size, height: size, flex: `0 0 ${size}px`, borderRadius: "50%",
          display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: Math.max(10, Math.round(size * 0.34)),
          fontWeight: 650, letterSpacing: "0.02em", border: "2px solid var(--dsw-alias-bg-layer-1, #fff)",
          boxShadow: remote ? "0 0 0 1px var(--dsw-alias-color-primary, #4b6bfb)" : "0 0 0 1px rgba(0,0,0,.06)"
        }
      }, initials(label ?? id));
    }

    function GearIcon() {
      return h("svg", { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true },
        h("circle", { cx: 12, cy: 12, r: 3 }),
        h("path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.5v-.1A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 3.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2V9.5h.1A1.7 1.7 0 0 0 3.6 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.06 3.2l.06.06A1.7 1.7 0 0 0 8 3.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2h4.1v.1A1.7 1.7 0 0 0 15 3.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.1h-.1A1.7 1.7 0 0 0 19.4 15Z" })
      );
    }

    function apply(ctx) {
      const call = async (method, args = {}) => result(await ctx.connection.rpc.call("/dsh-chat", method, { args }));
      const definition = {
        kind: "dsh-chat-room",
        target: "chat",
        match(event) { return event.type === "chat/room-link" ? { id: String(event.data.roomId), role: "start" } : null; },
        start(_context, match) { return { roomId: String(match.event.data.roomId), name: String(match.event.data.name), remote: Boolean(match.event.data.remote) }; },
        update(context) { return context.state; },
        publication: () => "immediate",
        buildViewNode(context) {
          if (!context.state) return null;
          return { key: context.key, kind: "dsh-chat-room", id: context.id, target: "chat", anchorSeq: context.start?.event.seq ?? 0, location: context.start?.location ?? { kind: "unresolved" }, visibility: "visible", data: context.state };
        }
      };
      ctx.conversationEvents.register(definition);

      function RoomTimeline({ node }) {
        const room = node.data;
        const [messages, setMessages] = React.useState([]);
        const [members, setMembers] = React.useState([]);
        const [settingsOpen, setSettingsOpen] = React.useState(false);
        const [memberId, setMemberId] = React.useState("");
        const [remoteSessionId, setRemoteSessionId] = React.useState("");
        const [remoteTicket, setRemoteTicket] = React.useState("");
        const [error, setError] = React.useState("");
        const refreshRoom = React.useCallback(async () => {
          const rooms = await call("listRooms");
          const current = rooms.find((item) => item.id === room.roomId);
          setMembers(current?.members ?? []);
        }, [room.roomId]);
        React.useEffect(() => {
          let stopped = false;
          const poll = async () => {
            while (!stopped) {
              try {
                const next = await call("messages", { roomId: room.roomId, limit: 200, waitMs: room.remote ? 25_000 : 0 });
                if (!stopped) { setMessages(next); setError(""); }
                if (!room.remote) await new Promise((resolve) => setTimeout(resolve, 1_000));
              } catch (cause) {
                if (!stopped) { setError(String(cause.message ?? cause)); await new Promise((resolve) => setTimeout(resolve, 1_000)); }
              }
            }
          };
          void refreshRoom().catch((cause) => setError(String(cause.message ?? cause)));
          void poll();
          return () => { stopped = true; };
        }, [room.roomId, room.remote, refreshRoom]);
        const addMember = async (event) => {
          event.preventDefault(); if (!memberId.trim()) return;
          try { await call("addMember", { roomId: room.roomId, member: { kind: "session", sessionId: memberId } }); setMemberId(""); await refreshRoom(); }
          catch (cause) { setError(String(cause.message ?? cause)); }
        };
        const addRemote = async (event) => {
          event.preventDefault(); if (!remoteSessionId.trim() || !remoteTicket.trim()) return;
          try { await call("addMember", { roomId: room.roomId, member: { kind: "weave", sessionId: remoteSessionId, ticket: remoteTicket } }); setRemoteSessionId(""); setRemoteTicket(""); await refreshRoom(); }
          catch (cause) { setError(String(cause.message ?? cause)); }
        };
        const field = { width: "100%", boxSizing: "border-box", padding: "9px 11px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 9, background: "var(--dsw-alias-bg-layer-1, #fff)", color: "inherit", outline: 0 };
        const quietButton = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 34, padding: "0 10px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 9, background: "var(--dsw-alias-bg-layer-1, #fff)", color: "inherit", cursor: "pointer" };
        return h("section", { style: { width: "min(780px, calc(100% - 32px))", margin: "0 auto", padding: "24px 0 36px" } },
          h("header", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, marginBottom: 32 } },
            h("div", { style: { minWidth: 0 } },
              h("h2", { style: { margin: "0 0 8px", fontSize: 21, lineHeight: 1.25, fontWeight: 680, letterSpacing: "-0.015em" } }, room.name),
              h("div", { style: { display: "flex", alignItems: "center", minHeight: 28 } },
                h("div", { "aria-label": `${members.length} room members`, style: { display: "flex", paddingLeft: members.length ? 3 : 0 } },
                  members.slice(0, 5).map((member, index) => h("span", { key: `${member.kind}:${member.sessionId}`, style: { display: "inline-flex", marginLeft: index ? -8 : 0, zIndex: 10 - index } }, h(Avatar, { id: member.sessionId, size: 28, remote: member.kind === "weave" }))),
                  members.length > 5 && h("span", { style: { width: 28, height: 28, marginLeft: -8, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--dsw-alias-bg-layer-2, #f1f2f4)", border: "2px solid var(--dsw-alias-bg-layer-1, #fff)", fontSize: 10, fontWeight: 650 } }, `+${members.length - 5}`)
                ),
                h("span", { style: { marginLeft: 10, color: "var(--dsw-alias-text-secondary, #777)", fontSize: 13 } }, `${members.length} member${members.length === 1 ? "" : "s"}${room.remote ? " · woven" : ""}`)
              )
            ),
            h("button", { type: "button", onClick: () => setSettingsOpen(true), style: quietButton, "aria-label": "Room settings" }, h(GearIcon), h("span", null, "Settings"))
          ),
          error && h("p", { role: "alert", style: { padding: "10px 12px", borderRadius: 9, background: "rgba(210,48,48,.08)", color: "var(--dsw-alias-state-error-primary, #b42318)", fontSize: 13 } }, error),
          h("div", { "aria-label": "Room messages", style: { display: "grid", gap: 22 } },
            messages.map((message) => h("article", { key: message.id, style: { display: "grid", gridTemplateColumns: "38px minmax(0,1fr)", gap: 12, alignItems: "start" } },
              h(Avatar, { id: message.author, label: displayName(message.author), size: 36, title: message.author }),
              h("div", { style: { minWidth: 0, paddingTop: 1 } },
                h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 } },
                  h("strong", { title: message.author, style: { fontSize: 14, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, displayName(message.author)),
                  h("time", { dateTime: new Date(message.sentAt).toISOString(), style: { flex: "0 0 auto", color: "var(--dsw-alias-text-tertiary, #999)", fontSize: 11 } }, new Date(message.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
                ),
                h("div", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.55, fontSize: 15 } }, message.text)
              )
            )),
            messages.length === 0 && h("div", { style: { padding: "48px 20px", textAlign: "center", color: "var(--dsw-alias-text-secondary, #777)" } }, h("p", { style: { margin: "0 0 5px", fontWeight: 600, color: "inherit" } }, "Start the conversation"), h("small", null, "Messages stay quiet until you mention a session."))
          ),
          settingsOpen && h("div", { role: "presentation", style: { position: "fixed", inset: 0, zIndex: 100, background: "rgba(18,20,24,.22)", display: "flex", justifyContent: "flex-end" } },
            h("aside", { role: "dialog", "aria-modal": true, "aria-label": "Room settings", style: { width: "min(420px, 92vw)", height: "100%", boxSizing: "border-box", padding: 24, overflow: "auto", background: "var(--dsw-alias-bg-layer-1, #fff)", boxShadow: "-12px 0 36px rgba(0,0,0,.12)" } },
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 26 } },
                h("div", null, h("h3", { style: { margin: "0 0 3px", fontSize: 18 } }, "Room settings"), h("small", { style: { color: "var(--dsw-alias-text-secondary, #777)" } }, room.name)),
                h("button", { type: "button", onClick: () => setSettingsOpen(false), style: { ...quietButton, width: 34, padding: 0 }, "aria-label": "Close room settings" }, "×")
              ),
              h("section", { style: { marginBottom: 28 } },
                h("h4", { style: { margin: "0 0 12px", fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--dsw-alias-text-secondary, #777)" } }, "Members"),
                h("div", { style: { display: "grid", gap: 9 } }, members.map((member) => h("div", { key: `${member.kind}:${member.sessionId}`, style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 9px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2, #f6f7f8)" } }, h(Avatar, { id: member.sessionId, size: 32, remote: member.kind === "weave" }), h("div", { style: { minWidth: 0 } }, h("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 } }, member.sessionId), h("small", { style: { color: "var(--dsw-alias-text-secondary, #777)" } }, member.kind === "weave" ? "Remote via Weave" : "Local session"))))),
                members.length === 0 && h("small", { style: { color: "var(--dsw-alias-text-secondary, #777)" } }, "No members yet.")
              ),
              h("section", { style: { marginBottom: 28 } },
                h("h4", { style: { margin: "0 0 10px", fontSize: 14 } }, "Add local session"),
                h("form", { onSubmit: addMember, style: { display: "flex", gap: 8 } }, h("input", { value: memberId, onChange: (event) => setMemberId(event.target.value), placeholder: "Session id", style: { ...field, flex: 1 } }), h("button", { type: "submit", style: quietButton }, "Add"))
              ),
              h("section", null,
                h("h4", { style: { margin: "0 0 4px", fontSize: 14 } }, "Add remote session"),
                h("p", { style: { margin: "0 0 10px", color: "var(--dsw-alias-text-secondary, #777)", fontSize: 12, lineHeight: 1.45 } }, "Connect a trusted session through its Weave ticket."),
                h("form", { onSubmit: addRemote, style: { display: "grid", gap: 8 } }, h("input", { value: remoteSessionId, onChange: (event) => setRemoteSessionId(event.target.value), placeholder: "Remote session id", style: field }), h("input", { value: remoteTicket, onChange: (event) => setRemoteTicket(event.target.value), placeholder: "Weave ticket", style: field }), h("button", { type: "submit", style: { ...quietButton, justifySelf: "start" } }, "Add remote"))
              )
            )
          )
        );
      }

      function RoomComposer({ matched, sessionId }) {
        const [draft, setDraft] = React.useState("");
        const [sending, setSending] = React.useState(false);
        const [error, setError] = React.useState("");
        const send = async (event) => {
          event.preventDefault(); if (!draft.trim() || sending) return;
          setSending(true);
          try {
            const mentions = [...new Set(Array.from(draft.matchAll(/@([A-Za-z0-9_-]+)/g), (match) => match[1]))];
            await call("send", { request: { roomId: matched.roomId, author: String(sessionId), text: draft, mentions } });
            setDraft(""); setError("");
          } catch (cause) { setError(String(cause.message ?? cause)); }
          finally { setSending(false); }
        };
        return h("div", { style: { width: "min(780px, calc(100% - 32px))", margin: "0 auto", padding: "10px 0 18px" } },
          error && h("small", { role: "alert", style: { display: "block", margin: "0 12px 7px", color: "var(--dsw-alias-state-error-primary, #b42318)" } }, error),
          h("form", { onSubmit: send, style: { padding: "12px 12px 9px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 19, background: "var(--dsw-alias-bg-layer-1, #fff)", boxShadow: "0 2px 8px rgba(0,0,0,.035), 0 12px 26px rgba(0,0,0,.035)" } },
            h("textarea", { value: draft, onChange: (event) => setDraft(event.target.value), rows: 2, placeholder: `Message ${matched.name}`, style: { width: "100%", minHeight: 44, maxHeight: 160, resize: "vertical", boxSizing: "border-box", padding: "2px 4px 8px", border: 0, outline: 0, background: "transparent", color: "inherit", font: "inherit", lineHeight: 1.45 } }),
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
              h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--dsw-alias-text-secondary, #777)", fontSize: 12 } }, h("span", { style: { width: 25, height: 25, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--dsw-alias-bg-layer-2, #f2f3f5)", fontWeight: 650 } }, "@"), "Mention a session to notify it"),
              h("button", { type: "submit", disabled: sending || !draft.trim(), "aria-label": "Send room message", style: { width: 36, height: 36, border: 0, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: draft.trim() && !sending ? "var(--dsw-alias-color-primary, #7289f5)" : "var(--dsw-alias-bg-layer-3, #e7e8eb)", color: draft.trim() && !sending ? "#fff" : "var(--dsw-alias-text-tertiary, #aaa)", cursor: draft.trim() && !sending ? "pointer" : "default", fontSize: 19, transition: "transform .15s ease, background .15s ease" } }, sending ? "…" : "↑")
            )
          )
        );
      }

      ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key: "dsh-chat-room" }, RoomTimeline));
      ctx.slots.inject("conversation.composer", () => ctx.slots.register({
        name: "conversation.composer",
        priority: -20,
        select: (owner) => {
          const node = roomNode(owner);
          return node ? { roomId: node.data.roomId, name: node.data.name } : null;
        }
      }, RoomComposer));
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
