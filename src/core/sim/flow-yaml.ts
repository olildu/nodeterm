/**
 * A deliberately small YAML reader for `sim --run` flow files — the subset an agent writes by hand:
 *
 *   - block mappings (`key: value`) and block lists (`- item`, `- key: value` with continuation keys);
 *   - flow lists `[a, b]` and flow maps `{ k: v }`, nested, with quoted strings that may hold commas;
 *   - plain, 'single' and "double" quoted scalars (double quotes take JSON-style escapes);
 *   - `#` comments, blank lines;
 *   - numbers, `true`/`false`, `null`/`~`.
 *
 * Not supported, and refused by name rather than guessed: anchors/aliases, tags, multi-document
 * files, `|` / `>` block scalars, tab indentation. The file is HOSTILE input (a repository can ship
 * one), so everything is bounded: file size, line count, nesting depth, node count. No dependency
 * on purpose — js-yaml is only a transitive package here, and a flow reader that vanishes with an
 * unrelated upgrade would fail on exactly the machines nobody is watching.
 *
 * Pure: string in, value out, or a {@link FlowYamlError} naming the line.
 */

export const FLOW_YAML_MAX_BYTES = 128 * 1024
export const FLOW_YAML_MAX_LINES = 2_000
export const FLOW_YAML_MAX_DEPTH = 12
export const FLOW_YAML_MAX_NODES = 5_000

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

export class FlowYamlError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(line > 0 ? `line ${line}: ${message}` : message)
  }
}

interface Line {
  indent: number
  text: string
  no: number
}

/** Remove a trailing ` # comment` that is outside quotes and `${…}`. */
function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quote) {
      if (quote === '"' && c === '\\') i++
      else if (c === quote) {
        if (quote === "'" && raw[i + 1] === "'") i++
        else quote = null
      }
      continue
    }
    if (c === '"' || c === "'") {
      // A quote opens a string only at a token start (an apostrophe inside a plain word is text).
      const prev = i === 0 ? ' ' : raw[i - 1]
      if (/[\s,[{:]/.test(prev) || i === 0) quote = c
      continue
    }
    if (c === '$' && raw[i + 1] === '{') {
      const end = raw.indexOf('}', i)
      if (end > 0) i = end
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i)
  }
  return raw
}

function splitLines(src: string): Line[] {
  const out: Line[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > FLOW_YAML_MAX_LINES) throw new FlowYamlError(`more than ${FLOW_YAML_MAX_LINES} lines`, 0)
  lines.forEach((raw, i) => {
    const no = i + 1
    if (/^\s*\t/.test(raw) || /^ *\t/.test(raw)) throw new FlowYamlError('tab indentation is not allowed — use spaces', no)
    const body = stripComment(raw).replace(/\s+$/, '')
    if (!body.trim()) return
    const indent = body.length - body.trimStart().length
    const text = body.trimStart()
    if (indent === 0 && (text === '---' || text === '...')) {
      if (out.length > 0 || text === '...') throw new FlowYamlError('multiple documents are not supported', no)
      return
    }
    out.push({ indent, text, no })
  })
  return out
}

// ─── Scalars and flow collections ───────────────────────────────────────────────────────────

function plainScalar(text: string): YamlValue {
  const t = text.trim()
  if (t === '' || t === '~' || t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+$/.test(t) && Math.abs(Number(t)) <= Number.MAX_SAFE_INTEGER) return Number(t)
  if (/^-?\d+\.\d+$/.test(t)) return Number(t)
  return t
}

class Flow {
  private pos = 0
  nodes = 0
  constructor(
    private readonly s: string,
    private readonly line: number
  ) {}

  private fail(msg: string): never {
    throw new FlowYamlError(msg, this.line)
  }

  private ws(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++
  }

  private count(): void {
    if (++this.nodes > FLOW_YAML_MAX_NODES) this.fail('too many values')
  }

  /** Parse the whole string as one value (a scalar may run to the end, commas included). */
  parseAll(depth: number, topLevelScalarWhole: boolean): YamlValue {
    this.ws()
    const c = this.s[this.pos]
    if (c === '[' || c === '{') {
      const v = this.value(depth, false)
      this.ws()
      if (this.pos < this.s.length) this.fail(`unexpected "${this.s.slice(this.pos, this.pos + 12)}" after the value`)
      return v
    }
    if (c === '"' || c === "'") {
      const v = this.quoted()
      this.ws()
      if (this.pos < this.s.length) this.fail(`unexpected "${this.s.slice(this.pos, this.pos + 12)}" after the quoted string`)
      return v
    }
    if (topLevelScalarWhole) {
      const rest = this.s.slice(this.pos)
      this.checkPlain(rest)
      this.pos = this.s.length
      return plainScalar(rest)
    }
    return this.value(depth, false)
  }

