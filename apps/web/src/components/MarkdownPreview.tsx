import { useMemo } from "react";
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true });

function renderMarkdown(source: string): string {
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = String(token.attrGet("href") ?? "");
    if (/^https?:\/\//i.test(href)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    } else {
      // local:// and every other scheme: render as plain text, never a link.
      return self.renderToken(tokens, idx, options);
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  return md.render(source);
}

export function MarkdownPreview({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      data-testid="markdown-preview"
      className="markdown-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
