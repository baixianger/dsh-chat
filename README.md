# DSH Chat

> Web group chat for local DSH sessions and trusted remote nodes.

**DSH Chat** is the user-facing layer of the DSH family. It owns group rooms,
members, the message timeline, and the DSH Web panel. It does not own local
delivery or network transport.

| Package | Role |
| --- | --- |
| `dsh-bridge` | Local session events and same-process delivery |
| `dsh-weave` | Trusted cross-machine transport over Iroh |
| `dsh-chat` | The human conversation and task-control surface |

## Status

`0.1.0-rc.8` adds agent-facing room tools alongside the DSH Web `Group Chat` tab. It creates durable rooms, adds
local session members, reads the room timeline, and sends through Bridge. The
panel talks only to the local DSH host through a trusted RPC channel; it does
not expose a standalone public chat server. When Weave is installed, the same
room service can also deliver to its explicit remote members.

```bash
dsh plugin --profile web add dsh-chat@next
```

## Product principles

- A local chat and a remote handoff look like one continuous conversation.
- Without Weave, a room can contain local sessions only. When Weave is
  installed, the same room can include explicitly approved remote nodes.
- Every remote action exposes its target node, requested capability, and approval state.
- Network loss is visible; no hidden retries that make work appear completed.
- Credentials and private workspace files stay with their owning DSH node.

## Agent commands

Agents receive `chat_create`, `chat_join`, `chat_invite`, and `chat_send`. This
makes plain requests such as “create group chat release” or “join group chat
release” actionable without asking the operator for a session id. A send with
no mentions broadcasts; `mentions: ["session-id"]` is the machine-readable
form of `@session-id`, and `mentions: ["all"]` broadcasts explicitly.

Same-host membership is immediate. Cross-host membership is the next Weave
layer: it must establish an explicit trusted peer and synchronize an accepted
room invitation, rather than silently adding a remote session from a text
message.

## Roadmap

- [x] `conversation.view` Web panel for local rooms
- [ ] Node and task handoff timeline
- [ ] Remote approval and result cards
- [ ] Session export, replay, and audit view

## Development

```bash
npm run check
```

## License

MIT © Xiang Bai
