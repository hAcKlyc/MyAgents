# 中国聊天平台 Bot 集成指南

> 本文档专注于飞书、企业微信、QQ 等中国常用聊天平台的 Bot 集成技术细节。

## 目录

1. [平台对比](#1-平台对比)
2. [飞书集成](#2-飞书集成)
3. [企业微信集成](#3-企业微信集成)
4. [QQ 集成](#4-qq-集成)
5. [钉钉集成](#5-钉钉集成)
6. [通用设计建议](#6-通用设计建议)

---

## 1. 平台对比

### 1.1 消息接收方式对比

| 平台 | WebSocket 长连接 | HTTP 回调 | Long Polling | 推荐方式 |
|------|-----------------|----------|--------------|---------|
| **飞书** | ✅ 支持 | ✅ 支持 | ❌ | WebSocket |
| **企业微信** | ❌ | ✅ 支持 | ❌ | HTTP 回调 |
| **QQ 官方** | ✅ 支持 | ✅ 支持 | ❌ | WebSocket |
| **钉钉** | ✅ 支持 (Stream) | ✅ 支持 | ❌ | Stream |

### 1.2 是否需要公网 IP

| 平台 | 使用 WebSocket/Stream | 使用 HTTP 回调 |
|------|----------------------|---------------|
| **飞书** | 不需要 ✅ | 需要 |
| **企业微信** | N/A | 需要 ⚠️ |
| **QQ 官方** | 不需要 ✅ | 需要 |
| **钉钉** | 不需要 ✅ | 需要 |

### 1.3 SDK 和文档

| 平台 | 官方 Node SDK | 文档质量 | 备注 |
|------|-------------|---------|------|
| 飞书 | `@larksuiteoapi/node-sdk` | 优秀 | 文档完善，示例丰富 |
| 企业微信 | 无官方 SDK | 一般 | 需自行封装 |
| QQ 官方 | `qq-bot-sdk` | 一般 | API 限制较多 |
| 钉钉 | `dingtalk-stream` | 良好 | Stream 模式文档清晰 |

---

## 2. 飞书集成

### 2.1 技术方案

**推荐方案**: WebSocket 长连接（无需公网 IP）

```
┌─────────────────┐        WebSocket        ┌─────────────────┐
│   本地 Bot      │ ──────────────────────→ │   飞书服务器     │
│   Gateway       │ ←────────────────────── │                 │
└─────────────────┘     消息推送 (事件)      └─────────────────┘
```

### 2.2 前置准备

1. 创建飞书应用: https://open.feishu.cn/app
2. 获取 App ID 和 App Secret
3. 配置权限:
   - `im:message` - 获取与发送单聊、群组消息
   - `im:message.group_at_msg` - 接收群聊@消息
   - `contact:user.base` - 获取用户基本信息

### 2.3 代码实现

```typescript
// channels/feishu/index.ts
import * as lark from "@larksuiteoapi/node-sdk";

interface FeishuConfig {
  appId: string;
  appSecret: string;
  // 可选: 加密配置
  encryptKey?: string;
  verificationToken?: string;
}

export class FeishuChannel implements ChannelPlugin {
  id = "feishu" as const;
  name = "飞书";

  private client!: lark.Client;
  private wsClient!: lark.WSClient;
  private messageHandler?: MessageHandler;
  private config!: FeishuConfig;

  async init(config: FeishuConfig): Promise<void> {
    this.config = config;

    // 创建 API 客户端
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      disableTokenCache: false,
    });
  }

  async connect(): Promise<void> {
    // 创建 WebSocket 客户端
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      logLevel: lark.LogLevel.INFO,
    });

    // 注册消息事件处理器
    this.wsClient.on("im.message.receive_v1", async (data) => {
      try {
        const ctx = await this.normalizeMessage(data);
        if (ctx) {
          await this.messageHandler?.(ctx);
        }
      } catch (err) {
        console.error("Error processing Feishu message:", err);
      }
    });

    // 启动 WebSocket 连接
    await this.wsClient.start();
  }

  async disconnect(): Promise<void> {
    await this.wsClient?.stop();
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async send(opts: SendOptions): Promise<void> {
    const { conversationId, text, replyTo } = opts;

    // 判断发送目标类型
    const receiveIdType = conversationId.startsWith("oc_")
      ? "chat_id"
      : "open_id";

    await this.client.im.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: conversationId,
        msg_type: "text",
        content: JSON.stringify({ text }),
        ...(replyTo ? { reply_in_thread: true } : {}),
      },
    });
  }

  private async normalizeMessage(
    event: lark.EventMessage
  ): Promise<BotMessageContext | null> {
    const message = event.message;

    // 过滤机器人自己的消息
    if (event.sender.sender_type === "app") {
      return null;
    }

    // 解析消息内容
    let text = "";
    if (message.message_type === "text") {
      const content = JSON.parse(message.content);
      text = content.text || "";
    } else {
      // 暂不处理其他类型消息
      return null;
    }

    // 获取发送者信息
    const senderInfo = await this.getUserInfo(event.sender.sender_id.open_id);

    return {
      id: message.message_id,
      text,
      channel: "feishu",
      timestamp: parseInt(message.create_time),
      sender: {
        id: event.sender.sender_id.open_id,
        name: senderInfo?.name || "Unknown",
        avatar: senderInfo?.avatar_url,
      },
      conversation: {
        type: message.chat_type === "p2p" ? "private" : "group",
        id: message.chat_id,
        name: message.chat_type === "group" ? await this.getChatName(message.chat_id) : undefined,
      },
      attachments: this.extractAttachments(message),
      _raw: event,
    };
  }

  private async getUserInfo(openId: string) {
    try {
      const res = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });
      return res.data?.user;
    } catch {
      return null;
    }
  }

  private async getChatName(chatId: string): Promise<string | undefined> {
    try {
      const res = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });
      return res.data?.name;
    } catch {
      return undefined;
    }
  }

  private extractAttachments(message: any): Attachment[] {
    const attachments: Attachment[] = [];

    if (message.message_type === "image") {
      const content = JSON.parse(message.content);
      attachments.push({
        type: "image",
        id: content.image_key,
      });
    }

    return attachments;
  }

  getStatus(): ChannelStatus {
    return {
      connected: this.wsClient?.isConnected() ?? false,
    };
  }
}
```

### 2.4 飞书消息类型处理

```typescript
// 支持的消息类型
type FeishuMessageType =
  | "text"      // 文本
  | "image"     // 图片
  | "file"      // 文件
  | "audio"     // 语音
  | "sticker"   // 表情
  | "share_chat" // 分享群名片
  | "share_user" // 分享个人名片
  | "post"      // 富文本
  | "interactive"; // 卡片消息

// 发送富文本消息
async function sendRichText(chatId: string, content: RichTextContent) {
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          title: content.title,
          content: content.paragraphs.map(p => [
            { tag: "text", text: p },
          ]),
        },
      }),
    },
  });
}

// 发送卡片消息
async function sendCard(chatId: string, card: CardContent) {
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify({
        elements: [
          {
            tag: "div",
            text: { tag: "plain_text", content: card.text },
          },
          {
            tag: "action",
            actions: card.buttons.map(btn => ({
              tag: "button",
              text: { tag: "plain_text", content: btn.text },
              type: "primary",
              value: { action: btn.action },
            })),
          },
        ],
      }),
    },
  });
}
```

---

## 3. 企业微信集成

### 3.1 技术方案

**企业微信不支持 WebSocket**，必须使用 HTTP 回调。

**方案 A**: 直接暴露本地服务（需要公网 IP 或内网穿透）

```
┌─────────────────┐       HTTP POST       ┌─────────────────┐
│   企业微信服务器  │ ──────────────────→  │   本地 Bot      │
│                 │                       │   (需公网可达)   │
└─────────────────┘                       └─────────────────┘
```

**方案 B**: 云函数转发（推荐）

```
┌─────────────────┐       HTTP POST       ┌─────────────────┐
│   企业微信服务器  │ ──────────────────→  │   云函数        │
│                 │                       │   (腾讯云/阿里云) │
└─────────────────┘                       └────────┬────────┘
                                                   │ WebSocket
                                                   ↓
                                          ┌─────────────────┐
                                          │   本地 Bot      │
                                          │   Gateway       │
                                          └─────────────────┘
```

### 3.2 前置准备

1. 登录企业微信管理后台: https://work.weixin.qq.com/wework_admin/frame
2. 创建自建应用或使用已有应用
3. 获取:
   - Corp ID (企业 ID)
   - Agent ID (应用 ID)
   - Secret (应用密钥)
   - Token 和 EncodingAESKey (消息加解密配置)

### 3.3 代码实现 (方案 A: 直接回调)

```typescript
// channels/wecom/index.ts
import crypto from "crypto";
import http from "http";

interface WecomConfig {
  corpId: string;
  agentId: string;
  secret: string;
  token: string;
  encodingAESKey: string;
  callbackPort: number;
}

export class WecomChannel implements ChannelPlugin {
  id = "wecom" as const;
  name = "企业微信";

  private config!: WecomConfig;
  private server?: http.Server;
  private messageHandler?: MessageHandler;
  private accessToken?: string;
  private tokenExpireAt = 0;

  async init(config: WecomConfig): Promise<void> {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        console.error("Wecom callback error:", err);
        res.writeHead(500);
        res.end("error");
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.callbackPort, () => {
        console.log(`Wecom callback server listening on port ${this.config.callbackPort}`);
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", `http://localhost:${this.config.callbackPort}`);

    // 验证 URL (企业微信配置回调时会发送 GET 请求验证)
    if (req.method === "GET") {
      const echostr = this.verifyUrl(url);
      if (echostr) {
        res.writeHead(200);
        res.end(echostr);
        return;
      }
      res.writeHead(403);
      res.end("verification failed");
      return;
    }

    // 处理消息 (POST)
    if (req.method === "POST") {
      const body = await this.readBody(req);
      const decrypted = this.decryptMessage(body, url);

      if (decrypted) {
        const ctx = this.normalizeMessage(decrypted);
        if (ctx) {
          await this.messageHandler?.(ctx);
        }
      }

      res.writeHead(200);
      res.end("success");
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private verifyUrl(url: URL): string | null {
    const msgSignature = url.searchParams.get("msg_signature");
    const timestamp = url.searchParams.get("timestamp");
    const nonce = url.searchParams.get("nonce");
    const echostr = url.searchParams.get("echostr");

    if (!msgSignature || !timestamp || !nonce || !echostr) {
      return null;
    }

    // 验证签名
    const signature = this.computeSignature(timestamp, nonce, echostr);
    if (signature !== msgSignature) {
      return null;
    }

    // 解密 echostr
    return this.decryptContent(echostr);
  }

  private computeSignature(timestamp: string, nonce: string, encrypted: string): string {
    const arr = [this.config.token, timestamp, nonce, encrypted].sort();
    const str = arr.join("");
    return crypto.createHash("sha1").update(str).digest("hex");
  }

  private decryptContent(encrypted: string): string {
    const aesKey = Buffer.from(this.config.encodingAESKey + "=", "base64");
    const iv = aesKey.subarray(0, 16);

    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
    decipher.setAutoPadding(false);

    let decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final(),
    ]);

    // 去除 PKCS7 padding
    const pad = decrypted[decrypted.length - 1];
    decrypted = decrypted.subarray(0, decrypted.length - pad);

    // 解析内容 (前 16 字节随机, 后 4 字节长度, 然后是内容, 最后是 corpId)
    const msgLen = decrypted.readUInt32BE(16);
    const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");

    return msg;
  }

  private decryptMessage(body: string, url: URL): WecomMessage | null {
    // 解析 XML
    const encrypted = this.extractXmlValue(body, "Encrypt");
    if (!encrypted) return null;

    // 验证签名
    const msgSignature = url.searchParams.get("msg_signature");
    const timestamp = url.searchParams.get("timestamp");
    const nonce = url.searchParams.get("nonce");

    if (!msgSignature || !timestamp || !nonce) return null;

    const signature = this.computeSignature(timestamp, nonce, encrypted);
    if (signature !== msgSignature) return null;

    // 解密
    const decrypted = this.decryptContent(encrypted);
    return this.parseXmlMessage(decrypted);
  }

  private parseXmlMessage(xml: string): WecomMessage {
    return {
      ToUserName: this.extractXmlValue(xml, "ToUserName") || "",
      FromUserName: this.extractXmlValue(xml, "FromUserName") || "",
      CreateTime: parseInt(this.extractXmlValue(xml, "CreateTime") || "0"),
      MsgType: this.extractXmlValue(xml, "MsgType") || "",
      Content: this.extractXmlValue(xml, "Content") || "",
      MsgId: this.extractXmlValue(xml, "MsgId") || "",
      AgentID: this.extractXmlValue(xml, "AgentID") || "",
    };
  }

  private extractXmlValue(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}><\\!\\[CDATA\\[([^\\]]+)\\]\\]></${tag}>`)) ||
                  xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
    return match ? match[1] : null;
  }

  private normalizeMessage(msg: WecomMessage): BotMessageContext | null {
    if (msg.MsgType !== "text") {
      return null; // 暂只处理文本消息
    }

    return {
      id: msg.MsgId,
      text: msg.Content,
      channel: "wecom",
      timestamp: msg.CreateTime * 1000,
      sender: {
        id: msg.FromUserName,
        name: msg.FromUserName, // 需要额外 API 获取
      },
      conversation: {
        type: "private", // 企业微信应用消息默认是私聊
        id: msg.FromUserName,
      },
      _raw: msg,
    };
  }

  async send(opts: SendOptions): Promise<void> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: opts.conversationId,
          msgtype: "text",
          agentid: this.config.agentId,
          text: { content: opts.text },
        }),
      }
    );

    const result = await response.json();
    if (result.errcode !== 0) {
      throw new Error(`Wecom send failed: ${result.errmsg}`);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpireAt) {
      return this.accessToken;
    }

    const response = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.config.corpId}&corpsecret=${this.config.secret}`
    );

    const result = await response.json();
    if (result.errcode !== 0) {
      throw new Error(`Failed to get access token: ${result.errmsg}`);
    }

    this.accessToken = result.access_token;
    this.tokenExpireAt = Date.now() + (result.expires_in - 300) * 1000; // 提前 5 分钟刷新

    return this.accessToken;
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  getStatus(): ChannelStatus {
    return {
      connected: this.server?.listening ?? false,
    };
  }
}

interface WecomMessage {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: string;
  Content: string;
  MsgId: string;
  AgentID: string;
}
```

### 3.4 云函数转发方案

```typescript
// 腾讯云函数代码示例
// 接收企业微信回调，通过 WebSocket 转发到本地

import { WebSocket } from "ws";

// 配置
const LOCAL_WS_URL = "wss://your-tailscale-address:port/wecom-relay";

exports.main = async (event, context) => {
  // 解析企业微信消息
  const message = parseWecomMessage(event);

  // 通过 WebSocket 发送到本地
  const ws = new WebSocket(LOCAL_WS_URL);

  await new Promise((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify(message));
      resolve();
    });
    ws.on("error", reject);
  });

  ws.close();

  return { statusCode: 200, body: "success" };
};
```

---

## 4. QQ 集成

### 4.1 官方 Bot vs 非官方方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **QQ 官方机器人** | 官方支持，稳定 | 功能受限，需要审核 |
| **go-cqhttp** | 功能完整 | 灰色地带，可能封号 |
| **Lagrange** | 较新，兼容性好 | 同上 |

### 4.2 官方 QQ Bot 实现

**推荐方案**: WebSocket 连接（无需公网 IP）

```typescript
// channels/qq/index.ts
import { createOpenAPI, createWebsocket } from "qq-bot-sdk";

