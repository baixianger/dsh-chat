window.__ModuleLoader__.load({
  id: "dsh-chat",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const inject = ["slots", "connection", "uiConversation", "sessions", "workspaces", "locale"];
    const NS = "dsh-chat";
    const dictionaries = {
  "zh": {
    "you": "你",
    "session": "会话",
    "idle": "空闲",
    "running": "运行中",
    "waking": "唤醒中…",
    "offline": "离线",
    "hostOffline": "主机离线",
    "archived": "已归档",
    "missing": "不存在",
    "connecting": "连接中…",
    "unknown": "未知",
    "thisHost": "本机",
    "roomSettings": "聊天设置",
    "settings": "设置",
    "roomMessages": "聊天消息",
    "startConversation": "开始聊天",
    "quietHint": "提及某个会话后，它才会收到通知。",
    "closeSettings": "关闭聊天设置",
    "members": "成员",
    "removeMember": "移出聊天",
    "noMembers": "尚未添加成员。",
    "addSession": "添加会话",
    "addHint": "依次选择主机、工作区和会话。已归档的工作区和会话不会显示。",
    "lookingHosts": "正在查找配对主机…",
    "host": "主机",
    "workspace": "工作区",
    "remote": "远程",
    "searchSessions": "搜索此工作区中的会话",
    "availableSessions": "可添加的会话",
    "noMatching": "没有匹配的会话。",
    "allMembers": "此工作区的所有会话都已加入。",
    "noWorkspaces": "暂无包含会话的活跃工作区。",
    "noRemote": "暂无可连接的远程主机，请前往设置 → Weave 配对。",
    "mentionSession": "提及会话",
    "mentionHint": "提及会话以发送通知",
    "send": "发送聊天消息",
    "message": "发送消息至",
    "roomMembers": "位成员",
    "woven": "跨主机",
    "mention": "提及",
    "loadingMessages": "正在读取聊天记录…",
    "working": "处理中…",
    "hostMembership": "成员由此聊天的主机管理。"
  },
  "en": {
    "you": "You",
    "session": "Session",
    "idle": "Idle",
    "running": "Running",
    "waking": "Waking…",
    "offline": "Offline",
    "hostOffline": "Host offline",
    "archived": "Archived",
    "missing": "Missing",
    "connecting": "Connecting…",
    "unknown": "Unknown",
    "thisHost": "This host",
    "roomSettings": "Room settings",
    "settings": "Settings",
    "roomMessages": "Room messages",
    "startConversation": "Start the conversation",
    "quietHint": "Messages stay quiet until you mention a session.",
    "closeSettings": "Close room settings",
    "members": "Members",
    "removeMember": "Remove from room",
    "noMembers": "No members yet.",
    "addSession": "Add session",
    "addHint": "Choose a host, then a workspace, then a session. Archived workspaces and sessions stay hidden.",
    "lookingHosts": "Looking for paired hosts…",
    "host": "Host",
    "workspace": "Workspace",
    "remote": "Remote",
    "searchSessions": "Search sessions in this workspace",
    "availableSessions": "Available sessions",
    "noMatching": "No matching sessions.",
    "allMembers": "All sessions in this workspace are already members.",
    "noWorkspaces": "No active workspaces with sessions.",
    "noRemote": "No remote hosts are reachable. Pair hosts in Settings → Weave.",
    "mentionSession": "Mention a session",
    "mentionHint": "Mention a session to notify it",
    "send": "Send room message",
    "message": "Message",
    "roomMembers": "room members",
    "woven": "Woven",
    "mention": "Mention",
    "loadingMessages": "Loading messages…",
    "working": "Working…",
    "hostMembership": "Membership is managed by this room’s host."
  }
};
    /** Host route the room UI posts to; under `/api`, the path Connection fences. */
    const SETTINGS_PATH = "/api/dsh-chat";

    function result(value) {
      if (!value?.ok) throw new Error(value?.error?.message ?? "DSH Chat request failed");
      return value.value;
    }

    /**
     * Post one endpoint to the host's `/api/dsh-chat` Fetch route.
     *
     * The route lives under `/api`, the single path Connection mounts and fences
     * for browser callers, and answers an `{ ok, value | error }` envelope; a
     * per-plugin RPC channel is not served by this deployment. The envelope is
     * returned whole because `result` owns unwrapping it.
     */
    async function postSettings(endpoint, args, signal) {
      const response = await fetch(SETTINGS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]),
        body: JSON.stringify({ endpoint, args })
      });
      if (!response.ok) throw new Error(`DSH Chat request failed: HTTP ${response.status}`);
      const envelope = await response.json();
      if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? "DSH Chat request failed");
      return envelope;
    }

    /**
     * Resolve the room node for one conversation owner.
     *
     * On the current client the chat nodes live in the Session's `chat`
     * Conversation view target, reached through the Conversation binding;
     * older runtimes published them on the Session snapshot itself, which
     * stays as the fallback.
     */
    function roomNode(ctx, owner) {
      const sessionId = owner?.sessionId;
      if (typeof sessionId === "string") {
        let nodes;
        try {
          nodes = ctx.uiConversation?.binding?.(sessionId)?.target?.("chat")?.getSnapshot?.()?.nodes;
        } catch {
          // binding() throws until the client has loaded that Session; fall through to the legacy shape.
          nodes = undefined;
        }
        const node = Array.isArray(nodes) ? nodes.find((item) => item.kind === "dsh-chat-room") : undefined;
        if (node) return node;
      }
      const legacy = owner?.session?.chat?.nodes?.values?.() ?? [];
      const legacyNodes = Array.isArray(legacy) ? legacy : [];
      return legacyNodes.find((node) => node.kind === "dsh-chat-room") ?? null;
    }

    function initials(value) {
      const words = String(value).replace(/^session-/, "").split(/[-_\s]+/).filter(Boolean);
      const letters = words.map((word) => word.match(/[a-z]/i)?.[0]).filter(Boolean);
      return (letters.length > 1 ? `${letters[0]}${letters[1]}` : words[0]?.slice(0, 2) ?? "?").toUpperCase();
    }

    function memberReference(member) {
      return member.kind === "remote"
        ? `remote:${encodeURIComponent(member.hostId)}:${encodeURIComponent(member.sessionId)}`
        : `session:${encodeURIComponent(member.sessionId)}`;
    }

    function runtimeState(value) {
      return value?.state ?? (value?.running === true ? "idle" : value?.running === false ? "offline" : "unknown");
    }

    function stateColor(state) {
      if (state === "idle") return "var(--dsw-alias-state-success-primary)";
      if (state === "running" || state === "waking" || state === "connecting") return "var(--dsw-alias-state-business-primary)";
      if (state === "offline" || state === "host-offline") return "var(--dsw-alias-label-tertiary)";
      return "var(--dsw-alias-label-tertiary)";
    }

    function identityColor(value) {
      let hash = 0;
      for (const character of String(value)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
      const tones = ["var(--dsw-alias-state-business-primary)", "var(--dsw-alias-state-success-primary)", "var(--dsw-alias-state-warn-primary)", "var(--dsw-alias-label-secondary)"];
      const color = tones[Math.abs(hash) % tones.length];
      return { background: `color-mix(in srgb, ${color} 12%, var(--dsw-alias-bg-layer-1))`, color };
    }

    function Avatar({ id, label, size = 34, remote = false, title }) {
      return h("span", {
        title: title ?? id,
        "aria-label": title ?? id,
        style: {
          ...identityColor(id), width: size, height: size, flex: `0 0 ${size}px`, borderRadius: "50%",
          display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: Math.max(10, Math.round(size * 0.34)),
          fontWeight: 500, letterSpacing: "0.02em", border: "2px solid var(--dsw-alias-bg-layer-1)",
          boxShadow: remote ? "0 0 0 1px var(--dsw-alias-state-business-primary)" : "0 0 0 1px var(--dsw-alias-border-l1)"
        }
      }, initials(label ?? id));
    }

    function GearIcon() {
      return h("svg", { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true },
        h("circle", { cx: 12, cy: 12, r: 3 }),
        h("path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.5v-.1A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 3.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2V9.5h.1A1.7 1.7 0 0 0 3.6 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.06 3.2l.06.06A1.7 1.7 0 0 0 8 3.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2h4.1v.1A1.7 1.7 0 0 0 15 3.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.1h-.1A1.7 1.7 0 0 0 19.4 15Z" })
      );
    }

    function ensureStyles() {
      if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="dsh-chat/controls"]')) return;
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-chat";
      style.dataset.pluginCss = "dsh-chat/controls";
      style.textContent = `
        .dshChatField { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
        .dshChatControl { box-sizing: border-box; width: 100%; height: 44px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background-color: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 0 12px; font: inherit; font-size: 14px; line-height: 22px; outline: none; }
        .dshChatControl::placeholder { color: var(--dsw-alias-label-tertiary); }
        .dshChatControl:focus-visible { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); }
        .dshChatControl:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; opacity: .6; }
        select.dshChatControl { appearance: auto; cursor: pointer; padding-right: 12px; font-weight: 500; }
        .dshChatSearch { height: 40px; }
        .dshChatQuietButton { box-sizing: border-box; min-height: 36px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px; background: transparent; color: var(--dsw-alias-label-primary); padding: 0 14px; font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
        .dshChatRoom button:disabled { opacity: .45; cursor: default; }
        .dshChatRoom :is(button,textarea):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
        .dshChatQuietButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
        .dshChatQuietButton:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
        .dshChatComposer { border-color: var(--dsw-alias-border-l2); transition: border-color .15s, box-shadow .15s; }
        .dshChatComposer:focus-within { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent), var(--dsw-shadow-lv1); }
        .dshChatComposer textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
        :has(> * > [data-slot="conversation.chat.node"] > [data-dsh-chat-room-timeline]) > *:not(:has([data-dsh-chat-room-timeline])) { display: none !important; }
        @media (prefers-reduced-motion: reduce) { .dshChatComposer { transition: none; } }
      `;
      document.head.appendChild(style);
      return () => style.remove();
    }

    function apply(ctx) {
      ctx.effect(ensureStyles, `${NS}: styles`);
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, dictionaries), `${NS}: dictionaries`);
    function displayName(value) {
      const id = String(value);
      if (id.startsWith("dsh-chat-room-")) return t("you");
      if (id.startsWith("session-")) return `${t("session")} ${id.slice(8, 12)}`;
      return id;
    }

    function stateLabel(state) {
      return t(({ idle: "idle", running: "running", waking: "waking", offline: "offline", "host-offline": "hostOffline", archived: "archived", missing: "missing", connecting: "connecting" })[state] ?? "unknown");
    }


      const call = async (method, args = {}, signal) => result(await postSettings(method, args, signal));
      const readWorkspaceRows = () => {
        const sessionList = ctx.sessions.list.getSnapshot();
        const workspaceList = ctx.workspaces.list.getSnapshot();
        const archived = new Set(workspaceList.archivedSessionIds ?? []);
        return (workspaceList.items ?? []).filter((workspace) => workspace.archived !== true && workspace.title !== "Chatrooms" && !String(workspace.path ?? "").endsWith("/Chatrooms")).map((workspace) => ({
          id: String(workspace.workspaceId), title: workspace.title, path: workspace.path,
          sessions: workspace.sessionIds.map((id) => sessionList.byId[id]).filter((session) => session && !archived.has(session.id) && !String(session.id).startsWith("dsh-chat-room-"))
        })).filter((workspace) => workspace.sessions.length > 0);
      };
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
      ctx.effect(() => ctx.uiConversation.events.register(definition), "dsh-chat: room node definition");

      function RoomTimeline({ node }) {
        const room = node.data;
        const [messages, setMessages] = React.useState([]);
        const [loaded, setLoaded] = React.useState(false);
        const [memberBusy, setMemberBusy] = React.useState(false);
        const action = React.useRef(null);
        const dialog = React.useRef(null);
        const [members, setMembers] = React.useState([]);
        const [workspaceRows, setWorkspaceRows] = React.useState(readWorkspaceRows);
        const [sourceHostId, setSourceHostId] = React.useState("local");
        const [workspaceId, setWorkspaceId] = React.useState("");
        const [sessionQuery, setSessionQuery] = React.useState("");
        const [remoteHosts, setRemoteHosts] = React.useState([]);
        const [remoteLoading, setRemoteLoading] = React.useState(false);
        const [settingsOpen, setSettingsOpen] = React.useState(false);
        const [error, setError] = React.useState("");
        const refreshRoom = React.useCallback(async (signal) => {
          const rooms = await call("listRooms", {}, signal);
          if (!signal.aborted) setMembers(rooms.find((item) => item.id === room.roomId)?.members ?? []);
        }, [room.roomId]);
        React.useEffect(() => {
          const controller = new AbortController(); const signal = controller.signal;
          let timer; let firstRead = true;
          setMessages([]); setLoaded(false);
          const poll = async () => {
            let delay = room.remote ? 100 : 1_000;
            try {
              const next = await call("messages", { roomId: room.roomId, limit: 200, waitMs: room.remote && !firstRead ? 25_000 : 0 }, signal);
              firstRead = false;
              if (!signal.aborted) { setMessages(next); setLoaded(true); await refreshRoom(signal); }
            } catch (cause) {
              delay = 2_000;
              if (!signal.aborted) setError(String(cause.message ?? cause));
            } finally { if (!signal.aborted) timer = setTimeout(poll, delay); }
          };
          void poll();
          return () => { controller.abort(); clearTimeout(timer); action.current?.abort(); action.current = null; };
        }, [room.roomId, room.remote, refreshRoom]);
        React.useEffect(() => {
          const refresh = () => setWorkspaceRows(readWorkspaceRows());
          refresh();
          const unsubscribeSessions = ctx.sessions.list.subscribe(refresh);
          const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(refresh);
          return () => { unsubscribeSessions(); unsubscribeWorkspaces(); };
        }, []);
        React.useEffect(() => {
          if (!settingsOpen) return;
          const controller = new AbortController(); const signal = controller.signal;
          const previousFocus = typeof document === "undefined" ? null : document.activeElement;
          dialog.current?.focus();
          setRemoteLoading(true); setMemberBusy(false);
          void call("remoteSessions", {}, signal).then((hosts) => { if (!signal.aborted) setRemoteHosts(hosts); })
            .catch((cause) => { if (!signal.aborted) setError(String(cause.message ?? cause)); })
            .finally(() => { if (!signal.aborted) setRemoteLoading(false); });
          return () => { controller.abort(); action.current?.abort(); action.current = null; previousFocus?.focus?.(); };
        }, [settingsOpen, room.roomId]);
        const changeMember = async (endpoint, member) => {
          if (action.current) return;
          const controller = new AbortController(); action.current = controller;
          setMemberBusy(true); setError("");
          try {
            await call(endpoint, { roomId: room.roomId, member }, controller.signal);
            await refreshRoom(controller.signal);
          } catch (cause) { if (!controller.signal.aborted) setError(String(cause.message ?? cause)); }
          finally { if (action.current === controller) { action.current = null; setMemberBusy(false); } }
        };
        const addMember = (session, workspace) => changeMember("addMember", { kind: "session", sessionId: String(session.id), alias: session.displayTitle ?? session.title ?? session.id, workspaceTitle: workspace?.title });
        const addRemoteSession = (host, workspace, session) => changeMember("addMember", { kind: "remote", hostId: host.hostId, hostName: host.hostName, sessionId: String(session.id), alias: session.displayTitle ?? session.title ?? session.id, workspaceTitle: workspace?.title });
        const removeMember = (member) => changeMember("removeMember", { kind: member.kind, sessionId: member.sessionId, ...(member.kind === "remote" ? { hostId: member.hostId } : {}) });
        const openSettings = () => { setSettingsOpen(true); setSourceHostId("local"); setWorkspaceId(workspaceRows[0]?.id ?? ""); };
        const dialogKeys = (event) => {
          if (event.key === "Escape") { event.preventDefault(); setSettingsOpen(false); }
          if (event.key !== "Tab") return;
          const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
          const first = controls[0]; const last = controls.at(-1);
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        const sources = [{ hostId: "local", hostName: t("thisHost"), workspaces: workspaceRows }, ...remoteHosts];
        const selectedSource = sources.find((source) => source.hostId === sourceHostId) ?? sources[0];
        const selectedWorkspace = selectedSource?.workspaces.find((workspace) => workspace.id === workspaceId) ?? selectedSource?.workspaces[0];
        const memberName = (member) => {
          const local = member.kind === "session" ? ctx.sessions.list.getSnapshot().byId[member.sessionId] : undefined;
          if (local) return local.displayTitle ?? local.title ?? member.alias ?? displayName(member.sessionId);
          const preferred = member.kind === "remote" ? sources.find((item) => item.hostId === member.hostId) : sources[0];
          const orderedSources = [preferred, ...sources].filter((source, index, items) => source && items.indexOf(source) === index);
          for (const source of orderedSources) for (const workspace of source.workspaces ?? []) {
            const session = workspace.sessions.find((item) => String(item.id) === member.sessionId);
            if (session) return session.displayTitle ?? session.title ?? displayName(member.sessionId);
          }
          return member.alias ?? displayName(member.sessionId);
        };
        const authorName = (message) => String(message.author).startsWith("dsh-chat-room-") ? t("you") : message.authorAlias ?? memberName(members.find((member) => member.sessionId === message.author && (
          message.authorHostId === undefined ? member.kind === "session" : member.kind === "remote" && member.hostId === message.authorHostId
        )) ?? { kind: "session", sessionId: message.author });
        const query = sessionQuery.trim().toLowerCase();
        const selectableSessions = (selectedWorkspace?.sessions ?? []).filter((session) => {
          const alreadyMember = selectedSource.hostId === "local"
            ? members.some((member) => member.kind === "session" && member.sessionId === String(session.id))
            : members.some((member) => member.kind === "remote" && member.hostId === selectedSource.hostId && member.sessionId === String(session.id));
          const title = session.displayTitle ?? session.title ?? session.id;
          return !alreadyMember && (!query || `${title} ${session.id}`.toLowerCase().includes(query));
        });
        return h("section", { "data-dsh-chat-room-timeline": "", className: "dshChatRoom", style: { width: "min(780px, calc(100% - 32px))", margin: "0 auto", padding: "24px 0 36px" } },
          h("header", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, marginBottom: 32 } },
            h("div", { style: { minWidth: 0 } },
              h("h2", { style: { margin: "0 0 8px", fontSize: 21, lineHeight: 1.25, fontWeight: 600, letterSpacing: "-0.015em" } }, room.name),
              h("div", { style: { display: "flex", alignItems: "center", minHeight: 28 } },
                h("div", { "aria-label": `${members.length} ${t("roomMembers")}`, style: { display: "flex", paddingLeft: members.length ? 3 : 0 } },
                  members.slice(0, 5).map((member, index) => h("span", { key: `${member.kind}:${member.hostId ?? "local"}:${member.sessionId}`, style: { display: "inline-flex", marginLeft: index ? -8 : 0, zIndex: 10 - index } }, h(Avatar, { id: member.sessionId, label: memberName(member), title: memberName(member), size: 28, remote: member.kind === "remote" }))),
                  members.length > 5 && h("span", { style: { width: 28, height: 28, marginLeft: -8, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--dsw-alias-bg-layer-2)", border: "2px solid var(--dsw-alias-bg-layer-1)", fontSize: 10, fontWeight: 500 } }, `+${members.length - 5}`)
                ),
                h("span", { style: { marginLeft: 10, color: "var(--dsw-alias-label-secondary)", fontSize: 13 } }, `${members.length} ${t("roomMembers")}${room.remote ? ` · ${t("woven")}` : ""}`)
              )
            ),
            h("button", { type: "button", onClick: openSettings, className: "dshChatQuietButton", "aria-label": t("roomSettings") }, h(GearIcon), h("span", null, t("settings")))
          ),
          error && h("p", { role: "alert", style: { padding: "10px 12px", borderRadius: 9, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-state-error-primary)", fontSize: 13 } }, error),
          h("div", { "aria-label": t("roomMessages"), style: { display: "grid", gap: 22 } },
            messages.map((message) => h("article", { key: message.id, style: { display: "grid", gridTemplateColumns: "38px minmax(0,1fr)", gap: 12, alignItems: "start" } },
              h(Avatar, { id: message.author, label: authorName(message), size: 36, title: authorName(message) }),
              h("div", { style: { minWidth: 0, paddingTop: 1 } },
                h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 } },
                  h("strong", { title: authorName(message), style: { fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, authorName(message)),
                  h("time", { dateTime: new Date(message.sentAt).toISOString(), style: { flex: "0 0 auto", color: "var(--dsw-alias-label-tertiary)", fontSize: 11 } }, new Date(message.sentAt).toLocaleTimeString(ctx.locale.getLocale?.().active ?? undefined, { hour: "2-digit", minute: "2-digit" }))
                ),
                h("div", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.55, fontSize: 15 } }, message.text)
              )
            )),
            messages.length === 0 && h("div", { style: { padding: "48px 20px", textAlign: "center", color: "var(--dsw-alias-label-secondary)" } }, h("p", { style: { margin: "0 0 5px", fontWeight: 600, color: "inherit" } }, loaded ? t("startConversation") : t("loadingMessages")), loaded && h("small", null, t("quietHint")))
          ),
          settingsOpen && h("div", { role: "presentation", onClick: (event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }, style: { position: "fixed", inset: 0, zIndex: 100, background: "var(--dsw-alias-bg-mask-1)", display: "flex", justifyContent: "flex-end" } },
            h("aside", { ref: dialog, tabIndex: -1, onKeyDown: dialogKeys, role: "dialog", "aria-modal": true, "aria-label": t("roomSettings"), style: { width: "min(470px, 94vw)", height: "100%", boxSizing: "border-box", padding: 26, overflow: "auto", background: "var(--dsw-alias-bg-layer-1)", boxShadow: "var(--dsw-shadow-lv2)" } },
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 26 } },
                h("div", null, h("h3", { style: { margin: "0 0 3px", fontSize: 18 } }, t("roomSettings")), h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, room.name)),
                h("button", { type: "button", onClick: () => setSettingsOpen(false), className: "dshChatQuietButton", style: { width: 36, padding: 0 }, "aria-label": t("closeSettings") }, "×")
              ),
              error && h("p", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 13 } }, error),
              memberBusy && h("p", { role: "status" }, t("working")),
              room.remote && h("p", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 13 } }, t("hostMembership")),
              h("section", { "aria-busy": memberBusy, style: { marginBottom: 28 } },
                h("h4", { style: { margin: "0 0 12px", fontSize: 13, color: "var(--dsw-alias-label-secondary)" } }, t("members")),
                h("div", { style: { display: "grid", gap: 9 } }, members.map((member) =>
                  h("div", { key: `${member.kind}:${member.hostId ?? "local"}:${member.sessionId}`, title: member.sessionId, style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 9px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" } },
                    h(Avatar, { id: member.sessionId, label: memberName(member), title: memberName(member), size: 32, remote: member.kind === "remote" }),
                    h("div", { style: { minWidth: 0, flex: 1 } },
                      h("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 } }, memberName(member)),
                      h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, member.kind === "remote" ? `${member.workspaceTitle ?? t("workspace")} · ${member.hostName ?? t("remote")}` : member.workspaceTitle ?? t("thisHost"))
                    ),
                    h("small", { style: { display: "inline-flex", alignItems: "center", gap: 5, color: "var(--dsw-alias-label-secondary)", flex: "0 0 auto" } },
                      h("span", { style: { width: 7, height: 7, borderRadius: "50%", background: stateColor(runtimeState(member)) } }),
                      stateLabel(runtimeState(member))
                    ),
                    h("button", { type: "button", disabled: memberBusy || room.remote, onClick: () => removeMember(member), "aria-label": `${t("removeMember")}: ${memberName(member)}`, title: t("removeMember"), style: { flex: "0 0 auto", width: 26, height: 26, borderRadius: "50%", border: 0, background: "transparent", color: "var(--dsw-alias-label-tertiary)", font: "inherit", fontSize: 15, lineHeight: 1, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" } }, "×")
                  )
                )),
                members.length === 0 && h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, t("noMembers"))
              ),
              h("section", { "aria-busy": memberBusy, style: { marginBottom: 28 } },
                h("h4", { style: { margin: "0 0 4px", fontSize: 14 } }, t("addSession")),
                h("p", { style: { margin: "0 0 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("addHint")),
                remoteLoading && h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, t("lookingHosts")),
                h("label", { className: "dshChatField" }, t("host"),
                  h("select", { value: selectedSource?.hostId ?? "local", onChange: (event) => { const hostId = event.target.value; const source = sources.find((item) => item.hostId === hostId); setSourceHostId(hostId); setWorkspaceId(source?.workspaces[0]?.id ?? ""); }, className: "dshChatControl" }, sources.map((source) => h("option", { key: source.hostId, value: source.hostId }, source.hostId === "local" ? source.hostName : `${source.hostName} · ${t("remote")}`)))
                ),
                h("label", { className: "dshChatField" }, t("workspace"),
                  h("select", { value: selectedWorkspace?.id ?? "", onChange: (event) => setWorkspaceId(event.target.value), disabled: !selectedSource?.workspaces.length, className: "dshChatControl" }, selectedSource?.workspaces.length ? selectedSource.workspaces.map((workspace) => h("option", { key: workspace.id, value: workspace.id }, workspace.title)) : h("option", { value: "" }, t("noWorkspaces")))
                ),
                h("input", { type: "search", value: sessionQuery, onChange: (event) => setSessionQuery(event.target.value), placeholder: t("searchSessions"), "aria-label": t("searchSessions"), className: "dshChatControl dshChatSearch" }),
                h("div", { role: "list", "aria-label": t("availableSessions"), style: { display: "grid", gap: 6, maxHeight: 260, marginTop: 9, overflow: "auto" } },
                  selectableSessions.slice(0, 50).map((session) => { const title = session.displayTitle ?? session.title ?? session.id; const remote = selectedSource.hostId !== "local"; return h("button", { key: session.id, type: "button", disabled: memberBusy || room.remote, onClick: () => remote ? addRemoteSession(selectedSource, selectedWorkspace, session) : addMember(session, selectedWorkspace), style: { display: "grid", gridTemplateColumns: "34px minmax(0,1fr) auto", alignItems: "center", gap: 10, width: "100%", padding: "8px 9px", border: 0, borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)", color: "inherit", textAlign: "left", cursor: "pointer" } },
                    h(Avatar, { id: remote ? `${selectedSource.hostId}:${session.id}` : String(session.id), label: title, size: 32, remote }),
                    h("span", { style: { minWidth: 0 } }, h("span", { style: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 } }, title), h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, `${selectedWorkspace?.title ?? t("workspace")}${remote ? ` · ${selectedSource.hostName}` : ""}`)),
                    h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, h("span", { style: { width: 7, height: 7, borderRadius: "50%", background: stateColor(runtimeState(session)) } }), stateLabel(runtimeState(session)))
                  ); }),
                  selectableSessions.length === 0 && h("small", { style: { padding: "12px 4px", color: "var(--dsw-alias-label-secondary)" } }, selectedWorkspace ? (query ? t("noMatching") : t("allMembers")) : t("noWorkspaces"))
                ),
                !remoteLoading && remoteHosts.length === 0 && h("p", { style: { margin: "12px 0 0", color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("noRemote"))
              )
            )
          )
        );
      }

      function RoomComposer({ matched, sessionId }) {
        const [draft, setDraft] = React.useState("");
        const [members, setMembers] = React.useState([]);
        const [selectedMentions, setSelectedMentions] = React.useState([]);
        const [sending, setSending] = React.useState(false);
        const [error, setError] = React.useState("");
        const sendController = React.useRef(null);
        React.useEffect(() => {
          const controller = new AbortController(); const signal = controller.signal;
          let timer;
          const refresh = async () => {
            try { const rooms = await call("listRooms", {}, signal); if (!signal.aborted) setMembers(rooms.find((room) => room.id === matched.roomId)?.members ?? []); }
            catch (cause) { if (!signal.aborted) setError(String(cause.message ?? cause)); }
            finally { if (!signal.aborted) timer = setTimeout(refresh, 2_000); }
          };
          void refresh();
          return () => { controller.abort(); clearTimeout(timer); sendController.current?.abort(); sendController.current = null; };
        }, [matched.roomId]);
        const nameOf = (member) => {
          const current = ctx.sessions.list.getSnapshot().byId[member.sessionId];
          return current?.displayTitle ?? current?.title ?? member.alias ?? displayName(member.sessionId);
        };
        const mentionable = members.filter((member) => !(member.kind === "session" && member.sessionId === String(sessionId)) && runtimeState(member) !== "archived");
        const insertMention = (member) => {
          const token = `@${nameOf(member)}`;
          setDraft((value) => `${value}${value && !/\s$/.test(value) ? " " : ""}${token} `);
          const reference = memberReference(member);
          setSelectedMentions((value) => value.some((item) => item.reference === reference) ? value : [...value, { reference, token }]);
        };
        const send = async (event) => {
          event.preventDefault(); if (!draft.trim() || sendController.current) return;
          const controller = new AbortController(); sendController.current = controller;
          setSending(true); setError("");
          try {
            const selected = selectedMentions.filter((item) => draft.includes(item.token)).map((item) => item.reference);
            const mentions = [...new Set(selected)];
            const current = ctx.sessions.list.getSnapshot().byId[String(sessionId)];
            const authorAlias = String(sessionId).startsWith("dsh-chat-room-") ? "You" : current?.displayTitle ?? current?.title ?? displayName(sessionId);
            await call("send", { request: { roomId: matched.roomId, author: String(sessionId), authorAlias, text: draft, mentions } }, controller.signal);
            if (controller.signal.aborted) return;
            setDraft(""); setSelectedMentions([]); setError("");
          } catch (cause) { if (!controller.signal.aborted) setError(String(cause.message ?? cause)); }
          finally { if (sendController.current === controller) { sendController.current = null; setSending(false); } }
        };
        return h("div", { className: "dshChatRoom", style: { width: "min(780px, calc(100% - 32px))", margin: "0 auto", padding: "10px 0 18px" } },
          error && h("small", { role: "alert", style: { display: "block", margin: "0 12px 7px", color: "var(--dsw-alias-state-error-primary)" } }, error),
          h("form", { onSubmit: send, className: "dshChatComposer", style: { padding: "12px 12px 9px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 19, background: "var(--dsw-alias-bg-layer-1)", boxShadow: "var(--dsw-shadow-lv1)" } },
            mentionable.length > 0 && h("div", { "aria-label": t("mentionSession"), style: { display: "flex", gap: 6, padding: "0 2px 9px", overflowX: "auto" } }, mentionable.map((member) => {
              const state = runtimeState(member);
              const label = nameOf(member);
              return h("button", { key: `${member.hostId ?? "local"}:${member.sessionId}`, type: "button", disabled: sending, onClick: () => insertMention(member), title: `${label} · ${stateLabel(state)}`, "aria-label": `${t("mention")} ${label}, ${stateLabel(state)}`, style: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)", padding: "3px 9px", font: "inherit", fontSize: 12, cursor: "pointer" } },
                h("span", { "aria-hidden": true, style: { width: 7, height: 7, flex: "0 0 7px", borderRadius: "50%", background: stateColor(state), boxShadow: state === "running" || state === "waking" ? `0 0 0 2px color-mix(in srgb, ${stateColor(state)} 18%, transparent)` : "none" } }),
                `@${label}`
              );
            })),
            h("textarea", { disabled: sending, "aria-label": `${t("message")} ${matched.name}`, value: draft, onChange: (event) => { const value = event.target.value; setDraft(value); setSelectedMentions((items) => items.filter((item) => value.includes(item.token))); }, rows: 2, placeholder: `${t("message")} ${matched.name}`, style: { width: "100%", minHeight: 44, maxHeight: 160, resize: "vertical", boxSizing: "border-box", padding: "2px 4px 8px", border: 0, outline: 0, background: "transparent", color: "inherit", font: "inherit", lineHeight: 1.45 } }),
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
              h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, h("span", { style: { width: 25, height: 25, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--dsw-alias-bg-layer-2)", fontWeight: 500 } }, "@"), t("mentionHint")),
              h("button", { type: "submit", disabled: sending || !draft.trim(), "aria-label": t("send"), style: { width: 36, height: 36, border: 0, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: draft.trim() && !sending ? "var(--dsw-alias-button-primary-fill)" : "var(--dsw-alias-bg-layer-3)", color: draft.trim() && !sending ? "var(--dsw-alias-label-primary-foreground)" : "var(--dsw-alias-label-tertiary)", cursor: draft.trim() && !sending ? "pointer" : "default", fontSize: 19, transition: "transform .15s ease, background .15s ease" } }, sending ? "…" : "↑")
            )
          )
        );
      }

      ctx.effect(() => {
        const disposeNode = ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key: "dsh-chat-room" }, RoomTimeline));
        const disposeComposer = ctx.slots.inject("conversation.composer", () => ctx.slots.register({
          name: "conversation.composer",
          priority: -20,
          select: (owner) => {
            const node = roomNode(ctx, owner);
            if (node) return { roomId: node.data.roomId, name: node.data.name };
            // The chain is selected before the Chat target activates. The room's
            // durable session id is available immediately, so the regular agent
            // composer must never become the fallback for a known room.
            const prefix = "dsh-chat-room-v3-";
            if (typeof owner?.sessionId === "string" && owner.sessionId.startsWith(prefix)) {
              const row = ctx.sessions?.list?.getSnapshot?.()?.byId?.[owner.sessionId];
              return { roomId: owner.sessionId.slice(prefix.length), name: row?.displayTitle ?? row?.title ?? t("roomMessages") };
            }
            return null;
          }
        }, RoomComposer));
        return () => { disposeNode(); disposeComposer(); };
      }, "dsh-chat: conversation contributions");
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
