import {
  buildCompositeBandsProps,
  CompositeBands,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { RenderTileResult } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import { buildMultiBandTile, type MultiBandTileData } from "../../../render/shared-textures";
import { tileLoadEnd, tileLoadStart } from "../../../render/tile-activity";
import { reportTileError, reportTileResult } from "../../tile-error";

const log = createLogger("tiles");

/** Tile loader for an int8/uint8 RGB(A) composite. The layer's selection leaves
 * the band dim whole (`null`); for RGBA we narrow it to the first three bands
 * so the alpha band is never fetched, and derive alpha as "any of R,G,B
 * non-zero" (missing/empty chunks are all-zero, hence transparent; a pixel
 * that is truly pure black becomes transparent too). Each plane becomes an
 * r8unorm texture. int8 is shifted by +128 onto 0..255 (the linear mapping of
 * its full range); uint8 is used as-is. */
export function makeRgbTileLoader(signed: boolean, nBands: 3 | 4) {
  return async function getTileData(
    arr: zarr.Array<zarr.DataType, zarr.Readable>,
    options: GetTileDataOptions,
  ): Promise<MultiBandTileData> {
    const { device, sliceSpec, signal, width, height } = options;
    tileLoadStart(options.z + 1);
    const readBands = nBands === 4 ? 3 : nBands;
    const bandSlot = sliceSpec.findIndex((s) => s === null);
    const spec = bandSlot < 0 ? sliceSpec : sliceSpec.map((s, i) => (i === bandSlot ? zarr.slice(0, readBands) : s));
    let chunk: Awaited<ReturnType<typeof zarr.get>>;
    try {
      chunk = await zarr.get(arr as zarr.Array<zarr.NumberDataType, zarr.Readable>, spec, { signal });
    } catch (err) {
      tileLoadEnd();
      reportTileError(err);
      log.debug(`rgb tile ${options.x},${options.y},${options.z} failed`, err);
      throw err;
    }
    tileLoadEnd();
    reportTileResult(true);
    const [bands, h, w] = chunk.shape;
    if (chunk.shape.length !== 3 || bands !== readBands || h !== height || w !== width) {
      throw new Error(
        `RGB tile expected [${readBands},${height},${width}]; got [${chunk.shape.join(",")}]`,
      );
    }
    const src = chunk.data as Uint8Array | Int8Array;
    const plane = width * height;
    const planes = Array.from({ length: readBands }, (_, i) => {
      const out = new Uint8Array(plane);
      const base = i * plane;
      if (signed) for (let j = 0; j < plane; j++) out[j] = src[base + j]! + 128;
      else for (let j = 0; j < plane; j++) out[j] = src[base + j]!;
      return { key: String(i + 1), data: out };
    });
    if (nBands === 4) {
      const alpha = new Uint8Array(plane);
      for (let j = 0; j < plane; j++) {
        if (src[j]! | src[plane + j]! | src[2 * plane + j]!) alpha[j] = 255;
      }
      planes.push({ key: "4", data: alpha });
    }
    return buildMultiBandTile(device, planes, width, height, null);
  };
}

/** Draw the band textures straight to RGB(A) (no colormap / rescale). */
export function buildRgbRenderTile(nBands: 3 | 4) {
  return function renderTile(data: MultiBandTileData): RenderTileResult {
    const props = buildCompositeBandsProps(nBands === 4 ? { r: "1", g: "2", b: "3", a: "4" } : { r: "1", g: "2", b: "3" },
      data.bands,);
    return { renderPipeline: [{ module: CompositeBands, props }] };
  };
}