interface QQConfig {
  appId: string;
  token: string;
  secret: string;
  sandbox?: boolean;
}

export class QQChannel implements ChannelPlugin {
  id = "qq" as const;
  name = "QQ";

  private config!: QQConfig;
  private client: any;
  private ws: any;
  private messageHandler?: MessageHandler;

  async init(config: QQConfig): Promise<void> {
    this.config = config;

    this.client = createOpenAPI({
      appID: config.appId,
      token: config.token,
      secret: config.secret,
      sandbox: config.sandbox ?? false,
    });

    this.ws = createWebsocket({
      appID: config.appId,
      token: config.token,
      secret: config.secret,
      sandbox: config.sandbox ?? false,
    });
  }

  async connect(): Promise<void> {
    // 注册事件处理
    this.ws.on("READY", (data: any) => {
      console.log("QQ Bot ready:", data);
    });

    // 私聊消息
    this.ws.on("C2C_MESSAGE_CREATE", async (data: any) => {
      const ctx = this.normalizeMessage(data, "private");
      if (ctx) {
        await this.messageHandler?.(ctx);
      }
    });

    // 群聊消息
    this.ws.on("GROUP_AT_MESSAGE_CREATE", async (data: any) => {
      const ctx = this.normalizeMessage(data, "group");
      if (ctx) {
        await this.messageHandler?.(ctx);
      }
    });

    // 频道消息
    this.ws.on("AT_MESSAGE_CREATE", async (data: any) => {
      const ctx = this.normalizeMessage(data, "guild");
      if (ctx) {
        await this.messageHandler?.(ctx);
      }
    });

    // 启动 WebSocket 连接
    await this.ws.start();
  }

