/**
 * Claude Code transcript 主链重建（P1 / issue #5）
 * 对齐 Grok Build session_reader：parentUuid leaf · compact · snip · sidechain · parallel siblings
 *
 * 导出纯函数，便于单测；listClaudeCodeMessages 走此路径。
 */

export interface ClaudeChainMeta {
  /** 原始 jsonl 记录数（非空行） */
  raw_records: number;
  /** 进入主链前的 user/assistant 数 */
  candidate_messages: number;
  /** 主链长度 */
  chain_length: number;
  /** 最终返回（可 convert）条数 */
  returned: number;
  sidechain_skipped: number;
  compact_boundaries: number;
  snip_removed: number;
  parallel_recovered: number;
  warnings: string[];
}

export interface ClaudeChainResult {
  messages: any[];
  meta: ClaudeChainMeta;
}

function isCompactBoundary(rec: any): boolean {
  return rec?.type === 'system' && rec?.subtype === 'compact_boundary';
}

function claudeParent(rec: any): string | null {
  for (const k of ['parentUuid', 'logicalParentUuid']) {
    const p = rec?.[k];
    if (typeof p === 'string' && p) return p;
  }
  return null;
}

function setClaudeParent(rec: any, parent: string | null) {
  rec.parentUuid = parent;
  if ('logicalParentUuid' in rec) rec.logicalParentUuid = parent;
}

function compactSegment(boundary: any): { head: any; anchor: any; tail: any } | null {
  const metadata = boundary?.compactMetadata ?? boundary?.compact_metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const segment = metadata.preservedSegment ?? metadata.preserved_segment;
  if (!segment || typeof segment !== 'object') return null;
  return {
    head: segment.headUuid ?? segment.head_uuid,
    anchor: segment.anchorUuid ?? segment.anchor_uuid,
    tail: segment.tailUuid ?? segment.tail_uuid,
  };
}

function tsKey(rec: any, index: number): [string, number] {
  const t = typeof rec?.timestamp === 'string' ? rec.timestamp : '';
  return [t, index];
}

function applyPreservedSegment(
  messages: Map<string, any>,
  warnings: string[],
): void {
  const keys = Array.from(messages.keys());
  let absoluteBoundaryIndex = -1;
  let lastSegmentIndex = -1;
  let lastSegment: { head: any; anchor: any; tail: any } | null = null;

  let i = 0;
  for (const rec of messages.values()) {
    if (isCompactBoundary(rec)) {
      absoluteBoundaryIndex = i;
      const seg = compactSegment(rec);
      if (seg) {
        lastSegment = seg;
        lastSegmentIndex = i;
      }
    }
    i += 1;
  }
  if (!lastSegment) return;

  const segmentLive = lastSegmentIndex === absoluteBoundaryIndex;
  const preserved = new Set<string>();

  if (segmentLive) {
    const { head, anchor, tail } = lastSegment;
    if (
      typeof head !== 'string' ||
      typeof anchor !== 'string' ||
      typeof tail !== 'string' ||
      !head ||
      !anchor ||
      !tail
    ) {
      warnings.push('preserved_segment_incomplete');
      return;
    }
    let current = messages.get(tail);
    const seen = new Set<string>();
    let reachedHead = false;
    while (current) {
      const uuid = current.uuid;
      if (typeof uuid !== 'string' || seen.has(uuid)) break;
      seen.add(uuid);
      preserved.add(uuid);
      if (uuid === head) {
        reachedHead = true;
        break;
      }
      const parent = claudeParent(current);
      current = parent ? messages.get(parent) : undefined;
    }
    if (!reachedHead) {
      warnings.push('preserved_segment_missing_or_cycle');
      return;
    }
    const headRec = messages.get(head);
    if (headRec) setClaudeParent(headRec, anchor);
    for (const [uuid, message] of messages) {
      if (uuid !== head && claudeParent(message) === anchor) {
        setClaudeParent(message, tail);
      }
    }
  }

  if (absoluteBoundaryIndex < 0) return;
  for (const uuid of keys.slice(0, absoluteBoundaryIndex)) {
    if (!preserved.has(uuid)) messages.delete(uuid);
  }
}

