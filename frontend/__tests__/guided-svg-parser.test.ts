import { describe, expect, it } from 'vitest'
import { parseDeviceIdsFromSvg } from '@/lib/guided/svg-parser'

describe('parseDeviceIdsFromSvg', () => {
  it('returns ids of <g> elements in document order', () => {
    const svg = `<?xml version="1.0"?>
      <svg>
        <g id="UL17_20_VFD"><rect/></g>
        <g id="UL17_21_VFD"><rect/></g>
        <g id="UL20_19_VFD"><rect/></g>
      </svg>`
    expect(parseDeviceIdsFromSvg(svg)).toEqual([
      'UL17_20_VFD',
      'UL17_21_VFD',
      'UL20_19_VFD',
    ])
  })

  it('ignores <g> elements without an id', () => {
    const svg = `<svg>
        <g id="A"/>
        <g><rect/></g>
        <g id="B"/>
      </svg>`
    expect(parseDeviceIdsFromSvg(svg)).toEqual(['A', 'B'])
  })

  it('returns empty array when SVG has no <g> elements with ids', () => {
    expect(parseDeviceIdsFromSvg('<svg><rect/></svg>')).toEqual([])
  })

  it('handles single-quoted ids', () => {
    const svg = `<svg><g id='X1'/><g id="X2"/></svg>`
    expect(parseDeviceIdsFromSvg(svg)).toEqual(['X1', 'X2'])
  })

  it('handles whitespace and newlines between attributes', () => {
    const svg = `<svg>
        <g
          inkscape:label="UL17_20_VFD"
          id="UL17_20_VFD"
          data-color="#000"
        ><rect/></g>
      </svg>`
    expect(parseDeviceIdsFromSvg(svg)).toEqual(['UL17_20_VFD'])
  })
})
