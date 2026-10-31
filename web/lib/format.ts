const usdFmt = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const intFmt = new Intl.NumberFormat("pt-BR");

export const usd = (n: number) => usdFmt.format(n);
export const int = (n: number) => intFmt.format(Math.round(n));
export const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString("pt-BR", { hour12: false });
};
export const shortHash = (h: string) => h.slice(0, 7);
