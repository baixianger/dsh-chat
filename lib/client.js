window.__ModuleLoader__.load({
  id: "dsh-chat",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const inject = ["slots", "connection"];

    function result(value) {
      if (!value?.ok) throw new Error(value?.error?.message ?? "DSH Chat request failed");
      return value.value;
    }

    function apply(ctx) {
      const call = async (method, args = {}) => result(await ctx.connection.rpc.call("/dsh-chat", method, { args }));
      function GroupChatView({ sessionId }) {
        const [rooms, setRooms] = React.useState([]);
        const [activeId, setActiveId] = React.useState(null);
        const [messages, setMessages] = React.useState([]);
        const [roomName, setRoomName] = React.useState("");
        const [memberId, setMemberId] = React.useState("");
        const [draft, setDraft] = React.useState("");
        const [error, setError] = React.useState("");
        const refreshRooms = React.useCallback(async () => {
          try { const next = await call("listRooms"); setRooms(next); setActiveId((current) => current ?? next[0]?.id ?? null); }
          catch (cause) { setError(String(cause.message ?? cause)); }
        }, []);
        React.useEffect(() => { void refreshRooms(); }, [refreshRooms]);
        React.useEffect(() => {
          if (!activeId) { setMessages([]); return; }
          void call("messages", { roomId: activeId, limit: 200 }).then(setMessages).catch((cause) => setError(String(cause.message ?? cause)));
        }, [activeId]);
        const createRoom = async (event) => {
          event.preventDefault(); if (!roomName.trim()) return;
          try { const room = await call("createRoom", { request: { name: roomName, members: [{ kind: "session", sessionId }] } }); setRoomName(""); await refreshRooms(); setActiveId(room.id); }
          catch (cause) { setError(String(cause.message ?? cause)); }
        };
        const addMember = async (event) => {
          event.preventDefault(); if (!activeId || !memberId.trim()) return;
          try { await call("addMember", { roomId: activeId, member: { kind: "session", sessionId: memberId } }); setMemberId(""); await refreshRooms(); }
          catch (cause) { setError(String(cause.message ?? cause)); }
        };
        const send = async (event) => {
          event.preventDefault(); if (!activeId || !draft.trim()) return;
          try { const message = await call("send", { request: { roomId: activeId, author: sessionId, text: draft } }); setDraft(""); setMessages((current) => [...current, message]); await refreshRooms(); }
          catch (cause) { setError(String(cause.message ?? cause)); }
        };
        const active = rooms.find((room) => room.id === activeId);
        const style = { root: { display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", height: "100%", minHeight: 0, fontFamily: "var(--dsw-font-family, system-ui)" }, sidebar: { borderRight: "1px solid var(--dsw-alias-border-l2)", padding: 12, overflow: "auto" }, main: { display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }, messages: { flex: 1, overflow: "auto", padding: 18 }, form: { display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--dsw-alias-border-l2)" }, input: { flex: 1, minWidth: 0, padding: "8px 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, background: "var(--dsw-alias-bg-layer-1)", color: "inherit" }, button: { padding: "7px 10px", border: 0, borderRadius: 6, cursor: "pointer" }, room: { width: "100%", textAlign: "left", padding: "8px 9px", border: 0, borderRadius: 5, marginBottom: 3, cursor: "pointer", color: "inherit", background: "transparent" } };
        return h("div", { style: style.root },
          h("aside", { style: style.sidebar },
            h("strong", null, "Group Chat"),
            h("form", { onSubmit: createRoom, style: { ...style.form, padding: "10px 0", borderTop: 0, flexDirection: "column" } }, h("input", { value: roomName, onChange: (event) => setRoomName(event.target.value), placeholder: "New room", style: style.input }), h("button", { type: "submit", style: style.button }, "Create room")),
            rooms.map((room) => h("button", { key: room.id, onClick: () => setActiveId(room.id), style: { ...style.room, background: room.id === activeId ? "var(--dsw-alias-interactive-bg-active)" : "transparent" } }, `${room.name} · ${room.messageCount}`))
          ),
          h("section", { style: style.main },
            h("header", { style: { padding: "12px 16px", borderBottom: "1px solid var(--dsw-alias-border-l2)" } }, active ? active.name : "Choose or create a room"),
            h("div", { style: style.messages }, error && h("p", { style: { color: "var(--dsw-alias-state-error-primary)" } }, error), messages.map((message) => h("article", { key: message.id, style: { marginBottom: 14 } }, h("small", null, `${message.author} · ${new Date(message.sentAt).toLocaleTimeString()}`), h("div", { style: { whiteSpace: "pre-wrap", marginTop: 3 } }, message.text))), active && messages.length === 0 && h("p", null, "No messages yet.")),
            active && h("form", { onSubmit: addMember, style: { ...style.form, borderTop: "1px solid var(--dsw-alias-border-l1)" } }, h("input", { value: memberId, onChange: (event) => setMemberId(event.target.value), placeholder: "Add local session id", style: style.input }), h("button", { type: "submit", style: style.button }, "Add")),
            active && h("form", { onSubmit: send, style: style.form }, h("input", { value: draft, onChange: (event) => setDraft(event.target.value), placeholder: "Message the room", style: style.input }), h("button", { type: "submit", style: style.button }, "Send"))
          )
        );
      }
      ctx.slots.inject("conversation.view", () => ctx.slots.register({ name: "conversation.view", id: "group-chat", order: 20, label: () => "Group Chat", inject: (sessionId) => ({ sessionId: String(sessionId) }) }, GroupChatView));
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
