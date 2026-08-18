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

    function apply(ctx) {
      const call = async (method, args = {}) => result(await ctx.connection.rpc.call("/dsh-chat", method, { args }));
      const definition = {
        kind: "dsh-chat-room",
        target: "chat",
        match(event) {
          return event.type === "chat/room-link" ? { id: String(event.data.roomId), role: "start" } : null;
        },
        start(_context, match) {
          return { roomId: String(match.event.data.roomId), name: String(match.event.data.name), remote: Boolean(match.event.data.remote) };
        },
        update(context) { return context.state; },
        publication: () => "immediate",
        buildViewNode(context) {
          if (!context.state) return null;
          return {
            key: context.key,
            kind: "dsh-chat-room",
            id: context.id,
            target: "chat",
            anchorSeq: context.start?.event.seq ?? 0,
            location: context.start?.location ?? { kind: "unresolved" },
            visibility: "visible",
            data: context.state
          };
        }
      };
      ctx.conversationEvents.register(definition);

      function RoomTimeline({ node }) {
        const room = node.data;
        const [messages, setMessages] = React.useState([]);
        const [members, setMembers] = React.useState([]);
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
        const input = { minWidth: 0, padding: "7px 9px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, background: "var(--dsw-alias-bg-layer-1)", color: "inherit" };
        const form = { display: "flex", gap: 8, marginTop: 10 };
        return h("section", { style: { width: "100%", padding: "8px 0 18px" } },
          h("header", { style: { marginBottom: 18 } },
            h("h2", { style: { margin: 0, fontSize: 20 } }, room.name),
            h("small", null, `${members.length} member${members.length === 1 ? "" : "s"}${room.remote ? " · remote room" : ""}`)
          ),
          error && h("p", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)" } }, error),
          messages.map((message) => h("article", { key: message.id, style: { marginBottom: 16 } },
            h("small", null, `${message.author} · ${new Date(message.sentAt).toLocaleTimeString()}`),
            h("div", { style: { whiteSpace: "pre-wrap", marginTop: 4 } }, message.text)
          )),
          messages.length === 0 && h("p", { style: { opacity: 0.65 } }, "No messages yet."),
          h("details", { style: { marginTop: 24 } },
            h("summary", { style: { cursor: "pointer" } }, "Room members"),
            h("form", { onSubmit: addMember, style: form }, h("input", { value: memberId, onChange: (event) => setMemberId(event.target.value), placeholder: "Local session id", style: { ...input, flex: 1 } }), h("button", { type: "submit" }, "Add")),
            h("form", { onSubmit: addRemote, style: form }, h("input", { value: remoteSessionId, onChange: (event) => setRemoteSessionId(event.target.value), placeholder: "Remote session id", style: { ...input, flex: 1 } }), h("input", { value: remoteTicket, onChange: (event) => setRemoteTicket(event.target.value), placeholder: "Iroh ticket", style: { ...input, flex: 1 } }), h("button", { type: "submit" }, "Add remote"))
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
        return h("div", { style: { width: "min(780px, calc(100% - 24px))", margin: "0 auto", padding: "10px 0" } },
          error && h("small", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)" } }, error),
          h("form", { onSubmit: send, style: { display: "flex", gap: 8, padding: 10, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, background: "var(--dsw-alias-bg-layer-1)" } },
            h("input", { value: draft, onChange: (event) => setDraft(event.target.value), placeholder: `Message ${matched.name}; use @session-id or @all to notify agents`, style: { flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent", color: "inherit" } }),
            h("button", { type: "submit", disabled: sending || !draft.trim() }, sending ? "Sending…" : "Send")
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
