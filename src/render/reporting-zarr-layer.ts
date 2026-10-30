import type { Layer } from "@deck.gl/core";
import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";
import { reportDisplayedTiles } from "./tile-activity";

type TilesetCtor = new (...args: never[]) => { getPixelRatio: () => number };
const scaledTilesets = new WeakMap<TilesetCtor, Map<number, TilesetCtor>>();

/** Subclass `Base` so its LOD pixel ratio is multiplied by `scale`. The tileset
 * picks the coarsest level whose source pixel is <= 1 device pixel, using the
 * drawing-buffer/CSS ratio; `scale` 0.5 therefore selects one pyramid level
 * coarser (4x fewer pixels per view). Memoized: deck.gl treats a new
 * `TilesetClass` identity as a reason to rebuild the tileset. */
function scaledTileset(Base: TilesetCtor, scale: number): TilesetCtor {
  let byScale = scaledTilesets.get(Base);
  if (!byScale) scaledTilesets.set(Base, (byScale = new Map()));
  let Scaled = byScale.get(scale);
  if (!Scaled) {
    Scaled = class extends Base {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        super(...(args as never[]));
        const base = this.getPixelRatio;
        this.getPixelRatio = () => base() * scale;
      }
    };
    byScale.set(scale, Scaled);
  }
  return Scaled;
}

/** A `ZarrLayer` that also reports which pyramid level is currently DISPLAYED,
 * so the level badge stays accurate when revisiting an already-cached zoom.
 *
 * Why a subclass: `@developmentseed/deck.gl-raster`'s `RasterTileLayer` (the
 * base of `ZarrLayer`) builds its inner deck.gl `TileLayer` from a fixed prop
 * list and never forwards `onViewportLoad`. The badge's level was therefore
 * driven only by the tile loader (`getTileData`), which deck calls on cache
 * misses only — so panning/zooming back into cached tiles left it stale.
 *
 * deck.gl fires `TileLayer.onViewportLoad(selectedTiles)` on every viewport
 * change once the selected tiles are loaded — including cache hits (see
 * `_updateTileset`'s `tilesetChanged` path). `renderLayers()` returns that
 * inner TileLayer, so we clone it to attach the callback. The callback target
 * is fixed (`reportDisplayedTiles`); this layer exists purely to wire it. */
export class ReportingZarrLayer<
  Store extends zarr.Readable = zarr.Readable,
  Dtype extends zarr.DataType = zarr.DataType,
  DataT extends MinimalTileData = MinimalTileData,
> extends ZarrLayer<Store, Dtype, DataT> {
  static layerName = "ReportingZarrLayer";

  renderLayers(): Layer | null {
    // RasterTileLayer.renderLayers returns the inner deck.gl TileLayer (or null
    // while the source is still loading).
    const rendered = super.renderLayers();
    if (!rendered) return rendered;
    // The inner layer is a deck.gl TileLayer, which supports `onViewportLoad`,
    // but ZarrLayer's prop types don't expose it — hence the loose clone arg.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Optional `tileLodScale` prop (not in ZarrLayer's types; passed via a cast)
    // trades sharpness for fewer/lighter tiles — see `scaledTileset`.
    const scale = (this.props as { tileLodScale?: number }).tileLodScale;
    const overrides: Record<string, unknown> = { onViewportLoad: reportDisplayedTiles };
    if (scale && scale !== 1) {
      overrides.TilesetClass = scaledTileset(
        (rendered as unknown as { props: { TilesetClass: TilesetCtor } }).props.TilesetClass,
        scale,
      );
    }
    return (rendered as any).clone(overrides);
  }
}
