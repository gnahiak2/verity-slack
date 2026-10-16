import { readFile, writeFile } from "node:fs/promises";

export interface VerityState {
  installedAt: string;
}

export interface DayOptions {
  dayMs?: number;
  forceDay?: number;
}

const DEFAULT_DAY_MS = 86_400_000;

function stateFile(): string {
  return process.env.VERITY_STATE_FILE ?? ".verity-state.json";
}

export async function loadState(file = stateFile()): Promise<VerityState> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<VerityState>;
    if (typeof parsed.installedAt === "string" && Number.isFinite(Date.parse(parsed.installedAt))) {
      return { installedAt: parsed.installedAt };
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
