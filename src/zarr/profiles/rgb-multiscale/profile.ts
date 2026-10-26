import * as zarr from "zarrita";
import { ReportingZarrLayer } from "../../../render/reporting-zarr-layer";
import type { MultiBandTileData } from "../../../render/shared-textures";
import { resolveCrsConverters } from "../../crs";
import { boundsFromProjection, geographicBounds, mercatorBounds } from "../../data-bounds";
import { openV3Group } from "../../load-zarr";
import { buildLayoutGeoZarrMetadata, type GeoZarrMetadata } from "../../multiscale";
import type { ProfileBaseContext, ZarrProfile } from "../../profile";
import { discoverPyramids } from "../multiscale-grid/discovery";
import { enumerateLayoutVariables } from "../multiscale-grid/profile";
import { buildRgbRenderTile, makeRgbTileLoader } from "./tile";

type RgbMultiscaleContext = ProfileBaseContext & {
  variable: string;
  /** "int8" | "uint8" */
  dtype: string;
  /** 3 = RGB, 4 = RGBA (4th band is alpha). */
  bands: 3 | 4;
  /** Non-band leading dims pinned to 0; the band dim is `null` (read whole). */
  selection: Record<string, number | null>;
  metadata: GeoZarrMetadata;
  levelCount: number;
  bounds: [number, number, number, number] | null;
};

/** RGB(A) composite stored as a GeoZarr multiscale pyramid: an int8/uint8
 * variable `[..., band, y, x]` with 3 (RGB) or 4 (RGBA) bands at every level.
 * Matched on dtype + shape, never on variable or band names. Select with
 * `?p=rgb-multiscale`. Discovery and metadata reuse the multiscale-grid
 * helpers. */
export const rgbMultiscaleProfile: ZarrProfile<object, RgbMultiscaleContext> = {
  id: "rgb-multiscale",
  label: "RGB composite (multiscale)",
  needsColormap: false,

  async prepare(url, signal, open = {}) {
    const opened = await openV3Group(url, { consolidated: true, ...open });
    const contents =
      (opened.store as { contents?: () => { path: string; kind: "array" | "group" }[] }).contents?.() ?? [];
    const src = (await discoverPyramids(opened, contents, signal)).find((s) => s.layout);
    if (!src?.layout) throw new Error("RGB composite: no multiscale `layout` pyramid found.");
    const layout = src.layout;
    const finest = layout.levels[0]!;
    const finestGroup = [src.prefix, finest.asset === "." ? "" : finest.asset].filter(Boolean).join("/");

    for (const f of await enumerateLayoutVariables(opened.group, finestGroup, contents)) {
      const band = f.dims[f.dims.length - 1];
      if (!(f.arr.dtype === "uint8" || f.arr.dtype === "int8") || (band?.size !== 3 && band?.size !== 4)) continue;
      const selection: Record<string, number | null> = {};
      for (const d of f.dims) selection[d.name] = 0;
      selection[band.name] = null;
      const metadata = buildLayoutGeoZarrMetadata({ layout, variable: f.name, subgroupPrefix: src.prefix });
      const t = finest["spatial:transform"];
      const shape = finest["spatial:shape"];
      const crs = await resolveCrsConverters({ code: src.crsCode, wkt2: src.crsWkt });
      const bounds = /4326|4269|4258/.test(src.crsCode ?? "")
        ? geographicBounds(t, shape)
        : src.crsCode === "EPSG:3857"
          ? mercatorBounds(t, shape)
          : crs
            ? boundsFromProjection(t, shape, crs.toLngLat)
            : null;
      return {
        url,
        group: opened.group,
        variable: f.name,
        dtype: f.arr.dtype,
        bands: band.size as 3 | 4,
        selection,
        metadata,
        levelCount: layout.levels.length,
        bounds,
      };
    }
    throw new Error(
      "RGB composite: no int8/uint8 variable with a 3- or 4-long band dim before y/x found in the pyramid.",
    );
  },

  initialState: () => ({}),
  parseUrlParams: () => ({}),
  serializeUrlParams: () => ({}),
  initialBounds: (ctx) => ctx.bounds,
  dataBounds: (ctx) => ctx.bounds,
  Controls: () => null,
  resolveNode: async (ctx) => ctx.group,
  pyramidLevelCount: (ctx) => ctx.levelCount,

  getStructure: (ctx) => ({
    zarrVersion: "v3",
    variables: [{ path: ctx.metadata.multiscales.layout[0]?.asset ?? ctx.variable, role: "finest" }],
    metadataSource: "synthesized",
    metadata: ctx.metadata,
  }),

  buildLayer({ ctx, chassisState, basemapBeforeId, node }) {
    if (!node) return null;
    return new ReportingZarrLayer<zarr.Readable, zarr.DataType, MultiBandTileData>({
      id: `rgb-multiscale-${ctx.variable}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: node as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: ctx.metadata as any,
      selection: ctx.selection,
      getTileData: makeRgbTileLoader(ctx.dtype === "int8", ctx.bands),
      renderTile: buildRgbRenderTile(ctx.bands),
      opacity: chassisState.opacity,
      maxRequests: 20,
      maxCacheSize: 64,
      ...({ beforeId: basemapBeforeId } as Record<string, unknown>),
    });
  },
};