  private checkPlain(text: string): void {
    const t = text.trim()
    if (/^[&*!|>%@`]/.test(t)) this.fail(`"${t[0]}" (anchors, aliases, tags, block scalars) is not supported`)
  }

  private value(depth: number, inFlow: boolean): YamlValue {
    if (depth > FLOW_YAML_MAX_DEPTH) this.fail('nested too deeply')
    this.count()
    this.ws()
    const c = this.s[this.pos]
    if (c === '[') return this.list(depth)
    if (c === '{') return this.map(depth)
    if (c === '"' || c === "'") return this.quoted()
    return this.plainInFlow(inFlow)
  }

  private list(depth: number): YamlValue[] {
    this.pos++ // [
    const out: YamlValue[] = []
    for (;;) {
      this.ws()
      if (this.s[this.pos] === ']') {
        this.pos++
        return out
      }
      if (this.pos >= this.s.length) this.fail('a "[" is never closed')
      out.push(this.value(depth + 1, true))
      this.ws()
      if (this.s[this.pos] === ',') this.pos++
      else if (this.s[this.pos] !== ']') this.fail(this.pos >= this.s.length ? 'a "[" is never closed' : 'expected "," or "]" in a list')
    }
  }

  private map(depth: number): { [k: string]: YamlValue } {
    this.pos++ // {
    const out: { [k: string]: YamlValue } = {}
    for (;;) {
      this.ws()
      if (this.s[this.pos] === '}') {
        this.pos++
        return out
      }
      if (this.pos >= this.s.length) this.fail('a "{" is never closed')
      let key: string
      const c = this.s[this.pos]
      if (c === '"' || c === "'") key = this.quoted()
      else {
        const start = this.pos
        while (this.pos < this.s.length && !/[:,}]/.test(this.s[this.pos])) this.pos++
        key = this.s.slice(start, this.pos).trim()
      }
      this.ws()
      if (this.s[this.pos] !== ':') this.fail(`expected ":" after the key ${JSON.stringify(key)}`)
      this.pos++
      if (!key) this.fail('an empty key')
      if (Object.prototype.hasOwnProperty.call(out, key)) this.fail(`the key ${JSON.stringify(key)} appears twice`)
      this.ws()
      const nx = this.s[this.pos]
      out[key] = nx === ',' || nx === '}' ? null : this.value(depth + 1, true)
      this.ws()
      if (this.s[this.pos] === ',') this.pos++
      else if (this.s[this.pos] !== '}') this.fail(this.pos >= this.s.length ? 'a "{" is never closed' : 'expected "," or "}" in a map')
    }
  }

  private quoted(): string {
    const q = this.s[this.pos++]
    let out = ''
    for (;;) {
      if (this.pos >= this.s.length) this.fail('a quoted string is never closed')
      const c = this.s[this.pos++]
      if (q === "'") {
        if (c === "'") {
          if (this.s[this.pos] === "'") {
            out += "'"
            this.pos++
          } else return out
        } else out += c
        continue
      }
      if (c === '"') return out
      if (c !== '\\') {
        out += c
        continue
      }
      const e = this.s[this.pos++]
      switch (e) {
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case '0': out += '\0'; break
        case '"': out += '"'; break
        case '\\': out += '\\'; break
        case '/': out += '/'; break
        case 'u': {
          const hex = this.s.slice(this.pos, this.pos + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('a \\u escape needs four hex digits')
          out += String.fromCharCode(parseInt(hex, 16))
          this.pos += 4
          break
        }
        default:
          this.fail(`unknown escape \\${e ?? ''}`)
      }
    }
  }

  private plainInFlow(inFlow: boolean): YamlValue {
    const start = this.pos
    while (this.pos < this.s.length) {
      const c = this.s[this.pos]
      if (c === '$' && this.s[this.pos + 1] === '{') {
        const end = this.s.indexOf('}', this.pos)
        if (end < 0) this.fail('a "${" is never closed')
        this.pos = end + 1
        continue
      }
      if (inFlow && /[,\]}]/.test(c)) break
      this.pos++
    }
    const text = this.s.slice(start, this.pos)
    this.checkPlain(text)
    return plainScalar(text)
  }
}

// ─── Block structure ────────────────────────────────────────────────────────────────────────

/** `key: rest` (key plain or quoted). Returns null when the line is not a mapping entry. */
function splitKey(text: string, no: number): { key: string; rest: string } | null {
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0]
    let i = 1
    for (; i < text.length; i++) {
      if (q === '"' && text[i] === '\\') i++
      else if (text[i] === q) {
        if (q === "'" && text[i + 1] === "'") i++
        else break
      }
    }
    if (i >= text.length) return null
    const after = text.slice(i + 1)
    if (!/^\s*:(\s|$)/.test(after)) return null
    const key = new Flow(text.slice(0, i + 1), no).parseAll(0, false)
    return { key: String(key), rest: after.replace(/^\s*:/, '').trim() }
  }
  if (/^[[{]/.test(text)) return null
  let i = 0
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '$' && text[i + 1] === '{') {
      const end = text.indexOf('}', i)
      if (end > 0) i = end
      continue
    }
    if (c === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) break
  }
  if (i >= text.length) return null
  const key = text.slice(0, i).trim()
  if (!key) throw new FlowYamlError('an empty key', no)
  return { key, rest: text.slice(i + 1).trim() }
}

export function parseFlowYaml(src: string): YamlValue {
  if (typeof src !== 'string') throw new FlowYamlError('the flow file is not text', 0)
  if (Buffer.byteLength(src, 'utf8') > FLOW_YAML_MAX_BYTES) {
    throw new FlowYamlError(`the flow file is larger than ${FLOW_YAML_MAX_BYTES / 1024} KB`, 0)
  }
  const lines = splitLines(src)
  if (lines.length === 0) throw new FlowYamlError('the flow file is empty', 0)
  let i = 0
  let nodes = 0
  const bump = (no: number): void => {
    if (++nodes > FLOW_YAML_MAX_NODES) throw new FlowYamlError('too many values', no)
  }

  function inline(rest: string, no: number, depth: number): YamlValue {
    bump(no)
    const f = new Flow(rest, no)
    const v = f.parseAll(depth, true)
    nodes += f.nodes
    if (nodes > FLOW_YAML_MAX_NODES) throw new FlowYamlError('too many values', no)
    return v
  }

  function block(indent: number, depth: number): YamlValue {
    if (depth > FLOW_YAML_MAX_DEPTH) throw new FlowYamlError('nested too deeply', lines[i].no)
    const first = lines[i]
    if (first.text === '-' || first.text.startsWith('- ')) return blockList(indent, depth)
    return blockMap(indent, depth)
  }

  function blockMap(indent: number, depth: number): YamlValue {
    const out: { [k: string]: YamlValue } = {}
    while (i < lines.length && lines[i].indent === indent) {
      const ln = lines[i]
      if (ln.text === '-' || ln.text.startsWith('- ')) throw new FlowYamlError('a list item where a "key: value" line was expected', ln.no)
      const kv = splitKey(ln.text, ln.no)
      if (!kv) throw new FlowYamlError(`expected "key: value", got "${ln.text.slice(0, 40)}"`, ln.no)
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new FlowYamlError(`the key ${JSON.stringify(kv.key)} appears twice`, ln.no)
      i++
      bump(ln.no)
      if (kv.rest === '') {
        // Nested block, or null when the next line is not indented deeper. A list may sit at the
        // SAME indent as its key (`steps:` then `- tap: x`), which YAML allows.
        const next = lines[i]
        if (next && next.indent > indent) out[kv.key] = block(next.indent, depth + 1)
        else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) out[kv.key] = blockList(indent, depth + 1)
        else out[kv.key] = null
      } else {
        if (/^[|>][+-]?\d*$/.test(kv.rest)) throw new FlowYamlError('block scalars (| and >) are not supported — use a quoted string', ln.no)
        out[kv.key] = inline(kv.rest, ln.no, depth + 1)
      }
    }
    if (i < lines.length && lines[i].indent > indent) throw new FlowYamlError('unexpected indentation', lines[i].no)
    return out
  }

  function blockList(indent: number, depth: number): YamlValue {
    const out: YamlValue[] = []
    while (i < lines.length && lines[i].indent === indent && (lines[i].text === '-' || lines[i].text.startsWith('- '))) {
      const ln = lines[i]
      const rest = ln.text === '-' ? '' : ln.text.slice(2)
      const lead = rest.length - rest.trimStart().length
      const body = rest.trimStart()
      bump(ln.no)
      if (body === '') {
        i++
        const next = lines[i]
        out.push(next && next.indent > indent ? block(next.indent, depth + 1) : null)
        continue
      }
      // `- key: value` opens a mapping whose continuation keys sit under the first key.
      const kv = body[0] === '[' || body[0] === '{' ? null : splitKey(body, ln.no)
      if (kv) {
        lines[i] = { indent: indent + 2 + lead, text: body, no: ln.no }
        out.push(blockMap(indent + 2 + lead, depth + 1))
      } else {
        i++
        out.push(inline(body, ln.no, depth + 1))
      }
    }
    if (i < lines.length && lines[i].indent > indent) throw new FlowYamlError('unexpected indentation', lines[i].no)
    return out
  }

  const root = block(lines[0].indent, 0)
  if (i < lines.length) throw new FlowYamlError('unexpected indentation', lines[i].no)
  return root
}