function applySnipRemovals(messages: Map<string, any>): number {
  const removed = new Set<string>();
  for (const rec of messages.values()) {
    const metadata = rec.snipMetadata ?? rec.snip_metadata;
    const values = metadata?.removedUuids ?? metadata?.removed_uuids;
    if (Array.isArray(values)) {
      for (const v of values) {
        if (typeof v === 'string') removed.add(v);
      }
    }
  }
  if (!removed.size) return 0;

  const deletedParents = new Map<string, string | null>();
  for (const uuid of removed) {
    const rec = messages.get(uuid);
    if (rec) {
      deletedParents.set(uuid, claudeParent(rec));
      messages.delete(uuid);
    }
  }

  const resolve = (start: string): string | null => {
    const path: string[] = [];
    let current: string | null = start;
    const seen = new Set<string>();
    while (current && removed.has(current) && !seen.has(current)) {
      seen.add(current);
      path.push(current);
      current = deletedParents.get(current) ?? null;
    }
    for (const item of path) deletedParents.set(item, current);
    return current;
  };

  for (const rec of messages.values()) {
    const parent = claudeParent(rec);
    if (parent && removed.has(parent)) {
      setClaudeParent(rec, resolve(parent));
    }
  }
  return removed.size;
}

function findLeaf(messages: Map<string, any>, warnings: string[]): any | null {
  if (!messages.size) return null;
  const parentUuids = new Set<string>();
  for (const rec of messages.values()) {
    const p = claudeParent(rec);
    if (p) parentUuids.add(p);
  }
  const positions = new Map<string, number>();
  let idx = 0;
  for (const uuid of messages.keys()) {
    positions.set(uuid, idx++);
  }

  const candidates: any[] = [];
  for (const rec of messages.values()) {
    const uuid = rec.uuid;
    if (typeof uuid !== 'string' || parentUuids.has(uuid)) continue;
    let current: any | undefined = rec;
    const seen = new Set<string>();
    while (current) {
      const cu = current.uuid;
      if (typeof cu !== 'string' || seen.has(cu)) {
        warnings.push('parent_cycle');
        break;
      }
      seen.add(cu);
      if (current.type === 'user' || current.type === 'assistant') {
        candidates.push(current);
        break;
      }
      const parent = claudeParent(current);
      current = parent ? messages.get(parent) : undefined;
    }
  }

  let pool = candidates;
  if (!pool.length) {
    pool = Array.from(messages.values()).filter(
      (r) => r.type === 'user' || r.type === 'assistant',
    );
  }
  if (!pool.length) return null;

  pool.sort((a, b) => {
    const [ta, ia] = tsKey(a, positions.get(String(a.uuid)) ?? -1);
    const [tb, ib] = tsKey(b, positions.get(String(b.uuid)) ?? -1);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return ia - ib;
  });
  return pool[pool.length - 1];
}

function buildChain(
  messages: Map<string, any>,
  leaf: any,
  warnings: string[],
): { chain: any[]; seen: Set<string> } {
  const chain: any[] = [];
  const seen = new Set<string>();
  let current: any | undefined = leaf;
  while (current) {
    const uuid = current.uuid;
    if (typeof uuid !== 'string') break;
    if (seen.has(uuid)) {
      warnings.push('parent_cycle');
      break;
    }
    seen.add(uuid);
    chain.push(current);
    const parent = claudeParent(current);
    current = parent ? messages.get(parent) : undefined;
  }
  chain.reverse();
  return { chain, seen };
}

/** 同 message.id 的并行 assistant + 其 tool_result 用户消息回收进主链 */
function recoverParallel(
  messages: Map<string, any>,
  chain: any[],
  seen: Set<string>,
): { chain: any[]; recovered: number } {
  const chainAssistants = chain.filter((r) => r.type === 'assistant');
  if (!chainAssistants.length) return { chain, recovered: 0 };

  const anchors = new Map<string, any>();
  const siblings = new Map<string, any[]>();
  const results = new Map<string, any[]>();
  const positions = new Map<string, number>();
  let pi = 0;
  for (const uuid of messages.keys()) {
    positions.set(uuid, pi++);
  }

  for (const assistant of chainAssistants) {
    const mid = assistant.message?.id;
    if (typeof mid === 'string' && mid) anchors.set(mid, assistant);
  }

  for (const rec of messages.values()) {
    const message = rec.message || {};
    if (rec.type === 'assistant') {
      const mid = message.id;
      if (typeof mid === 'string' && mid) {
        const list = siblings.get(mid) || [];
        list.push(rec);
        siblings.set(mid, list);
      }
    } else if (rec.type === 'user') {
      const parent = claudeParent(rec);
      const content = message.content;
      const hasToolResult =
        Array.isArray(content) &&
        content.some((b: any) => b && b.type === 'tool_result');
      if (parent && hasToolResult) {
        const list = results.get(parent) || [];
        list.push(rec);
        results.set(parent, list);
      }
    }
  }

  const inserts = new Map<string, any[]>();
  const processed = new Set<string>();
  let recovered = 0;

  for (const assistant of chainAssistants) {
    const mid = assistant.message?.id;
    if (typeof mid !== 'string' || processed.has(mid)) continue;
    processed.add(mid);
    const group = siblings.get(mid) || [assistant];
    const orphanedSiblings = group.filter((r) => !seen.has(String(r.uuid)));
    const orphanedResults: any[] = [];
    for (const member of group) {
      for (const r of results.get(String(member.uuid)) || []) {
        if (!seen.has(String(r.uuid))) orphanedResults.push(r);
      }
    }
    const order = (r: any) => tsKey(r, positions.get(String(r.uuid)) ?? -1);
    const cmp = (a: any, b: any) => {
      const [ta, ia] = order(a);
      const [tb, ib] = order(b);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return ia - ib;
    };
    const recoveredList = [
      ...orphanedSiblings.sort(cmp),
      ...orphanedResults.sort(cmp),
    ];
    if (recoveredList.length) {
      const anchor = anchors.get(mid)!;
      inserts.set(String(anchor.uuid), recoveredList);
      for (const r of recoveredList) {
        if (r.uuid) seen.add(String(r.uuid));
        recovered += 1;
      }
    }
  }

  if (!inserts.size) return { chain, recovered: 0 };
  const out: any[] = [];
  for (const rec of chain) {
    out.push(rec);
    out.push(...(inserts.get(String(rec.uuid)) || []));
  }
  return { chain: out, recovered };
}

