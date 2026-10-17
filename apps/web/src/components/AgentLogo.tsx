/**
 * The mark of an agent tool (2026-10-17), beside its name on the welcome's
 * cards and in Your devices. One SVG per registry id under assets/agents/;
 * these are drawn by hand as stand-ins, and an official mark dropped in under
 * the same name replaces one with no code change. A tool without a file, and
 * "something else", get a lettered tile instead.
 */
import claudeCode from '../assets/agents/claude-code.svg';
import codex from '../assets/agents/codex.svg';
import opencode from '../assets/agents/opencode.svg';
import antigravity from '../assets/agents/antigravity.svg';

const MARK: Record<string, string> = { 'claude-code': claudeCode, codex, opencode, antigravity };

export function AgentLogo({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  const src = MARK[id];
  if (!src) {
    return (
      <span className="agent-logo agent-logo-letter" style={{ width: size, height: size }} aria-hidden>
        {id === 'other' ? '?' : name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return <img className="agent-logo" src={src} width={size} height={size} alt="" aria-hidden />;
}
