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

`0.1.0-rc.1` is the DSH-plugin foundation: it has a stable plugin identity and
installation path. The interactive `conversation.view` Web panel is the next
implementation increment; this release does not claim to provide it yet.

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

## Roadmap

- [ ] `conversation.view` Web panel for local rooms
- [ ] Node and task handoff timeline
- [ ] Remote approval and result cards
- [ ] Session export, replay, and audit view

## Development

```bash
npm run check
```

## License

MIT © Xiang Bai
