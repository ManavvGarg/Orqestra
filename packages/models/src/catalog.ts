import { catalogSchema, type Catalog, type CatalogModel, type RuntimeKind } from "./types";
import seed from "../data/catalog.json" with { type: "json" };

export const seedCatalog: Catalog = catalogSchema.parse(seed);

export function findModel(catalog: Catalog, id: string): CatalogModel | undefined {
  return catalog.models.find((m) => m.id === id);
}

export interface FitInput {
  freeRamGB: number;
  freeVramGB: number;
  hasGPU: boolean;
}

export function fitsHost(model: CatalogModel, host: FitInput): boolean {
  if (model.minRamGB > host.freeRamGB) return false;
  if (host.hasGPU && model.minVramGB > host.freeVramGB) return false;
  return true;
}

export function preferredRuntimes(model: CatalogModel): RuntimeKind[] {
  return model.runtimes.map((r) => r.kind);
}
