# DSH Chat

> One conversation surface for local DSH sessions and trusted remote nodes.

`dsh-chat` is the user-facing layer of the DSH family. It will present live conversations, task handoffs, node presence, and remote results without making a user think about transports or process boundaries.

| Package | Role |
| --- | --- |
| `dsh-bridge` | Local session events and same-process delivery |
| `dsh-weave` | Trusted cross-machine transport over Iroh |
| `dsh-chat` | The human conversation and task-control surface |

## Status

`0.1.0-rc.0` reserves the package name and publishes the initial UI contract. It is intentionally a design preview, not a finished chat application.

```bash
npm install dsh-chat@next
```

## Product principles

- A local chat and a remote handoff look like one continuous conversation.
- Every remote action exposes its target node, requested capability, and approval state.
- Network loss is visible; no hidden retries that make work appear completed.
- Credentials and private workspace files stay with their owning DSH node.

## Roadmap

- [ ] DSH Web panel for local sessions
- [ ] Node and task handoff timeline
- [ ] Remote approval and result cards
- [ ] Session export, replay, and audit view

## Development

```bash
npm run check
```

## License

MIT © Xiang Bai
