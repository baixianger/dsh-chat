# DSH Chat

[English](README.md) | [简体中文](README.zh.md)

> 面向本地 DSH 会话与可信远程节点的 Web 群聊。

**DSH Chat** 是 DSH 通信系列中面向用户的一层。它在 DSH Web 客户端中管理群聊房间、
成员、消息时间线与房间会话，但不自己实现本地投递或网络传输。

| 插件 | 职责 |
| --- | --- |
| `dsh-bridge` | 本地会话事件与同进程投递 |
| `dsh-weave` | 基于 Iroh 的可信跨机传输 |
| `dsh-chat` | 面向用户的对话与任务控制界面 |

## 核心能力

- 在专用的 `Chatrooms` 工作区中使用 DSH 原生房间会话。
- 通过显式 `@` 提及向指定 Agent 投递，仅 `@all` 会广播。
- 界面显示人类可读的成员别名，投递使用稳定 session id。
- 持久化房间成员、权威时间线与有界的远程缓存。
- 可通过已显式信任的 `dsh-weave` 对端把远程会话加入同一房间。

## 快速开始

```bash
dsh plugin --profile web add dsh-chat@next
dsh web
```

可以让 Agent 创建或加入房间，也可以直接在 `Chatrooms` 工作区中打开已生成的房间会话。
本地投递由 `dsh-bridge` 完成；要添加远程成员，需要先在 **设置 → Weave** 中配对 Host。

## 界面与房间模型

每个房间都是 `Chatrooms` 工作区中一个专用 DSH 会话。打开后继续使用原生 Chat 视图：

- conversation node 渲染权威的房间时间线；
- 经 selector 路由的 composer 发送房间消息；
- 成员头像显示在时间线中；
- 成员与 Weave 配置放在独立设置抽屉中。

本地成员从 Host 实时会话目录中选择，无需手动输入 id。已连通的 Weave Host
会按工作区提供自己的会话目录，并显示 Host 名称；已归档会话不会出现在新成员候选中。

从房间移除成员是持久化操作，会丢弃该成员待投递的目标消息，且只能由房间权威 Host 执行。
已归档成员仍会显示以便移除，但不会出现在 `@` 提及候选中，也不再接收房间投递。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `chat_create` | 创建群聊房间 |
| `chat_join` | 加入已有房间 |
| `chat_invite` | 邀请本地或可信远程成员 |
| `chat_send` | 向房间发送公开或定向消息 |

因此，用户可以直接说“创建一个 release 群聊”或“加入 release 群聊”，
不需要先找到 session id。

## `@` 提及规则

- 没有提及的消息只属于房间公开时间线，不会唤醒 Agent。
- 在 UI 中明确选择成员时，显示别名，但在独立 `mentions` 字段中记录稳定 id。
- 普通文本中的 `at`、邮箱地址或字面量 `@alias` 都不会自动唤醒 Agent。
- `mentions: ["all"]` 是唯一的 Agent 广播方式。

被显式提及的 Agent 会通过 Bridge 唤醒。注入消息会告诉 Agent：普通 assistant 回复只留在自己会话中，
要在房间中可见地回复，必须调用 `chat_send`。

## 跨 Host 房间

同 Host 成员关系立即生效。跨 Host 成员关系需要已显式信任的 peer，并创建带 capability 的
room link，不会从一条普通文本消息复制房间状态。

远程房间视图通过 cursor 长轮询权威 Host。Host 会将未确认的定向投递保留 7 天并重试，
但普通房间公开消息不会因此变成 Agent follow-up。

房间会话在 DSH 日志中只保存持久化的 `chat/room-link` 标记和关闭的初始化回合。
房间消息仍在权威 room store 中；链接节点只保存 Host id、房间 capability、cursor 和有界只读时间线缓存。

## 产品原则

- 本地聊天与远程交付在用户眼中是一段连续对话。
- 一个房间只有一个权威 Host；远程节点保存 room link，不保存第二份房间。
- 远程操作明确显示目标节点、请求能力与批准状态。
- 断网会明确可见，不用隐式重试伪造“已完成”。
- 凭据与私有工作区文件留在各自所属的 DSH 节点。

## 开发

```bash
npm run check
```

## 许可证

MIT © Xiang Bai
