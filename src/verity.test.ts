import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRequest, wireFor } from "./llm.js";
import { currentDay, touch, type VerityState } from "./state.js";
import { GREETING, PHASES, buildSystemPrompt, fallbackLine, phaseForDay } from "./verity.js";

test("phaseForDay maps the six-day arc", () => {
  assert.equal(phaseForDay(1), 1);
  assert.equal(phaseForDay(2), 2);
  assert.equal(phaseForDay(3), 3);
  assert.equal(phaseForDay(4), 3);
  assert.equal(phaseForDay(5), 4);
  assert.equal(phaseForDay(6), 4);
  assert.equal(phaseForDay(99), 4);
  assert.equal(phaseForDay(0), 1);
  assert.equal(phaseForDay(-5), 1);
  assert.equal(phaseForDay(Number.NaN), 1);
});

test("currentDay derives day from elapsed time", () => {
  const dayMs = 60_000;
  const fresh: VerityState = { installedAt: new Date().toISOString() };
  assert.equal(currentDay(fresh, { dayMs }), 1);

  const aged: VerityState = { installedAt: new Date(Date.now() - 5 * dayMs).toISOString() };
  assert.equal(currentDay(aged, { dayMs }), 6);
});

test("currentDay honours forceDay", () => {
  const state: VerityState = { installedAt: new Date().toISOString() };
  assert.equal(currentDay(state, { dayMs: 1, forceDay: 4 }), 4);
});

test("buildSystemPrompt carries the phase directive and live context", () => {
  const prompt = buildSystemPrompt({
    day: 4,
    phase: 3,
    channel: "#laboratory",
    localTime: "3:14 AM",
  });
  assert.match(prompt, /PHASE 3/);
  assert.match(prompt, /#laboratory/);
  assert.match(prompt, /3:14 AM/);
  assert.match(prompt, /Verity/);
});

test("prompt reveals silence and session only once they are meaningful", () => {
  const quiet = buildSystemPrompt({ day: 3, phase: 3, silenceSeconds: 12, sessionMinutes: 0 });
  assert.doesNotMatch(quiet, /silent for/);

  const watched = buildSystemPrompt({ day: 3, phase: 3, silenceSeconds: 47, sessionMinutes: 9 });
  assert.match(watched, /silent for 47 seconds/);
  assert.match(watched, /9 minutes/);
});

test("the horror voice block is in every prompt", () => {
  const prompt = buildSystemPrompt({ day: 1, phase: 1 });
  assert.match(prompt, /HOW TO BE FRIGHTENING/);
  assert.match(prompt, /never break character/i);
});

test("every phase has scripted fallback lines", () => {
  for (const phase of [1, 2, 3, 4] as const) {
    const line = fallbackLine(phase, () => 0);
    assert.ok(line.length > 0);
    assert.equal(PHASES[phase].id, phase);
  }
  assert.ok(GREETING.includes("I know everything"));
});

test("touch reports how long Verity was left alone", () => {
  const now = Date.parse("2026-10-16T12:00:00.000Z");

  const first = touch({ installedAt: new Date(now).toISOString() }, now);
  assert.equal(first.silenceSeconds, 0);
  assert.equal(first.state.lastSeenAt, new Date(now).toISOString());

  const back = touch(first.state, now + 90_000);
  assert.equal(back.silenceSeconds, 90);
  assert.equal(back.sessionMinutes, 2);
  assert.equal(back.state.firstSeenAt, first.state.firstSeenAt);

  const keptGoing = touch(back.state, now + 290_000);
  assert.equal(keptGoing.silenceSeconds, 200);
  assert.equal(keptGoing.sessionMinutes, 5);
  assert.equal(keptGoing.state.firstSeenAt, first.state.firstSeenAt);
});

test("a long gap starts a new conversation", () => {
  const now = Date.parse("2026-10-16T12:00:00.000Z");
  const earlier = touch({ installedAt: new Date(now).toISOString() }, now);
  const later = touch(earlier.state, now + 60 * 60_000);

  assert.ok(later.silenceSeconds >= 3600);
  assert.equal(later.sessionMinutes, 0);
  assert.notEqual(later.state.firstSeenAt, earlier.state.firstSeenAt);
});

test("wireFor picks the Anthropic wire for claude models", () => {
  const saved = process.env.VERITY_WIRE;
  delete process.env.VERITY_WIRE;
  try {
    assert.equal(wireFor("claude-sonnet-4-6"), "anthropic");
    assert.equal(wireFor("deepseek/deepseek-v4-flash"), "openai");
    assert.equal(wireFor("z-ai/glm-5.3-flash"), "openai");
  } finally {
    if (saved !== undefined) process.env.VERITY_WIRE = saved;
  }
});

test("buildRequest targets the right Provider API endpoints", () => {
  const history: { role: "assistant"; content: string }[] = [{ role: "assistant", content: "hello" }];

  const anthropic = buildRequest(
    "anthropic",
    "https://api.commandcode.ai/provider/v1",
    "claude-sonnet-4-6",
    "system",
    history,
    "hi",
  );
  assert.equal(anthropic.url, "https://api.commandcode.ai/provider/v1/messages");
  assert.equal(anthropic.body["system"], "system");

  const openai = buildRequest(
    "openai",
    "https://api.commandcode.ai/provider/v1",
    "deepseek/deepseek-v4-flash",
    "system",
    history,
    "hi",
  );
  assert.equal(openai.url, "https://api.commandcode.ai/provider/v1/chat/completions");
  const messages = openai.body["messages"] as unknown[];
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], { role: "system", content: "system" });
  assert.deepEqual(messages[2], { role: "user", content: "hi" });
});
