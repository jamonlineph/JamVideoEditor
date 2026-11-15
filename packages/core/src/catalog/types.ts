export interface CatalogItem<D = Record<string, unknown>> {
  id: string;
  name: string;
  category: string;
  description?: string;
  data: D;
}