  async disconnect(): Promise<void> {
    await this.ws?.stop();
  }

  private normalizeMessage(
    data: any,
    type: "private" | "group" | "guild"
  ): BotMessageContext | null {
    const msg = data.msg;

    return {
      id: msg.id,
      text: msg.content?.replace(/<@!\d+>/g, "").trim() || "",
      channel: "qq",
      timestamp: new Date(msg.timestamp).getTime(),
      sender: {
        id: msg.author.id,
        name: msg.author.username,
        avatar: msg.author.avatar,
      },
      conversation: {
        type: type === "private" ? "private" : "group",
        id: type === "private"
          ? msg.author.id
          : type === "group"
            ? msg.group_openid
            : msg.channel_id,
      },
      _raw: data,
    };
  }

  async send(opts: SendOptions): Promise<void> {
    // 根据 conversationId 判断发送类型
    if (opts.conversationId.startsWith("group_")) {
      // 群聊
      await this.client.groupApi.postGroupMessage(
        opts.conversationId.replace("group_", ""),
        { content: opts.text, msg_type: 0 }
      );
    } else if (opts.conversationId.startsWith("channel_")) {
      // 频道
      await this.client.messageApi.postMessage(
        opts.conversationId.replace("channel_", ""),
        { content: opts.text }
      );
    } else {
      // 私聊
      await this.client.c2cApi.postC2CMessage(
        opts.conversationId,
        { content: opts.text, msg_type: 0 }
      );
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  getStatus(): ChannelStatus {
    return {
      connected: this.ws?.isConnected?.() ?? false,
    };
  }
}
```

### 4.3 使用 go-cqhttp (非官方)

```typescript
// 使用 go-cqhttp 的 WebSocket 反向连接
// go-cqhttp 会主动连接到你指定的 WebSocket 服务器

import { WebSocketServer } from "ws";

export class QQCqhttpChannel implements ChannelPlugin {
  id = "qq-cqhttp" as const;
  name = "QQ (go-cqhttp)";

  private wss?: WebSocketServer;
  private connection?: WebSocket;
  private messageHandler?: MessageHandler;

  async init(config: { port: number }): Promise<void> {
    this.wss = new WebSocketServer({ port: config.port });
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.wss!.on("connection", (ws) => {
        console.log("go-cqhttp connected");
        this.connection = ws;

        ws.on("message", async (data) => {
          const event = JSON.parse(data.toString());
          await this.handleEvent(event);
        });

        resolve();
      });
    });
  }

