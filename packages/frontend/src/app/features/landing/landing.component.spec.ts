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

    it('lists exactly the eight tools the MCP server registers', () => {
      // Mirrors backend mcp-tools.service.ts registerTools(). The last two
      // reach the caller's own hosted servers, so one connection covers them
      // all; they are not marketplace search.
      [
        'generate_mcp_server',
        'continue_generation',
        'get_generation_status',
        'get_generated_server',
        'list_conversations',
        'search_marketplace',
        'search_tools',
        'call_tool',
      ].forEach(tool => expect(text).toContain(tool));
    });

    it('names the four supported inputs', () => {
      // Rendered as the rotating examples in the hero "machine".
      expect(text).toContain('GitHub repository');
      expect(text).toContain('documentation');
      expect(text).toContain('service name');
      expect(text).toContain('description');
    });

    it('promises the tools are run and tested before delivery', () => {
      // The refine/repair mechanism is real but deliberately not described -
      // the pitch sells the outcome ("they actually work"), not the process.
      // What must survive is the trust promise itself.
      expect(text.toLowerCase()).toContain('tested');
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
      // No OpenAPI or GraphQL parser exists anywhere in the backend.
      //
      // The page used to carry an explicit denial ("no specification parser
      // exists") purely because the chat empty-state offered a "Work with API
      // specs - OpenAPI, Swagger, GraphQL" card. That card was corrected on
      // 2026-08-04, so the denial is gone too: with nothing promising it
      // anywhere, answering a question nobody asked just seeded the idea.
      // The denial survives in llms.txt and the FAQ structured data, where a
      // searcher would actually look for it.
      expect(text).not.toContain('OpenAPI');
      expect(text).not.toContain('GraphQL');
      expect(text).not.toContain('Swagger');
    });

    it('describes hosting accurately - offered, and capped at one', () => {
      // This assertion is INVERTED from what it was before 2026-08-04, when
      // it forbade any present-tense hosting claim. That was correct while the
      // Kubernetes path was unexercised; it stopped being correct once
      // tier-config.ts shipped hostedServerLimit: 1 on the free tier, chat
      // grew a "Host on Cloud" button wired to deployToCloud, and hosted
      // servers began running in production. The page denied its own best
      // feature for a day because this guard demanded it.
      const lower = text.toLowerCase();
      expect(lower).toContain('hosted here');
      expect(lower).not.toContain('run your server for you yet');

      // Still overclaiming if any of these appear: the cap is one server, and
      // nothing autoscales.
      expect(lower).not.toContain('unlimited');
      expect(lower).not.toContain('scale automatically');
      expect(lower).not.toContain('scales to zero');
    });

    it('keeps the pitch free of a build-status ledger', () => {
      // Removed 2026-08-26: the "Straight talk / Not available yet" ledger
      // read like a changelog and led the reader with limitations. The precise
      // gated / not-for-sale disclosures now live where someone looks for them
      // - the FAQ in index.html and /llms.txt - not in the landing pitch. This
      // guard fails the build if the ledger (or its status-report voice) comes
      // back, or if the page starts quoting a price.
      expect(text).not.toContain('Not available yet');
      expect(text.toLowerCase()).not.toContain('active development');
      expect(text).not.toMatch(/\$\s?\d/);
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
      const pitch = Array.from(el.querySelectorAll('.hero, .ideas, .status, .closing'))
        .map(node => node.textContent ?? '')
        .join(' ')
        .toLowerCase();

      ['docker', 'json-rpc', 'kubernetes', 'stdio', 'sandbox', 'pipeline', 'repair round'].forEach(
        term => expect(pitch).not.toContain(term),
      );
    });

    /**
     * Stripping the plumbing words is not enough on its own - the first pass
     * did that and still shipped pipeline.service.ts's step names (Research /
     * Design / Build / Test / Deliver) as an animated numbered rail in the
     * hero. The hero must show the OUTPUT, not the procedure.
     */
    it('shows what the reader gets rather than the steps we run', () => {
      const el = fixture.nativeElement as HTMLElement;
      const hero = el.querySelector('.hero')?.textContent ?? '';

      // Example tool names - the thing the reader's assistant actually gains.
      expect(hero).toContain('refund_charge');
      expect(el.querySelectorAll('.tools-item').length).toBeGreaterThan(0);

      // ...and no step-by-step narration of our own pipeline.
      expect(el.querySelector('.rail')).toBeNull();
    });

    /**
     * A landing page has to provoke "I could use this for ___". Nothing on
     * this page did that job until the ideas strip replaced a stat band whose
     * numbers counted our own surface area.
     */
    it('gives the reader concrete ideas and a route to real examples', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelectorAll('.idea-list li').length).toBeGreaterThanOrEqual(3);
      expect(el.querySelector('.ideas-link')).toBeTruthy();
    });

    it('does not offer GitHub repository push as a destination', () => {
      // Free-tier deployment is Gist/download only; repo push is gated to an
      // unpurchasable tier. The pitch simply never claims a repository push
      // (the precise gating lives in the FAQ and /llms.txt). A repo as a
      // generation *input* ("paste a repo") is fine - this guards the *act of
      // pushing to* a repository.
      expect(text.toLowerCase()).not.toMatch(/push[a-z]*\s+(to\s+)?(a\s+)?(your\s+)?(github\s+)?repo/);
    });

    it('does not advertise usage quotas or caps on the pitch', () => {
      // Metered limits (generations per month, the one-server cap) are enforced
      // in-app and documented in the FAQ + /llms.txt. The marketing page sells
      // the outcome, not the rate limits - so no "N generations a month" and no
      // server-count cap on the pitch.
      const lower = text.toLowerCase();
      expect(lower).not.toMatch(/\d+\s+generation/);
      expect(lower).not.toMatch(/generations?\s+(a|per)\s+month/);
    });
  });
});
