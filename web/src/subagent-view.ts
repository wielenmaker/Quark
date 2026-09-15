export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  const value = tokens / 1_000
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`
}

export function tokenPercentage(tokensUsed: number, tokenLimit: number): number {
  if (tokenLimit <= 0) return 0
  return Math.min(100, tokensUsed / tokenLimit * 100)
}