  private async handleEvent(event: any) {
    if (event.post_type !== "message") return;

    const ctx: BotMessageContext = {
      id: String(event.message_id),
      text: event.raw_message,
      channel: "qq-cqhttp",
      timestamp: event.time * 1000,
      sender: {
        id: String(event.user_id),
        name: event.sender.nickname,
      },
      conversation: {
        type: event.message_type === "private" ? "private" : "group",
        id: String(event.message_type === "private" ? event.user_id : event.group_id),
      },
      _raw: event,
    };

    await this.messageHandler?.(ctx);
  }

  async send(opts: SendOptions): Promise<void> {
    const isGroup = opts.conversationId.startsWith("group_");

    this.connection?.send(JSON.stringify({
      action: isGroup ? "send_group_msg" : "send_private_msg",
      params: {
        [isGroup ? "group_id" : "user_id"]: parseInt(
          opts.conversationId.replace(/^(group_|user_)/, "")
        ),
        message: opts.text,
      },
    }));
  }

  // ...
}
```

---

## 5. 钉钉集成

### 5.1 技术方案

**推荐方案**: Stream 模式（无需公网 IP）

钉钉的 Stream 模式类似于 WebSocket，是出站连接。

### 5.2 代码实现

```typescript
// channels/dingtalk/index.ts
import DingTalkStream from "dingtalk-stream";

