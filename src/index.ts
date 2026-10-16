import "dotenv/config";

import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

import { backend, generateReply, hasLLM, type Turn } from "./llm.js";
import { currentDay, loadState, saveState, touch } from "./state.js";
import { PHASES, TOTAL_DAYS, buildSystemPrompt, fallbackLine, phaseForDay } from "./verity.js";

interface SlackMessage {
  ts?: string;
  text?: string;
  bot_id?: string;
}

interface IncomingMessage {
  channel?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  channel_type?: string;
}

interface ReplyArgs {
  client: WebClient;
  channel: string;
  /** Thread root used to read back the conversation. Undefined = channel history. */
  historyTs?: string;
  /** The incoming message, so it is not echoed back into history. */
  currentTs?: string;
  /** Where the reply is posted. */
  replyTs?: string;
  text: string;
}

const dayMs = Number(process.env.VERITY_DAY_MS ?? 86_400_000) || 86_400_000;
const forceDayRaw = process.env.VERITY_FORCE_DAY;
const forceDay = forceDayRaw ? Number(forceDayRaw) : undefined;
const watchChannels = process.env.VERITY_WATCH_CHANNELS === "true";

const SUMMON = /^\s*(?:hey|hi|hello|yo)?[,\s]*verity\b/i;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

function clean(text: string): string {
  return text
    .replace(/<@[^>]+>/g, "")
    .replace(/<![^>]+>/g, "")
    .replace(/<#[^>|]+(?:\|[^>]+)?>/g, "")
    .trim();
}

function stripSummon(text: string): string {
  const rest = text.replace(SUMMON, "").trim();
  return rest || text;
}

async function channelLabel(client: WebClient, channel: string): Promise<string> {
  try {
    const info = await client.conversations.info({ channel });
    const name = info.channel?.name;
    return name ? `#${name}` : `<#${channel}>`;
  } catch {
    return `<#${channel}>`;
  }
}

async function fetchHistory(
  client: WebClient,
  channel: string,
  opts: { threadTs?: string; currentTs?: string },
): Promise<Turn[]> {
  try {
    const res = opts.threadTs
      ? await client.conversations.replies({ channel, ts: opts.threadTs, limit: 30 })
      : await client.conversations.history({ channel, limit: 15 });

    const messages = ((res.messages ?? []) as unknown as SlackMessage[])
      .slice()
      .sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));

    const turns: Turn[] = [];
    for (const message of messages) {
      if (!message.ts || message.ts === opts.currentTs) continue;
      const text = typeof message.text === "string" ? clean(message.text) : "";
      if (!text) continue;
      turns.push({ role: message.bot_id ? "assistant" : "user", content: text });
    }
    return turns;
  } catch (err) {
    console.error("Verity could not read the conversation:", err);
    return [];
  }
}

async function verityReply(args: ReplyArgs): Promise<string> {
  const loaded = await loadState();
  const day = currentDay(loaded, { dayMs, forceDay });
  const phase = phaseForDay(day);

  const seen = touch(loaded);
  void saveState(seen.state).catch((err) => console.error("Verity lost track of time:", err));

  if (!hasLLM()) return fallbackLine(phase);

  const system = buildSystemPrompt({
    day,
    phase,
    channel: await channelLabel(args.client, args.channel),
    localTime: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    silenceSeconds: seen.silenceSeconds,
    sessionMinutes: seen.sessionMinutes,
  });

  try {
    const history = await fetchHistory(args.client, args.channel, {
      threadTs: args.historyTs,
      currentTs: args.currentTs,
    });
    const reply = await generateReply(system, history, args.text);
    return reply || fallbackLine(phase);
  } catch (err) {
    console.error("Verity failed to reply:", err);
    return fallbackLine(phase);
  }
}

async function post(client: WebClient, channel: string, replyTs: string, text: string): Promise<void> {
  await client.chat.postMessage({ channel, thread_ts: replyTs, text });
}

app.event("app_mention", async ({ event, client }) => {
  const text = clean(event.text ?? "");
  if (!text) return;

  const replyTs = event.thread_ts ?? event.ts;
  const reply = await verityReply({
    client,
    channel: event.channel,
    historyTs: event.thread_ts,
    currentTs: event.ts,
    text,
  });
  await post(client, event.channel, replyTs, reply);
});

app.message(async ({ message, client }) => {
  const incoming = message as IncomingMessage;
  if (incoming.subtype) return;

  const raw = incoming.text ?? "";
  const text = clean(raw);
  if (!text) return;

  const isDM = incoming.channel_type === "im";
  if (!isDM && !(watchChannels && SUMMON.test(raw))) return;

  const channel = incoming.channel;
  if (!channel) return;

  const reply = await verityReply({
    client,
    channel,
    historyTs: incoming.thread_ts,
    currentTs: incoming.ts,
    text: isDM ? text : stripSummon(text),
  });
  await post(client, channel, incoming.thread_ts ?? incoming.ts ?? channel, reply);
});

app.command("/verity", async ({ ack, respond, command }) => {
  await ack();

  const state = await loadState();
  const day = currentDay(state, { dayMs, forceDay });
  const phase = phaseForDay(day);
  const info = PHASES[phase];
  const line = fallbackLine(phase);

  await respond({
    response_type: "ephemeral",
    text: `Verity — day ${day}: ${info.name}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${info.emoji} Verity™`, emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Day ${day} of ${TOTAL_DAYS}* · *${info.name}*\n${info.blurb}`,
        },
      },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `> ${line}` } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `backend: ${backend()}` }],
      },
    ],
  });
});

async function main(): Promise<void> {
  await app.start();

  const state = await loadState();
  const day = currentDay(state, { dayMs, forceDay });
  const phase = phaseForDay(day);

  console.log(`Verity™ is awake. Day ${day}/${TOTAL_DAYS} — ${PHASES[phase].name}.`);
  console.log(`Backend: ${backend()}`);
  if (!watchChannels) {
    console.log('Channel watcher off — enable with VERITY_WATCH_CHANNELS=true to answer "Hey Verity".');
  }
}

async function shutdown(): Promise<void> {
  try {
    await app.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
