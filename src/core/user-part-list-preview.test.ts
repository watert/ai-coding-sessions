import { describe, expect, it } from 'bun:test';
import {
  buildUserPartListPreviewSegments,
  countUserPartsByDay,
  groupUserPartIndicesByDay,
  pickUserPartIndicesByDay,
  sampleUserPartsForList,
} from './user-part-list-preview';

function at(day: string, hour: number): number {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).getTime();
}

function partsForDay(day: string, count: number) {
  const base = at(day, 10);
  return Array.from({ length: count }, (_, i) => ({
    text: `${day}#${i}`,
    startTime: base + i * 60_000,
  }));
}

describe('groupUserPartIndicesByDay', () => {
  it('按时间顺序切自然日', () => {
    const parts = [
      ...partsForDay('2026-07-14', 2),
      ...partsForDay('2026-07-15', 3),
    ];
    const groups = groupUserPartIndicesByDay(parts);
    expect(groups).toHaveLength(2);
    expect(groups[0].dayKey).toBe('2026-07-14');
    expect(groups[0].indices).toEqual([0, 1]);
    expect(groups[1].indices).toEqual([2, 3, 4]);
  });
});

describe('pickUserPartIndicesByDay', () => {
  it('单日超过 6 条时取头 3 + 尾 3', () => {
    const parts = partsForDay('2026-07-14', 10);
    expect(pickUserPartIndicesByDay(parts)).toEqual([0, 1, 2, 7, 8, 9]);
  });

  it('每日分别取头尾', () => {
    const parts = [
      ...partsForDay('2026-07-14', 8),
      ...partsForDay('2026-07-15', 8),
    ];
    expect(pickUserPartIndicesByDay(parts)).toEqual([
      0, 1, 2, 5, 6, 7,
      8, 9, 10, 13, 14, 15,
    ]);
  });
});

describe('buildUserPartListPreviewSegments', () => {
  it('单日 ≤6 条不跳号', () => {
    const parts = partsForDay('2026-07-14', 5);
    const segs = buildUserPartListPreviewSegments(parts);
    expect(segs.every(s => s.kind === 'row')).toBe(true);
    expect(segs).toHaveLength(5);
    expect(segs[0]).toMatchObject({ kind: 'row', isDayStart: true });
  });

  it('单日 >6 条中间一条跳号', () => {
    const parts = partsForDay('2026-07-14', 10);
    const segs = buildUserPartListPreviewSegments(parts);
    expect(segs.map(s => s.kind)).toEqual([
      'row', 'row', 'row', 'ellipsis', 'row', 'row', 'row',
    ]);
    const ell = segs[3];
    expect(ell).toMatchObject({ kind: 'ellipsis', hidden: 4, dayTotal: 10 });
  });

  it('跨天各日分别跳号', () => {
    const parts = [
      ...partsForDay('2026-07-14', 10),
      ...partsForDay('2026-07-15', 10),
    ];
    const segs = buildUserPartListPreviewSegments(parts);
    const ellipses = segs.filter(s => s.kind === 'ellipsis');
    expect(ellipses).toHaveLength(2);
    expect(ellipses[0]).toMatchObject({ hidden: 4, dayTotal: 10, dayKey: '2026-07-14' });
    expect(ellipses[1]).toMatchObject({ hidden: 4, dayTotal: 10, dayKey: '2026-07-15' });
  });

  it('列表 API 裁剪后可用 dayTotals 还原 hidden', () => {
    const full = [
      ...partsForDay('2026-07-14', 20),
      ...partsForDay('2026-07-15', 5),
    ];
    const dayTotals = countUserPartsByDay(full);
    const capped = sampleUserPartsForList(full);
    const segs = buildUserPartListPreviewSegments(capped, { dayTotals });
    const ell14 = segs.find(s => s.kind === 'ellipsis' && s.dayKey === '2026-07-14');
    expect(ell14).toMatchObject({ hidden: 14, dayTotal: 20 });
    expect(segs.filter(s => s.kind === 'ellipsis' && s.dayKey === '2026-07-15')).toHaveLength(0);
  });
});