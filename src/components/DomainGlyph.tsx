import type { Glyph } from "@/lib/ui/domains";
import { BookOpen, Controller, Mic, Reel, Screen, Spark, Vinyl } from "./Icons";

/** Domain glyph from the shared icon family; unknown domains get a neutral spark. */
export function DomainGlyph({ glyph, size = 20 }: { glyph: Glyph; size?: number }) {
  switch (glyph) {
    case "film":
      return <Reel size={size} />;
    case "book":
      return <BookOpen size={size} />;
    case "vinyl":
      return <Vinyl size={size} />;
    case "screen":
      return <Screen size={size} />;
    case "controller":
      return <Controller size={size} />;
    case "mic":
      return <Mic size={size} />;
    default:
      return <Spark size={size} />;
  }
}
