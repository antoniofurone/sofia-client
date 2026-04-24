import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { TextPart } from '../../types/a2a';

marked.use({ breaks: true, gfm: true });

interface Props {
  part: TextPart;
}

export function TextPartView({ part }: Props) {
  const html = useMemo(() => {
    const raw = (marked.parse(part.text) as string)
      .replace(/<table/g, '<div class="table-wrap"><table')
      .replace(/<\/table>/g, '</table></div>');
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [part.text]);

  return (
    <div
      className="text-part markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
