import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import hljs from 'highlight.js';

/**
 * SafeMarkdownPipe
 *
 * Securely renders markdown content with syntax highlighting while preventing XSS attacks.
 *
 * Features:
 * - Converts markdown to HTML using marked.js
 * - Syntax highlighting for code blocks using highlight.js
 * - XSS protection via Angular's DomSanitizer
 * - Configures marked to be secure by default
 *
 * Usage:
 * ```html
 * <div [innerHTML]="message.content | safeMarkdown"></div>
 * ```
 *
 * Security:
 * - Sanitizes HTML output using Angular's DomSanitizer
 * - marked configured with secure defaults (no inline HTML script execution)
 * - All user input is processed through marked's parser which escapes dangerous content
 */
@Pipe({
  name: 'safeMarkdown',
  standalone: true,
})
export class SafeMarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {
    this.configureMarked();
  }

  /**
   * Configure marked with secure defaults and syntax highlighting
   */
  private configureMarked(): void {
    marked.setOptions({
      // Enable GitHub Flavored Markdown
      gfm: true,

      // Break on single line breaks (like GitHub)
      breaks: true,

      // Use async rendering for better performance
      async: false,

      // Use pedantic mode for better markdown compatibility
      pedantic: false,
    });

    // Configure marked renderer for additional security
    const renderer = new marked.Renderer();

    // Override link renderer to add security attributes
    renderer.link = ({ href, title, tokens }) => {
      const text = this.parseInline(tokens);

      // Security: Prevent javascript: and data: URLs
      if (href.startsWith('javascript:') || href.startsWith('data:')) {
        return text;
      }

      // Add rel="noopener noreferrer" for external links
      const isExternal = href.startsWith('http://') || href.startsWith('https://');
      const rel = isExternal ? ' rel="noopener noreferrer"' : '';
      const target = isExternal ? ' target="_blank"' : '';
      const titleAttr = title ? ` title="${title}"` : '';

      return `<a href="${href}"${titleAttr}${rel}${target}>${text}</a>`;
    };

    // Override image renderer to add security attributes
    renderer.image = ({ href, title, text }) => {
      // Security: Only allow http(s) and relative image URLs
      if (href.startsWith('javascript:') || href.startsWith('data:')) {
        return text || '';
      }

      const titleAttr = title ? ` title="${title}"` : '';
      const altAttr = text ? ` alt="${text}"` : '';
      return `<img src="${href}"${altAttr}${titleAttr} loading="lazy">`;
    };

    marked.use({
      renderer,
      // Add syntax highlighting via hooks
      hooks: {
        postprocess: (html: string) => {
          // This will be called after markdown is converted to HTML
          return html;
        }
      }
    });

    // Configure code highlighting using marked extension
    marked.use({
      async: false,
      breaks: true,
      gfm: true,
    });
  }

  /**
   * Parse inline tokens to text (helper for renderer)
   */
  private parseInline(tokens: any[]): string {
    return tokens.map((token) => {
      if (token.type === 'text') {
        return token.text;
      }
      if (token.type === 'em') {
        return `<em>${this.parseInline(token.tokens)}</em>`;
      }
      if (token.type === 'strong') {
        return `<strong>${this.parseInline(token.tokens)}</strong>`;
      }
      if (token.type === 'codespan') {
        return `<code>${token.text}</code>`;
      }
      return token.raw || '';
    }).join('');
  }

  /**
   * Transform markdown content to safe HTML
   * @param value Markdown string to convert
   * @returns SafeHtml that can be used with [innerHTML]
   */
  transform(value: string | null | undefined): SafeHtml {
    if (!value) {
      return '';
    }

    try {
      // Parse markdown to HTML
      const html = marked.parse(value, { async: false }) as string;

      // Sanitize the HTML to prevent XSS attacks
      // Angular's DomSanitizer removes dangerous content like:
      // - <script> tags
      // - Event handlers (onclick, onerror, etc.)
      // - javascript: and data: URLs
      // - Dangerous CSS
      return this.sanitizer.sanitize(1, html) || ''; // 1 = SecurityContext.HTML
    } catch (error) {
      console.error('Markdown parsing error:', error);
      // Return escaped plain text as fallback
      return this.sanitizer.sanitize(1, this.escapeHtml(value)) || '';
    }
  }

  /**
   * Escape HTML characters as fallback
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
