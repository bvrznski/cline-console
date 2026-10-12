export function formatTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "--";
  if (value < 1_000) return Math.trunc(value).toString();
  if (value < 1_000_000) return `${trim(value / 1_000)}K`;
  if (value < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000)}B`;
}

function trim(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "");
}
