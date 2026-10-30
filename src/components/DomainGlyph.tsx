import type { Glyph } from "@/lib/ui/domains";
import { BookOpen, Broadcast, Controller, Film, Note, Screen, Spark, Vinyl } from "./Icons";

/** Domain glyph from the shared icon family; unknown domains get a neutral spark. */
export function DomainGlyph({ glyph, size = 20 }: { glyph: Glyph; size?: number }) {
  switch (glyph) {
    case "film":
      return <Film size={size} />;
    case "book":
      return <BookOpen size={size} />;
    case "vinyl":
      return <Vinyl size={size} />;
    case "note":
      return <Note size={size} />;
    case "screen":
      return <Screen size={size} />;
    case "controller":
      return <Controller size={size} />;
    case "mic":
      return <Broadcast size={size} />;
    default:
      return <Spark size={size} />;
  }
}
