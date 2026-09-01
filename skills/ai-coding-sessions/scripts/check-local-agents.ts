#!/usr/bin/env bun
/**
 * 检查本机有哪些 coding agent 落盘数据及规模
 *
 * bun skills/ai-coding-sessions/scripts/check-local-agents.ts
 * bun skills/ai-coding-sessions/scripts/check-local-agents.ts --all --kind=other
 * bun skills/ai-coding-sessions/scripts/check-local-agents.ts --format=md
 */
import {
  AGENT_PROBES,
  checkLocalAgents,
  displayPath,
  formatBytes,
  makeProbeCtx,
  type AgentHit,
  type ProbeKind,
} from './local-agent-probes.ts';

function parseArgs(argv: string[]) {
  const ids: string[] = [];
  let kind: 'all' | ProbeKind = 'all';
  let all = false;
  let format: 'json' | 'md' = 'json';
  for (const a of argv) {
    if (a === '--all') all = true;
    else if (a === '--md' || a === '--format=md') format = 'md';
    else if (a === '--format=json') format = 'json';
    else if (a.startsWith('--kind=')) kind = a.slice(7) as 'all' | ProbeKind;
    else if (a.startsWith('--id=')) ids.push(...a.slice(5).split(',').filter(Boolean));
    else if (a === '-h' || a === '--help') {
      process.stderr.write(
        'check-local-agents [--all] [--kind=acs|other|all] [--id=id,...] [--format=json|md]\n',
      );
      process.exit(0);
    }
  }
  return { ids, kind, all, format };
}

function formatMd(hits: AgentHit[], home: string, all: boolean): string {
  const lines = [
    `# local coding agents`,
    '',
    `- home: \`${displayPath(home, home)}\``,
    `- probes: ${AGENT_PROBES.length} (acs ${AGENT_PROBES.filter((p) => p.kind === 'acs').length} / other ${AGENT_PROBES.filter((p) => p.kind === 'other').length})`,
    `- shown: ${hits.length}${all ? ' (including empty/missing)' : ' (present only)'}`,
    '',
  ];
  const groups: Array<['acs' | 'other', string]> = [
    ['acs', 'ACS 已实现'],
    ['other', '未实现 extras'],
  ];
  for (const [kind, title] of groups) {
    const rows = hits.filter((h) => h.kind === kind);
    lines.push(`## ${title}`, '');
    if (!rows.length) {
      lines.push('- (none)', '');
      continue;
    }
    for (const h of rows) {
      const when = h.newestMs ? new Date(h.newestMs).toISOString().slice(0, 10) : '-';
      const hitRoots = h.roots.filter((r) => r.exists && r.files > 0);
      lines.push(
        `- **${h.id}** (${h.display}) \`${h.status}\` · ${h.files} files · ${formatBytes(h.bytes)} · newest ${when}`,
      );
      for (const r of hitRoots) {
        const trunc = r.truncated ? ' (truncated)' : '';
        lines.push(`  - \`${displayPath(r.path, home)}\` ${r.files} / ${formatBytes(r.bytes)}${trunc}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function toJson(hits: AgentHit[], home: string) {
  return {
    home: displayPath(home, home),
    generatedAt: new Date().toISOString(),
    probeCount: AGENT_PROBES.length,
    shown: hits.length,
    agents: hits.map((h) => ({
      ...h,
      bytesLabel: formatBytes(h.bytes),
      newest: h.newestMs ? new Date(h.newestMs).toISOString() : null,
      roots: h.roots
        .filter((r) => r.exists)
        .map((r) => ({
          path: displayPath(r.path, home),
          isFile: r.isFile,
          files: r.files,
          bytes: r.bytes,
          bytesLabel: formatBytes(r.bytes),
          newest: r.newestMs ? new Date(r.newestMs).toISOString() : null,
          truncated: r.truncated,
        })),
    })),
  };
}

const args = parseArgs(process.argv.slice(2));
const ctx = makeProbeCtx();
const hits = checkLocalAgents({
  kind: args.kind,
  all: args.all,
  ids: args.ids.length ? args.ids : undefined,
});

if (args.format === 'md') {
  process.stdout.write(formatMd(hits, ctx.home, args.all));
} else {
  process.stdout.write(JSON.stringify(toJson(hits, ctx.home), null, 2) + '\n');
}
