import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LandingComponent } from './landing.component';

describe('LandingComponent', () => {
  let fixture: ComponentFixture<LandingComponent>;
  let text: string;
  let html: string;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LandingComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    html = (fixture.nativeElement as HTMLElement).innerHTML;
  });

  it('renders', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  describe('document structure', () => {
    it('has exactly one h1', () => {
      const h1s = (fixture.nativeElement as HTMLElement).querySelectorAll('h1');
      expect(h1s.length).toBe(1);
    });

    it('does not skip from h1 straight past h2', () => {
      const headings = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('h1, h2, h3'),
      ).map(h => Number(h.tagName.substring(1)));

      expect(headings[0]).toBe(1);
      headings.slice(1).forEach((level, i) => {
        // A heading may only ever go one level deeper than the one before it.
        expect(level).toBeLessThanOrEqual(headings[i] + 1);
      });
    });

    it('gives every image an alt attribute', () => {
      const images = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('img'));
      expect(images.length).toBeGreaterThan(0);
      images.forEach(img => expect(img.hasAttribute('alt')).toBe(true));
    });

    it('offers both sign-in and sign-up routes without being a login page', () => {
      expect(html).toContain('/auth/login');
      expect(html).toContain('/auth/register');
      // A marketing page, not a login form.
      expect((fixture.nativeElement as HTMLElement).querySelectorAll('input').length).toBe(0);
    });

    it('uses the canonical button classes rather than bespoke ones', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelectorAll('.mcp-btn-primary').length).toBeGreaterThan(0);
      expect(el.querySelectorAll('.mcp-btn-secondary').length).toBeGreaterThan(0);
    });
  });

  /**
   * The landing copy exists twice: here, and as the static crawlable shell
   * inside <mcp-root> in src/index.html (the app has no SSR, so a non-JS
   * crawler only ever sees that shell). These assertions pin the factual
   * claims that must not drift between the two. If you change a fact here,
   * change it in src/index.html and src/seo/llms.txt as well.
   */
  describe('load-bearing factual claims (mirrored in index.html and llms.txt)', () => {
    it('states the MCP endpoint, transport and credential correctly', () => {
      expect(text).toContain('POST /mcp');
      expect(text).toContain('Streamable HTTP');
      expect(text).toContain('mcpe_');
      expect(text).toContain('X-API-Key');
      expect(text).toContain('Authorization: Bearer');
    });

    it('publishes the endpoint path the backend actually serves', () => {
      // The MCP controller is mounted OUTSIDE the /api/v1 global prefix and
      // the Ingress routes /mcp to the backend; /api/mcp is a 404. The page
      // shipped the 404 form until 2026-08-03.
      expect(text).toContain('https://mcpeverything.com/mcp');
      expect(text).not.toContain('mcpeverything.com/api/mcp');
    });

    it('lists exactly the six tools the MCP server registers', () => {
      // Mirrors backend mcp-tools.service.ts registerTools().
      [
        'generate_mcp_server',
        'continue_generation',
        'get_generation_status',
        'get_generated_server',
        'list_conversations',
        'search_marketplace',
      ].forEach(tool => expect(text).toContain(tool));
    });

    it('names the four supported inputs', () => {
      // Rendered as the rotating examples in the hero "machine".
      expect(text).toContain('GitHub repository');
      expect(text).toContain('documentation');
      expect(text).toContain('service name');
      expect(text).toContain('description');
    });

    it('promises the servers are tested and repaired before delivery', () => {
      // The underlying mechanism (a Docker sandbox, JSON-RPC tool calls, five
      // refinement iterations) is real - see mcp-testing.service.ts and
      // MAX_REFINEMENT_ITERATIONS - but it is deliberately NOT named on the
      // page any more. What must survive is the promise itself.
      const lower = text.toLowerCase();
      expect(lower).toContain('tested');
      expect(lower).toMatch(/fixed|repair/);
    });
  });

  /**
   * The honesty guard. This project has previously shipped UI describing
   * features that did not exist (a "$3/mo" hosting flow with no billing
   * behind it, and a fabricated endpoint URL). These assertions fail the
   * build if the landing page starts making those claims again.
   */
  describe('honesty guard', () => {
    it('quotes no price, because billing is not implemented', () => {
      expect(text).not.toMatch(/\$\s?\d/);
      expect(text.toLowerCase()).not.toContain('per month for');
      expect(text.toLowerCase()).not.toContain('subscribe');
      expect(text.toLowerCase()).not.toContain('upgrade to pro');
    });

    it('does not claim OpenAPI or GraphQL specification input', () => {
      // No OpenAPI or GraphQL parser exists anywhere in the backend, so the
      // words may appear only as an explicit denial - which must stay on the
      // page, because the in-product help text still wrongly offers it.
      expect(text).toContain('OpenAPI or GraphQL specs');
      expect(text).toContain('We don’t read them');

      // ...and never as one of the advertised inputs or capabilities. Checked
      // structurally rather than by phrase-matching, so the denial itself -
      // which necessarily names OpenAPI - doesn't trip the guard.
      const promoted = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll(
          '.hero, .band, .agent-grid, .ledger-col-ready',
        ),
      )
        .map(el => el.textContent ?? '')
        .join(' ');

      expect(promoted).not.toContain('OpenAPI');
      expect(promoted).not.toContain('GraphQL');
      expect(promoted).not.toContain('Swagger');
    });

    it('does not advertise cloud hosting as available', () => {
      const lower = text.toLowerCase();
      // These phrases would be present-tense claims about the unexercised
      // Kubernetes path.
      expect(lower).not.toContain('we host');
      expect(lower).not.toContain('deploy to the cloud');
      expect(lower).not.toContain('one-click deploy');
      expect(lower).not.toContain('scale automatically');
    });

    it('keeps an explicit "not available yet" disclosure on the page', () => {
      expect(text).toContain('Not available yet');
      expect(text.toLowerCase()).toContain('nothing is for sale');
      // Hosting must still be disclosed as unavailable - just without naming
      // the cluster it does not yet run for users on.
      expect(text).toContain('Hosting');
      expect(text.toLowerCase()).toContain('run your server for you');
    });

    /**
     * The pitch describes what the reader gets; it does not describe how we
     * built it. This page shipped Docker, JSON-RPC, "repair rounds",
     * stdio/Streamable HTTP and Kubernetes in its marketing copy until
     * 2026-08-03. The "For agents" block is exempt by design - there the
     * protocol details ARE the product surface, not implementation trivia.
     */
    it('keeps implementation vocabulary out of the marketing copy', () => {
      const el = fixture.nativeElement as HTMLElement;
      const pitch = Array.from(el.querySelectorAll('.hero, .band, .status, .closing'))
        .map(node => node.textContent ?? '')
        .join(' ')
        .toLowerCase();

      ['docker', 'json-rpc', 'kubernetes', 'stdio', 'sandbox', 'pipeline', 'repair round'].forEach(
        term => expect(pitch).not.toContain(term),
      );
    });

    it('does not offer GitHub repository push as an available destination', () => {
      // tier-config.ts gives the free tier deploymentTypes: ['gist'] and
      // deployment-router.service.ts throws TIER_RESTRICTION for 'repo'.
      // Since no paid tier is purchasable, no real account can push to a repo,
      // so the page must present it as gated rather than as a destination.
      const worksToday =
        (fixture.nativeElement as HTMLElement).querySelector('.ledger-col-ready')?.textContent ?? '';

      // ("repo" alone is fine there - it's also a generation *input*, which is
      // exactly why this checks for the *act of pushing* rather than the noun.)
      expect(worksToday.toLowerCase()).not.toContain('push');
      expect(worksToday).toContain('Gist');
      expect(text.toLowerCase()).toContain('gated to a paid tier');
    });
  });
});
