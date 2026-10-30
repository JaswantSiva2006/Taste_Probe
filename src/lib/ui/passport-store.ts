"use client";

import { useSyncExternalStore } from "react";
import { SavedDiscoverySchema, type SavedDiscovery } from "@/lib/contracts";

/**
 * S9.13 Sound Passport: the user's saved recordings, browser-local only.
 * - Stores exactly the S9.12 canonical SavedDiscovery records (artist + verified video
 *   reference + anchor), keyed by videoId. No tokens, credentials or model context.
 * - Every read re-validates; corrupt or unknown entries are dropped, never trusted.
 * - Storage may be unavailable (private mode, blocked, full): the Passport then lives
 *   in memory for this tab and says so.
 * - Retention: titles/channels learned from the YouTube Data API are shown for 30 days
 *   from saving, then hidden (the video reference itself is kept and still opens).
 */

export const PASSPORT_KEY = "tasteprobe.passport.v1";
export const MAX_ITEMS = 200;
const DATA_API_METADATA_DAYS = 30;

type Snapshot = { items: SavedDiscovery[]; persistent: boolean };
const EMPTY: Snapshot = { items: [], persistent: true };

let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = "__tp_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/** Parses stored JSON into valid, deduplicated, newest-first records. */
export function parsePassport(raw: string | null): SavedDiscovery[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (data as { v?: unknown; items?: unknown })?.v === 1 && Array.isArray((data as { items: unknown[] }).items) ? (data as { items: unknown[] }).items : [];
  const seen = new Set<string>();
  const out: SavedDiscovery[] = [];
  for (const item of list) {
    const parsed = SavedDiscoverySchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.video.videoId)) continue;
    seen.add(parsed.data.video.videoId);
    out.push(parsed.data);
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, MAX_ITEMS);
}

function read(): Snapshot {
  if (typeof window === "undefined") return EMPTY;
  const s = storage();
  if (!s) return { items: snapshot?.items ?? [], persistent: false };
  return { items: parsePassport(s.getItem(PASSPORT_KEY)), persistent: true };
}

function write(items: SavedDiscovery[]): void {
  const s = storage();
  let persistent = Boolean(s);
  if (s) {
    try {
      s.setItem(PASSPORT_KEY, JSON.stringify({ v: 1, items }));
    } catch {
      persistent = false; // quota exceeded: keep this tab's copy, report it honestly
    }
  }
  snapshot = { items, persistent };
  listeners.forEach((l) => l());
}

function current(): Snapshot {
  snapshot ??= read();
  return snapshot;
}

export const passport = {
  /** Adds new records from the server's verified `listening.saved`; existing videoIds are kept as first saved. */
  merge(records: SavedDiscovery[]): number {
    const items = current().items;
    const known = new Set(items.map((i) => i.video.videoId));
    const fresh = records.filter((r) => SavedDiscoverySchema.safeParse(r).success && !known.has(r.video.videoId));
    if (fresh.length) write([...fresh, ...items].slice(0, MAX_ITEMS));
    return fresh.length;
  },
  remove(videoId: string): void {
    write(current().items.filter((i) => i.video.videoId !== videoId));
  },
  clear(): void {
    write([]);
  },
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PASSPORT_KEY) {
      snapshot = read();
      listeners.forEach((l) => l());
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePassport(): Snapshot {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}

/** Title/channel to display, or null when Data API metadata is past its retention window. */
export function displayMetadata(item: SavedDiscovery, now = Date.now()): { title: string; channel: string } | null {
  if (item.video.provenance !== "youtube_data_api") return { title: item.video.title, channel: item.video.channelTitle };
  const age = now - Date.parse(item.savedAt);
  return Number.isFinite(age) && age <= DATA_API_METADATA_DAYS * 86_400_000 ? { title: item.video.title, channel: item.video.channelTitle } : null;
}

/** Plain-text summary for "Copy my Passport". */
export function passportSummary(items: SavedDiscovery[]): string {
  const lines = items.map((i) => {
    const meta = displayMetadata(i);
    return `• ${meta ? `${meta.title} — ` : ""}${i.artist.name} (from ${i.anchor.name}) ${i.video.watchUrl}`;
  });
  return [`My TasteProbe Sound Passport — ${items.length} recording${items.length === 1 ? "" : "s"}`, ...lines].join("\n");
}
