import { readFile, writeFile } from "node:fs/promises";

export interface VerityState {
  installedAt: string;
  lastSeenAt?: string;
  firstSeenAt?: string;
}

export interface DayOptions {
  dayMs?: number;
  forceDay?: number;
}

export interface TouchResult {
  state: VerityState;
  silenceSeconds: number;
  sessionMinutes: number;
}

const DEFAULT_DAY_MS = 86_400_000;
const SESSION_GAP_MS = 10 * 60_000;

function stateFile(): string {
  return process.env.VERITY_STATE_FILE ?? ".verity-state.json";
}

function validIso(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export async function loadState(file = stateFile()): Promise<VerityState> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<VerityState>;
    const installedAt = validIso(parsed.installedAt);
    if (installedAt) {
      return {
        installedAt,
        lastSeenAt: validIso(parsed.lastSeenAt),
        firstSeenAt: validIso(parsed.firstSeenAt),
      };
    }
  } catch {
    // First run, or unreadable state — start fresh.
  }
  const fresh: VerityState = { installedAt: new Date().toISOString() };
  await saveState(fresh, file);
  return fresh;
}

export async function saveState(state: VerityState, file = stateFile()): Promise<void> {
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function resetState(file = stateFile()): Promise<VerityState> {
  const fresh: VerityState = { installedAt: new Date().toISOString() };
  await saveState(fresh, file);
  return fresh;
}

export function currentDay(state: VerityState, opts: DayOptions = {}): number {
  if (opts.forceDay && opts.forceDay >= 1) return Math.floor(opts.forceDay);
  const dayMs = opts.dayMs && opts.dayMs > 0 ? opts.dayMs : DEFAULT_DAY_MS;
  const elapsed = Date.now() - Date.parse(state.installedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 1;
  return Math.max(1, Math.floor(elapsed / dayMs) + 1);
}

/**
 * Records a sighting and returns how long Verity was left alone. A gap longer than
 * SESSION_GAP_MS counts as a new conversation, so the session clock restarts.
 */
export function touch(state: VerityState, now = Date.now()): TouchResult {
  const nowIso = new Date(now).toISOString();

  if (!state.lastSeenAt) {
    return {
      state: { installedAt: state.installedAt, lastSeenAt: nowIso, firstSeenAt: nowIso },
      silenceSeconds: 0,
      sessionMinutes: 0,
    };
  }

  const lastMs = Date.parse(state.lastSeenAt);
  const gapMs = Number.isFinite(lastMs) ? Math.max(0, now - lastMs) : 0;
  const newSession = gapMs > SESSION_GAP_MS;
  const firstSeenAt =
    newSession || !state.firstSeenAt ? nowIso : (state.firstSeenAt as string);
  const sessionMs = Math.max(0, now - Date.parse(firstSeenAt));

  return {
    state: { installedAt: state.installedAt, lastSeenAt: nowIso, firstSeenAt },
    silenceSeconds: Math.round(gapMs / 1000),
    sessionMinutes: Number.isFinite(sessionMs) ? Math.round(sessionMs / 60_000) : 0,
  };
}
