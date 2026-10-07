export function total(items: { price: number; qty: number }[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.qty;
  }
  return Math.round(sum * 100) / 100;
}

export const isEmpty = (s: string) => s.trim().length === 0;
