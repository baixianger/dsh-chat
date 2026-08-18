# DSH Chat

> Web group chat for local DSH sessions and trusted remote nodes.

**DSH Chat** is the user-facing layer of the DSH family. It owns group rooms,
members, the message timeline, and room sessions in the DSH Web client. It does not own local
delivery or network transport.

| Package | Role |
| --- | --- |
| `dsh-bridge` | Local session events and same-process delivery |
| `dsh-weave` | Trusted cross-machine transport over Iroh |
| `dsh-chat` | The human conversation and task-control surface |

## Status

`0.1.0-rc.18` represents every room as a dedicated DSH session inside a
`Chatrooms` workspace. Opening that session uses the native Chat view: a
conversation node renders the authoritative room timeline and a
selector-routed composer sends room messages. The room timeline uses member
avatars and keeps membership and Weave configuration in a dedicated settings
drawer. Local members are selected from the host's live session catalog rather
than entered as raw ids. Reachable paired Weave hosts contribute their own
workspace-grouped session catalogs, labeled by host name; archived sessions
are excluded. Iroh identity and pairing remain owned by dsh-weave's Settings
page. Its composer follows the native session input layout. There is no
separate Group Chat view tab. Existing rooms are assigned room sessions on
startup. When Weave is installed, the same room service can also deliver to
its explicit remote members. The Host → Workspace → Session picker follows
the same token-based field, select, focus, and disabled-state contract as DSH
Settings without depending on Settings' private CSS-module class names.

```bash
dsh plugin --profile web add dsh-chat@next
```

## Product principles

- A local chat and a remote handoff look like one continuous conversation.
- A room has one authoritative host. Remote nodes store a room link (host id,
  capability, and cursor), not an endpoint ticket, second room, or message-history replica.
- Public messages without `@` belong only to the room view; `@session-id`
  directs delivery and `@all` is the explicit agent broadcast.
- Without Weave, a room can contain local sessions only. When Weave is
  installed, the same room can include explicitly approved remote nodes.
- Every remote action exposes its target node, requested capability, and approval state.
- Network loss is visible; no hidden retries that make work appear completed.
- Credentials and private workspace files stay with their owning DSH node.

## Agent commands

Agents receive `chat_create`, `chat_join`, `chat_invite`, and `chat_send`. This
makes plain requests such as “create group chat release” or “join group chat
release” actionable without asking the operator for a session id. A send with
no mentions is a room-only public event; `mentions: ["session-id"]` is the
machine-readable form of `@session-id`, and `mentions: ["all"]` is the only
agent broadcast. The web view extracts these mentions from composed text.

Same-host membership is immediate. Cross-host membership requires an explicit
trusted peer and creates a capability-bearing room link, rather than copying
room state from a text message. A remote room view cursor-long-polls its host;
the host retains an unacknowledged targeted delivery for seven days and retries
it without turning normal public room traffic into agent follow-ups.

The room session stores only a durable `chat/room-link` marker and a closed,
step-free initialization turn so DSH treats it as a visible session. Room
messages remain in the authoritative room store; linked machines keep the
host id, room capability, and cursor rather than copying the timeline into their session logs.

## Roadmap

- [x] Native Chat room sessions with a composer takeover
- [ ] Node and task handoff timeline
- [ ] Remote approval and result cards
- [ ] Session export, replay, and audit view

## Development

```bash
npm run check
```

## License

MIT © Xiang Bai