/**
 * 是否可作为 convert 输入（兼容旧 listClaudeCodeMessages 过滤）
 * - 有 message 且非 isMeta
 * - 跳过「user 且无 promptId」的旧 isUserCmd 口径（多为 meta）
 * - 跳过 isSidechain（主链重建后仍兜底）
 */
export function isClaudeConvertibleMessage(msg: any): boolean {
  if (!msg || !msg.message || msg.isMeta) return false;
  if (msg.isSidechain) return false;
  if (msg.type === 'user' && !msg.promptId) {
    // tool_result 用户消息通常有 promptId；无 promptId 的 user 在旧逻辑里剔除
    // 但 tool_result 若无 promptId 也应保留：有 tool_result block 则放行
    const content = msg.message?.content;
    const hasToolResult =
      Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result');
    if (!hasToolResult) return false;
  }
  if (msg.type !== 'user' && msg.type !== 'assistant') return false;
  return true;
}

/**
 * 从 jsonl 解析出的 records 重建主链消息列表
 */
export function reconstructClaudeMainChain(records: any[]): ClaudeChainResult {
  const warnings: string[] = [];
  const raw_records = records.length;
  let sidechain_skipped = 0;
  let compact_boundaries = 0;

  // 绝对 compact（无 preserved segment）之后才保留
  let lastNonPreserved = -1;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (isCompactBoundary(rec)) {
      compact_boundaries += 1;
      if (!compactSegment(rec)) lastNonPreserved = i;
    }
  }
  const scoped =
    lastNonPreserved >= 0 ? records.slice(lastNonPreserved) : records;

  const messages = new Map<string, any>();
  for (const record of scoped) {
    if (record?.isSidechain) {
      sidechain_skipped += 1;
      continue;
    }
    if (record?.type !== 'user' && record?.type !== 'assistant' && record?.type !== 'system') {
      continue;
    }
    const uuid = record?.uuid;
    if (typeof uuid === 'string' && uuid) {
      messages.set(uuid, { ...record });
    }
  }

  applyPreservedSegment(messages, warnings);
  const snip_removed = applySnipRemovals(messages);

  const candidate_messages = Array.from(messages.values()).filter(
    (r) => r.type === 'user' || r.type === 'assistant',
  ).length;

  const leaf = findLeaf(messages, warnings);
  let chain: any[] = [];
  let parallel_recovered = 0;
  if (leaf) {
    const built = buildChain(messages, leaf, warnings);
    const recovered = recoverParallel(messages, built.chain, built.seen);
    chain = recovered.chain;
    parallel_recovered = recovered.recovered;
  } else {
    // fallback：时间序全部 user/assistant
    chain = Array.from(messages.values())
      .filter((r) => r.type === 'user' || r.type === 'assistant')
      .sort((a, b) => {
        const [ta, ia] = tsKey(a, 0);
        const [tb, ib] = tsKey(b, 1);
        if (ta !== tb) return ta < tb ? -1 : 1;
        return ia - ib;
      });
    warnings.push('leaf_unavailable_fallback_all');
  }

  const converted = chain.filter(isClaudeConvertibleMessage);

  return {
    messages: converted,
    meta: {
      raw_records,
      candidate_messages,
      chain_length: chain.length,
      returned: converted.length,
      sidechain_skipped,
      compact_boundaries,
      snip_removed,
      parallel_recovered,
      warnings: [...new Set(warnings)].sort(),
    },
  };
}

/** 解析 jsonl 文本 → records */
export function parseClaudeJsonl(content: string): any[] {
  const records: any[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') records.push(v);
    } catch {
      // skip malformed
    }
  }
  return records;
}
