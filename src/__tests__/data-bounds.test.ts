import { describe, expect, it } from "vitest";
import {
  boundsFromEpsgCode,
  boundsFromProjection,
  geographicBounds,
  mercatorBounds,
  projectedBounds,
} from "../zarr/data-bounds";

describe("geographicBounds (degrees)", () => {
  it("builds W/S/E/N from a north-first (descending-lat) affine", () => {
    // 400 lon × 200 lat, 0.25° step, top-left at (-10, 50), lat descending.
    const b = geographicBounds([0.25, 0, -10, 0, -0.25, 50], [200, 400]);
    expect(b).not.toBeNull();
    // west, south, east, north
    expect(b![0]).toBeCloseTo(-10, 6); // west
    expect(b![1]).toBeCloseTo(0, 6); // south = 50 - 0.25*200
    expect(b![2]).toBeCloseTo(90, 6); // east = -10 + 0.25*400
    expect(b![3]).toBeCloseTo(50, 6); // north
  });

  it("returns null on a malformed transform/shape", () => {
    expect(geographicBounds([0.25, 0, -10], [200, 400])).toBeNull();
    expect(geographicBounds([0, 0, -10, 0, -0.25, 50], [200, 400])).toBeNull(); // stepX 0
    expect(geographicBounds([0.25, 0, -10, 0, -0.25, 50], [0, 400])).toBeNull(); // height 0
  });
});

describe("mercatorBounds (EPSG:3857 metres)", () => {
  it("inverts the full web-mercator world to ~[-180,-85.05,180,85.05]", () => {
    const M = 20037508.342789244; // half the 3857 world span
    // One-cell affine spanning the whole 3857 extent, north-first.
    const b = mercatorBounds([2 * M, 0, -M, 0, -2 * M, M], [1, 1]);
    expect(b).not.toBeNull();
    expect(b![0]).toBeCloseTo(-180, 4); // west
    expect(b![1]).toBeCloseTo(-85.051129, 4); // south
    expect(b![2]).toBeCloseTo(180, 4); // east
    expect(b![3]).toBeCloseTo(85.051129, 4); // north
  });
});

// A GRIB-sphere Lambert Conformal Conic like NOAA HRRR (CONUS 3 km).
const HRRR_LCC_WKT = `PROJCS["unnamed",GEOGCS["Coordinate System imported from GRIB file",DATUM["unnamed",SPHEROID["Sphere",6371229,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",38.5],PARAMETER["central_meridian",-97.5],PARAMETER["standard_parallel_1",38.5],PARAMETER["standard_parallel_2",38.5],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]`;

describe("projectedBounds (WKT2 reprojection)", () => {
  it("reprojects an HRRR-style LCC CONUS extent to a plausible lng/lat bbox", () => {
    // ~1799×1059 cells at 3 km, top-left origin, y descending.
    const transform = [3000, 0, -2699020, 0, -3000, 1588806];
    const shape = [1059, 1799];
    const b = projectedBounds(transform, shape, HRRR_LCC_WKT);
    expect(b).not.toBeNull();
    const [w, s, e, n] = b!;
    expect([w, s, e, n].every(Number.isFinite)).toBe(true);
    // Ordered and inside the globe.
    expect(w).toBeLessThan(e);
    expect(s).toBeLessThan(n);
    expect(w).toBeGreaterThan(-180);
    expect(e).toBeLessThan(0); // CONUS is western hemisphere
    expect(s).toBeGreaterThan(10);
    expect(n).toBeLessThan(60);
    // Roughly CONUS: west of the Rockies to the eastern seaboard, ~Mexico to Canada.
    expect(w).toBeLessThan(-100);
    expect(e).toBeGreaterThan(-80);
    expect(s).toBeLessThan(30);
    expect(n).toBeGreaterThan(45);
  });

  it("returns null on an empty or unparseable WKT", () => {
    const transform = [3000, 0, -2699020, 0, -3000, 1588806];
    const shape = [1059, 1799];
    expect(projectedBounds(transform, shape, "")).toBeNull();
    expect(projectedBounds(transform, shape, "not a wkt string")).toBeNull();
  });
});

describe("boundsFromProjection (explicit projection fn)", () => {
  it("with an identity projection matches geographicBounds", () => {
    const transform = [0.25, 0, -10, 0, -0.25, 50];
    const shape = [200, 400];
    const identity = (x: number, y: number): [number, number] => [x, y];
    expect(boundsFromProjection(transform, shape, identity)).toEqual(
      geographicBounds(transform, shape),
    );
  });

  it("returns null on a malformed transform/shape", () => {
    const identity = (x: number, y: number): [number, number] => [x, y];
    expect(boundsFromProjection([0.25, 0, -10], [200, 400], identity)).toBeNull();
  });

  it("returns null when the projection throws", () => {
    const boom = (): [number, number] => {
      throw new Error("nope");
    };
    expect(boundsFromProjection([1, 0, 0, 0, -1, 10], [10, 10], boom)).toBeNull();
  });
});

describe("boundsFromEpsgCode (proj4 built-in EPSG definitions)", () => {
  it("EPSG:4326 matches geographicBounds (no network, direct shortcut)", () => {
    const transform = [0.25, 0, -10, 0, -0.25, 50];
    const shape = [200, 400];
    expect(boundsFromEpsgCode(transform, shape, "EPSG:4326")).toEqual(
      geographicBounds(transform, shape),
    );
  });

  it("EPSG:32601 (UTM zone 1 north) reprojects to a plausible lng/lat bbox", () => {
    // utm01 extent from OlmoEarth: [0, -9175040, 983040, 9502720] in UTM metres.
    // Affine: step=10 m/px, origin (0, 9502720), shape [1867776, 98304].
    const transform = [10, 0, 0, 0, -10, 9502720];
    const shape = [1867776, 98304];
    const b = boundsFromEpsgCode(transform, shape, "EPSG:32601");
    expect(b).not.toBeNull();
    const [w, s, e, n] = b!;
    expect([w, s, e, n].every(Number.isFinite)).toBe(true);
    expect(s).toBeLessThan(n);
    // UTM zone 1 straddles the anti-meridian (180°W = 180°E). The western
    // extent (easting ≈ 0 m) maps to ~178°E (positive longitude) in the
    // [-180, 180] range, so transformBounds produces a wide span: w ≈ -177,
    // e ≈ 179. The bounds are finite and cover most of the globe.
    expect(w).toBeGreaterThan(-180);
    expect(e).toBeGreaterThan(170); // wraps to near +180
    // North/south extent covers most of the globe for this dataset.
    expect(s).toBeLessThan(-70);
    expect(n).toBeGreaterThan(70);
  });

  it("returns null for an EPSG code not in proj4's built-in registry", () => {
    const transform = [10, 0, 0, 0, -10, 100];
    const shape = [10, 10];
    expect(boundsFromEpsgCode(transform, shape, "EPSG:99999")).toBeNull();
  });

  it("returns null on a malformed transform", () => {
    expect(boundsFromEpsgCode([10, 0], [10, 10], "EPSG:32601")).toBeNull();
  });
});
