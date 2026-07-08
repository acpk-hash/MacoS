// Normalize LaTeX math delimiters so KaTeX (remark-math) renders every common
// form the model emits. remark-math only understands `$...$` / `$$...$$`, but
// models frequently output `\(...\)` (inline) and `\[...\]` (block). We
// rewrite those to the dollar forms *before* markdown parsing.
//
// Design goals / edge cases:
//   1. Never touch content inside fenced code blocks (``` / ~~~) or inline code
//      spans (`...`) - a stray `\(` in a code sample must stay literal.
//   2. Respect escaping: `\\(` is an escaped backslash followed by `(`, not an
//      inline-math opener, so it must be left alone.
//   3. Streaming-safe: a half-typed `\(` / `\[` with no matching close is
//      left untouched so partial formulas don't get corrupted mid-stream.
//
// The rewrite only swaps the delimiters; the KaTeX body is passed through
// verbatim.

/**
 * Rewrite `\(...\)` -> `$...$` and `\[...\]` -> `$$...$$` outside of code
 * regions, honoring backslash-escaping and leaving unclosed openers intact.
 */
export function normalizeMathDelimiters(md: string): string {
  if (!md || md.indexOf('\\') === -1) return md

  let out = ''
  let i = 0
  const n = md.length

  // True if `pos` is the first non-blank char of its line (fences are only
  // recognized at line start).
  const atLineStart = (pos: number): boolean => {
    let j = pos - 1
    while (j >= 0 && (md[j] === ' ' || md[j] === '\t')) j--
    return j < 0 || md[j] === '\n'
  }

  while (i < n) {
    const c = md[i]

    // Fenced code block: ``` or ~~~ at line start, consumed opaquely.
    if ((c === '`' || c === '~') && atLineStart(i)) {
      let k = i
      while (k < n && md[k] === c) k++
      const fenceLen = k - i
      if (fenceLen >= 3) {
        const fenceChar = c
        const firstNl = md.indexOf('\n', i)
        if (firstNl === -1) {
          out += md.slice(i)
          i = n
          continue
        }
        let p = firstNl + 1
        let blockEnd = n
        while (p < n) {
          let q = p
          while (q < n && (md[q] === ' ' || md[q] === '\t')) q++
          let r = q
          while (r < n && md[r] === fenceChar) r++
          if (r - q >= fenceLen) {
            const lineEnd = md.indexOf('\n', r)
            blockEnd = lineEnd === -1 ? n : lineEnd + 1
            break
          }
          const nl = md.indexOf('\n', p)
          if (nl === -1) break
          p = nl + 1
        }
        out += md.slice(i, blockEnd)
        i = blockEnd
        continue
      }
      // Fewer than 3 fence chars: fall through to inline handling.
    }

    // Inline code span: `...`, ``...``, etc. - opaque, copied verbatim.
    if (c === '`') {
      let k = i
      while (k < n && md[k] === '`') k++
      const ticks = md.slice(i, k)
      const close = md.indexOf(ticks, k)
      if (close !== -1) {
        const spanEnd = close + ticks.length
        out += md.slice(i, spanEnd)
        i = spanEnd
        continue
      }
      // No matching close: treat backticks as literal text.
      out += ticks
      i = k
      continue
    }

    // Backslash sequences (escaping + math openers).
    if (c === '\\') {
      let k = i
      while (k < n && md[k] === '\\') k++
      const runLen = k - i
      // Each pair of backslashes is one literal escaped backslash - emit as-is.
      out += '\\\\'.repeat(runLen >> 1)
      if (runLen % 2 === 0) {
        // Even run: no dangling backslash to form a delimiter.
        i = k
        continue
      }
      // Odd run: one dangling backslash at md[k-1] that may open a delimiter.
      const opener = md[k]
      if (opener === '(' || opener === '[') {
        const isBlock = opener === '['
        const closeSeq = isBlock ? '\\]' : '\\)'
        const bodyStart = k + 1
        const closeIdx = findClose(md, bodyStart, closeSeq)
        if (closeIdx !== -1) {
          const body = md.slice(bodyStart, closeIdx)
          out += isBlock ? `$$${body}$$` : `$${body}$`
          i = closeIdx + 2 // skip past the closing delimiter
          continue
        }
        // Unclosed (streaming half-formula): keep the dangling backslash literal.
        out += '\\'
        i = k
        continue
      }
      // Any other escaped char: emit the lone backslash and let normal scanning
      // handle what follows.
      out += '\\'
      i = k
      continue
    }

    out += c
    i++
  }

  return out
}

/**
 * Find the closing delimiter (`\)` or `\]`) starting at `from`, respecting
 * backslash escaping. Bails (returns -1) on a backtick so math bodies never
 * swallow a code span. Returns the index of the *backslash* of the close
 * sequence, or -1 if unclosed.
 */
function findClose(md: string, from: number, closeSeq: string): number {
  const closerChar = closeSeq[1]
  const n = md.length
  let i = from
  while (i < n) {
    const c = md[i]
    if (c === '`') return -1
    if (c === '\\') {
      let k = i
      while (k < n && md[k] === '\\') k++
      const runLen = k - i
      // An odd run means one real backslash; if it precedes the closer char,
      // that is our closing delimiter.
      if (runLen % 2 === 1 && md[k] === closerChar) {
        return k - 1
      }
      i = k
      continue
    }
    i++
  }
  return -1
}
