export interface LineItem {
  sku: string;
  quantity: number;
  unitCents: number;
}

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.quantity * i.unitCents, 0);
}

export function applyTax(cents: number, rate: number): number {
  return Math.round(cents * (1 + rate));
}
