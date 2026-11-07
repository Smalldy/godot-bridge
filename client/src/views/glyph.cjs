/**
 * Sidebar glyph view module.
 *
 * Extracted from the shell fragment; h is injected by the build.
 */
function createGlyph(deps) {
	const h = deps.h

	function Glyph(props) {
		const size = typeof props.size === 'number' ? props.size : 18
		const active = props.active === true
		// The sidebar row itself carries no stable attribute and its aria-label
		// is localized; this glyph is inside that row's <button>, so clicking it
		// bubbles to selectPanel and gives shot tools a locale-independent target.
		return h(
			'span',
			{ className: 'gbt-glyphwrap', 'data-panel': 'task-center' },
			h(
		'svg',
		{ className: 'gbt-glyph', width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
		h('rect', { x: 1.5, y: 2, width: 13, height: 12, rx: 2.4, stroke: 'currentColor', strokeWidth: active ? 1.6 : 1.3 }),
		h('path', { d: 'M5.6 4.6v6.8M10.4 4.6v6.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
			),
		)
	}


	return Glyph
}

module.exports = { createGlyph }
