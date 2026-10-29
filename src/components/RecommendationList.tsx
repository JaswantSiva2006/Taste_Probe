import type { RankedRecommendation } from "@/lib/contracts";

function Movement({ item }: { item: RankedRecommendation }) {
  if (item.previousPosition === null) return null;
  const delta = item.previousPosition - item.position;
  if (delta === 0) return <span className="text-xs text-slate-400">no change</span>;
  return delta > 0 ? (
    <span className="text-xs font-semibold text-emerald-600">▲ {delta}</span>
  ) : (
    <span className="text-xs font-semibold text-rose-600">▼ {-delta}</span>
  );
}

export function RecommendationList({ items }: { items: RankedRecommendation[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item) => {
        const { candidate } = item;
        const isMock = candidate.evidence.source === "mock";
        return (
          <li
            key={candidate.entityId}
            className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">
                  <span className="mr-2 text-slate-400">#{item.position}</span>
                  {candidate.name}
                </p>
                {candidate.description && (
                  <p className="mt-0.5 text-sm text-slate-500">{candidate.description}</p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
                    isMock ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"
                  }`}
                >
                  {isMock ? "MOCK" : "QLOO"}
                </span>
                <Movement item={item} />
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {candidate.tags.map((t) => {
                const pos = item.matchedPositiveTagIds.includes(t.id);
                const neg = item.matchedRejectedTagIds.includes(t.id);
                return (
                  <span
                    key={t.id}
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      pos
                        ? "bg-emerald-100 text-emerald-800"
                        : neg
                          ? "bg-rose-100 text-rose-800 line-through"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {t.name}
                  </span>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {item.explanation} {isMock ? "Synthetic score" : "Score"}: {item.score.toFixed(3)}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
