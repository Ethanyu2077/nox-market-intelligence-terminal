import type { ReactNode } from 'react';
import type { AiCitation } from '../../shared/ai';

/**
 * Deliberately small markdown renderer.
 *
 * The assistant output is untrusted text from a third-party model, so this component
 * never injects HTML: it tokenises a safe subset into React nodes. Links are restricted
 * to http(s) and rendered with rel="noreferrer noopener".
 */

interface MarkdownProps {
  text: string;
  citations?: AiCitation[];
}

const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[S\d+\]|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;

function inline(text: string, citations: AiCitation[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (/^\[S\d+\]$/.test(token)) {
      const id = token.slice(1, -1);
      const citation = citations.find((item) => item.id === id);
      nodes.push(
        <span key={key} className={`ai-cite${citation ? '' : ' unknown'}`} title={citation ? `${citation.exchange} · ${citation.symbol} · ${new Date(citation.eventTime).toLocaleString()} · ${citation.quality}` : 'Unverified source id'}>
          {id}
        </span>,
      );
    } else if (token.startsWith('*')) nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    else {
      const label = token.slice(1, token.indexOf(']'));
      const href = token.slice(token.indexOf('(') + 1, -1);
      nodes.push(<a key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</a>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text, citations = [] }: MarkdownProps) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) { index += 1; continue; }

    // Fenced code
    if (line.trimStart().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith('```')) { body.push(lines[index]); index += 1; }
      index += 1;
      blocks.push(
        <pre key={`b${key++}`} className="ai-code" data-language={language || undefined}><code>{body.join('\n')}</code></pre>,
      );
      continue;
    }

    // Heading
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = (level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5';
      blocks.push(<Tag key={`b${key++}`}>{inline(heading[2], citations, `h${key}`)}</Tag>);
      index += 1;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (index < lines.length && lines[index].startsWith('>')) { body.push(lines[index].replace(/^>\s?/, '')); index += 1; }
      blocks.push(<blockquote key={`b${key++}`}>{inline(body.join(' '), citations, `q${key}`)}</blockquote>);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*[-*]\s+/, '')); index += 1; }
      blocks.push(<ul key={`b${key++}`}>{items.map((item, n) => <li key={n}>{inline(item, citations, `u${key}-${n}`)}</li>)}</ul>);
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*\d+[.)]\s+/, '')); index += 1; }
      blocks.push(<ol key={`b${key++}`}>{items.map((item, n) => <li key={n}>{inline(item, citations, `o${key}-${n}`)}</li>)}</ol>);
      continue;
    }

    // Paragraph: consume until a blank line or a block opener.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^\s*([-*]\s|\d+[.)]\s|#{1,4}\s|>|```)/.test(lines[index]) && !lines[index].trimStart().startsWith('```')) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (!paragraph.length) { paragraph.push(lines[index]); index += 1; }
    blocks.push(<p key={`b${key++}`}>{inline(paragraph.join(' '), citations, `p${key}`)}</p>);
  }

  return <div className="ai-markdown">{blocks}</div>;
}
