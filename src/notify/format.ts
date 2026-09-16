import type { Alert } from './types.js';

/**
 * Plain-text alert formatting (docs/SPEC.md #10.1: "each alert includes the
 * position, its level, the signals that fired with their key numbers, the block
 * number, block explorer links, and the action taken or planned"). Pure and
 * markdown-free by design — every `Notifier` implementation decorates this base
 * text for its own channel (Telegram's MarkdownV2 escaping, Discord embeds) rather
 * than each reimplementing what goes into an alert.
 */
export function formatAlertText(alert: Alert): string {
  const lines: string[] = [];
  lines.push(`[${alert.level}] ${alert.protocol} (chain ${alert.chainId}) — ${alert.asset}`);
  lines.push(`Position: ${alert.positionId}`);
  if (alert.previousLevel !== alert.level) {
    lines.push(`Transition: ${alert.previousLevel} -> ${alert.level} (raw: ${alert.rawLevel})`);
  }
  lines.push(`Rule: ${alert.rule}`);
  if (alert.standingAlert) {
    lines.push(`Standing rule: position exceeds configured share of available liquidity`);
  }

  if (alert.signals.length > 0) {
    lines.push('Signals:');
    for (const s of alert.signals) {
      lines.push(
        `  - ${s.detectorId} [${s.family}] ${s.severity}: value=${s.value} threshold=${s.threshold}`,
      );
    }
  }

  lines.push(
    `Block: ${alert.blockNumber}${alert.blockExplorerUrl ? ` (${alert.blockExplorerUrl})` : ''}`,
  );

  const actionText =
    alert.action.kind === 'none'
      ? 'none'
      : alert.action.kind === 'alert'
        ? alert.action.suppressedByKillSwitch
          ? 'alert only (withdrawal suppressed by kill switch)'
          : 'alert only'
        : alert.action.kind === 'partial_withdraw'
          ? `partial withdrawal (${((alert.action.fraction ?? 0) * 100).toFixed(0)}%) [planned, not yet executed — execution mode off]`
          : 'full exit [planned, not yet executed — execution mode off]';
  lines.push(`Action: ${actionText}`);

  lines.push(`Decision id: ${alert.decisionId} (ack with /ack ${alert.decisionId})`);
  lines.push(`At: ${alert.at.toISOString()}`);

  return lines.join('\n');
}