interface DingtalkConfig {
  clientId: string;
  clientSecret: string;
}

export class DingtalkChannel implements ChannelPlugin {
  id = "dingtalk" as const;
  name = "钉钉";

  private config!: DingtalkConfig;
  private client: any;
  private messageHandler?: MessageHandler;

  async init(config: DingtalkConfig): Promise<void> {
    this.config = config;

    this.client = new DingTalkStream.default({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
  }

  async connect(): Promise<void> {
    // 注册回调
    this.client.registerAllCallback(async (message: any) => {
      if (message.type === "im_callback") {
        const ctx = this.normalizeMessage(message);
        if (ctx) {
          await this.messageHandler?.(ctx);
        }
      }
    });

    // 启动 Stream 连接
    await this.client.start();
  }

  async disconnect(): Promise<void> {
    await this.client?.stop();
  }

  private normalizeMessage(event: any): BotMessageContext | null {
    const data = JSON.parse(event.data);

    return {
      id: data.msgId,
      text: data.text?.content || "",
      channel: "dingtalk",
      timestamp: data.createAt,
      sender: {
        id: data.senderStaffId,
        name: data.senderNick,
      },
      conversation: {
        type: data.conversationType === "1" ? "private" : "group",
        id: data.conversationId,
      },
      _raw: event,
    };
  }

  async send(opts: SendOptions): Promise<void> {
    await this.client.sendMessage({
      conversationId: opts.conversationId,
      content: JSON.stringify({
        msgtype: "text",
        text: { content: opts.text },
      }),
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  getStatus(): ChannelStatus {
    return {
      connected: this.client?.isConnected?.() ?? false,
    };
  }
}
```

---

## 6. 通用设计建议

### 6.1 连接策略选择

```typescript
// config/bot.ts
interface BotConnectionConfig {
  // 优先使用的连接方式
  preferredMethod: "websocket" | "callback" | "auto";

  // 回调模式配置（当无法使用 WebSocket 时）
  callback?: {
    // 内网穿透
    tunnel?: {
      provider: "ngrok" | "frp" | "cloudflared";
      config: Record<string, unknown>;
    };
    // 或直接配置公网地址
    publicUrl?: string;
  };
}

// 连接策略工厂
function createConnectionStrategy(
  channel: ChannelId,
  config: BotConnectionConfig
): ConnectionStrategy {
  const capabilities = getChannelCapabilities(channel);

  if (config.preferredMethod === "websocket" && capabilities.websocket) {
    return new WebSocketStrategy();
  }

  if (config.preferredMethod === "callback" || !capabilities.websocket) {
    if (config.callback?.tunnel) {
      return new TunnelCallbackStrategy(config.callback.tunnel);
    }
    if (config.callback?.publicUrl) {
      return new DirectCallbackStrategy(config.callback.publicUrl);
    }
    throw new Error(`Channel ${channel} requires callback but no callback config provided`);
  }

  return new WebSocketStrategy();
}
```

### 6.2 消息队列和重试

```typescript
// gateway/message-queue.ts
class MessageQueue {
  private queue: QueueItem[] = [];
  private processing = false;

  async enqueue(message: OutgoingMessage): Promise<void> {
    this.queue.push({
      message,
      attempts: 0,
      createdAt: Date.now(),
    });

    this.process();
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue[0];

      try {
        await this.sendMessage(item.message);
        this.queue.shift();
      } catch (err) {
        item.attempts++;

        if (item.attempts >= 3) {
          console.error("Message failed after 3 attempts:", item.message);
          this.queue.shift();
        } else {
          // 指数退避
          await sleep(Math.pow(2, item.attempts) * 1000);
        }
      }
    }

    this.processing = false;
  }
}
```

### 6.3 访问控制

```typescript
// gateway/access-control.ts
interface AccessControlConfig {
  // 白名单模式
  allowlist?: {
    users?: string[];    // 允许的用户 ID
    groups?: string[];   // 允许的群组 ID
  };

  // 黑名单模式
  blocklist?: {
    users?: string[];
    groups?: string[];
  };

  // 默认策略
  defaultPolicy: "allow" | "deny";
}

function checkAccess(
  ctx: BotMessageContext,
  config: AccessControlConfig
): boolean {
  const { sender, conversation } = ctx;

  // 检查黑名单
  if (config.blocklist) {
    if (config.blocklist.users?.includes(sender.id)) return false;
    if (conversation.type === "group" &&
        config.blocklist.groups?.includes(conversation.id)) return false;
  }

  // 检查白名单
  if (config.allowlist) {
    if (config.allowlist.users?.includes(sender.id)) return true;
    if (conversation.type === "group" &&
        config.allowlist.groups?.includes(conversation.id)) return true;
    return false;
  }

  return config.defaultPolicy === "allow";
}
```

### 6.4 统一配置管理

```typescript
// config/schema.ts
interface BotConfig {
  enabled: boolean;

  channels: {
    feishu?: {
      enabled: boolean;
      appId: string;
      appSecret: string;
      accessControl?: AccessControlConfig;
    };

    wecom?: {
      enabled: boolean;
      corpId: string;
      agentId: string;
      secret: string;
      token: string;
      encodingAESKey: string;
      callbackPort?: number;
      accessControl?: AccessControlConfig;
    };

    qq?: {
      enabled: boolean;
      appId: string;
      token: string;
      secret: string;
      sandbox?: boolean;
      accessControl?: AccessControlConfig;
    };

    dingtalk?: {
      enabled: boolean;
      clientId: string;
      clientSecret: string;
      accessControl?: AccessControlConfig;
    };
  };

  // 全局访问控制（覆盖各频道配置）
  globalAccessControl?: AccessControlConfig;

  // Agent 路由规则
  routing?: {
    rules: Array<{
      match: {
        channel?: string;
        userId?: string;
        groupId?: string;
      };
      agentId: string;
    }>;
    defaultAgentId: string;
  };
}
```

### 6.5 状态监控 UI

```tsx
// components/BotStatusPanel.tsx
function BotStatusPanel() {
  const [status, setStatus] = useState<Record<string, ChannelStatus>>({});

  useEffect(() => {
    const interval = setInterval(async () => {
      const newStatus = await invoke("get_all_channel_status");
      setStatus(newStatus);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bot-status-panel">
      <h3>Bot 状态</h3>

      {Object.entries(status).map(([channelId, channelStatus]) => (
        <div key={channelId} className="channel-status">
          <span className={`indicator ${channelStatus.connected ? "online" : "offline"}`} />
          <span className="channel-name">{getChannelName(channelId)}</span>
          <span className="status-text">
            {channelStatus.connected ? "已连接" : channelStatus.error || "未连接"}
          </span>
          {channelStatus.lastMessageAt && (
            <span className="last-message">
              最后消息: {formatTime(channelStatus.lastMessageAt)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
```

---

## 附录

### A. 各平台开发文档

| 平台 | 文档地址 |
|------|---------|
| 飞书 | https://open.feishu.cn/document/ |
| 企业微信 | https://developer.work.weixin.qq.com/document/ |
| QQ 官方 | https://bot.q.qq.com/wiki/ |
| 钉钉 | https://open.dingtalk.com/document/ |

### B. SDK 包

| 平台 | npm 包 |
|------|--------|
| 飞书 | `@larksuiteoapi/node-sdk` |
| 企业微信 | 无官方，推荐 `wechat-work` 或自行封装 |
| QQ 官方 | `qq-bot-sdk` |
| 钉钉 | `dingtalk-stream` |

### C. 内网穿透工具

| 工具 | 特点 |
|------|------|
| ngrok | 简单易用，免费版有限制 |
| frp | 自建服务，需要有公网服务器 |
| cloudflared | Cloudflare 提供，免费 |
| Tailscale Funnel | 简单，与 Tailscale 集成 |
