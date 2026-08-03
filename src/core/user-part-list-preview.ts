/**
 * Session 列表 user prompt 预览：按自然日分组，每日内 head + 中间跳号 + tail
 */

export function partLocalDay(startTime?: number): string | null {
  if (!startTime || !Number.isFinite(startTime)) return null;
  const d = new Date(startTime);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function groupUserPartIndicesByDay(
  parts: Array<{ startTime?: number }>,
): Array<{ dayKey: string | null; indices: number[] }> {
  const groups: Array<{ dayKey: string | null; indices: number[] }> = [];
  let current: { dayKey: string | null; indices: number[] } | null = null;

  for (let i = 0; i < parts.length; i++) {
    const dayKey = partLocalDay(parts[i].startTime);
    if (!current || current.dayKey !== dayKey) {
      current = { dayKey, indices: [] };
      groups.push(current);
    }
    current.indices.push(i);
  }
  return groups;
}

export function countUserPartsByDay(parts: Array<{ startTime?: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of parts) {
    const d = partLocalDay(p.startTime) ?? '_unknown';
    out[d] = (out[d] ?? 0) + 1;
  }
  return out;
}

export function pickUserPartIndicesByDay(
  parts: Array<{ startTime?: number }>,
  headN = 3,
  tailN = 3,
): number[] {
  const indices: number[] = [];
  for (const { indices: dayIdx } of groupUserPartIndicesByDay(parts)) {
    if (dayIdx.length <= headN + tailN) {
      indices.push(...dayIdx);
    } else {
      indices.push(...dayIdx.slice(0, headN), ...dayIdx.slice(-tailN));
    }
  }
  return Array.from(new Set(indices)).sort((a, b) => a - b);
}

export type UserPartListPreviewSegment =
  | { kind: 'row'; index: number; dayKey: string | null; isDayStart: boolean }
  | { kind: 'ellipsis'; hidden: number; dayTotal: number; dayKey: string | null };

export function buildUserPartListPreviewSegments(
  parts: Array<{ startTime?: number }>,
  opts?: { headN?: number; tailN?: number; dayTotals?: Record<string, number> },
): UserPartListPreviewSegment[] {
  const headN = opts?.headN ?? 3;
  const tailN = opts?.tailN ?? 3;
  const segments: UserPartListPreviewSegment[] = [];

  for (const { dayKey, indices } of groupUserPartIndicesByDay(parts)) {
    const dayLabel = dayKey ?? '_unknown';
    const dayTotal = opts?.dayTotals?.[dayLabel] ?? indices.length;
    const needsEllipsis = dayTotal > headN + tailN;

    if (!needsEllipsis) {
      indices.forEach((index, j) => {
        segments.push({ kind: 'row', index, dayKey, isDayStart: j === 0 });
      });
      continue;
    }

    const head = indices.slice(0, headN);
    const tail = indices.length > headN ? indices.slice(-tailN) : [];
    const hidden = Math.max(0, dayTotal - headN - tailN);

    head.forEach((index, j) => {
      segments.push({ kind: 'row', index, dayKey, isDayStart: j === 0 });
    });
    if (hidden > 0) {
      segments.push({ kind: 'ellipsis', hidden, dayTotal, dayKey });
    }
    tail.forEach((index) => {
      segments.push({ kind: 'row', index, dayKey, isDayStart: false });
    });
  }
  return segments;
}

export function sampleUserPartsForList<T extends { text: string; startTime?: number }>(
  parts: T[],
  headN = 3,
  tailN = 3,
): T[] {
  const idx = pickUserPartIndicesByDay(parts, headN, tailN);
  return idx.map(i => parts[i]);
}