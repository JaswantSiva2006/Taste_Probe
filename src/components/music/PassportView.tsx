"use client";

import { useState } from "react";
import type { SavedDiscovery } from "@/lib/contracts";
import { displayMetadata, passport, passportSummary, usePassport } from "@/lib/ui/passport-store";
import { ArrowRight, Cross, ExternalLink, PassportIcon } from "../Icons";
import { VinylDisc } from "./VinylDisc";

/**
 * S9.13 Sound Passport — the recordings this person chose to keep, on this device.
 * Each entry is the S9.12 SavedDiscovery: Qloo artist + verified YouTube video
 * reference + the cultural starting point. Thumbnails are YouTube's own, unmodified,
 * labelled as video thumbnails (not album art), and link to the video.
 */

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const thumb = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

export function PassportView({ onContinue, onStart }: { onContinue: (() => void) | null; onStart: () => void }) {
  const { items, persistent } = usePassport();
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const [announce, setAnnounce] = useState("");
  const anchors = [...new Set(items.map((i) => i.anchor.name))];
  const artists = [...new Set(items.map((i) => i.artist.qlooId))];

  const remove = (item: SavedDiscovery) => {
    passport.remove(item.video.videoId);
    setAnnounce(`Removed ${displayMetadata(item)?.title ?? "the recording"} by ${item.artist.name}.`);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(passportSummary(items));
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  };

  return (
    <section className="sp-passport" aria-labelledby="sp-passport-title">
      <header className="sp-passport__head">
        <div>
          <p className="sp-kicker">
            <PassportIcon size={16} /> Sound Passport
          </p>
          <h1 className="sp-passport__title" id="sp-passport-title" tabIndex={-1}>
            {items.length ? "The sounds you discovered." : "Your Passport is ready for its first stamp."}
          </h1>
          <p className="sp-passport__lede">
            {items.length
              ? `${items.length} recording${items.length === 1 ? "" : "s"} by ${artists.length} artist${artists.length === 1 ? "" : "s"}, found from ${anchors.slice(0, 3).join(", ")}${anchors.length > 3 ? ` and ${anchors.length - 3} more` : ""}. Kept on this device only — no account, no playlist.`
              : "Every recording you save while listening lands here, with where your journey started. Nothing is saved unless you choose it."}
          </p>
        </div>
        <div className="sp-passport__actions">
          {onContinue ? (
            <button type="button" className="sp-btn sp-btn--primary" onClick={onContinue}>
              Continue listening <ArrowRight size={16} />
            </button>
          ) : (
            <button type="button" className="sp-btn sp-btn--primary" onClick={onStart}>
              Start exploring <ArrowRight size={16} />
            </button>
          )}
          {items.length ? (
            <button type="button" className="sp-btn sp-btn--quiet" onClick={copy}>
              {copied === "ok" ? "Copied" : "Copy as text"}
            </button>
          ) : null}
        </div>
      </header>

      {!persistent ? (
        <p className="sp-passport__warn" role="note">
          This browser isn’t letting TasteProbe store data, so your Passport will only last until you close this tab.
        </p>
      ) : null}
      {copied === "fail" ? (
        <p className="sp-passport__warn" role="alert">
          Couldn’t copy to the clipboard in this browser.
        </p>
      ) : null}
      <p className="tp-sr" role="status" aria-live="polite">
        {announce}
      </p>

      {items.length ? (
        <>
          <ol className="sp-crate">
            {items.map((item, i) => {
              const meta = displayMetadata(item);
              return (
                <li key={item.video.videoId} className="sp-sleeve" style={{ ["--i" as string]: i }}>
                  <div className="sp-sleeve__art">
                    <span className="sp-sleeve__record" aria-hidden="true" />
                    <a className="sp-sleeve__cover" href={item.video.watchUrl} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element -- YouTube's own thumbnail, shown unmodified */}
                      <img src={thumb(item.video.videoId)} alt={`YouTube video thumbnail: ${meta?.title ?? "recording"} by ${item.artist.name}`} width={320} height={180} loading="lazy" decoding="async" />
                      <span className="sp-sleeve__badge" aria-hidden="true">YouTube video</span>
                    </a>
                  </div>
                  <div className="sp-sleeve__body">
                    <p className="sp-sleeve__stamp">From {item.anchor.name}</p>
                    <h2 className="sp-sleeve__title">{meta?.title ?? "Recording on YouTube"}</h2>
                    <p className="sp-sleeve__artist">{item.artist.name}</p>
                    <p className="sp-sleeve__meta">
                      {meta ? `${meta.channel} · ` : ""}saved {dateFmt.format(new Date(item.savedAt))}
                    </p>
                    <div className="sp-sleeve__actions">
                      <a className="sp-link" href={item.video.watchUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={14} /> Listen on YouTube
                      </a>
                      <button type="button" className="sp-link sp-link--muted" onClick={() => remove(item)} aria-label={`Remove ${meta?.title ?? "recording"} by ${item.artist.name} from your Passport`}>
                        <Cross size={14} /> Remove
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          <footer className="sp-passport__foot">
            <p>Thumbnails and titles come from YouTube; artists were suggested by Qloo. Saved recordings stay on this device until you remove them.</p>
            {confirmClear ? (
              <div className="sp-passport__clear" role="group" aria-label="Confirm clearing your Passport">
                <span>Remove all {items.length}?</span>
                <button
                  type="button"
                  className="sp-btn sp-btn--danger"
                  onClick={() => {
                    passport.clear();
                    setConfirmClear(false);
                    setAnnounce("Your Sound Passport is now empty.");
                  }}
                >
                  Yes, clear Passport
                </button>
                <button type="button" className="sp-btn sp-btn--quiet" onClick={() => setConfirmClear(false)}>
                  Keep them
                </button>
              </div>
            ) : (
              <button type="button" className="sp-link sp-link--muted" onClick={() => setConfirmClear(true)}>
                Clear Passport…
              </button>
            )}
          </footer>
        </>
      ) : (
        <div className="sp-passport__empty">
          <div className="sp-passport__empty-art">
            <span className="sp-sleeve__ghost" aria-hidden="true" />
            <VinylDisc state="idle" seed="empty-passport" artist="Your first discovery" title="waiting to be found" size="md" tonearm={false} />
          </div>
          <p>Start with a film you love, hear an artist you’ve never met, and press “Save to Passport” on anything that stays with you.</p>
        </div>
      )}
    </section>
  );
}
