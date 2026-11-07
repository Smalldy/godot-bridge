import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createGlyph } = require('../../client/src/views/glyph.cjs')
function h(type, props, ...children) { return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) } }
const Glyph = createGlyph({ h: h })
const out = Glyph({ size: 20, active: true })
assert.equal(out.type, 'span')
assert.equal(out.props.className, 'gbt-glyphwrap')
assert.equal(out.props['data-panel'], 'task-center')
const text = JSON.stringify(out)
assert.ok(text.includes('gbt-glyph'))
assert.ok(text.includes('"width":20'))
assert.ok(text.includes('"height":20'))
console.log('PASS  Glyph is an independently testable view module')
