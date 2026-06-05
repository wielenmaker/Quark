export const FLIP_OLD_FRAME = 0
export const FLIP_TOP_FRAME = 1
export const FLIP_BOTTOM_FRAME = 2
export const FLIP_DONE_FRAME = 3
export const FLIP_PERCENT_INTERVAL_MS = 70

export function tokenPercentValue(used: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.round((used / limit) * 1000) / 10
}

export function shouldAnimateTokenPercent(from: number, to: number): boolean {
  return to > from
}

export function tokenPercentText(value: number): string {
  return `${value.toFixed(1)}%`
}

const TOP_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹"
const BOTTOM_DIGITS = "₀₁₂₃₄₅₆₇₈₉"

function rollDigit(char: string, digits: string): string {
  const n = char.charCodeAt(0) - 48
  return n >= 0 && n <= 9 ? digits[n]! : char
}

export function flipPercentText(from: number, to: number, frame: number): string {
  if (frame >= FLIP_DONE_FRAME) return tokenPercentText(to)

  const prev = tokenPercentText(from)
  const next = tokenPercentText(to)
  const width = Math.max(prev.length, next.length)
  const a = prev.padStart(width)
  const b = next.padStart(width)

  if (frame <= FLIP_OLD_FRAME) return a

  let out = ""
  for (let i = 0; i < width; i++) {
    if (a[i] === b[i]) {
      out += b[i]
    } else {
      out += frame === FLIP_TOP_FRAME ? rollDigit(a[i]!, TOP_DIGITS) : rollDigit(b[i]!, BOTTOM_DIGITS)
    }
  }
  return out
}
