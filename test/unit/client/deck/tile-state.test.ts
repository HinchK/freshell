import { describe, it, expect } from 'vitest'
import { tileFill, tileDot, tilePriority, type TabStatusFlags } from '@/deck/tile-state'

const f = (over: Partial<TabStatusFlags> = {}): TabStatusFlags => ({
  busy: false, attention: false, greenIcon: false, ...over,
})

describe('tileFill', () => {
  it('bar-on-top for active tab with attention (tab bar: border-t-success + bg wash)', () => {
    expect(tileFill(true, f({ attention: true }))).toBe('barTop')
  })
  it('green fill for inactive tab with attention (tab bar: bg-emerald-100)', () => {
    expect(tileFill(false, f({ attention: true }))).toBe('green')
  })
  it('no fill without attention, regardless of busy/green-icon/active', () => {
    expect(tileFill(true, f())).toBe('none')
    expect(tileFill(false, f({ busy: true, greenIcon: true }))).toBe('none')
  })
})

describe('tileDot', () => {
  it('blue when any pane is busy (tab bar: text-blue-500), even if green icons exist', () => {
    expect(tileDot(f({ busy: true, greenIcon: true }))).toBe('blue')
  })
  it('green for a running non-busy pane (tab bar: text-success)', () => {
    expect(tileDot(f({ greenIcon: true }))).toBe('green')
  })
  it('null otherwise', () => {
    expect(tileDot(f())).toBe(null)
  })
})

describe('tilePriority', () => {
  it('orders: barTop(0) < greenFill(1) < greenIcon(2) < blueIcon(3) < rest(4)', () => {
    expect(tilePriority(true, f({ attention: true }))).toBe(0)
    expect(tilePriority(false, f({ attention: true }))).toBe(1)
    expect(tilePriority(false, f({ greenIcon: true }))).toBe(2)
    expect(tilePriority(false, f({ busy: true, greenIcon: true }))).toBe(3) // busy dominates
    expect(tilePriority(false, f())).toBe(4)
    expect(tilePriority(true, f())).toBe(4) // active alone is not a priority bucket
  })
  it('attention outranks busy/greenIcon', () => {
    expect(tilePriority(false, f({ attention: true, busy: true, greenIcon: true }))).toBe(1)
  })
})
