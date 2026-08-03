import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle.component';

/**
 * Public marketing landing page served at `/`.
 *
 * Everything on this page must map to a feature that actually works today.
 * Where something is planned but not working (cloud hosting, billing,
 * authentication for hosted servers) it is confined to the "Not available
 * yet" section and phrased in the future tense. See the component template
 * for the per-claim notes.
 *
 * Rendering note: this SPA has no SSR or prerendering, so crawlers that do
 * not execute JavaScript never see this component. The same marketing copy
 * and the machine-readable facts are therefore *also* present as static HTML
 * inside <mcp-root> in src/index.html, which Angular replaces on bootstrap.
 * If you change a factual claim here (the MCP endpoint, the API key prefix,
 * the tool list, what is and isn't available), change it in src/index.html
 * and src/seo/llms.txt too - landing.component.spec.ts guards the most
 * important of those strings.
 */
@Component({
  selector: 'mcp-landing',
  standalone: true,
  imports: [CommonModule, RouterModule, ThemeToggleComponent],
  templateUrl: './landing.component.html',
  styleUrls: ['./landing.component.scss'],
})
export class LandingComponent {
  /** Public MCP endpoint agents connect to. Mirrored in index.html + llms.txt. */
  readonly mcpEndpoint = 'https://mcpeverything.com/api/mcp';

  /** Prefix of the API keys issued on the account page. */
  readonly apiKeyPrefix = 'mcpe_';

  /** Source repository - used for the footer link and the JSON-LD sameAs. */
  readonly repoUrl = 'https://github.com/4eyedengineer/mcp-everything';

  /**
   * Worked example of calling the MCP endpoint.
   *
   * This lives here rather than inline in the template because the JSON-RPC
   * body contains `{` and `}`, which Angular's template parser tokenises as
   * an ICU message and then fails to compile. A component string sidesteps
   * that entirely.
   *
   * localhost is used deliberately: the endpoint is not routed on the public
   * domain yet, so a public URL here would be a fabricated one - exactly the
   * class of claim this page exists to avoid.
   */
  readonly curlExample = [
    `curl -X POST http://localhost:3000/mcp \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Accept: application/json, text/event-stream' \\`,
    `  -H 'X-API-Key: ${this.apiKeyPrefix}<your key>' \\`,
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  ].join('\n');

  readonly currentYear = new Date().getFullYear();
}
